// Design doc: docs/design/chunked-cloud-sync-design.md
// App doc: docs/user-guide/cloud-sync.md, docs/user-guide/pages/game-save.md §2.3

// ─── Types ───

export interface ChunkManifest {
  manifestVersion: 2;
  createdAt: string;
  engineVersion: string;
  totalSizeBytes: number;
  bundleChecksum: string;
  chunks: ChunkEntry[];
  /**
   * Audit stamp: which device produced this upload. Set by GitHubSyncService at
   * upload time (the packer never writes it). Manifest fields are not covered
   * by bundleChecksum / chunk checksums, so this is roundtrip-safe and old
   * manifests without it stay valid.
   */
  uploadedBy?: import('./device-identity').UploadDeviceStamp;
}

export interface ChunkEntry {
  name: string;
  path: string;
  compressedSize: number;
  originalSize: number;
  checksum: string;
}

export interface PackResult {
  manifest: ChunkManifest;
  chunks: Map<string, Blob>;
}

export class ChecksumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChecksumError';
  }
}

// ─── Constants ───

const TARGET_CHUNK_BYTES = 20_000_000;
// The state has no natural array to split on, so a very large state is sliced
// from its serialized JSON string (UTF-16 code units, kept below
// TARGET_CHUNK_BYTES so even all-CJK content stays a safe size per gzip call).
// Small states keep the single legacy `state` chunk.
const STATE_SLICE_CHARS = 8_000_000;
const ENGINE_VERSION = '0.1.0';

// ─── Public API ───

/**
 * Streaming packer — yields each compressed chunk as it is produced, then
 * returns the manifest. This is the memory-bounded core: a caller that uploads
 * and releases each yielded chunk never holds the whole chunk set in memory.
 *
 * Why this exists (2026-06-14): a ~110MB save OOM'd the eager `pack()` because
 * the source JSON string, the parsed object, AND every compressed chunk were
 * all alive at once. The gzip step (`new Response(compressionStream).blob()`)
 * then failed allocation and Chrome rethrew it as `TypeError: Failed to fetch`.
 * To cut the peak this generator:
 *   1. accepts a Blob so the source string is generator-local and freed after
 *      parse (the caller never has to retain it);
 *   2. drops the source string immediately once parsed;
 *   3. `shift()`s each image off the source array so processed assets become
 *      GC-able instead of being pinned until the end;
 *   4. yields each chunk so the caller can PUT + release it one at a time.
 *
 * @param source the bundle JSON as a string (legacy/test callers) or a Blob
 *   (preferred for large bundles — keeps the decoded string out of the caller).
 * @param dir remote directory prefix for chunk paths (default 'v2' — the legacy
 *   whole-bundle layout). The save-slot pipeline passes 'slots/<profileId>' or
 *   'global' so each slot's chunks live in their own directory
 *   (docs/design/github-save-slots-design.md §4). Pure path prefix — the pack
 *   algorithm, checksums, and roundtrip identity are unaffected.
 */
