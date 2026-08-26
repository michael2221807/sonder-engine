// App doc: docs/user-guide/pages/game-main.md §3.14 (语音输入 · STT)
/**
 * CosyVoice STT provider (SenseVoiceSmall via the CosyVoice native server).
 *
 * Real contract (probed against a live CosyVoice3 build @ localhost:9880, 2026-08-01;
 * see docs/design/stt-voice-input-handoff.md §2):
 *   - Transcribe: POST {endpoint}{routingPath} (multipart/form-data)
 *       fields: file (audio, any common format — server ffmpeg → 16k mono wav),
 *               language (optional, default 'auto'), response_format ('json' default)
 *       → 200 { "text": "已清洗文本", "raw_text": "原始富文本(含情绪 emoji)" }
 *   - Errors: 400 {"error":"..."} (missing file) / 500 {"error":"..."} (convert/infer fail)
 *   - CORS: flask_cors 全开;github.io 源可直连 localhost。
 *   - 首次请求懒加载模型 (+12s);之后热态 <1s。CPU,与 TTS(GPU) 并发不抢占。
 */
import { BaseSttProvider, STT_TRANSCRIBE_TIMEOUT_MS } from './base';
import { DEFAULT_STT_ROUTING_PATH } from '../types';
import type { SttBackendType, SttTranscribeOptions, SttResult } from '../types';

export class CosyVoiceSttProvider extends BaseSttProvider {
  readonly backend: SttBackendType = 'cosyvoice';

  /** 构造转写 URL(纯函数式,便于测试断言) */
  buildTranscribeUrl(): string {
    const path = this.routingPath?.trim() || DEFAULT_STT_ROUTING_PATH;
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${normalized}`;
  }

  /**
   * 连测探针 — 迁自 AIService.testConnection 的 stt 分支(epic P0 连测委托)。
   * 转写端点要真实音频,连测改探健康端点 GET / → JSON status:'ok'(与 TTS 共用
   * 同一 CosyVoice 服务;判活即可,避免连测时空录音)。
   */
  async testConnection(opts?: { signal?: AbortSignal }): Promise<{ ok: boolean; error?: string }> {
    const { signal, cleanup } = this.withTimeout(opts?.signal, 10_000);
    try {
      const res = await fetch(`${this.baseUrl}/`, { method: 'GET', signal });
      if (!res.ok) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        return { ok: false, error: `${res.status}: ${errText.slice(0, 120)}` };
      }
      const data = (await res.json().catch(() => null)) as { status?: string } | null;
      const ok = data?.status === 'ok';
      return { ok, error: ok ? undefined : '健康探测未返回 status:ok' };
    } finally {
      cleanup();
    }
  }

  async transcribe(blob: Blob, options?: SttTranscribeOptions): Promise<SttResult> {
    const url = this.buildTranscribeUrl();
    const form = new FormData();
    // 文件名给个带扩展的占位即可(MediaRecorder 常为 webm/opus;服务端 ffmpeg 统一转)。
    form.append('file', blob, 'voice.webm');
    form.append('language', options?.language?.trim() || 'auto');
    form.append('response_format', 'json');
    // 专有名词热词(FunASR hotwords JSON 字符串);空则不传 = 后端关闭。
    if (options?.hotwords && options.hotwords.trim()) form.append('hotwords', options.hotwords);

    const { signal, cleanup } = this.withTimeout(options?.signal, STT_TRANSCRIBE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'POST', body: form, signal });
      if (!res.ok) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(`[CosyVoice STT] transcribe failed ${res.status}: ${errText.slice(0, 160)}`);
      }
      const data = (await res.json().catch(() => null)) as { text?: unknown; raw_text?: unknown } | null;
      const text = typeof data?.text === 'string' ? data.text : '';
      const rawText = typeof data?.raw_text === 'string' ? data.raw_text : undefined;
      return { text, rawText };
    } finally {
      cleanup();
    }
  }
}
