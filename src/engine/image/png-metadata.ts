/**
 * PNG Metadata Extractor — ported (full feature set)
 *
 * Extracts image generation parameters from PNG files via multiple strategies:
 * 1. Standard tEXt/zTXt/iTXt chunks (SD-WebUI, ComfyUI, etc.)
 * 2. EXIF metadata (eXIf chunks — ImageDescription, UserComment, XPComment)
 * 3. NovelAI JSON comment parsing (Comment chunk with JSON payload)
 * 4. NovelAI stealth alpha channel (bit-level LSB extraction from alpha channel)
 * 5. NovelAI raw byte search (fallback: scan raw bytes for known JSON markers)
 * 6. SD-WebUI parameter text parsing (Steps/CFG/Sampler/etc.)
 * 7. LoRA reference extraction from prompt text
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ FRONTEND TODO (Phase 5-6: Presets Tab)                         │
 * │                                                                 │
 * │ PNG metadata extraction is consumed by the PNG style preset     │
 * │ import flow. User uploads a PNG → metadata extracted → AI      │
 * │ refines style → preset saved. Needs Presets tab UI.             │
 * │ See original design doc §M "PNG Style Import Flow"             │
 * └─────────────────────────────────────────────────────────────────┘
 */
import { inflateSync } from 'fflate';

// ═══════════════════════════════════════════════════════════
// §1 — Types
// ═══════════════════════════════════════════════════════════

type PngMetadataSource = 'novelai' | 'sd_webui' | 'unknown';

interface PngParsedParams {
  sampler?: string;
  noiseSchedule?: string;
  steps?: number;
  cfgScale?: number;
  cfgRescale?: number;
  unconditionalScale?: number;
  clipSkip?: number;
  width?: number;
  height?: number;
  seed?: number;
  smea?: boolean;
  smeaDynamic?: boolean;
  dynamicThresholding?: boolean;
  preferBrownian?: boolean;
  model?: string;
  loras?: Array<{ name: string; weight?: number }>;
  rawParams?: Record<string, unknown>;
}

export interface PngMetadataResult {
  source: PngMetadataSource;
  positive: string;
  negative: string;
  params?: PngParsedParams;
  rawText: string;
  metadataTags?: Record<string, string>;
}

// ═══════════════════════════════════════════════════════════
// §2 — Encoding helpers
// ═══════════════════════════════════════════════════════════

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const latin1Decoder = new TextDecoder('latin1', { fatal: false });

function decodeUTF8(bytes: Uint8Array): string {
  try { return utf8Decoder.decode(bytes); } catch { return ''; }
}

function decodeLatin1(bytes: Uint8Array): string {
  try { return latin1Decoder.decode(bytes); } catch { return ''; }
}

function readNullTerminated(bytes: Uint8Array, start: number, decoder: (b: Uint8Array) => string): { text: string; next: number } {
  let end = start;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return { text: decoder(bytes.subarray(start, end)), next: Math.min(bytes.length, end + 1) };
}

function decompressZlib(bytes: Uint8Array): Uint8Array {
  if (!bytes.length) return bytes;
  try { return inflateSync(bytes); } catch { return bytes; }
}

