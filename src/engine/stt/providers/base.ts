// App doc: docs/user-guide/pages/game-main.md §3.14 (语音输入 · STT)
/**
 * Base STT provider — abstract class each concrete backend extends.
 * Mirrors BaseTtsProvider (src/engine/tts/providers/base.ts).
 */
import type { SttProvider, SttBackendType, SttTranscribeOptions, SttResult } from '../types';

/** 转写超时:热态 <1s,首次懒加载 +12s,留足余量。 */
export const STT_TRANSCRIBE_TIMEOUT_MS = 60_000;

export abstract class BaseSttProvider implements SttProvider {
  abstract readonly backend: SttBackendType;

  constructor(
    protected endpoint: string,
    protected apiKey: string,
    protected routingPath: string = '',
  ) {}

  abstract transcribe(blob: Blob, options?: SttTranscribeOptions): Promise<SttResult>;
  abstract testConnection(opts?: { signal?: AbortSignal }): Promise<{ ok: boolean; error?: string }>;

  /** 归一化 endpoint(去尾斜杠) */
  protected get baseUrl(): string {
    return this.endpoint.replace(/\/+$/, '');
  }

  /** controller + 超时 → { signal, cleanup },可与外部 signal 联动取消。 */
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
