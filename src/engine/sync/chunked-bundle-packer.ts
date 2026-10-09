// Design doc: docs/design/chunked-cloud-sync-design.md
// App doc: docs/user-guide/cloud-sync.md, docs/user-guide/pages/game-save.md §2.3

import { ENGINE_VERSION } from '../core/engine-version';
import { gzipCompress, gzipDecompress, sha256, sha256String, sha256Blob, serializeBundleJson, type BundleSerialization } from '../core/codec';

// The codec functions moved to core/codec.ts; keep the original export names here.
export { gzipCompress, gzipDecompress, sha256, sha256String, sha256Blob };

// ─── Types ───

export interface ChunkManifest {
  manifestVersion: 2;
  createdAt: string;
  engineVersion: string;
  totalSizeBytes: number;
  bundleChecksum: string;
  /**
   * The layout of the bundle JSON the checksum was taken over (存档瘦身 D9A): unpack serialises the reassembled bundle
   * this way to check it. Absent on uploads from before D9A, whose bundles were 'pretty'.
   */
  bundleSerialization?: BundleSerialization;
  /**
   * What the upload stores: the compressed bytes of all its chunks (存档瘦身 D9A). For display — the size a slot
   * really takes; totalSizeBytes keeps its old meaning. Absent on uploads from before D9A.
   */
  storedBytes?: number;
  chunks: ChunkEntry[];
  /**
   * Audit stamp: which device produced this upload. Set by GitHubSyncService at
   * upload time (the packer never writes it). Manifest fields are not covered
   * by bundleChecksum / chunk checksums, so this is roundtrip-safe and old
   * manifests without it stay valid.
   */
  uploadedBy?: import('./device-identity').UploadDeviceStamp;
}

interface ChunkEntry {
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
 *
 * The layout of the bundle text (存档瘦身 D9A) is read off the text, never taken from the caller: a manifest that named
 * another layout than the one its checksum was taken over would make the upload undownloadable. 'compact' is recorded
 * in the manifest (`bundleSerialization`) for unpack's check; 'pretty' records nothing, as manifests before D9A did.
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
  const serialization = bundleSerializationOf(json);
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
    ...storageFields(serialization, entries),
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
  // The layout the bundle checksum was taken over (a manifest from before 存档瘦身 D9A names none: 'pretty'). The
  // manifest is data read back from the cloud: checked, not trusted.
  const serialization: unknown = manifest.bundleSerialization ?? 'pretty';
  if (serialization !== 'pretty' && serialization !== 'compact') {
    throw new ChecksumError(`存档格式无法识别（bundleSerialization: ${String(serialization)}）`);
  }

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
  const reassembledJson = serializeBundleJson(stateObj, serialization);
  const actualChecksum = await sha256String(reassembledJson);
  if (actualChecksum !== manifest.bundleChecksum) {
    throw new ChecksumError('存档重组校验失败（SHA-256 不匹配）');
  }

  return reassembledJson;
}

// ─── Internal ───

/**
 * The layout of a bundle's text as serializeBundleJson writes it: an object serialised with an indent starts with a
 * line break after its brace, one serialised without never does (an empty object is the same text either way).
 */
function bundleSerializationOf(json: string): BundleSerialization {
  return json.charCodeAt(1) === 0x0a ? 'pretty' : 'compact';
}

/** The manifest fields of 存档瘦身 D9A: the layout when it is not the old one, and what the chunks store. */
function storageFields(serialization: BundleSerialization, entries: readonly ChunkEntry[]): Pick<ChunkManifest, 'bundleSerialization' | 'storedBytes'> {
  return {
    ...(serialization === 'compact' ? { bundleSerialization: serialization } : {}),
    storedBytes: entries.reduce((sum, entry) => sum + entry.compressedSize, 0),
  };
}

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
