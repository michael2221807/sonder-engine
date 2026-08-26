// App doc: docs/user-guide/pages/game-main.md §3.14 (语音输入 · STT)
/**
 * STT (speech-to-text) 层类型定义 — 语音输入子系统。
 *
 * 架构镜像 TTS 子系统(src/engine/tts/types.ts):provider 接口 + backend 类型 +
 * registry 工厂 + 独立 fetch(非 LLM 类别,apiCategory='stt')。但**更瘦**:单一
 * 方法 transcribe、无流式、无播放态、无自动触发——玩家录音 → 一次性转写 → 回填输入框。
 *
 * 引擎铁律:本文件不 import vue-i18n、不含游戏特定内容。端点/参数由用户配置传入。
 *
 * 设计文档:docs/design/stt-voice-input-handoff.md
 */

/** STT 后端类型 — CosyVoice(SenseVoiceSmall, 本地) / 豆包录音识别(火山 flash, epic P3)。 */
export type SttBackendType = 'cosyvoice' | 'doubao';

/** 单次转写选项 */
export interface SttTranscribeOptions {
  /**
   * 识别语言 → 查询/表单参数 language。SenseVoice 支持 zh/en/ja/ko/yue;
   * 默认 'auto'(服务端自动识别)。MVP 固定 auto,不暴露 UI。
   */
  language?: string;
  /** 取消信号 */
  signal?: AbortSignal;
  /**
   * 专有名词热词(FunASR `hotwords`,JSON 字符串 `{"词":权重}`)。后端做拼音相似度
   * 确定性校正(POSTPROCESS_HOTWORDS)。空/缺省 = 关闭。由 UI 层组装传入(词表来自
   * 游戏状态 + 自定义词典,引擎不碰游戏字段)。见 docs/design/stt-hotword-handoff.md。
   */
  hotwords?: string;
}

/** 转写结果 */
export interface SttResult {
  /** 已清洗文本(剔除 SenseVoice 情绪/事件 emoji)—— AGA 一律用这个。 */
  text: string;
  /** 原始富文本(含情绪标记),仅调试用。 */
  rawText?: string;
}

/**
 * STT Provider 抽象接口 — 每个 backend 实现一份。镜像 TtsProvider(tts/types.ts)。
 */
export interface SttProvider {
  readonly backend: SttBackendType;
  /**
   * 把一段录音 Blob 转写成文字。
   * CosyVoice: `POST {endpoint}{routingPath}` multipart(file=blob),返回 `{text, raw_text}`。
   */
  transcribe(blob: Blob, options?: SttTranscribeOptions): Promise<SttResult>;
  /**
   * 最小连通探测(epic P0 连测委托):APIPanel"测试连接"经 AIService 注册的 tester
   * 调到这里。延迟计时/错误整形由 measureConnectionTest 包装,这里只回答 ok/error。
   */
  testConnection(opts?: { signal?: AbortSignal }): Promise<{ ok: boolean; error?: string }>;
}

/** Provider 工厂签名 — 由 registry 注册 */
export type SttProviderFactory = (config: {
  endpoint: string;
  apiKey: string;
  model?: string;
  /** 自定义转写路径(默认 '/v1/audio/transcriptions') */
  routingPath?: string;
  /** 多凭证 backend 的附加凭证(豆包: appId/accessToken/resourceId, epic P3) */
  credentials?: Record<string, string>;
}) => SttProvider;

/** CosyVoice STT 默认转写路径(OpenAI Whisper 兼容) */
export const DEFAULT_STT_ROUTING_PATH = '/v1/audio/transcriptions';

// ─────────────────────────────────────────────────────────────────────────
// 实时流式听写(streaming) — FunASR 2pass WebSocket 协议
// 契约见 docs/design/stt-streaming-handoff.md 头部「后端已确认的最终契约」:
//   ws://{host}:{port}/v1/audio/stream — JSON 握手 → 裸 PCM(16k/mono/int16 LE)
//   帧 → {is_speaking:false} 收尾;服务端回 2pass-online(partial,覆盖式)/
//   2pass-offline(final,带标点、已清洗)。
// ─────────────────────────────────────────────────────────────────────────

/** CosyVoice 流式听写默认 WS 路径(后端固定) */
export const DEFAULT_STT_STREAM_PATH = '/v1/audio/stream';

/**
 * 延迟档 → FunASR chunk_size `[look-back, chunk, look-ahead]`(每格 ≈60ms)。
 * balanced 为后端实测默认值,partial 滞后语音 ~0.6-0.9s。
 */
export type SttLatencyProfile = 'fast' | 'balanced' | 'stable';
export const STT_CHUNK_SIZE: Record<SttLatencyProfile, [number, number, number]> = {
  fast: [4, 8, 4], // ~480ms 更跟手
  balanced: [5, 10, 5], // ~600ms 后端默认
  stable: [8, 12, 8], // ~720ms 更稳更准
};

/** 采集帧长(ms):worklet 攒够这么多 16k 单声道样本再发一帧 */
export const STT_STREAM_FRAME_MS = 60;

/**
 * 停顿容忍(VAD 最长结束静音,ms)→ 后端握手字段 `vad_max_silence_ms`。
 * 后端默认 800、clamp 200-10000。停顿超过此值才断句(切一句 final 并补句号)。
 * 调大 = 边说边想的停顿不会被切;代价 = 句中自动断句的 final 更晚出(停多久才出),
 * 但点「停止」(is_speaking:false)立即收尾、末句不受影响。仅流式生效(非流式无 VAD)。
 */
