// App doc: docs/user-guide/pages/game-main.md §3.14 (语音输入 · 听写服务商)
/**
 * Doubao voice (豆包语音, Volcano) STT provider — epic P3, calibrated against
 * the Agent Plan live endpoints 2026-08-27.
 *
 * Protocol: 大模型流式语音识别 (sauc) WebSocket V3 —
 *   WSS {endpoint}{routingPath || '/api/v3/plan/sauc/bigmodel_nostream'}
 *       ?api_key=<key>&api_resource_id=<resourceId>
 *   Client sends one full request (seq 1) with
 *   { user, audio: { format:'wav', rate:16000, … }, request:{ model_name:'bigmodel' } },
 *   then audio-only frames (negative sequence on the last one). The server
 *   replies with full-response frames whose payload carries result.text — for
 *   bigmodel_nostream only the terminal frame holds the transcript.
 *
 * Live findings that shaped this implementation (2026-08-27, plan key):
 * - The Agent Plan gateway has NO flash (file-recognition) HTTP endpoint —
 *   `/api/v3/plan/auc/...` 404s; sauc WebSocket is the only plan ASR surface,
 *   which is why this provider is WS despite design D6 deferring streaming
 *   dictation UX (the recorded-blob flow below is still non-streaming UX).
 * - `?api_key=` + `?api_resource_id=` query auth live-verified (browser
 *   WebSocket cannot set headers; WS needs no CORS preflight → browser-safe).
 * - Round-trip verified: plan TTS audio fed back through this protocol
 *   returned the exact source text.
 *
 * MediaRecorder emits webm/opus; blobToWav16kMono decodes + resamples to the
 * 16 kHz mono WAV the request declares. WAV input passes through untouched.
 */
import { BaseSttProvider, STT_TRANSCRIBE_TIMEOUT_MS } from './base';
import type { SttBackendType, SttTranscribeOptions, SttResult } from '../types';
import { blobToWav16kMono, pcm16ToWav, STT_TARGET_SAMPLE_RATE } from '../audio-transcode';
import {
  buildFullClientFrame,
  buildAudioClientFrame,
  parseServerFrame,
  toWebSocketUrl,
} from '../../providers/doubao-ws-protocol';

export const DOUBAO_STT_DEFAULT_PATH = '/api/v3/plan/sauc/bigmodel_nostream';
export const DOUBAO_STT_DEFAULT_RESOURCE_ID = 'volc.seedasr.sauc.duration';

/** Upload chunk size (bytes) — ~200ms of 16k s16le audio per frame. */
const AUDIO_CHUNK_BYTES = 6400;

/** Dig the transcript out of a sauc payload. Pure for tests. */
export function extractSaucText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const result = (payload as { result?: unknown }).result;
  if (!result || typeof result !== 'object') return '';
  const r = result as { text?: unknown; utterances?: unknown };
  if (typeof r.text === 'string' && r.text.length > 0) return r.text;
  if (Array.isArray(r.utterances)) {
    return r.utterances
      .map((u) => (u && typeof u === 'object' && typeof (u as { text?: unknown }).text === 'string')
        ? (u as { text: string }).text : '')
      .join('');
  }
  return '';
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

  private transcribeUrl(): string {
    const raw = this.routingPath?.trim();
    const path = raw ? (raw.startsWith('/') ? raw : '/' + raw) : DOUBAO_STT_DEFAULT_PATH;
    const resourceId = this.credentials.resourceId?.trim() || DOUBAO_STT_DEFAULT_RESOURCE_ID;
    return `${toWebSocketUrl(this.baseUrl)}${path}`
      + `?api_key=${encodeURIComponent(this.apiKey)}`
      + `&api_resource_id=${encodeURIComponent(resourceId)}`;
  }

  /** Open the socket, stream `wav`, resolve with the final transcript. */
  private streamRecognition(wav: Uint8Array, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.transcribeUrl());
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      ws.binaryType = 'arraybuffer';
      let latestText = '';
      let settled = false;
      const finish = (result: string | Error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        try { ws.close(); } catch { /* already closed */ }
        if (result instanceof Error) reject(result); else resolve(result);
      };
      const onAbort = () => finish(new Error('[Doubao STT] aborted'));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });

      ws.onerror = () => finish(new Error('[Doubao STT] WebSocket 连接失败（检查 URL/API Key/网络）'));
      ws.onopen = () => {
        ws.send(buildFullClientFrame({
          user: { uid: 'aga' },
          audio: { format: 'wav', codec: 'raw', rate: STT_TARGET_SAMPLE_RATE, bits: 16, channel: 1 },
          request: { model_name: 'bigmodel', enable_punc: true },
        }, 1));
        let seq = 1;
        for (let i = 0; i < wav.length; i += AUDIO_CHUNK_BYTES) {
          seq += 1;
          const last = i + AUDIO_CHUNK_BYTES >= wav.length;
          ws.send(buildAudioClientFrame(wav.subarray(i, i + AUDIO_CHUNK_BYTES), seq, last));
        }
      };
      ws.onmessage = (evt: MessageEvent) => {
        if (!(evt.data instanceof ArrayBuffer)) return;
        const frame = parseServerFrame(new Uint8Array(evt.data));
        if (!frame) return;
        if (frame.errorCode !== undefined) {
          finish(new Error(`[Doubao STT] server error ${frame.errorCode}: ${(frame.errorMessage ?? '').slice(0, 200)}`));
          return;
        }
        const text = extractSaucText(frame.json);
        if (text) latestText = text;
        // Terminal frame: negative sequence OR the last-packet flag bit (the
        // live server set the flag while keeping the sequence positive).
        if ((frame.sequence !== undefined && frame.sequence < 0) || (frame.flags & 0b0010) !== 0) finish(latestText);
      };
      // bigmodel_nostream closes normally ("finish last sequence") right after
      // the terminal frame — the close is an alternate success signal.
      ws.onclose = () => finish(latestText);
    });
  }

  async transcribe(blob: Blob, options?: SttTranscribeOptions): Promise<SttResult> {
    // hotwords: FunASR-specific (CosyVoice backend) — no sauc equivalent; ignored.
    const { signal, cleanup } = this.withTimeout(options?.signal, STT_TRANSCRIBE_TIMEOUT_MS);
    try {
      const wav = await blobToWav16kMono(blob);
      return { text: await this.streamRecognition(wav, signal) };
    } finally {
      cleanup();
    }
  }

  /**
   * Cheap probe: a header-only WAV (no samples) exercises handshake + auth +
   * resource grant; an empty transcript back is success, an auth-family error
   * (or a rejected handshake, surfacing as onerror) reports false.
   */
  async testConnection(opts?: { signal?: AbortSignal }): Promise<{ ok: boolean; error?: string }> {
    const { signal, cleanup } = this.withTimeout(opts?.signal, 10_000);
    try {
      const silent = new Int16Array(STT_TARGET_SAMPLE_RATE / 10); // 100ms of silence
      await this.streamRecognition(pcm16ToWav(silent, STT_TARGET_SAMPLE_RATE), signal);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 160) };
    } finally {
      cleanup();
    }
  }
}