// ═══════════════════════════════════════════════════════════
// §3 — PNG chunk iteration
// ═══════════════════════════════════════════════════════════

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function iteratePngChunks(
  pngBytes: Uint8Array,
  visitor: (chunk: { type: string; data: Uint8Array }) => boolean | void,
): boolean {
  if (pngBytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (pngBytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  const view = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= pngBytes.length) {
    const length = view.getUint32(offset);
    const typeBytes = pngBytes.subarray(offset + 4, offset + 8);
    const type = String.fromCharCode(...Array.from(typeBytes));
    const dataEnd = offset + 8 + length;
    if (dataEnd > pngBytes.length) return false;
    if (visitor({ type, data: pngBytes.subarray(offset + 8, dataEnd) }) === true) return true;
    offset = dataEnd + 4; // skip CRC
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
// §4 — Text chunk parsing
// ═══════════════════════════════════════════════════════════

function parseTextChunk(type: string, data: Uint8Array): { key: string; value: string } | null {
  if (!data.length) return null;
  if (type === 'tEXt') {
    const splitIdx = data.indexOf(0);
    if (splitIdx <= 0) return null;
    return { key: decodeLatin1(data.subarray(0, splitIdx)).trim(), value: decodeLatin1(data.subarray(splitIdx + 1)).trim() };
  }
  if (type === 'zTXt') {
    const splitIdx = data.indexOf(0);
    if (splitIdx <= 0 || splitIdx + 2 > data.length) return null;
    const key = decodeLatin1(data.subarray(0, splitIdx)).trim();
    const value = decodeLatin1(decompressZlib(data.subarray(splitIdx + 2))).trim();
    return key ? { key, value } : null;
  }
  if (type === 'iTXt') {
    const kw = readNullTerminated(data, 0, decodeLatin1);
    if (!kw.text) return null;
    const compFlag = data[kw.next] || 0;
    const compMethod = data[kw.next + 1] || 0;
    let cursor = kw.next + 2;
    const lang = readNullTerminated(data, cursor, decodeLatin1);
    cursor = lang.next;
    const translated = readNullTerminated(data, cursor, decodeUTF8);
    cursor = translated.next;
    const raw = data.subarray(cursor);
    const value = compFlag === 1 && compMethod === 0 ? decodeUTF8(decompressZlib(raw)) : decodeUTF8(raw);
    return { key: kw.text.trim(), value: value.trim() };
  }
  return null;
}

function extractTextMetadata(pngBytes: Uint8Array): Record<string, string> {
  const result: Record<string, string> = {};
  iteratePngChunks(pngBytes, ({ type, data }) => {
    if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') return;
    const parsed = parseTextChunk(type, data);
    if (!parsed?.key) return;
    const existing = result[parsed.key];
    result[parsed.key] = existing ? `${existing}\n${parsed.value}` : parsed.value;
  });
  return result;
}

// ═══════════════════════════════════════════════════════════
// §5 — EXIF parsing
// ═══════════════════════════════════════════════════════════

const TIFF_TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readExifFieldBytes(view: DataView, entryOff: number, type: number, count: number, le: boolean): Uint8Array | null {
  const unit = TIFF_TYPE_SIZES[type];
  if (!unit || !Number.isFinite(count) || count <= 0) return null;
  const total = unit * count;
  if (!Number.isFinite(total) || total <= 0) return null;
  if (total <= 4) return new Uint8Array(view.buffer.slice(view.byteOffset + entryOff + 8, view.byteOffset + entryOff + 8 + total));
  const valOff = view.getUint32(entryOff + 8, le);
  if (valOff + total > view.byteLength) return null;
  return new Uint8Array(view.buffer.slice(view.byteOffset + valOff, view.byteOffset + valOff + total));
}

function decodeExifUserComment(bytes: Uint8Array, le: boolean): string {
  if (!bytes.length) return '';
  if (bytes.length >= 8) {
    const prefix = decodeLatin1(bytes.subarray(0, 8));
    const payload = bytes.subarray(8);
    if (prefix === 'ASCII\u0000\u0000\u0000') return decodeLatin1(payload).replace(/\0+$/g, '').trim();
    if (prefix === 'UNICODE\u0000') {
      try { return new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(payload).replace(/\0+$/g, '').trim(); }
      catch { return decodeUTF8(payload).replace(/\0+$/g, '').trim(); }
    }
  }
  return decodeUTF8(bytes).replace(/\0+$/g, '').trim() || decodeLatin1(bytes).replace(/\0+$/g, '').trim();
}

function parseExifIFD(view: DataView, ifdOff: number, le: boolean, sink: Record<string, string>, visited: Set<number>): void {
  if (!Number.isFinite(ifdOff) || ifdOff < 0 || ifdOff + 2 > view.byteLength || visited.has(ifdOff)) return;
  visited.add(ifdOff);
  const count = view.getUint16(ifdOff, le);
  for (let i = 0; i < count; i++) {
    const off = ifdOff + 2 + i * 12;
    if (off + 12 > view.byteLength) break;
    const tag = view.getUint16(off, le);
    const type = view.getUint16(off + 2, le);
    const cnt = view.getUint32(off + 4, le);
    if (tag === 0x8769 || tag === 0x8825) { parseExifIFD(view, view.getUint32(off + 8, le), le, sink, visited); continue; }
    const raw = readExifFieldBytes(view, off, type, cnt, le);
    if (!raw?.length) continue;
    if (tag === 0x010E && !sink.ImageDescription) { const v = (type === 2 ? decodeLatin1(raw) : decodeUTF8(raw)).replace(/\0+$/g, '').trim(); if (v) sink.ImageDescription = v; }
    if (tag === 0x9286 && !sink.UserComment) { const v = decodeExifUserComment(raw, le); if (v) sink.UserComment = v; }
    if (tag === 0x9C9C && !sink.XPComment) { try { const v = new TextDecoder('utf-16le').decode(raw).replace(/\0+$/g, '').trim(); if (v) sink.XPComment = v; } catch { /* ignore */ } }
  }
  const nextOff = ifdOff + 2 + count * 12;
  if (nextOff + 4 <= view.byteLength) { const next = view.getUint32(nextOff, le); if (next > 0) parseExifIFD(view, next, le, sink, visited); }
}

function extractExifMetadata(pngBytes: Uint8Array): Record<string, string> {
  const chunks: Uint8Array[] = [];
  iteratePngChunks(pngBytes, ({ type, data }) => { if (type === 'eXIf') chunks.push(data.slice()); });
  if (!chunks.length) return {};
  const result: Record<string, string> = {};
  for (const chunk of chunks) {
    if (chunk.length < 8) continue;
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const bo = view.getUint16(0, false);
    const le = bo === 0x4949;
    if (!le && bo !== 0x4D4D) continue;
    if (view.getUint16(2, le) !== 42) continue;
    const sink: Record<string, string> = {};
    parseExifIFD(view, view.getUint32(4, le), le, sink, new Set());
    if (sink.ImageDescription && !result.Description) result.Description = sink.ImageDescription;
    if (sink.UserComment && !result.Comment) result.Comment = sink.UserComment;
    else if (sink.XPComment && !result.Comment) result.Comment = sink.XPComment;
    Object.entries(sink).forEach(([k, v]) => { if (v && !result[k]) result[k] = v; });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════
// §6 — NovelAI stealth alpha
// ═══════════════════════════════════════════════════════════

const STEALTH_MAGIC = 'stealth_pngcomp';
const STEALTH_MAX_PIXELS = 4096 * 4096;

async function extractNovelAIStealthText(blob: Blob): Promise<string> {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return '';
  let objectUrl = '';
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load PNG image'));
      objectUrl = URL.createObjectURL(blob);
      img.src = objectUrl;
    });
    if (!image.width || !image.height || image.width * image.height > STEALTH_MAX_PIXELS) return '';
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return '';
    ctx.drawImage(image, 0, 0);
    const imageData = ctx.getImageData(0, 0, image.width, image.height);
    const alphaLsb = new Uint8Array(image.width * image.height);
    for (let px = 0; px < alphaLsb.length; px++) alphaLsb[px] = imageData.data[px * 4 + 3] & 1;

    let bitOffset = 0;
    const nextByte = (): number | null => {
      if (bitOffset + 8 > alphaLsb.length) return null;
      let byte = 0;
      for (let i = 0; i < 8; i++) {
        const converted = (bitOffset % image.height) * image.width + Math.floor(bitOffset / image.height);
        if (converted >= alphaLsb.length) return null;
        byte |= alphaLsb[converted] << (7 - i);
        bitOffset++;
      }
      return byte;
    };

    const magicBytes = new Uint8Array(STEALTH_MAGIC.length);
    for (let i = 0; i < magicBytes.length; i++) { const v = nextByte(); if (v === null) return ''; magicBytes[i] = v; }
    if (decodeLatin1(magicBytes) !== STEALTH_MAGIC) return '';

    const sizeBytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) { const v = nextByte(); if (v === null) return ''; sizeBytes[i] = v; }
    const compressedBitSize = new DataView(sizeBytes.buffer).getUint32(0, false);
    if (!Number.isFinite(compressedBitSize) || compressedBitSize <= 0 || compressedBitSize % 8 !== 0) return '';
    const compressedByteSize = compressedBitSize / 8;
    const compressed = new Uint8Array(compressedByteSize);
    for (let i = 0; i < compressedByteSize; i++) { const v = nextByte(); if (v === null) return ''; compressed[i] = v; }

    return decodeUTF8(inflateSync(compressed)).trim();
  } catch { return ''; }
  finally { if (objectUrl) URL.revokeObjectURL(objectUrl); }
}

// ═══════════════════════════════════════════════════════════
// §7 — NovelAI JSON + raw byte search
// ═══════════════════════════════════════════════════════════

function extractBalancedJSON(text: string, start: number): string {
  if (!text || start < 0 || text[start] !== '{') return '';
  let depth = 0; let inStr = false; let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (escaped) { escaped = false; continue; } if (ch === '\\') { escaped = true; continue; } if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return '';
}

function readFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) { const n = Number(v); if (Number.isFinite(n)) return n; }
  return undefined;
}

function readBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') { const n = v.trim().toLowerCase(); if (n === 'true') return true; if (n === 'false') return false; }
  return undefined;
}

function extractLoras(text: string): PngParsedParams['loras'] {
  const matches = Array.from((text || '').matchAll(/<lora:([^:>]+)(?::([\d.]+))?>/gi));
  if (!matches.length) return undefined;
  const items: Array<{ name: string; weight?: number }> = [];
  for (const m of matches) {
    const name = (m[1] || '').trim();
    if (!name) continue;
    const w = m[2] ? Number(m[2]) : undefined;
    items.push({ name, weight: Number.isFinite(w) ? w : undefined });
  }
  return items.length ? items : undefined;
}

function parseNovelAICommentJSON(rawText: string): { positive: string; negative: string; params?: PngParsedParams } | null {
  if (!rawText) return null;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(rawText) as Record<string, unknown>; } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const positive = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
  const negative = typeof parsed.uc === 'string' ? (parsed.uc as string).trim()
    : typeof parsed.negative_prompt === 'string' ? (parsed.negative_prompt as string).trim() : '';
  if (!positive && !negative) return null;
  const steps = readFiniteNumber(parsed.steps);
  const cfg = readFiniteNumber(parsed.scale ?? parsed.cfg_scale ?? parsed.cfg);
  const params: PngParsedParams = {
    sampler: typeof parsed.sampler === 'string' ? parsed.sampler.trim() || undefined : undefined,
    noiseSchedule: typeof parsed.noise_schedule === 'string' ? parsed.noise_schedule.trim() || undefined : undefined,
    steps: steps !== undefined ? Math.floor(steps) : undefined,
    cfgScale: cfg,
    cfgRescale: readFiniteNumber(parsed.cfg_rescale ?? parsed.prompt_guidance_rescale),
    unconditionalScale: readFiniteNumber(parsed.uncond_scale),
    clipSkip: (() => { const c = readFiniteNumber(parsed.clip_skip ?? parsed.clipSkip); return c !== undefined ? Math.floor(c) : undefined; })(),
    width: (() => { const w = readFiniteNumber(parsed.width); return w !== undefined ? Math.floor(w) : undefined; })(),
    height: (() => { const h = readFiniteNumber(parsed.height); return h !== undefined ? Math.floor(h) : undefined; })(),
    seed: (() => { const s = readFiniteNumber(parsed.seed); return s !== undefined ? Math.floor(s) : undefined; })(),
    smea: readBool(parsed.sm),
    smeaDynamic: readBool(parsed.sm_dyn),
    dynamicThresholding: readBool(parsed.dynamic_thresholding),
    preferBrownian: readBool(parsed.prefer_brownian),
    model: typeof parsed.model === 'string' ? parsed.model.trim() || undefined : undefined,
    loras: extractLoras(positive),
    rawParams: JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>,
  };
  return { positive, negative, params };
}