export type SttPauseTolerance = 'short' | 'medium' | 'long';
export const VAD_MAX_SILENCE_MS: Record<SttPauseTolerance, number> = {
  short: 800, // = 后端默认,一句说完就停、反应快
  medium: 1500, // 容忍一般思考停顿
  long: 3000, // 边说边想,停很久也不切
};

/** 流式识别回调 —— 由 UI 组件消费,驱动实时上屏。 */
export interface SttStreamCallbacks {
  /** 连接建立、握手已发,可以开始说话。 */
  onOpen?(): void;
  /** partial:当前句的累积文本(覆盖式刷新,替换未定句)。无标点。 */
  onPartial?(text: string): void;
  /** final:一句定稿(带标点、已清洗)。VAD 断句时可多次触发。 */
  onFinal?(text: string): void;
  /** 采集电平 0..1 —— 驱动波形(可选)。 */
  onLevel?(level: number): void;
  /** 协议/连接/权限错误。触发后会走 onClose。 */
  onError?(error: Error): void;
  /** 会话结束(正常收尾或取消/出错)。error 非空表示异常收场。 */
  onClose?(error?: Error): void;
}

/** 流式会话句柄 —— UI 用它停止/取消一段听写。 */
export interface SttStreamHandle {
  /** 停止说话:发 is_speaking:false,等末尾 final 到达(或超时)后关闭。 */
  stop(): void;
  /** 取消:立即丢弃并关闭,不等 final、不再回调 onFinal。 */
  cancel(): void;
}

/** 打开流式会话的配置 */
export interface SttStreamConfig {
  /** ws(s)://host:port/path */
  url: string;
  /** 延迟档 → chunk_size,默认 'balanced'。 */
  latency?: SttLatencyProfile;
  /** ITN(逆文本规整,数字/单位归一),默认 true。 */
  itn?: boolean;
  /** 复用外部已取得的麦克风流(避免二次授权);不传则内部 getUserMedia。 */
  stream?: MediaStream;
  /** 专有名词热词(FunASR `hotwords` JSON 字符串)。空/缺省 = 关闭。见 SttTranscribeOptions.hotwords。 */
  hotwords?: string;
  /** 停顿容忍 → 握手 `vad_max_silence_ms`(ms)。>0 才传;缺省 = 后端默认。见 VAD_MAX_SILENCE_MS。 */
  vadMaxSilenceMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// 语音输入设置(aga_stt_settings) — 与 aga_tts_settings 对称,进备份/云同步。
// ─────────────────────────────────────────────────────────────────────────

/** 输入模式:auto=可用则实时、否则回落录音;stream=只实时;record=只录音转写。 */
export type SttInputMode = 'auto' | 'stream' | 'record';

/**
 * 专有名词偏置强度 → FunASR 权重(后端回告):
 *   weak=10   仅无调拼音完全一致才替换(零误伤,最保守)
 *   medium=20 +模糊音等价(z/zh、n/l、in/ing…);后端推荐默认
 *   strong=40 +词长≥3 允许 1 个音节不同
 * 已正确词不会被同音变体反纠。默认取 weak(用户要求"保守")。
 */
export type SttHotwordStrength = 'weak' | 'medium' | 'strong';
export const HOTWORD_WEIGHT: Record<SttHotwordStrength, number> = {
  weak: 10,
  medium: 20,
  strong: 40,
};

/** 热词表硬上限(后端:200 词 / 每词 2-10 汉字 / JSON≤8KB)。AGA 侧先行裁剪。 */
export const MAX_LEXICON_TERMS = 200;
export const LEXICON_TERM_MIN_CHARS = 2;
export const LEXICON_TERM_MAX_CHARS = 10;

export interface SttSettings {
  /** 总开关:关则主输入/私聊不显示麦克风键。 */
  enabled: boolean;
  /**
   * 当前听写服务商(epic P3 / D2)——平行 backend 的显式选择位(设置区可切)。
   * 流式听写仅对声明 sttStreaming 能力的 backend 可用(能力门,无 toggle)。
   */
  backend: SttBackendType;
  /** 输入模式。 */
  mode: SttInputMode;
  /** 实时听写延迟档(仅 stream/auto 生效)。 */
  latency: SttLatencyProfile;
  /** 首次转写懒加载较慢时是否给「首次稍慢」提示。 */
  firstUseHint: boolean;
  /** 专有名词偏置开关(热词)。关 = 不传 hotwords(等价后端关闭)。 */
  hotwordEnabled: boolean;
  /** 偏置强度 → 权重。默认 weak(保守)。 */
  hotwordStrength: SttHotwordStrength;
  /** 停顿容忍(仅实时听写生效)。默认 medium(比后端默认 800 更宽,治边说边想)。 */
  pauseTolerance: SttPauseTolerance;
}

export const DEFAULT_STT_SETTINGS: SttSettings = {
  enabled: true,
  backend: 'cosyvoice',
  mode: 'auto',
  latency: 'balanced',
  firstUseHint: true,
  hotwordEnabled: true,
  hotwordStrength: 'weak',
  pauseTolerance: 'medium',
};
