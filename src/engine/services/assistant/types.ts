/**
 * Assistant Utility — 类型定义
 *
 * 本文件是整个 assistant utility 的契约层。所有跨模块边界的数据形状都在这里。
 *
 * 设计原则：
 * 1. 每条消息有唯一 id（UI key 用）+ timestamp（排序/审计）
 * 2. user message 的 attachments 字段在历史回放时只展示 label，**不**重发 snapshot
 *    （即只在 *当前* turn 的 build 中以 AttachmentPayload 形式带值发送）
 * 3. assistant message 的 payloadDraft 字段记录 AI 输出的可注入数据 + validator 校验结果
 * 4. system message 的 systemKind 字段区分"对话级"系统消息（本会话特有）vs 引擎注入的状态消息
 * 5. 全部 ID 用 user_-prefix-style：`asst_<base36-ts>_<rand>` —— 与 CustomPresetStore 的
 *    `user_` 前缀刻意不冲突，可未来扁平地共存
 *
 * 对应 docs/status/plan-assistant-utility-2026-04-14.md §3。
 */

// ─── Patch 协议（AI 输出 → 中间层翻译为 Command） ─────────

/**
 * AI 输出的 patch op 词汇表 —— **故意克制只 6 种**
 *
 * 每条 op 在 PayloadApplier 内部翻译成一组 CommandExecutor.Command。
 *
 * 设计原则：
 * - 数组操作优先精确到项（append-item / insert-item / replace-item / remove-item）
 * - **不暴露 `set-object`**（直接覆盖整对象太危险）
 * - replace-array 保留但 prompt 侧已降级为"仅全局重写"——整数组 pass 给模型容易
 *   导致无关项被污染（模型在重写时可能无意识修改其他 item），所以对于"新增一项"
 *   场景强烈推荐 insert-item / append-item。
 */
type AssistantPatchOp =
  | 'set-field'
  | 'append-item'
  | 'insert-item'    // 2026-04-14 新增：精确位置插入（按名称定位，非下标）
  | 'replace-item'
  | 'remove-item'
  | 'replace-array';

/**
 * 数组项匹配条件 —— 仅 replace-item / remove-item / insert-item(before/after) 用
 *
 * 不用位置索引（避免 AI 数错）；要求按字段值匹配，最常见是 `by: '名称'`。
 */
export interface PatchMatchSpec {
  by: string;
  value: unknown;
}

/**
 * insert-item 的插入位置 —— 故意不支持下标（防 AI 数错）
 *
 * 四种形态：
 * - `{ at: 'start' }`：插在数组头
 * - `{ at: 'end' }`：插在数组尾（语义等价于 append-item；允许 AI 选择任一形态）
 * - `{ before: match }`：插在匹配项之前
 * - `{ after: match }`：插在匹配项之后
 *
 * before/after 匹配不到 item 时：
 * - validator 发 warn（referential 层）
 * - applier fallback 到数组末尾（与 replace-item match 找不到时 fallback 到 push 同策略）
 */
export type InsertPosition =
  | { at: 'start' }
  | { at: 'end' }
  | { before: PatchMatchSpec }
  | { after: PatchMatchSpec };

export interface AssistantPatch {
  /** JSONPath 风格："$.社交.关系" 或 "社交.关系"（前导 $. 可选） */
  target: string;
  op: AssistantPatchOp;
  /** op=remove-item 时无需 value */
  value?: unknown;
  /** 仅 replace-item / remove-item 必填 */
  match?: PatchMatchSpec;
  /** 仅 insert-item 必填 —— 指定插入位置 */
  position?: InsertPosition;
  /** AI 给出的解释 —— 展示给用户帮助理解为何这么改 */
  rationale?: string;
}

/**
 * AI 在 Mode B 输出的注入包
 *
 * `summary` 用于"📦 注入包就绪"按钮的副标题。
 * `patches` 顺序即注入顺序（PayloadApplier 严格按数组顺序翻译/执行）。
 */
export interface AssistantPayload {
  summary: string;
  patches: AssistantPatch[];
  knowledgeFacts?: KnowledgeFact[];
}

/**
 * Knowledge fact extracted from AI response in worldBuilder mode.
 * Processed by EngramManager.processResponse after patches injection.
 * Uses same structure as main-round step2 knowledge_facts output.
 */
export interface KnowledgeFact {
  sourceEntity: string;
  targetEntity: string;
  fact: string;
  confidence: number;
}

// ─── Validator 输出 ────────────────────────────────────────

/** 校验状态 —— ok 可注入；warn 可注入但提示用户；error 必须修复后才能注入 */
type PatchValidationStatus = 'ok' | 'warn' | 'error';

