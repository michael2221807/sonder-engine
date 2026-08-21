/**
 * AI 层类型定义
 *
 * 定义 API 配置、消息格式、调用选项和响应结构。
 * 与 demo 的 aiService.ts 和 apiManagementStore.ts 保持概念一致，
 * 但去除酒馆模式相关类型（MVP 为独立 Web 应用）。
 *
 * 对应 STEP-03B M2.2。
 */
import type { Command } from '../types';

// ─── API Provider ───

/** API 提供商类型 — 决定请求格式和端点路径 */
export type APIProviderType = 'openai' | 'claude' | 'gemini' | 'deepseek' | 'custom';

/**
 * API 类别 — 决定调用时走哪条路径 / 端点 / 响应解析逻辑
 *
 * - 'llm':       chat completion 类型的 API（/v1/chat/completions 或等效）
 * - 'embedding': 向量化 API（/v1/embeddings）
 * - 'rerank':    重排序 API（/v1/rerank，Cohere/SiliconFlow 格式）
 *
 * 默认 `'llm'` — 向后兼容没有此字段的旧配置。
 *
 * 功能分配（APIAssignment）会按此字段过滤：embedding usage 只能选 'embedding' 类 API，
 * rerank 只能选 'rerank' 类，其他 usage 只能选 'llm' 类。
 */
export type APICategory = 'llm' | 'embedding' | 'rerank' | 'image' | 'tts' | 'stt';

/**
 * API 提供商预设信息
 * 用于 UI 中快速填充 URL 和默认模型
 */
