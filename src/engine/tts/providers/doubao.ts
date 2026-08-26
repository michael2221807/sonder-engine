// App doc: docs/user-guide/pages/game-main.md §3.13 (配音 · 配音服务商)
/**
 * Doubao voice (豆包语音, Volcano) TTS provider — epic P2, calibrated against
 * the Agent Plan live endpoints 2026-08-27.
 *
 * Protocol: 大模型语音合成 WebSocket 单向流式 V3 —
 *   WSS {endpoint}{routingPath || '/api/v3/plan/tts/unidirectional/stream'}
 *       ?api_key=<key>&api_resource_id=<resourceId>
 *   One session-less full-client frame carrying
 *   { user, req_params: { text, speaker, audio_params } }; the server streams
 *   audio-only frames (mp3 fragments) plus TTSSentenceStart/End events and
 *   ends with SessionFinished (152).
 *
 * Live findings that shaped this implementation (2026-08-27, plan key):
 * - The HTTP chunked variant (/plan/tts/unidirectional) accepts the request
 *   and replies OK but streams ZERO audio frames — server-side dead for plan
 *   accounts, hence WebSocket here.
 * - Auth via `?api_key=` query + resource id via `?api_resource_id=` query are
 *   both live-verified; this matters because a browser WebSocket cannot set
 *   custom headers at all (and openspeech's CORS allow-list would block
 *   X-Api-Key on the HTTP paths anyway).
 * - `seed-tts-2.0` only voices the `*_uranus_bigtts` 2.0 series; the sample
 *   list below is the set that actually produced audio in the live sweep.
 * - WebSocket needs no CORS preflight → fully browser-usable.
 *
 * The same provider serves non-plan (standalone 豆包语音 console) accounts by
 * overriding the routing path to '/api/v3/tts/unidirectional/stream'.
 *
 * No transport-level streaming for <audio>: the audio arrives over WS frames
 * → getStreamUrl() returns null and playback falls back to the buffered modes
 * (design D6).
 */
import { BaseTtsProvider, TTS_SYNTHESIZE_TIMEOUT_MS } from './base';
import type { TtsBackendType, TtsSynthesizeOptions, TtsSpeaker } from '../types';
import {
  buildFullClientFrame,
  parseServerFrame,
  toWebSocketUrl,
  DOUBAO_WS_EVENT,
} from '../../providers/doubao-ws-protocol';

export const DOUBAO_TTS_DEFAULT_PATH = '/api/v3/plan/tts/unidirectional/stream';
export const DOUBAO_TTS_DEFAULT_RESOURCE_ID = 'seed-tts-2.0';

/**
 * Built-in speakers — every id below produced real audio in the 2026-08-27
 * live sweep against seed-tts-2.0 (10 中文 uranus 2.0 音色; the English ones
 * from the same series stayed silent on Chinese text and are excluded).
 */
export const DOUBAO_SAMPLE_SPEAKERS: TtsSpeaker[] = [
  { name: '爽快思思 2.0', voiceId: 'zh_female_shuangkuaisisi_uranus_bigtts' },
  { name: '知性灿灿 2.0', voiceId: 'zh_female_cancan_uranus_bigtts' },
  { name: '甜美小源 2.0', voiceId: 'zh_female_tianmeixiaoyuan_uranus_bigtts' },
  { name: 'Vivi 2.0', voiceId: 'zh_female_vv_uranus_bigtts' },
  { name: '小何 2.0', voiceId: 'zh_female_xiaohe_uranus_bigtts' },
  { name: '暖阳女声 2.0', voiceId: 'zh_female_kefunvsheng_uranus_bigtts' },
  { name: '佩奇猪 2.0', voiceId: 'zh_female_peiqi_uranus_bigtts' },
  { name: '云舟 2.0', voiceId: 'zh_male_m191_uranus_bigtts' },
  { name: '小天 2.0', voiceId: 'zh_male_taocheng_uranus_bigtts' },
  { name: '儒雅逸辰 2.0', voiceId: 'zh_male_ruyayichen_uranus_bigtts' },
];

export class DoubaoTtsProvider extends BaseTtsProvider {
  readonly backend: TtsBackendType = 'doubao';

  constructor(
    endpoint: string,
    apiKey: string,
    private customPath?: string,
    private credentials: Record<string, string> = {},
  ) {
    super(endpoint, apiKey, customPath);
  }