export async function* packChunks(
  source: string | Blob,
  dir = 'v2',
): AsyncGenerator<{ path: string; blob: Blob }, ChunkManifest, void> {
  let json: string;
  if (typeof source === 'string') {
    json = source;
  } else {
    json = await source.text();
    // Release the source Blob immediately — only the decoded string is needed
    // now. With the caller also dropping its reference this frees ~100MB+
    // before the parse/compress peak.
    source = '';
  }
  // `totalSizeBytes` is a DISPLAY-ONLY uncompressed-size estimate (getCloudInfo
  // renders it as "云端 … KB"). Measure it as `json.length` (UTF-16 code units) for
  // BOTH string and Blob inputs so the streaming Blob path reports the SAME number
  // the legacy eager string path always did. Using the Blob's UTF-8 `.size` here
  // counted each CJK char as 3 bytes vs 1, which made the displayed save size jump
  // on the first upload after switching upload() to feed a Blob — alarming and
  // inconsistent with every previously-uploaded save, even though the stored data
  // (chunks + checksums) is byte-identical.
  const totalSizeBytes = json.length;
  const bundleChecksum = await sha256String(json);
  let parsed = JSON.parse(json) as Record<string, unknown>;
  // Release the (potentially 100MB+) source string before the compress phase.
  json = '';

  const hadImages = 'imageAssets' in parsed;
  const imageAssets = (hadImages ? parsed.imageAssets : []) as unknown[];
  // Extract images to their own chunks, but leave an EMPTY `imageAssets: []`
  // placeholder in the state so the key keeps its ORIGINAL position. On unpack
  // the rebuilt array is assigned back to this existing key (in-place update,
  // order preserved). If we deleted it and re-appended at the end, the bundle
  // key order would shift relative to any keys that follow `imageAssets` in the
  // export (worldBooks / builtinPromptOverrides), the whole-bundle SHA-256
  // would never match, and the cloud save would be permanently undownloadable.
  if (hadImages && imageAssets.length > 0) parsed.imageAssets = [];

  const entries: ChunkEntry[] = [];

  let stateJson = JSON.stringify(parsed);
  // The parsed object is no longer needed (state is serialized; images are held
  // separately) — drop it so its ~tens of MB don't sit in the compress peak.
  parsed = {};

  // Compress the state. Small states stay a single legacy `state` chunk (so
  // existing manifests/tests are unchanged); large states are sliced into
  // byte-safe `state-N` pieces so no single gzip `new Blob([...])` call handles
  // the whole 50MB+ at once (that monolithic alloc is what threw "Failed to
  // fetch"). chunkError attributes a failure to the exact piece + its size.
  if (stateJson.length <= STATE_SLICE_CHARS) {
    const e = await compressChunk('state', `${dir}/state.gz`, stateJson).catch(
      (err: unknown) => { throw chunkError('state', stateJson.length, imageAssets.length, err); },
    );
    entries.push(e.entry);
    yield { path: e.path, blob: e.blob };
  } else {
    let si = 0;
    let pos = 0;
    while (pos < stateJson.length) {
      let end = Math.min(pos + STATE_SLICE_CHARS, stateJson.length);
      // Never split a surrogate pair: a lone half corrupts UTF-8 on blob-encode.
      if (end < stateJson.length) {
        const c = stateJson.charCodeAt(end);
        if (c >= 0xDC00 && c <= 0xDFFF) end++;
      }
      const piece = stateJson.slice(pos, end);
      const e = await compressChunk(`state-${si}`, `${dir}/state-${si}.gz`, piece).catch(
        (err: unknown) => { throw chunkError(`state-${si}`, piece.length, imageAssets.length, err); },
      );
      entries.push(e.entry);
      yield { path: e.path, blob: e.blob };
      pos = end;
      si++;
    }
  }
  // Release the serialized state (~tens of MB) before the image phase — it was
  // being held all the way through image compression for no reason, inflating
  // the peak that the image-chunk gzip allocation has to fit under.
  stateJson = '';

  if (imageAssets.length > 0) {
    let currentBatch: unknown[] = [];
    let currentSize = 0;
    let chunkIndex = 0;

    const flush = async (): Promise<{ path: string; blob: Blob }> => {
      const batchJson = JSON.stringify(currentBatch);
      const count = currentBatch.length;
      const imgEntry = await compressChunk(
        `img-${chunkIndex}`, `${dir}/img-${chunkIndex}.gz`, batchJson,
      ).catch((err: unknown) => { throw chunkError(`img-${chunkIndex}`, batchJson.length, count, err); });
      entries.push(imgEntry.entry);
      chunkIndex++;
      currentBatch = [];
      currentSize = 0;
      return { path: imgEntry.path, blob: imgEntry.blob };
    };

    // Drain via shift() (not for…of) so each processed asset can be GC'd
    // incrementally rather than being held in the array until the end.
    while (imageAssets.length > 0) {
      const asset = imageAssets.shift();
      const assetSize = JSON.stringify(asset).length;

      if (currentSize + assetSize > TARGET_CHUNK_BYTES && currentBatch.length > 0) {
        yield await flush();
      }

      currentBatch.push(asset);
      currentSize += assetSize;
    }

    if (currentBatch.length > 0) {
      yield await flush();
    }
  }

  return {
    manifestVersion: 2,
    createdAt: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
    totalSizeBytes,
    bundleChecksum,
    chunks: entries,
  };
}

