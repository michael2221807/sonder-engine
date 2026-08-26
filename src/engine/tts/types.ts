/**
 * TTS 层类型定义 — 语音配音子系统
 *
 * 架构镜像自 image 子系统(见 src/engine/image/types.ts):provider 接口 +
 * backend 类型 + registry 工厂 + 独立 fetch(非 LLM 类别,apiCategory='tts')。
 *
 * 引擎铁律:本文件不 import vue-i18n、不含游戏特定内容。所有音色名/风格串
 * 由用户配置或 pack 传入,引擎只按 dot-path/参数操作。
 *
 * 设计文档:docs/design/tts-system-design.md
 */

// ─── Backend / Provider ───

/** TTS 后端类型 — 决定请求格式与端点。CosyVoice(本地) / 豆包语音(火山, epic P2)。 */
export type TtsBackendType = 'cosyvoice' | 'doubao';

/** 单次合成选项 */
export interface TtsSynthesizeOptions {
  /** 音色 → 查询参数 speaker(CosyVoice: voices/*.pt 的名字) */
  speaker: string;
  /** 风格/方言 → 查询参数 instruct(自然语言,可空) */
  instruct?: string;
  /** 取消信号 */
  signal?: AbortSignal;
}

/** 服务端可用音色条目(CosyVoice: GET /speakers) */
export interface TtsSpeaker {
  name: string;
  voiceId: string;
}

/**
 * TTS Provider 抽象接口 — 每个 backend 实现一份。
 * 镜像 ImageProvider(image/types.ts)。
 */
export interface TtsProvider {
  readonly backend: TtsBackendType;
  /** 合成整段文本 → 音频 Blob(整段非流式:此 build 为完整 WAV) */
  synthesize(text: string, options: TtsSynthesizeOptions): Promise<Blob>;
  /**
   * 真·传输级流式播放 URL —— 让 `<audio crossOrigin='anonymous'>` 直接渐进播放
   * 服务端 chunked 输出(边下边播)。分句流水线里对「每一句」各取一个 URL。
   * CosyVoice: `GET {url}?text=&speaker=&instruct=&streaming=1` → chunked audio/ogg，
   * 浏览器原生渐进解码 ogg(MSE 不支持 ogg ≠ `<audio>` 不支持;媒体元素自有渐进管线)。
   * 返回 `null` 表示该 backend 不支持传输级流式(调用方整体回落整段 synthesize)。
   */
  getStreamUrl(text: string, options: Omit<TtsSynthesizeOptions, 'signal'>): string | null;
  /** 拉取服务端可用音色列表;失败返回 [](UI 降级为自由输入) */
  listSpeakers(signal?: AbortSignal): Promise<TtsSpeaker[]>;
  /**
   * 最小连通探测(epic P0 连测委托):APIPanel 的"测试连接"经 AIService 注册的
   * tester 调到这里,让每个 backend 的连测真正命中它自己的契约。延迟计时与
   * 错误整形由 measureConnectionTest 包装,这里只回答 ok/error。
   */
  testConnection(opts?: { speaker?: string; signal?: AbortSignal }): Promise<{ ok: boolean; error?: string }>;
}

/** Provider 工厂签名 — 由 registry 注册 */
export type TtsProviderFactory = (config: {
  endpoint: string;
  apiKey: string;
  model?: string;
  /** 自定义查询路径(默认 '/') */
  routingPath?: string;
  /** 多凭证 backend 的附加凭证(豆包: appId/accessToken/resourceId, epic P2) */
  credentials?: Record<string, string>;
}) => TtsProvider;

// ─── 全局配音设置(持久化到 aga_tts_settings) ───

/** 常用音色收藏项 */
export interface TtsVoiceFavorite {
  speaker: string;
  instruct: string;
}

/**
 * 全局配音偏好 — 跨存档统一,存 localStorage `aga_tts_settings`。
 * 经 collectLocalStorageSettings 自动进 engineSettings → 随备份/云同步。
 */