function tryParseNovelAIComment(rawText: string): { positive: string; negative: string; params?: PngParsedParams } | null {
  const direct = parseNovelAICommentJSON(rawText);
  if (direct) return direct;
  if (!rawText) return null;
  const firstBrace = rawText.indexOf('{');
  if (firstBrace < 0) return null;
  const candidate = extractBalancedJSON(rawText, firstBrace);
  return candidate ? parseNovelAICommentJSON(candidate) : null;
}

function searchNovelAIRawBytes(pngBytes: Uint8Array): { positive: string; negative: string; params?: PngParsedParams; raw: string } | null {
  const rawText = decodeLatin1(pngBytes);
  if (!rawText) return null;
  const markers = ['"request_type":"PromptGenerateRequest"', '"request_type": "PromptGenerateRequest"', '"signed_hash"', '"v4_negative_prompt"'];
  for (const marker of markers) {
    const idx = rawText.indexOf(marker);
    if (idx < 0) continue;
    let braceIdx = rawText.lastIndexOf('{', idx);
    let attempts = 0;
    while (braceIdx >= 0 && attempts < 12) {
      const candidate = extractBalancedJSON(rawText, braceIdx);
      if (candidate) {
        const parsed = parseNovelAICommentJSON(candidate);
        if (parsed?.positive) return { ...parsed, raw: candidate };
      }
      braceIdx = rawText.lastIndexOf('{', braceIdx - 1);
      attempts++;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// §8 — SD-WebUI parameter text parsing
// ═══════════════════════════════════════════════════════════

function parseSDParameterText(rawText: string): { positive: string; negative: string; params?: PngParsedParams } {
  const lines = (rawText || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const metaIdx = lines.findIndex((l) => /Steps\s*:\s*\d+/i.test(l) || /Sampler\s*:/i.test(l));
  const metaLine = metaIdx >= 0 ? lines[metaIdx] : '';
  const textLines = metaIdx >= 0 ? lines.slice(0, metaIdx) : lines;
  const negIdx = textLines.findIndex((l) => /^negative prompt\s*:/i.test(l));
  const positive = negIdx >= 0 ? textLines.slice(0, negIdx).join('\n').trim() : textLines.join('\n').trim();
  const negative = negIdx >= 0 ? textLines.slice(negIdx).join('\n').replace(/^negative prompt\s*:\s*/i, '').trim() : '';

  const getParam = (key: string): string => { const m = metaLine.match(new RegExp(`${key}\\s*:\\s*([^,]+)`, 'i')); return m?.[1]?.trim() ?? ''; };
  const steps = readFiniteNumber(getParam('Steps'));
  const cfg = readFiniteNumber(getParam('CFG scale'));
  const params: PngParsedParams = {
    sampler: getParam('Sampler') || undefined,
    steps: steps !== undefined ? Math.floor(steps) : undefined,
    cfgScale: cfg,
    seed: (() => { const s = readFiniteNumber(getParam('Seed')); return s !== undefined ? Math.floor(s) : undefined; })(),
    model: getParam('Model') || undefined,
    width: (() => { const m = getParam('Size').match(/(\d+)x(\d+)/); return m ? parseInt(m[1]) : undefined; })(),
    height: (() => { const m = getParam('Size').match(/(\d+)x(\d+)/); return m ? parseInt(m[2]) : undefined; })(),
    clipSkip: (() => { const c = readFiniteNumber(getParam('Clip skip')); return c !== undefined ? Math.floor(c) : undefined; })(),
    loras: extractLoras(positive),
  };
  return { positive, negative, params };
}

// ═══════════════════════════════════════════════════════════
// §9 — Main entry points
// ═══════════════════════════════════════════════════════════

function readMetadataField(map: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const direct = map[key];
    if (direct?.trim()) return direct.trim();
    const lower = Object.entries(map).find(([k]) => k.toLowerCase() === key.toLowerCase());
    if (lower?.[1]) return lower[1].trim();
  }
  return '';
}

/**
 * Extract metadata from raw PNG bytes.
 * Extract metadata from raw PNG bytes — ported
 */
function extractPngBytesMetadata(pngBytes: Uint8Array, extraNovelAIText = ''): PngMetadataResult {
  const tags = { ...extractExifMetadata(pngBytes), ...extractTextMetadata(pngBytes) };
  const parametersText = readMetadataField(tags, ['parameters', 'Parameters']);
  const commentText = readMetadataField(tags, ['comment', 'Comment', 'UserComment', 'XPComment']);
  const descriptionText = readMetadataField(tags, ['description', 'Description', 'ImageDescription']);

  // Try NovelAI JSON comment
  const naiCandidates = [commentText, extraNovelAIText].filter(Boolean);
  for (const candidate of naiCandidates) {
    const naiParsed = tryParseNovelAIComment(candidate);
    if (!naiParsed) continue;
    return {
      source: 'novelai',
      positive: naiParsed.positive || descriptionText || '',
      negative: naiParsed.negative || '',
      params: naiParsed.params,
      rawText: candidate || descriptionText || JSON.stringify(tags, null, 2),
      metadataTags: Object.keys(tags).length > 0 ? tags : undefined,
    };
  }

  // Try NovelAI raw byte search
  const rawNai = searchNovelAIRawBytes(pngBytes);
  if (rawNai) {
    return {
      source: 'novelai',
      positive: rawNai.positive || descriptionText || '',
      negative: rawNai.negative || '',
      params: rawNai.params,
      rawText: rawNai.raw || commentText || descriptionText || JSON.stringify(tags, null, 2),
      metadataTags: Object.keys(tags).length > 0 ? tags : undefined,
    };
  }

  // Try SD-WebUI parameters text
  if (parametersText) {
    const sdParsed = parseSDParameterText(parametersText);
    return {
      source: 'sd_webui',
      positive: sdParsed.positive,
      negative: sdParsed.negative,
      params: sdParsed.params,
      rawText: parametersText,
      metadataTags: Object.keys(tags).length > 0 ? tags : undefined,
    };
  }

  // Fallback
  const fallback = descriptionText || commentText || '';
  return {
    source: 'unknown',
    positive: fallback,
    negative: '',
    params: fallback ? { loras: extractLoras(fallback) } : undefined,
    rawText: fallback || JSON.stringify(tags, null, 2),
    metadataTags: Object.keys(tags).length > 0 ? tags : undefined,
  };
}

/**
 * Extract metadata from a PNG File/Blob (async — includes stealth alpha extraction).
 * Extract metadata from a PNG File/Blob — ported
 */
export async function extractPngMetadata(file: File | Blob): Promise<PngMetadataResult> {
  const buffer = await file.arrayBuffer();
  const pngBytes = new Uint8Array(buffer);
  const stealthText = await extractNovelAIStealthText(file);
  return extractPngBytesMetadata(pngBytes, stealthText);
}
