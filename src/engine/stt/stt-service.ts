// App doc: docs/user-guide/pages/game-main.md §3.14 (语音输入 · STT)
/**
 * SttService — 语音输入编排核心。TtsService 的「更瘦」镜像。
 *
 * 职责:
 *   - 从 AIService 取 stt 类 APIConfig(getSttConfigForBackend),经 registry 解析出
 *     CosyVoiceSttProvider。
 *   - transcribe(blob):一次性把录音转成文字;失败抛 Error(调用方 UI 负责 toast/复位)。
 *   - isReady():是否具备可用 stt 配置(UI 用于显隐麦克风键)。
 *
 * 与 TtsService 的差异:无流式、无播放态广播、无自动触发、无缓存——玩家手动录音后
 * 同步转写、回填输入框即结束。故不注入 player、不发 eventBus 事件。
 *
 * 引擎铁律:不 import vue-i18n;错误以 Error 上抛,由 UI 侧翻译成 toast。
 */
import type { AIService } from '../ai/ai-service';
import type { SttProviderRegistry } from './provider-registry';
import type { SttProvider, SttBackendType, SttStreamCallbacks, SttStreamHandle, SttLatencyProfile } from './types';
import { deriveStreamUrl, openSttStream } from './stt-stream';
import { providerCatalog } from '../providers';
import { loadSttSettings } from './stt-settings';

/**
 * Active STT backend — the user's dictation-vendor selection (epic P3 / D2,
 * settings 区可切); normalizeSttSettings guarantees a legal union value.
 * Read fresh per call (MicInputButton pattern) so setting changes take effect
 * on the next recording without a service restart.
 */
function activeSttBackend(): SttBackendType {
  return loadSttSettings().backend;
}

export class SttService {
  constructor(
    private aiService: Pick<AIService, 'getSttConfigForBackend'>,
    private registry: SttProviderRegistry,
  ) {}

  /** 是否具备可用配置(有启用的 stt 类 API)。UI 用于显隐麦克风键。 */
  isReady(): boolean {
    return !!this.aiService.getSttConfigForBackend(activeSttBackend());
  }

  private resolveProvider(): SttProvider | null {
    const backend = activeSttBackend();
    const config = this.aiService.getSttConfigForBackend(backend);
    if (!config) return null;
    try {
      return this.registry.resolve({
        backend,
        endpoint: config.url,
        apiKey: config.apiKey,
        model: config.model,
        routingPath: config.useCustomRouting ? config.customRoutingPath : undefined,
        credentials: config.credentials,
      });
    } catch {
      return null;
    }
  }

  /**
   * 录音 Blob → 文字(去情绪 emoji 的清洗文本;静音/无语音可能返回空串)。
   * 失败抛 Error —— 调用方(麦克风组件)catch 后 toast 并复位到 idle。
   */
  async transcribe(blob: Blob, options?: { signal?: AbortSignal; hotwords?: string }): Promise<string> {
    const provider = this.resolveProvider();
    if (!provider) throw new Error('[STT] 未配置可用的语音转文字(STT)API');
    const result = await provider.transcribe(blob, { language: 'auto', signal: options?.signal, hotwords: options?.hotwords });
    return result.text;
  }

  // ── 实时流式听写(streaming) ──

  /**
   * 从 stt 配置的 base URL 派生流式 WS 地址(http→ws / https→wss + /v1/audio/stream)。
   * 无可用配置返回 null。后端确认 WS 路径固定,故无需单独配置字段。
   * 能力门(epic P0 §3.7):仅描述符声明 sttStreaming 的 backend 才有流式地址——
   * 不支持流式的后端(如 epic P3 的豆包 flash)自动隐藏实时听写入口,无用户开关。
   */
  getStreamUrl(): string | null {
    const backend = activeSttBackend();
    if (providerCatalog.get('stt', backend)?.capabilities.sttStreaming !== true) return null;
    const config = this.aiService.getSttConfigForBackend(backend);
    if (!config?.url) return null;
    return deriveStreamUrl(config.url);
  }

  /** 是否可用实时听写(有 stt 配置且能派生出 WS 地址)。 */
  isStreamReady(): boolean {
    return !!this.getStreamUrl();
  }

  /**
   * 打开一段实时听写会话。立即返回句柄(stop/cancel);连接与麦克风异步进行,
   * 失败经 callbacks.onError/onClose 上报。无配置返回 null(调用方回落录音转写)。
   */
  startStream(
    callbacks: SttStreamCallbacks,
    options?: { latency?: SttLatencyProfile; stream?: MediaStream; hotwords?: string; vadMaxSilenceMs?: number },
  ): SttStreamHandle | null {
    const url = this.getStreamUrl();
    if (!url) return null;
    return openSttStream(
      {
        url, latency: options?.latency, itn: true, stream: options?.stream,
        hotwords: options?.hotwords, vadMaxSilenceMs: options?.vadMaxSilenceMs,
      },
      callbacks,
    );
  }
}