export interface TtsSettings {
  /** 总开关 — 关闭后播放键与自动配音全部失效 */
  enabled: boolean;
  /**
   * 当前配音服务商(epic P2 / D2)——平行 backend 之间的显式选择位,
   * 设置区 + 配音快切 popover 可切。值为目录 tts 描述符 id。
   */
  backend: TtsBackendType;
  /** 自动配音 — AI 出文后自动朗读正文(post-round fire-and-forget) */
  autoNarrateOnRound: boolean;
  /**
   * 'stream' = 真·分句流式(客户端切句拼段 + 每段 streaming=1,服务端 chunked ogg,
   *            `<audio crossOrigin>` 边下边播,段间预取近无缝,首段快出声,默认);
   * 'pseudo' = 假流式(客户端切句拼段,但**不用 streaming=1**,每段普通非流式
   *            synthesize 整段 blob;自建缓冲:预热攒够 prewarmSeconds 秒再开播,
   *            边播当前段边合成下一段。对不支持/CORS 不便 streaming 的部署更稳);
   * 'full'   = 整段非流式(整段一次合成完整 WAV 后播放,最稳)
   */
  transmissionMode: 'stream' | 'pseudo' | 'full';
  /**
   * 假流式(pseudo)的「预热缓冲秒数」— 开播前先合成若干段直到累计音频时长 >= 此值
   * (或全部合成完)再开始播放。提前量吸收合成抖动,让后续播放不断流。仅 pseudo 生效。
   */
  prewarmSeconds: number;
  /**
   * 分句流式的「每段目标字数」(主控) — splitSentences 细分后按此拼段,平衡断点、
   * 允许略超。越大段落越长越连贯、卡顿越少;越小越碎但停止/跳过更细。仅 stream 模式生效。
   */
  segmentTargetChars: number;
  /**
   * 分句流式的「每段最多句数」(硬上限) — 兜底延迟与停止粒度,即使短尾合并也不突破。
   * 仅 stream 模式生效。
   */
  segmentMaxSentences: number;
  /** 默认音色 → speaker */
  defaultSpeaker: string;
  /** 默认风格/方言 → instruct */
  defaultInstruct: string;
  /** 播放速率(HTMLAudioElement.playbackRate),0.5–2.0 */
  rate: number;
  /** 音量 0–1 */
  volume: number;
  /** 常用音色收藏(主面板 popover 候选) */
  favorites: TtsVoiceFavorite[];
}

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  enabled: false,
  backend: 'cosyvoice',
  autoNarrateOnRound: false,
  transmissionMode: 'stream',
  segmentTargetChars: 120,
  segmentMaxSentences: 6,
  prewarmSeconds: 3,
  defaultSpeaker: '',
  defaultInstruct: '',
  rate: 1,
  volume: 0.85,
  favorites: [],
};

export const TTS_RATE_MIN = 0.5;
export const TTS_RATE_MAX = 2;

/** 预热缓冲秒数的硬边界(normalize 夹持;UI 滑杆用更小的实用区间) */
export const PREWARM_SECONDS_MIN = 0;
export const PREWARM_SECONDS_MAX = 30;

// ─── 播放态事件(eventBus 'tts:state') ───

export type TtsStatus = 'idle' | 'synthesizing' | 'playing' | 'paused';

/** 'tts:state' 事件负载 — 供 UI 播放键/状态栏 chip 同步 */
export interface TtsStateEvent {
  status: TtsStatus;
  /** 当前朗读的回合标识(UI 用于定位是哪个回合在播),idle 时为 null */
  roundKey: string | null;
}

/**
 * 'tts:cache' 事件负载 — 供 UI(配音快切 popover 下载按钮)反应式显隐。
 * 仅假流式/整段模式会缓存字节;真流式不缓存 → available 恒 false。
 */
export interface TtsCacheEvent {
  /** 最新一回合全配音是否已缓存、可下载 */
  available: boolean;
  /** 已缓存的回合标识,无缓存时 null */
  roundKey: string | null;
}
