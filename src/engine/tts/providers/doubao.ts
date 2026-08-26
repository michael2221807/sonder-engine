// App doc: docs/user-guide/pages/game-main.md §3.13 (配音 · 配音服务商)
/**
 * Doubao voice (豆包语音, Volcano) TTS provider — epic P2.
 *
 * Protocol: 大模型语音合成 HTTP 单向流式 V3 —
 *   POST {endpoint}{routingPath || '/api/v3/tts/unidirectional'}
 *   Headers: X-Api-Key (新版控制台单 API Key 鉴权, live-verified 2026-08-27)
 *   + X-Api-Resource-Id (per model, e.g. volc.service_type.10029 / seed-tts-2.0)
 *   + X-Api-Request-Id.
 *   Body: { req_params: { text, speaker, audio_params: { format, sample_rate } } }
 *   Response: chunked JSON lines, each carrying a base64 `data` audio fragment;
 *   fragments concatenate into one MP3.
 *
 * CORS verified reachable from browser origins (research doc §3.2, curl probe
 * 2026-08-26: ACAO * + X-Api-* headers allowed).
 *
 * ⚠ Field-level protocol details are transcribed from the official docs
 * (volcengine.com/docs/6561) WITHOUT a live round-trip — the PO has not yet
 * provided Doubao voice credentials. `parseDoubaoTtsBody` is deliberately
 * defensive (collects every base64 `data` field on any non-error line) and
 * MUST be validated against a real response during P2 acceptance.
 *
 * No transport-level streaming for `<audio>`: the endpoint needs POST +
 * credential headers, which an audio element cannot send → getStreamUrl()
 * returns null and playback falls back to the existing pseudo/full buffered
 * modes (design D6).
 */
import { BaseTtsProvider, TTS_SYNTHESIZE_TIMEOUT_MS } from './base';
import type { TtsBackendType, TtsSynthesizeOptions, TtsSpeaker } from '../types';

export const DOUBAO_TTS_DEFAULT_PATH = '/api/v3/tts/unidirectional';

/**
 * Built-in speaker candidates (documented sample voice_types; the service has
 * no listing endpoint — descriptor declares speakerListing:false). Users can
 * type any voice_type their console shows. VERIFY ids during P2 acceptance.
 */
export const DOUBAO_SAMPLE_SPEAKERS: TtsSpeaker[] = [
  { name: '灿灿', voiceId: 'zh_female_cancan_mars_bigtts' },
  { name: '爽快思思', voiceId: 'zh_female_shuangkuaisisi_moon_bigtts' },
  { name: '温暖阿虎', voiceId: 'zh_male_wennuanahu_moon_bigtts' },
  { name: '少年梓辛', voiceId: 'zh_male_shaonianzixin_moon_bigtts' },
];

/**
 * Parse a unidirectional-TTS response body: one JSON object per line, audio
 * fragments in base64 `data` fields. Error lines (code present and non-zero
 * beyond the terminal sentinel) surface as an Error; malformed lines are
 * skipped. Pure — unit-tested without network.
 */
export function parseDoubaoTtsBody(body: string): Uint8Array {
  const fragments: Uint8Array[] = [];
  let total = 0;
  for (const line of body.split('\n')) {
    const trimmed = line.trim().replace(/^data:\s*/, '');
    if (!trimmed || trimmed === '[DONE]') continue;
    let obj: {
      code?: unknown; data?: unknown; message?: unknown;
      header?: { code?: unknown; message?: unknown };
    };
    try {
      obj = JSON.parse(trimmed) as typeof obj;
    } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    // Status may sit at the top level OR nested under `header` — the nested
    // form is live-verified (2026-08-27 error frames look like
    // {"header":{"reqid":…,"code":45000030,"message":"…"}}).
    const rawCode = typeof obj.code === 'number' ? obj.code
      : typeof obj.header?.code === 'number' ? obj.header.code : 0;
    // 0 = data frame; 20000000 = documented terminal OK sentinel. Anything
    // else with a message is an error frame.
    if (rawCode !== 0 && rawCode !== 20000000) {
      const msg = typeof obj.message === 'string' ? obj.message
        : typeof obj.header?.message === 'string' ? obj.header.message : `code ${rawCode}`;
      throw new Error(`[Doubao TTS] server error ${rawCode}: ${msg}`);
    }
    if (typeof obj.data === 'string' && obj.data.length > 0) {
      try {
        const bin = atob(obj.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        fragments.push(bytes);
        total += bytes.length;
      } catch { /* not base64 — skip the frame */ }
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const f of fragments) { out.set(f, offset); offset += f.length; }
  return out;
}

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

  private headers(): Record<string, string> {
    // 新版控制台单 API Key 鉴权 — the key travels as the `api_key` QUERY
    // parameter (see synthesizeUrl), NOT a header: live-verified 2026-08-27
    // that `?api_key=` reaches the grant stage, while the `X-Api-Key` header
    // (though accepted by curl) is missing from openspeech's CORS
    // allow-headers list → browser preflight fails. The X-Api-* headers below
    // ARE allow-listed.
    return {
      'Content-Type': 'application/json',
      'X-Api-Resource-Id': this.credentials.resourceId ?? '',
      'X-Api-Request-Id': (globalThis.crypto?.randomUUID?.() ?? `aga-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    };
  }

  private synthesizeUrl(): string {
    // `customPath` keeps the caller's original value: BaseTtsProvider defaults
    // this.routingPath to '/' (CosyVoice's real synth path), which would be
    // indistinguishable from "not customized" here (review Minor 2026-08-26).
    const raw = this.customPath?.trim();
    const path = raw ? (raw.startsWith('/') ? raw : '/' + raw) : DOUBAO_TTS_DEFAULT_PATH;
    // API key via query — browser-compatible auth (see headers() note).
    return `${this.baseUrl}${path}?api_key=${encodeURIComponent(this.apiKey)}`;
  }

  private async requestSynthesis(text: string, speaker: string, signal: AbortSignal): Promise<Blob> {
    const res = await fetch(this.synthesizeUrl(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        req_params: {
          text,
          speaker,
          audio_params: { format: 'mp3', sample_rate: 24000 },
        },
      }),
      signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(`[Doubao TTS] synthesize failed ${res.status}: ${errText.slice(0, 160)}`);
    }
    const bytes = parseDoubaoTtsBody(await res.text());
    if (bytes.length === 0) throw new Error('[Doubao TTS] empty audio in response');
    return new Blob([bytes], { type: 'audio/mpeg' });
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

  /** POST + credential headers can't feed an <audio> URL → no transport streaming. */
  getStreamUrl(): string | null {
    return null;
  }

  async listSpeakers(): Promise<TtsSpeaker[]> {
    return [...DOUBAO_SAMPLE_SPEAKERS];
  }

  async testConnection(opts?: { speaker?: string; signal?: AbortSignal }): Promise<{ ok: boolean; error?: string }> {
    const { signal, cleanup } = this.withTimeout(opts?.signal, 15_000);
    try {
      const speaker = opts?.speaker || DOUBAO_SAMPLE_SPEAKERS[0].voiceId;
      const blob = await this.requestSynthesis('test', speaker, signal);
      return { ok: blob.size > 0, error: blob.size > 0 ? undefined : '响应无音频数据' };
    } catch (err) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 160) };
    } finally {
      cleanup();
    }
  }
}