/**
 * 校验后的 patch —— 在原 patch 基础上加 status + issues
 *
 * 用户决策点：
 * - 全部 ok → 可"全部注入"
 * - 任一 error → 必须修复（在 PayloadPatchEditor 中）或全部丢弃；不允许部分注入
 *   （用户拍板的硬约束 —— 避免半成品状态）
 */
export interface ValidatedPatch extends AssistantPatch {
  status: PatchValidationStatus;
  issues: string[];
}

// ─── Attachment 模型 ───────────────────────────────────────

/**
 * Attachment scope
 * - context：仅作为上下文喂给 AI（read-only）；可多个
 * - target：AI 应该返回 patch 修改这条；MVP 限制单个
 */
type AttachmentScope = 'context' | 'target';

/**
 * 用户在 picker 中选定的 attach 描述（输入端）
 *
 * 仅 path + scope；具体值/schema 由 AttachmentBuilder 在 send 时取
 */
export interface AttachmentSpec {
  path: string;
  scope: AttachmentScope;
}

/**
 * 历史消息中保留的 attachment 摘要 —— **不含 snapshot**
 *
 * 这是 5.1-B 决策的体现：历史不重发完整数据，AI 只看见 label。
 */
export interface AttachmentSummary {
  path: string;
  label: string;
  scope: AttachmentScope;
  /** 数组类型时显示 "12 项" 提示 */
  itemCount?: number;
}

/**
 * 当前 turn 实际发送时构造的完整 attachment —— 含 snapshot + schema
 *
 * 由 AttachmentBuilder.build 产出。仅用于本 turn 的 messages 构造，
 * 不会保留到 history（history 只存 AttachmentSummary）。
 */
export interface AttachmentPayload extends AttachmentSummary {
  /** attach 那一刻 deep-cloned 的值（已可能 NSFW 剥离） */
  snapshot: unknown;
  /** 从 state-schema 裁出的子 schema 片段（含 $comment） */
  schemaFragment: Record<string, unknown>;
  /** 是否因 nsfwMode=false 剥离了 NSFW 子树 */
  nsfwStripped: boolean;
}

// ─── Conversation 数据模型 ────────────────────────────────

type AssistantMessageRole = 'user' | 'assistant' | 'system';

/**
 * Synthetic system message 的种类
 *
 * 这些是引擎主动插入对话的状态消息，与 jailbreak 的 system prompt 完全不同
 * （后者只在 send 时即时拼接，不进入 conversation 历史）。
 */
export type AssistantSystemKind =
  | 'inject-success'    // ✅ 已注入 N 个 patch
  | 'inject-rolled-back'// ↶ 已撤销注入
  | 'inject-failed'     // ⚠ 注入失败：XX
  | 'cleared'           // 🗑 对话已清空（仅在清空"撤销"场景下显示）
  | 'ai-error';         // ⚠ AI 调用失败：XX

/**
 * 对话中的单条消息
 *
 * 字段 optional 因为不同 role 用不同子集：
 * - user → attachments, 无 payloadDraft / systemKind
 * - assistant → payloadDraft（Mode B 才有），无 attachments / systemKind
 * - system → systemKind，无 attachments / payloadDraft
 */
export interface AssistantMessage {
  id: string;
  role: AssistantMessageRole;
  content: string;
  timestamp: number;
  attachments?: AttachmentSummary[];
  payloadDraft?: PayloadDraft;
  systemKind?: AssistantSystemKind;
}

/**
 * Session —— MVP 单 session（id 固定 "default"）
 *
 * 接口已为多 session 预留：
 * - createdAt / messages 数组结构稳定
 * - sessionId 字段贯穿，未来 ConversationStore.list() 可枚举
 */
export interface AssistantSession {
  sessionId: string;
  createdAt: number;
  messages: AssistantMessage[];
  // 未来字段：title?: string; archivedAt?: number;
}

// ─── Payload Draft（可注入数据状态机） ─────────────────────

type PayloadDraftStatus = 'pending' | 'injected' | 'discarded';

/**
 * Payload 草稿 —— 挂在 assistant message 上
 *
 * 状态机：
 *   pending → injected   (用户在 PayloadPreviewModal 点"注入"且 applier 成功)
 *   pending → discarded  (用户点"丢弃")
 *   injected → injected  (终态，但记录 rolledBackAt 标记是否已撤销)
 *
 * 注意：rolledBack 不变成新的状态值，是因为撤销后注入数据本身仍存在
 * （仅是"改回去了"），保留 status='injected' + 增加 rolledBackAt 比新增 status 更清晰。
 */
