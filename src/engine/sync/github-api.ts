/**
 * Plumbing of the GitHub sync service: the API error type, stage-error wrapping,
 * the per-upload generation tag and the base64 helpers. Moved out of github-sync.ts
 * (R6 step 5), unchanged. Leaf module (no imports).
 */

export class ApiError extends Error {
  constructor(public status: number, body: string) {
    super(`GitHub API ${status}: ${body.slice(0, 300)}`);
  }
}

export function fmtErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Per-upload generation tag. Chunk filenames are suffixed with it so each upload
 * writes to fresh paths and never overwrites a chunk the current cloud manifest
 * still references — the property that makes "manifest written last" atomic.
 * Timestamp + a small random suffix keeps it unique even for two uploads in the
 * same millisecond.
 */
export function uploadGenTag(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')}`;
}

/** Insert the generation tag before the `.gz` extension: `v2/state-0.gz` → `v2/state-0.<tag>.gz`. */
export function withGenTag(path: string, tag: string): string {
  return path.replace(/\.gz$/, `.${tag}.gz`);
}

/**
 * Wrap a stage failure so the surfaced message names the failing step.
 *
 * `fetch()` (and `Response.blob()` over a failed CompressionStream) throws a
 * bare `TypeError: Failed to fetch` with no HTTP status and no Network-tab
 * entry — useless on its own. Prefixing the stage + a likely-cause hint turns
 * it into something actionable, while preserving the original stack.
 */
export function stageError(stage: string, err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const hint = /failed to fetch/i.test(raw)
    ? '（网络中断、被浏览器/扩展拦截，或存档过大导致内存不足）'
    : '';
  const wrapped = new Error(`${stage}失败：${raw}${hint}`);
  if (err instanceof Error && err.stack) wrapped.stack = err.stack;
  return wrapped;
}

export function utf8ToBase64(str: string): string {
  return bytesToBase64(new TextEncoder().encode(str));
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const cleaned = b64.replace(/\s/g, '');
  const bin = atob(cleaned);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function safeBody(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}