/**
 * Eager packer — collects every chunk into a Map and returns it with the
 * manifest. Thin wrapper over {@link packChunks}; kept for callers/tests that
 * want the whole set at once. For large bundles prefer streaming via
 * `packChunks` so chunks are not all held in memory simultaneously.
 */
export async function pack(json: string, dir = 'v2'): Promise<PackResult> {
  const chunks = new Map<string, Blob>();
  const gen = packChunks(json, dir);
  let res = await gen.next();
  while (!res.done) {
    chunks.set(res.value.path, res.value.blob);
    res = await gen.next();
  }
  return { manifest: res.value, chunks };
}

export async function unpack(
  manifest: ChunkManifest,
  chunks: Map<string, Blob>,
): Promise<string> {
  // Layer 1: per-chunk checksum verification
  for (const entry of manifest.chunks) {
    const blob = chunks.get(entry.path);
    if (!blob) throw new ChecksumError(`分块 ${entry.name} 缺失`);

    const actual = await sha256Blob(blob);
    if (actual !== entry.checksum) {
      throw new ChecksumError(`分块 ${entry.name} 数据损坏（校验不通过）`);
    }
  }

  // Decompress state — either a single legacy `state` chunk or split
  // `state-0`,`state-1`,… pieces concatenated back in order.
  const stateEntries = manifest.chunks
    .filter(e => e.name === 'state' || /^state-\d+$/.test(e.name))
    .sort((a, b) => stateOrder(a.name) - stateOrder(b.name));
  if (stateEntries.length === 0) throw new ChecksumError('缺少 state 分块');
  // A valid manifest has EITHER one legacy `state` OR a `state-N` set, never
  // both. Both present means a corrupt/straddled manifest — fail loudly rather
  // than concatenate inconsistent pieces.
  if (stateEntries.some(e => e.name === 'state') && stateEntries.some(e => e.name !== 'state')) {
    throw new ChecksumError('state 分块同时存在单块与分片，manifest 不一致');
  }
  let stateJson = '';
  for (const entry of stateEntries) {
    stateJson += await gzipDecompress(chunks.get(entry.path)!);
  }
  const stateObj = JSON.parse(stateJson) as Record<string, unknown>;

  // Decompress and merge image chunks (ordered by manifest)
  const imgEntries = manifest.chunks
    .filter(e => e.name.startsWith('img-'))
    .sort((a, b) => {
      const ai = parseInt(a.name.split('-')[1], 10);
      const bi = parseInt(b.name.split('-')[1], 10);
      return ai - bi;
    });

  if (imgEntries.length > 0) {
    const allImages: unknown[] = [];
    for (const entry of imgEntries) {
      const imgJson = await gzipDecompress(chunks.get(entry.path)!);
      const batch = JSON.parse(imgJson) as unknown[];
      allImages.push(...batch);
    }
    stateObj.imageAssets = allImages;
  }

  // Layer 2: bundle checksum verification
  const reassembledJson = JSON.stringify(stateObj, null, 2);
  const actualChecksum = await sha256String(reassembledJson);
  if (actualChecksum !== manifest.bundleChecksum) {
    throw new ChecksumError('存档重组校验失败（SHA-256 不匹配）');
  }

  return reassembledJson;
}

// ─── Compression ───

/**
 * Gzip a string to a Blob.
 *
 * Drives the CompressionStream explicitly via reader/writer instead of
 * `new Blob([data]).stream() → new Response(stream).blob()`. The Response/Body
 * path threw an opaque `TypeError: Failed to fetch` on large inputs for some
 * users (the Fetch machinery, not raw OOM); the explicit form avoids both the
 * intermediate Blob and the Fetch consumer, and releases the writer/reader
 * deterministically so nothing accumulates across many chunks. The bytes fed to
 * the CompressionStream are the same UTF-8 encoding `new Blob([data])` would
 * produce, so the gzip output is byte-identical (roundtrip/checksum preserved).
 */
