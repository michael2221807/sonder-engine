/**
 * Base TTS provider — abstract class each concrete backend extends.
 * Mirrors BaseImageProvider (src/engine/image/providers/base.ts).
 */
import type { TtsProvider, TtsBackendType, TtsSynthesizeOptions, TtsSpeaker } from '../types';

/** 合成超时:单句 CosyVoice ≈ 14s,长句留余量。 */
export const TTS_SYNTHESIZE_TIMEOUT_MS = 120_000;
/** /speakers 与连测超时。 */
export const TTS_LIST_TIMEOUT_MS = 10_000;

export abstract class BaseTtsProvider implements TtsProvider {
  abstract readonly backend: TtsBackendType;

  constructor(
    protected endpoint: string,
    protected apiKey: string,
    protected routingPath: string = '/',
  ) {}

  abstract synthesize(text: string, options: TtsSynthesizeOptions): Promise<Blob>;
  abstract getStreamUrl(text: string, options: { speaker: string; instruct?: string }): string | null;
  abstract listSpeakers(signal?: AbortSignal): Promise<TtsSpeaker[]>;
  abstract testConnection(opts?: { speaker?: string; signal?: AbortSignal }): Promise<{ ok: boolean; error?: string }>;

  /** 归一化 endpoint(去尾斜杠) */
  protected get baseUrl(): string {
    return this.endpoint.replace(/\/+$/, '');
  }

  /** 合成后 controller + 超时 → { signal, cleanup },可与外部 signal 联动取消。 */
  protected withTimeout(external: AbortSignal | undefined, ms: number): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const onAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onAbort, { once: true });
    }
    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timer);
        external?.removeEventListener('abort', onAbort);
      },
    };
  }
}