  private synthesizeUrl(): string {
    // `customPath` keeps the caller's original value: BaseTtsProvider defaults
    // this.routingPath to '/' (CosyVoice's real synth path), which would be
    // indistinguishable from "not customized" here (review Minor 2026-08-26).
    const raw = this.customPath?.trim();
    const path = raw ? (raw.startsWith('/') ? raw : '/' + raw) : DOUBAO_TTS_DEFAULT_PATH;
    const resourceId = this.credentials.resourceId?.trim() || DOUBAO_TTS_DEFAULT_RESOURCE_ID;
    // Key + resource id via query — the only auth a browser WebSocket can carry.
    return `${toWebSocketUrl(this.baseUrl)}${path}`
      + `?api_key=${encodeURIComponent(this.apiKey)}`
      + `&api_resource_id=${encodeURIComponent(resourceId)}`;
  }

  private requestSynthesis(text: string, speaker: string, signal: AbortSignal): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.synthesizeUrl());
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      ws.binaryType = 'arraybuffer';
      const chunks: Uint8Array[] = [];
      let settled = false;
      const finish = (result: Blob | Error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        try { ws.close(); } catch { /* already closed */ }
        if (result instanceof Error) reject(result); else resolve(result);
      };
      const onAbort = () => finish(new Error('[Doubao TTS] aborted'));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });

      ws.onerror = () => finish(new Error('[Doubao TTS] WebSocket 连接失败（检查 URL/网络）'));
      ws.onopen = () => {
        ws.send(buildFullClientFrame({
          user: { uid: 'aga' },
          req_params: {
            text,
            speaker,
            audio_params: { format: 'mp3', sample_rate: 24000 },
          },
        }));
      };
      ws.onmessage = (evt: MessageEvent) => {
        if (!(evt.data instanceof ArrayBuffer)) return;
        const frame = parseServerFrame(new Uint8Array(evt.data));
        if (!frame) return;
        if (frame.errorCode !== undefined) {
          finish(new Error(`[Doubao TTS] server error ${frame.errorCode}: ${(frame.errorMessage ?? '').slice(0, 200)}`));
          return;
        }
        if (frame.audio && frame.audio.length > 0) {
          // Copy — the subarray aliases the (reusable) event buffer.
          chunks.push(new Uint8Array(frame.audio));
          return;
        }
        if (frame.event === DOUBAO_WS_EVENT.SessionFailed) {
          finish(new Error(`[Doubao TTS] session failed: ${JSON.stringify(frame.json ?? {}).slice(0, 200)}`));
          return;
        }
        if (frame.event === DOUBAO_WS_EVENT.SessionFinished) {
          if (chunks.length === 0) {
            finish(new Error('[Doubao TTS] empty audio in response（检查音色是否为 2.0 uranus 系）'));
            return;
          }
          const total = chunks.reduce((n, c) => n + c.length, 0);
          const out = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) { out.set(c, off); off += c.length; }
          finish(new Blob([out], { type: 'audio/mpeg' }));
        }
      };
      ws.onclose = () => finish(new Error('[Doubao TTS] 连接提前关闭（会话未完成）'));
    });
  }

  async synthesize(text: string, options: TtsSynthesizeOptions): Promise<Blob> {
    // `instruct` has no Doubao equivalent (CosyVoice-specific natural-language
    // style hint) — ignored by design; the voice character lives in voice_type.
    const { signal, cleanup } = this.withTimeout(options.signal, TTS_SYNTHESIZE_TIMEOUT_MS);
    try {
      return await this.requestSynthesis(text, options.speaker, signal);
    } finally {
      cleanup();
    }
  }

  /** Audio arrives over WS frames — nothing an <audio> URL could stream. */
  getStreamUrl(): string | null {
    return null;
  }

  async listSpeakers(): Promise<TtsSpeaker[]> {
    return [...DOUBAO_SAMPLE_SPEAKERS];
  }

  async testConnection(opts?: { speaker?: string; signal?: AbortSignal }): Promise<{ ok: boolean; error?: string }> {
    const { signal, cleanup } = this.withTimeout(opts?.signal, 15_000);
    try {
      // Real single-character synthesis — per-character billing makes this a
      // ~1-char probe while proving the full auth + resource + voice chain.
      const speaker = opts?.speaker || DOUBAO_SAMPLE_SPEAKERS[0].voiceId;
      const blob = await this.requestSynthesis('好', speaker, signal);
      return { ok: blob.size > 0, error: blob.size > 0 ? undefined : '响应无音频数据' };
    } catch (err) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 160) };
    } finally {
      cleanup();
    }
  }
}
