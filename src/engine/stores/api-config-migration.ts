/**
 * One-time (idempotent) API-config normalization — epic P0, design doc §3.6.
 *
 * Backfills the persisted `backend` field on non-llm configs saved before the
 * provider catalog existed. Runs at every load point of `aga_api_management`
 * (cold start, backup import reload, JSON import) so old localStorage, old
 * backups and old export files all converge without a separate migration step.
 *
 * Deliberately does NOT touch assignments or assignment presets: the
 * per-backend assignment rows are the product's multi-config switcher
 * (PO clarification 2026-08-26) and stay byte-identical.
 */
import type { APIConfig } from '../ai/types';

/**
 * Infer image backend from a config URL — moved here from ai-service.ts where
 * it once served runtime routing and UI preset re-selection. Post-P0 the
 * user's explicit backend choice is persisted, so URL sniffing survives ONLY
 * as this migration's one-shot backfill for pre-P0 configs. Do not re-export.
 */
function inferImageBackendFromUrl(url: string): string {
  if (url.includes('orchestration.civitai.com')) return 'civitai';
  if (url.includes('api.openai.com')) return 'openai';
  if (url.includes('image.novelai.net')) return 'novelai';
  try {
    const hostname = new URL(url).hostname;
    if (hostname.endsWith('.novelai.net')) return 'novelai';
  } catch { /* invalid URL — fall through */ }
  if (url.includes(':8188')) return 'comfyui';
  if (url.includes(':7860')) return 'sd_webui';
  return '';
}

export interface NormalizeApiConfigsResult {
  configs: APIConfig[];
  changed: boolean;
}

/**
 * Pure: returns a new array (rows are copied only when modified).
 *
 * - image configs without `backend`: inferred from URL — the URL sniffer's
 *   final act of service; unrecognized URLs get `'custom'` (UI prompts the
 *   user to pick, matching the pre-migration edit-modal behavior).
 * - tts/stt configs without `backend`: `'cosyvoice'` (the only backend that
 *   could have produced them).
 * - llm/embedding/rerank rows and already-normalized rows pass through
 *   untouched; malformed rows are left as-is (loadFromStorage's existing
 *   guards own that concern).
 */
export function normalizeApiManagementState(configs: APIConfig[]): NormalizeApiConfigsResult {
  let changed = false;
  const out = configs.map((cfg) => {
    if (!cfg || typeof cfg !== 'object') return cfg;
    if (typeof cfg.backend === 'string' && cfg.backend.length > 0) return cfg;
    const category = cfg.apiCategory ?? 'llm';
    if (category === 'image') {
      const inferred = inferImageBackendFromUrl(typeof cfg.url === 'string' ? cfg.url : '');
      changed = true;
      return { ...cfg, backend: inferred || 'custom' };
    }
    if (category === 'tts' || category === 'stt') {
      changed = true;
      return { ...cfg, backend: 'cosyvoice' };
    }
    return cfg;
  });
  return { configs: out, changed };
}