export const API_PROVIDER_PRESETS: Record<APIProviderType, {
  url: string;
  defaultModel: string;
  name: string;
}> = {
  openai: { url: 'https://api.openai.com', defaultModel: 'gpt-4o', name: 'OpenAI' },
  claude: { url: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-20250514', name: 'Claude' },
  gemini: { url: 'https://generativelanguage.googleapis.com', defaultModel: 'gemini-2.0-flash', name: 'Gemini' },
  deepseek: { url: 'https://api.deepseek.com', defaultModel: 'deepseek-chat', name: 'DeepSeek' },
  custom: { url: '', defaultModel: '', name: '自定义(OpenAI兼容)' },
};

// ─── 消息格式 ───

/** 单条 AI 消息 — 通用的 role/content 格式 */
export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ─── API 配置 ───

/**
 * 单个 API 配置
 * 对应 demo 的 APIConfig，支持多 API 配置场景
 */
export interface APIConfig {
  /** 唯一标识（如 "default", "api_1712345678_abc"） */
  id: string;
  /** 显示名称 */
  name: string;
  /**
   * API 类别 — 决定这条配置走哪条调用路径
   *
   * - 'llm'（默认，向后兼容）: chat completion → provider 决定具体端点
   * - 'embedding': POST `{url}/v1/embeddings` —— 由 Embedder 直接 fetch
   * - 'rerank':    POST `{url}/v1/rerank` —— 由 Reranker 直接 fetch（Cohere/SiliconFlow 格式）
   *
   * 功能分配按此字段过滤：embedding/rerank usage 只能选对应类别的 API。
   * 不填时视为 'llm'（向后兼容）。
   */
  apiCategory?: APICategory;
  /** 提供商类型 — 决定 LLM 请求格式（仅 apiCategory='llm' 时使用） */
  provider: APIProviderType;
  /** API 端点 URL（不含 /v1 后缀） */
  url: string;
  /** API Key */
  apiKey: string;
  /** 模型名称 */
  model: string;
  /** 温度参数（仅 LLM 类别使用） */
  temperature: number;
  /** 最大输出 token 数（仅 LLM 类别使用） */
  maxTokens: number;
  /** 是否启用 */
  enabled: boolean;
  /** 是否使用自定义路由路径（高级：覆盖默认 `/v1/embeddings` 或 `/v1/rerank`） */
  useCustomRouting?: boolean;
  /** 自定义路由路径（如 "/rerank" 或 "/v2/embed"）— 对 embedding/rerank 类别生效 */
  customRoutingPath?: string;
  /** 禁用 assistant prefill — 部分反代理不支持消息列表以 assistant 结尾 */
  disablePrefill?: boolean;
  /**
   * 严格消息格式兼容 — 面向"不接受对话中途 system 消息"且"要求以 user 结尾"的
   * 模型/反代（如经 gproxy 转发的 Claude Opus，会因 mid_conv_system 块位置报 400）。
   * 开启后：首个非 system 消息之后的 system 全部转为 user，且末尾 assistant(prefill)
   * 转为 user，确保对话以 user 结尾。优先级高于 disablePrefill（已涵盖其 user 结尾诉求）。
   */
  strictMessageFormat?: boolean;
  /**
   * gproxy prompt cache — when true, the main-round prompt builder hoists the
   * guaranteed-static system pieces to the front and appends a gproxy magic-cache
   * trigger string so gproxy stamps an Anthropic `cache_control` breakpoint there,
   * caching the stable rules block across rounds (~90% input savings on it).
   * Requires the gproxy provider to have `enable_magic_cache` on. Off (default) =
   * no reorder, no marker. Only meaningful for gproxy-backed LLM configs.
   */
  gproxyPromptCache?: boolean;
  /**
   * Force streaming transport for EVERY request routed to this config, including
   * background / non-narrative calls (memory summary, world generation, tokenizers,
   * JSON repair, etc.) that never pass an `onStreamChunk`.
   *
   * Why: some providers/proxies expose ONLY a streaming endpoint — a non-streaming
   * request 404s or hangs. Streaming is already a transport concern here: the provider
   * accumulates SSE chunks and returns the SAME complete `Promise<string>` whether or
   * not anyone consumes the chunks (see `BaseProvider.processSSEStream`). So turning
   * this on makes those background calls send `stream: true` and simply discard the
   * incremental chunks (no `onStreamChunk` → nothing renders), while the caller still
   * receives the full assembled text.
   *
   * When on, {@link AIService.doGenerate} overrides `stream` to `true` regardless of
   * the caller's flag, and the providers MUST NOT auto-downgrade a failed stream to a
   * non-streaming retry (that endpoint can't do non-streaming) — they re-throw instead.
   * Off (default) = unchanged behavior (stream decided per-call by `onStreamChunk`).
   */
  forceStreaming?: boolean;
}

// ─── Usage Type ───

/**
 * 功能用途类型 — 不同 AI 任务可路由到不同 API 配置
 * 对应 demo 的 APIUsageType
 */
export type UsageType =
  | 'main'                     // 主游戏回合
  | 'memory_summary'           // 记忆总结
  | 'text_optimization'        // 文本优化
  | 'cot'                      // 思维链
  | 'instruction_generation'   // 指令生成
  | 'world_generation'         // 世界生成
  | 'event_generation'         // 世界事件生成
  | 'world_heartbeat'          // 世界心跳
  | 'location_npc_generation'  // 新地点 NPC 生成
  | 'privacy_repair'           // NSFW 私密信息自动修复（§11.2 B）— 独立于 instruction_generation
  | 'npc_chat'                 // §7.2 NPC 私聊 — 独立于主回合的异步 1:1 对话
  | 'embedding'                // Engram 向量化
  | 'rerank'                   // Engram 重排
  | 'assistant'                // AI 助手（utility chat —— 复用 main fallback，但可单独配 API）
  | 'imageGeneration'          // 图像生成（Legacy fallback）— 被 per-backend types 取代
  | 'imageGen_novelai'         // NovelAI 图像生成
  | 'imageGen_openai'          // OpenAI DALL-E 图像生成
  | 'imageGen_sd_webui'        // SD-WebUI 图像生成
  | 'imageGen_comfyui'         // ComfyUI 图像生成
  | 'imageGen_civitai'         // Civitai 图像生成
  | 'imageCharacterTokenizer'  // 角色视觉 token 提取（LLM 类）— Sprint Image-2
  | 'imageSceneTokenizer'      // 场景视觉 token 提取（LLM 类）— Sprint Image-2
  | 'imageSecretTokenizer'     // 私密部位 token 提取（LLM 类）— Sprint Image-2
  | 'bodyPolish'               // 文本润色（LLM 类）— Sprint CoT-4
  | 'field_repair'             // 通用字段补齐（2026-04-18）— 复用 step-2 context 补齐 rules/required-fields.json 列出的任意字段
  | 'plot_decompose'           // 剧情大纲拆解（Sprint Plot-1）— 将玩家大纲拆解为 PlotNode 链
  | 'world_builder'            // Story 3: 世界构建批量生成（WorldBuilderService）— 可单独配 API
  | 'engram_batch_solidify'    // Story 4: Engram 批量固化（EngramBatchSolidifyPipeline）— 可单独配 API
  | 'card_edge_classify'       // Story 7: 存档转卡知识边分类（CardEdgeClassifyPipeline）— 可单独配 API
  | 'ttsGen_cosyvoice'         // TTS: CosyVoice 语音合成（apiCategory='tts'）— 可单独配 API
  | 'sttGen_cosyvoice';        // STT: CosyVoice/SenseVoice 语音转文字（apiCategory='stt'）— 可单独配 API

/** API 分配 — 指定某个功能使用哪个 API 配置 */
export interface APIAssignment {
  type: UsageType;
  apiId: string;
}

// ─── 调用选项 ───

/** AI 生成调用选项 */
export interface GenerateOptions {
  /** 消息列表（由 PromptAssembler 组装） */
  messages: AIMessage[];
  /** 是否使用流式传输 */
  stream?: boolean;
  /** 功能用途（用于选择 API 配置） */
  usageType?: UsageType;
  /** 生成 ID（用于日志追踪） */
  generationId?: string;
  /** 流式 chunk 回调 — 每收到一个文本片段就回调 */
  onStreamChunk?: (chunk: string) => void;
  /** AbortSignal — 由 AIService 注入，用于取消和超时 */
  signal?: AbortSignal;
  /** Per-call temperature override (takes precedence over APIConfig.temperature) */
  temperature?: number;
  /** Per-call maxTokens override (takes precedence over APIConfig.maxTokens) */
  maxTokens?: number;
}

// ─── Canon Capture ───

/**
 * A single `setting_updates` item exactly as the model emitted it.
 *
 * Deliberately typed with `unknown` fields: this is UNTRUSTED model output. Shape,
 * enum, length, evidence and capacity checks all happen in `SettingCaptureStage`,
 * which needs to report a per-candidate rejection reason to the player — so the
 * parser must NOT quietly discard malformed items on its way through.
 *
 * The validated shape is `SettingUpdateCandidate` (see `setting-capture` types).
 */
export interface RawSettingUpdate {
  kind?: unknown;
  statement?: unknown;
  evidence?: unknown;
  anchors?: unknown;
  entities?: unknown;
}

/**
 * Upper bound on raw items retained from one response.
 *
 * NOT the product cap — the per-round product cap (10) is enforced by
 * `SettingCaptureStage` so that overflow is REPORTED to the player rather than
 * silently dropped. This bound only stops a runaway model from parking an unbounded
 * array in memory.
 */
export const MAX_RAW_SETTING_UPDATES = 50;

// ─── AI 响应 ───

/**
 * AI 响应（结构化）
 * ResponseParser 从 AI 原始输出中提取以下字段
 */
export interface AIResponse {
  /** AI 生成的叙事文本 */
  text: string;
  /** 结构化指令（修改状态树） */
  commands?: Command[];
  /** 中期记忆内容 */
  midTermMemory?: string | {
    相关角色: string[];
    事件时间: string;
    记忆主体: string;
  };
  /** 行动选项列表 */
  actionOptions?: string[];
  /** 判定结果 */
  judgement?: {
    type: string;
    dc: number;
    roll: number;
    success_rate: number;
    grade: string;
    details?: unknown;
  };
  /** 语义记忆（长期记忆汇总 pipeline 使用 semantic_memory.long_term_memories） */
  semanticMemory?: Record<string, unknown>;
  /** V2: AI 产出的知识事实（从 knowledge_facts 提取） */
  knowledgeFacts?: Array<{ fact: string; sourceEntity: string; targetEntity: string }>;
  /**
   * Canon Capture — long-term settings the player marked with `<设定>` this round.
   *
   * An explicit field rather than a `customFields` passenger, because split-gen merges
   * response fields through a hand-written whitelist (`ai-call.ts`): anything not named
   * there is silently dropped in split mode, and a silently-dropped player setting is
   * exactly the failure this feature exists to prevent.
   *
   * `undefined` = the model never emitted the key (normal for rounds with no tag).
   * `[]` = emitted but empty.
   */
  settingUpdates?: RawSettingUpdate[];
  /**
   * §7.2 NPC 私聊专属 — NPC 以第一人称总结本次交流对自己的影响（50 字内）
   *
   * 由 `NpcChatPipeline` push 到目标 NPC 的 `记忆` 数组，主线 AI 后续可从
   * `GAME_STATE_JSON` 中看见此条记忆。仅在 npcChat flow 的响应中出现，
   * 其他 flow 忽略此字段。
   */
  memoryEntry?: string;
  /**
   * CoT 前置思考内容（Sprint CoT-1）
   *
   * 由 ResponseParser 的 Tag 预处理器从 `<thinking>...</thinking>` 标签中捕获。
   * 当 `captureThinking=true` 时填充；`false` 时保持 undefined（销毁式 strip，
   * 与 pre-migration 行为 byte-identical — PRINCIPLES §3.9.3）。
   *
   * 此字段是 **context**，不是 action —— CoT 不触发 commands（PRINCIPLES §3.10）。
   * Sprint CoT-2 的 ReasoningIngestStage 消费此字段写入 `元数据.推理历史`。
   */
  thinking?: string;
  /**
   * 扩展字段 — 由 ResponseParser 收集 JSON 中未被显式提取的顶级 key。
   * 用于 Plot Direction System (plot_evaluation) 等可选特性的透传。
   * 引擎核心不解释此对象的内容；消费方（如 PlotEvaluationPipeline）
   * 自行做类型校验。Sprint Plot-1。
   */
  customFields?: Record<string, unknown>;
  /** 原始 AI 输出（调试用） */
  raw?: string;
  /**
   * JSON 解析是否成功（2026-04-19 加入）
   *
   * `true` —— 三个 tryParseJson 策略有一个成功；commands/memory/options 都是真的。
   * `false` —— 全部失败（典型场景：模型输出了非法转义 `\X`，且 sanitizer
   *    也救不回来的更深层畸形）。此时 `text` 包含了整段 raw dump，
   *    commands/midTermMemory/actionOptions 都是 undefined。
   *
   * 下游 ResponseRepairStage 检测到 `parseOk === false` 会重新调用 AI 把结构
   * 化字段抢回来，保证一个有 narrative 但没 commands 的回合不会静默吞掉
   * 状态变更。
   */
  parseOk?: boolean;
}

// ─── API 请求超时 ───

/** 主 generate 请求超时的默认值（10 分钟）—— 作为 AIService.requestTimeoutMs 的初始值 */
export const API_TIMEOUT_MS = 600_000;

/**
 * 主 generate 请求超时的可配置边界（分钟）。
 *
 * 用户在 APIPanel「AI 设置」区以「分钟」为单位配置，值持久化到
 * `aga_ai_settings.requestTimeoutMinutes`，冷启动 / 导入存档时经
 * {@link requestTimeoutMinutesToMs} 钳制换算后写回 AIService.requestTimeoutMs。
 *
 * 仅作用于主 generate（AI 回合/生成）请求；连通测试(10s)、embedding(15s)、
 * rerank(15s)、图像生成(180s) 等专用短超时语义不同，保持各自硬编码不变。
 */
export const REQUEST_TIMEOUT_MIN_MINUTES = 1;
export const REQUEST_TIMEOUT_MAX_MINUTES = 30;
export const REQUEST_TIMEOUT_DEFAULT_MINUTES = 10;

/** 将分钟数钳制到 [MIN, MAX] 合法范围并转为毫秒。非法输入（NaN 等）退回默认值。 */
export function requestTimeoutMinutesToMs(minutes: number): number {
  const safe = Number.isFinite(minutes) ? Math.round(minutes) : REQUEST_TIMEOUT_DEFAULT_MINUTES;
  const clamped = Math.min(REQUEST_TIMEOUT_MAX_MINUTES, Math.max(REQUEST_TIMEOUT_MIN_MINUTES, safe));
  return clamped * 60_000;
}