export interface PayloadDraft {
  /** AI 原始输出 */
  raw: AssistantPayload;
  /** validator 校验后 */
  validated: ValidatedPatch[];
  status: PayloadDraftStatus;
  injectedAt?: number;
  /** 用户在 modal 中编辑过的次数 —— 用户体验提示用 */
  editedTimes?: number;
  /** 撤销标记（只 inject 后才可能有值） */
  rolledBackAt?: number;
  /** Engram knowledge_facts 已处理标记（inject 后 engramManager 处理完成） */
  knowledgeFactsProcessed?: boolean;
}

// ─── ConversationStore 接口 ────────────────────────────────

/**
 * Conversation 持久化抽象
 *
 * MVP 实现：InMemoryConversationStore（存内存 Map）
 * 未来：IDBConversationStore（持久化到 IndexedDB）
 *
 * `appendMessage` 内部应用 FIFO trim（按 turn 数）。
 */
export interface ConversationStore {
  load(sessionId: string): Promise<AssistantSession>;
  save(session: AssistantSession): Promise<void>;
  clear(sessionId: string): Promise<void>;
  /** 未来扩展点：列出所有已存的 session */
  list?(): Promise<Array<{ sessionId: string; createdAt: number; messageCount: number }>>;
}

// ─── Send 入参/出参 ────────────────────────────────────────

export interface SendInput {
  sessionId: string;
  prompt: string;
  attachments: AttachmentSpec[];
  /** 流式 chunk 回调 —— UI 用于实时渲染 assistant message */
  onStreamChunk?: (chunk: string, accumulated: string) => void;
}

export interface SendResult {
  /** 新追加的 user message */
  userMessage: AssistantMessage;
  /** 新追加的 assistant message（含 payloadDraft 如果是 Mode B） */
  assistantMessage: AssistantMessage;
}

// ─── Inject / Rollback ───────────────────────────────────

export interface InjectResult {
  ok: boolean;
  /** 注入了几条 patch */
  patchCount: number;
  /** 失败时的错误消息 */
  error?: string;
}

export interface RollbackResult {
  ok: boolean;
  /** 失败时的错误消息（无可回退快照、状态树状态不一致等） */
  error?: string;
}

// ─── 设置 ─────────────────────────────────────────────────

/**
 * Assistant 用户可调设置 —— 持久化在 localStorage(`aga_assistant_settings`)
 *
 * 不放在游戏存档里（跨 profile 共享），与 EngramConfig 模式一致。
 */
export interface AssistantSettings {
  /** FIFO 历史保留 turn 数（1 turn = 1 user + 1 assistant） */
  maxHistoryTurns: number;
  /** 是否在 inject 前显示二次确认对话框 */
  confirmBeforeInject: boolean;
  /** 是否在清空对话前显示二次确认对话框 */
  confirmBeforeClear: boolean;
  /** 世界构建模式 — 启用后 prompt 增强 + context 自动建议 + knowledge_facts 处理 */
  worldBuilderMode: boolean;
}

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  maxHistoryTurns: 5,        // 用户拍板默认值
  confirmBeforeInject: true,
  confirmBeforeClear: true,
  worldBuilderMode: false,
};

// ─── WorldBuilder 类型（D3 双工程 — "批量/复杂"通道） ──────

/**
 * WorldBuilderService 的任务描述
 * - region: 生成完整区域（地点+NPC+物品）
 * - npcs: 批量生成 NPC
 * - from-description: 根据自由文本描述生成结构化数据
 * - st-import: Story 8 ST 卡导入（预留）
 */
export interface WorldBuilderTask {
  type: 'region' | 'npcs' | 'from-description' | 'st-import';
  userInstruction: string;
  config?: {
    npcCount?: number;
    parentLocation?: string;
    subLocationCount?: number;
    generateItems?: boolean;
    itemCount?: number;
  };
}

export interface WorldBuilderResult {
  userMessage: AssistantMessage;
  assistantMessage: AssistantMessage;
  knowledgeFacts?: KnowledgeFact[];
}

/**
 * Progress callback payload — consistent with pipeline-runner's onProgress signature.
 * UI layer can render both pipeline and world-builder progress uniformly.
 */
export interface ProgressPayload {
  i18nKey: string;
  i18nParams?: Record<string, unknown>;
  message: string;
}

// ─── ID 工具 ──────────────────────────────────────────────

const ID_PREFIX = 'asst_';

export function generateAssistantMessageId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ID_PREFIX}${ts}_${rand}`;
}