export async function gzipCompress(data: string): Promise<Blob> {
  const cs = new CompressionStream('gzip');
  const reader = cs.readable.getReader();
  const parts: Uint8Array[] = [];
  // Drain the compressed output concurrently with writing so a large single
  // write cannot deadlock on backpressure.
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  })();
  const writer = cs.writable.getWriter();
  await writer.write(new TextEncoder().encode(data));
  await writer.close();
  await pump;
  return new Blob(parts);
}

/**
 * Decompress a gzip blob to text.
 *
 * @param maxBytes Optional decompressed-size ceiling (default Infinity = unbounded, the legacy
 *   behavior for backup/sync). The card-import path passes a bound to defend against a zip-bomb
 *   (a small compressed blob that balloons to GBs and OOMs the tab) on an untrusted .aga-card file.
 */
export async function gzipDecompress(blob: Blob, maxBytes = Infinity): Promise<string> {
  if (maxBytes === Infinity) {
    // Fast path — unchanged legacy behavior for trusted internal callers (backup/github-sync).
    const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  const reader = blob.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('decompressed size exceeds limit');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(merged);
}

// ─── Hashing ───

export async function sha256(data: ArrayBuffer): Promise<string> {
  // crypto.subtle requires secure context (HTTPS or localhost)
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return sha256Js(new Uint8Array(data));
}

// Pure JS SHA-256 fallback for non-secure contexts (e.g. http://192.168.x.x dev server)
/* eslint-disable no-bitwise */
function sha256Js(data: Uint8Array): string {
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  const msgLen = data.length;
  const bitLen = msgLen * 8;
  const padLen = 64 - ((msgLen + 9) % 64 || 64) + msgLen + 9;
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[msgLen] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 4, bitLen & 0xffffffff);
  dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000));

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i-15], 7) ^ rotr(w[i-15], 18) ^ (w[i-15] >>> 3);
      const s1 = rotr(w[i-2], 17) ^ rotr(w[i-2], 19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
    }
    h0=(h0+a)|0; h1=(h1+b)|0; h2=(h2+c)|0; h3=(h3+d)|0;
    h4=(h4+e)|0; h5=(h5+f)|0; h6=(h6+g)|0; h7=(h7+h)|0;
  }

  return [h0,h1,h2,h3,h4,h5,h6,h7]
    .map(v => (v >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

export async function sha256String(str: string): Promise<string> {
  return sha256(new TextEncoder().encode(str).buffer as ArrayBuffer);
}

export async function sha256Blob(blob: Blob): Promise<string> {
  return sha256(await blob.arrayBuffer());
}

// ─── Internal ───

/** Order key for state chunks: legacy single `state` sorts before any `state-N`. */
function stateOrder(name: string): number {
  if (name === 'state') return -1;
  const m = /^state-(\d+)$/.exec(name);
  return m ? parseInt(m[1], 10) : 0;
}

/** Attribute a chunk compression failure to its name + uncompressed size. */
function chunkError(name: string, uncompressedBytes: number, itemCount: number, err: unknown): Error {
  const mb = (uncompressedBytes / 1_048_576).toFixed(1);
  const raw = err instanceof Error ? err.message : String(err);
  return new Error(`分块 ${name}（未压缩 ${mb}MB，${itemCount} 项）压缩失败：${raw}`);
}

async function compressChunk(
  name: string, path: string, json: string,
): Promise<{ entry: ChunkEntry; blob: Blob; path: string }> {
  // Tag which sub-step fails so an opaque "Failed to fetch" points at gzip vs
  // sha256 instead of just "compression".
  let blob: Blob;
  try {
    blob = await gzipCompress(json);
  } catch (err) {
    throw new Error(`gzip: ${err instanceof Error ? err.message : String(err)}`);
  }
  let checksum: string;
  try {
    checksum = await sha256Blob(blob);
  } catch (err) {
    throw new Error(`sha256: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    path,
    blob,
    entry: {
      name,
      path,
      compressedSize: blob.size,
      originalSize: json.length,
      checksum,
    },
  };
}
