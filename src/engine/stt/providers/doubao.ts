// App doc: docs/user-guide/pages/game-main.md §3.14 (语音输入 · 听写服务商)
/**
 * Doubao voice (豆包语音, Volcano) STT provider — epic P3, non-streaming.
 *
 * Protocol: 大模型录音文件识别·极速版 (flash) —
 *   POST {endpoint}{routingPath || '/api/v3/auc/bigmodel/recognize/flash'}
 *   Headers: X-Api-App-Key / X-Api-Access-Key / X-Api-Resource-Id +
 *   X-Api-Request-Id + X-Api-Sequence: -1. Success is signalled by the
 *   X-Api-Status-Code response header (20000000).
 *   Body: { user: { uid }, audio: { format, data: <base64> }, request: { model_name: 'bigmodel', enable_itn: true } }
 *
 * CORS verified reachable from browser origins (research doc §3.2).
 *
 * ⚠ Transcribed from official docs without a live round-trip (credentials
 * pending from the PO) — `parseDoubaoSttResponse` digs for text defensively
 * and MUST be validated during P3 acceptance. Known open risk (recorded in
 * the design doc): MediaRecorder produces webm/opus; whether flash accepts it
 * needs the real-credential test, else the recorder needs a wav path.
 *
 * Streaming dictation (wss binary protocol) is deliberately NOT implemented
 * (design D6 / backlog); the descriptor declares sttStreaming:false so the
 * live-dictation entry point auto-hides for this backend (capability gate).
 */
import { BaseSttProvider, STT_TRANSCRIBE_TIMEOUT_MS } from './base';
import type { SttBackendType, SttTranscribeOptions, SttResult } from '../types';

export const DOUBAO_STT_DEFAULT_PATH = '/api/v3/auc/bigmodel/recognize/flash';

/** Map a recording MIME type onto the API's `format` field (best-effort). */
export function doubaoAudioFormat(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('wav')) return 'wav';
  if (m.includes('mp3') || m.includes('mpeg')) return 'mp3';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('webm')) return 'webm';
  return 'wav';
}

/**
 * Extract the transcript from a flash response body. Documented shape is
 * `result.text` (with optional utterances); dig defensively. Pure for tests.
 */
export function parseDoubaoSttResponse(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const obj = data as { result?: unknown; text?: unknown };
  if (typeof obj.text === 'string') return obj.text;
  const result = obj.result as { text?: unknown; utterances?: unknown } | undefined;
  if (result && typeof result === 'object') {
    if (typeof result.text === 'string') return result.text;
    if (Array.isArray(result.utterances)) {
      return result.utterances
        .map((u) => (u && typeof u === 'object' && typeof (u as { text?: unknown }).text === 'string')
          ? (u as { text: string }).text : '')
        .join('');
    }
  }
  return '';
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export class DoubaoSttProvider extends BaseSttProvider {
  readonly backend: SttBackendType = 'doubao';

  constructor(
    endpoint: string,
    apiKey: string,
    routingPath?: string,
    private credentials: Record<string, string> = {},
  ) {
    super(endpoint, apiKey, routingPath);
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Api-App-Key': this.credentials.appId ?? '',
      'X-Api-Access-Key': this.credentials.accessToken ?? this.apiKey,
      'X-Api-Resource-Id': this.credentials.resourceId ?? '',
      'X-Api-Request-Id': (globalThis.crypto?.randomUUID?.() ?? `aga-${Date.now()}-${Math.random().toString(36).slice(2)}`),
      'X-Api-Sequence': '-1',
    };
  }

  private transcribeUrl(): string {
    const path = this.routingPath?.trim() || DOUBAO_STT_DEFAULT_PATH;
    return `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`;
  }

  async transcribe(blob: Blob, options?: SttTranscribeOptions): Promise<SttResult> {
    // hotwords: FunASR-specific (CosyVoice backend) — no flash equivalent; ignored.
    const { signal, cleanup } = this.withTimeout(options?.signal, STT_TRANSCRIBE_TIMEOUT_MS);
    try {
      const res = await fetch(this.transcribeUrl(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          user: { uid: 'aga' },
          audio: { format: doubaoAudioFormat(blob.type), data: await blobToBase64(blob) },
          request: { model_name: 'bigmodel', enable_itn: true },
        }),
        signal,
      });
      const statusCode = res.headers.get('X-Api-Status-Code') ?? '';
      if (!res.ok || (statusCode && statusCode !== '20000000')) {
        const msg = res.headers.get('X-Api-Message') ?? (await res.text().catch(() => '')).slice(0, 160);
        throw new Error(`[Doubao STT] transcribe failed ${res.status}${statusCode ? `/${statusCode}` : ''}: ${msg}`);
      }
      const data: unknown = await res.json().catch(() => null);
      return { text: parseDoubaoSttResponse(data) };
    } finally {
      cleanup();
    }
  }

  /**
   * Free-ish probe: an empty-audio request is rejected at validation, which
   * still proves endpoint + credentials; explicit auth errors report false.
   */
  async testConnection(opts?: { signal?: AbortSignal }): Promise<{ ok: boolean; error?: string }> {
    const { signal, cleanup } = this.withTimeout(opts?.signal, 10_000);
    try {
      const res = await fetch(this.transcribeUrl(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ user: { uid: 'aga' }, audio: { format: 'wav', data: '' }, request: { model_name: 'bigmodel' } }),
        signal,
      });
      const statusCode = res.headers.get('X-Api-Status-Code') ?? '';
      if (statusCode === '20000000') return { ok: true };
      // Documented auth-failure family is 401/403 at HTTP level or 45xxxxxx
      // status codes; parameter complaints mean we got past auth.
      if (res.status === 401 || res.status === 403 || statusCode.startsWith('45')) {
        const msg = res.headers.get('X-Api-Message') ?? `HTTP ${res.status}`;
        return { ok: false, error: `认证失败: ${msg}`.slice(0, 160) };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 160) };
    } finally {
      cleanup();
    }
  }
}
