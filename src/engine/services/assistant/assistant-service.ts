// Archived plan: docs/status/archive/plan-assistant-utility-2026-04-14.md
// App doc: docs/user-guide/pages/game-assistant.md
/**
 * AssistantService — Assistant utility 顶层编排
 *
 * **本文件 Phase 1 只是骨架**，仅定义 API surface + 内部依赖装配。
 * 真正的逻辑（attachment 构造、AI 调用、payload 解析/校验/注入）在
 * Phase 2-4 逐步填充。
 *
 * Phase 完成进度：
 * - [x] Phase 1：构造、clear、appendSystemMessage、conversation read
 * - [ ] Phase 2：send 中的 AttachmentBuilder + PayloadParser + PayloadValidator
 * - [ ] Phase 3：applyPayload + rollback（注入 + 撤销）
 * - [ ] Phase 4：MessageBuilder（system prompt 装配） + AIService 调用
 *
 * 对应 docs/status/plan-assistant-utility-2026-04-14.md §4 + Phase 1。
 */
import type { AIService } from '../../ai/ai-service';
import type { PromptTextSource } from '../../prompt/prompt-assembler';
import type { AIResponse } from '../../ai/types';
import type { CommandExecutor } from '../../core/command-executor';
import type { StateManager } from '../../core/state-manager';
import type { EngramManager } from '../../memory/engram/engram-manager';
import type { GamePack } from '../../types';
import type {
  AssistantMessage,
  AssistantSession,
  AssistantSettings,
  AssistantSystemKind,
  AttachmentSpec,
  ConversationStore,
  InjectResult,
  PayloadDraft,
  RollbackResult,
  SendInput,
  SendResult,
} from './types';
import {
  generateAssistantMessageId,
  DEFAULT_ASSISTANT_SETTINGS,
} from './types';
import { appendMessageWithFifoTrim, InMemoryConversationStore } from './conversation-store';
import { PayloadApplier } from './payload-applier';
import { AttachmentBuilder } from './attachment-builder';
import { PayloadValidator } from './payload-validator';
import { parseAssistantPayload } from './payload-parser';
import { MessageBuilder } from './message-builder';
import { eventBus } from '../../core/event-bus';

/** AssistantService 构造依赖 —— 全部通过 DI 注入便于测试 */
export interface AssistantServiceDeps {
  aiService: AIService;
  stateManager: StateManager;
  commandExecutor: CommandExecutor;
  /** 当前活跃 game pack —— 用于读 prompt 模块 + state schema */
  gamePack: GamePack | null;
  /** Conversation 持久化 —— MVP 默认 InMemoryConversationStore */
  conversationStore?: ConversationStore;
  /** 用户设置 —— 决定 maxHistoryTurns 等行为 */
  settings?: AssistantSettings;
  /** Current UI locale — forwarded to AttachmentBuilder for display label translation */
  locale?: string;
  /** Story 3: EngramManager for knowledge_facts processing after inject */
  engramManager?: EngramManager;
  /** Story 3: externally-constructed PayloadApplier for sharing with WorldBuilderService */
  payloadApplier?: PayloadApplier;
  /** Story 3: externally-constructed PayloadValidator for sharing with WorldBuilderService */
  payloadValidator?: PayloadValidator;
  /** The prompts as the prompt page left them (item 2, PO 2026-10-05); without it, the pack's text. */
  prompts?: PromptTextSource;
}

/**
 * Send 失败时抛出的专用错误 —— 携带已 commit 到 conversation 的 user/system 消息引用
 * UI 可据此刷新视图（user 消息已显示 + 错误已记录到对话流）
 */
export class AssistantSendError extends Error {
  constructor(
    message: string,
    public userMessage: AssistantMessage,
    public systemMessage: AssistantMessage,
  ) {
    super(message);
    this.name = 'AssistantSendError';
  }
}

export class AssistantService {
  private aiService: AIService;
  private stateManager: StateManager;
  /**
   * commandExecutor 仅在构造时传入 PayloadApplier；本类不直接调
   * （注入流程封装在 PayloadApplier 内）。保留字段方便未来扩展（如 audit 直接执行 commands）。
   */
  // @ts-expect-error — 当前未直接使用，但保留 DI 入口
  private commandExecutor: CommandExecutor;
  private gamePack: GamePack | null;
  private readonly prompts?: PromptTextSource;
  private locale: string | undefined;
  private conversationStore: ConversationStore;
  private settings: AssistantSettings;
  private payloadApplier: PayloadApplier;
  private attachmentBuilder: AttachmentBuilder;
  private payloadValidator: PayloadValidator;
  private messageBuilder: MessageBuilder;
  private engramManager: EngramManager | null;
  private validatorExternallySupplied: boolean;

  /**
   * 上一次成功注入时的状态树快照 —— 用于"撤销"（与主回合 rollback 同 UX）
   *
   * 单步快照：每次新注入会**覆盖**上一份，与 `元数据.上次对话前快照` 模式一致。
   * 注意：故意放在 in-memory 而非 state-tree —— assistant 是工具，不该污染游戏存档；
   * 用户刷新页面后撤销能力丢失（与 conversation 一同丢失，符合 MVP no-persistence 约束）。
   */
  private lastInjectSnapshot: {
    snapshot: Record<string, unknown>;
    capturedAt: number;
    draftMessageId: string;
  } | null = null;

  /**
   * In-memory 注入审计日志 —— 记录每次注入的 patch 数 / 时间戳 / draft id
   * Phase 6 会暴露给 UI 设置区。
   */
  private injectAuditLog: Array<{
    timestamp: number;
    sessionId: string;
    draftMessageId: string;
    patchCount: number;
    rolledBackAt?: number;
  }> = [];

  constructor(deps: AssistantServiceDeps) {
    this.aiService = deps.aiService;
    this.stateManager = deps.stateManager;
    this.commandExecutor = deps.commandExecutor;
    this.gamePack = deps.gamePack;
    this.prompts = deps.prompts;
    this.locale = deps.locale;
    this.conversationStore = deps.conversationStore ?? new InMemoryConversationStore();
    this.settings = deps.settings ?? { ...DEFAULT_ASSISTANT_SETTINGS };
    this.engramManager = deps.engramManager ?? null;
    this.validatorExternallySupplied = !!deps.payloadValidator;
    this.payloadApplier = deps.payloadApplier ?? new PayloadApplier({
      stateManager: deps.stateManager,
      commandExecutor: deps.commandExecutor,
    });
    this.attachmentBuilder = new AttachmentBuilder({
      stateManager: deps.stateManager,
      gamePack: deps.gamePack,
      locale: deps.locale,
    });
    this.payloadValidator = deps.payloadValidator ?? new PayloadValidator({
      stateManager: deps.stateManager,
      gamePack: deps.gamePack,
    });
    this.messageBuilder = new MessageBuilder();
  }

  // ─── Public API（Phase 1 已可用） ────────────────────────

  /**
   * 拉取当前 session 的完整状态（含全部消息、attachment summaries 等）
   *
   * UI 层调用此方法刷新对话视图。
   */
  async getSession(sessionId: string): Promise<AssistantSession> {
    return this.conversationStore.load(sessionId);
  }

  /**
   * 清空对话 —— messages = []，但保留 session 元数据（createdAt 等）
   *
   * UI 必须在调用前显示 confirm dialog（settings.confirmBeforeClear=true 时），
   * 此函数本身不做确认。
   */
  async clear(sessionId: string): Promise<void> {
    await this.conversationStore.clear(sessionId);
    // 清空对话不影响 lastInjectSnapshot —— 即使对话被清，注入的撤销能力仍在
    // （除非紧接着新一次注入覆盖了快照）
  }

  /**
   * 更新设置 —— 主要被 UI 用于改 maxHistoryTurns
   *
   * 不持久化（Phase 6 由 UI 层负责 localStorage 同步）。
   */
  updateSettings(patch: Partial<AssistantSettings>): void {
    this.settings = { ...this.settings, ...patch };
  }

  /** 当前生效设置（只读视图） */
  getSettings(): AssistantSettings {
    return { ...this.settings };
  }

  /** 是否有可撤销的注入 */
  canRollbackInject(): boolean {
    return this.lastInjectSnapshot !== null;
  }

  /**
   * Story 3: 为"世界构建模式"自由对话推荐默认 context attachments
   * （关系网 / 地点 / 世界描述），让 AI 在生成世界数据时拿到现有世界状态。
   *
   * 引擎不硬编码游戏专属路径——由 UI 层（DEFAULT_ENGINE_PATHS）传入。
   * 委托给内部 AttachmentBuilder，使其 helper 被真实消费。
   */
  suggestWorldBuilderAttachments(paths: {
    relationships: string;
    locations: string;
    worldDescription: string;
  }): AttachmentSpec[] {
    return this.attachmentBuilder.suggestWorldBuilderAttachments(paths);
  }

  /** 当前生效 game pack —— 装配新 pack 时由 outer service 调用 */
  setGamePack(pack: GamePack | null): void {
    this.gamePack = pack;
    this.attachmentBuilder = new AttachmentBuilder({
      stateManager: this.stateManager,
      gamePack: pack,
      locale: this.locale,
    });
    if (!this.validatorExternallySupplied) {
      this.payloadValidator = new PayloadValidator({
        stateManager: this.stateManager,
        gamePack: pack,
      });
    }
  }

  /**
   * 发送一条用户消息 + 触发 AI 调用 + 解析 payload + 持久化
   *
   * 流程：
   * 1. 用 AttachmentBuilder 把每个 spec 转成完整 AttachmentPayload（含 snapshot）
   * 2. 把当前 turn 写入 conversation（user message，attachments 仅存 summary 不含 snapshot）
   * 3. 拉历史（已 trim）→ MessageBuilder 装配 messages
   * 4. AIService.generate({ usageType: 'assistant', stream: true, onStreamChunk })
   * 5. 流式渲染期间 partial chunks 交给 onStreamChunk 给 UI；流结束后才解析 payload
   * 6. 若有 target attachment → parser 提取 → validator 校验 → payloadDraft 挂到 assistant message
   * 7. 写入 assistant message 到 conversation
   * 8. 返回 user + assistant message 给 UI
   *
   * 注意：FIFO trim 在 conversation-store.appendMessageWithFifoTrim 内做，
   * 一次 append 一条；user 和 assistant 各 append 一次。
   */
  async send(input: SendInput): Promise<SendResult> {
    // ── 1. 构造 attachment payloads ──
    const attachmentPayloads = input.attachments.map((spec) =>
      this.attachmentBuilder.build(spec),
    );

    const session = await this.conversationStore.load(input.sessionId);

    // ── 2. user message 入历史（attachments 仅 summary） ──
    const userMessage: AssistantMessage = {
      id: generateAssistantMessageId(),
      role: 'user',
      content: input.prompt,
      timestamp: Date.now(),
      attachments: attachmentPayloads.map(({ snapshot, schemaFragment, nsfwStripped, ...summary }) => {
        void snapshot; void schemaFragment; void nsfwStripped;
        return summary;
      }),
    };
    appendMessageWithFifoTrim(session, userMessage, this.settings.maxHistoryTurns);

    // ── 3. MessageBuilder 装配 messages（用 trim 后的历史 —— 不含刚加的 userMessage 是错的，
    //     因为 builder 把当前 turn 单独拼 —— 所以传 history = trim 后的全部，但末尾的 user 跟当前 turn 重复）
    //    → 解决：传 history = session.messages.slice(0, -1)，跳过刚 push 的 user
    const history = session.messages.slice(0, -1);
    const messages = this.messageBuilder.build({
      history,
      userPrompt: input.prompt,
      attachments: attachmentPayloads,
      gamePack: this.gamePack,
      worldBuilderMode: this.settings.worldBuilderMode,
      prompts: this.prompts,
    });

    // ── 4-5. AI 调用（流式） ──
    let accumulated = '';
    let aiResponse: string;
    try {
      aiResponse = await this.aiService.generate({
        messages,
        usageType: 'assistant',
        stream: true,
        onStreamChunk: (chunk) => {
          accumulated += chunk;
          input.onStreamChunk?.(chunk, accumulated);
        },
      });
    } catch (err) {
      // 失败：把 user message 已经入历史，但 assistant 没有 —— 插一条 system error
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.conversationStore.save(session); // 先 save user message
      const sysMsg = await this.appendSystemMessage(
        input.sessionId,
        `⚠ AI 调用失败：${errMsg}`,
        'ai-error',
      );
      throw new AssistantSendError(`AI generate failed: ${errMsg}`, userMessage, sysMsg);
    }

    // ── 6. 解析 payload（仅当有 target attachment 时尝试） ──
    const hasTarget = attachmentPayloads.some((a) => a.scope === 'target');
    let payloadDraft: PayloadDraft | undefined;
    if (hasTarget) {
      const parsed = parseAssistantPayload(aiResponse);
      if (parsed) {
        const validated = this.payloadValidator.validate(parsed);
        payloadDraft = {
          raw: parsed,
          validated,
          status: 'pending',
        };
      }
    }

    // ── 7. assistant message 入历史 ──
    const assistantMessage: AssistantMessage = {
      id: generateAssistantMessageId(),
      role: 'assistant',
      content: aiResponse,
      timestamp: Date.now(),
      payloadDraft,
    };
    appendMessageWithFifoTrim(session, assistantMessage, this.settings.maxHistoryTurns);
    await this.conversationStore.save(session);

    return { userMessage, assistantMessage };
  }

  /**
   * 注入 payload draft —— 自动快照 + 翻译 patch → Command + 执行
   *
   * 流程（与主回合 rollback 同范式）：
   * 1. 拒绝有 error 的 draft（用户必须先修复或丢弃，"无半成品" 硬约束）
   * 2. 捕获当前状态树快照到 in-memory（**覆盖**上一次的 lastInjectSnapshot —— 单步 undo）
   * 3. PayloadApplier.apply → CommandExecutor.executeBatch
   * 4. 若 ok：标记 draft.status='injected'、push 一条 inject-success synthetic system 消息
   * 5. 若失败：尝试用刚 capture 的快照回滚状态树（best-effort，不保证完美），
   *    push inject-failed system 消息，**清除** lastInjectSnapshot（避免后续 undo 拿到脏快照）
   *
   * @param sessionId 当前 session（用于追加 system 消息）
   * @param draft 已校验的 payload draft
   * @returns InjectResult
   */
  async applyPayload(sessionId: string, messageId: string, draft: PayloadDraft): Promise<InjectResult> {
    // 硬约束：有 error 的 patch 不能注入
    const hasError = draft.validated.some((p) => p.status === 'error');
    if (hasError) {
      return {
        ok: false,
        patchCount: 0,
        error: '存在 error 级 patch，请先修复或丢弃整个 draft 后重试',
      };
    }

    if (draft.status !== 'pending') {
      return {
        ok: false,
        patchCount: 0,
        error: `draft 已是 ${draft.status} 状态，不能重复注入`,
      };
    }

    // 1. 捕获快照（与主回合 preRoundSnapshot 同方式：toSnapshot 是 deep-clone）
    const snapshotBeforeInject = this.stateManager.toSnapshot();

    // 2. 翻译 + 执行
    const result = this.payloadApplier.apply(draft.validated);

    if (!result.ok) {
      // 回滚（best-effort，与失败时一致）
      try {
        this.stateManager.rollbackTo(snapshotBeforeInject);
      } catch (err) {
        console.error('[AssistantService] post-failure rollback also failed:', err);
      }
      // 失败 → 不缓存 snapshot（避免后续 undo 操作误用），不标 draft.injected
      this.lastInjectSnapshot = null;
      await this.appendSystemMessage(
        sessionId,
        `⚠ 注入失败：${result.error ?? '未知错误'}（已尝试回滚到注入前状态）`,
        'inject-failed',
      );
      eventBus.emit('assistant:payload-inject-failed', { error: result.error });
      return { ok: false, patchCount: 0, error: result.error };
    }

    // 3. 成功：覆盖 lastInjectSnapshot（单步 undo 范式）
    this.lastInjectSnapshot = {
      snapshot: snapshotBeforeInject,
      capturedAt: Date.now(),
      draftMessageId: messageId,
    };
    draft.status = 'injected';
    draft.injectedAt = Date.now();

    // 3.5 Process knowledge_facts via EngramManager (Story 3 §3.1.5)
    if (this.engramManager && draft.raw.knowledgeFacts?.length) {
      try {
        const syntheticResponse: AIResponse = {
          text: '',
          // confidence is KnowledgeFact-only; AIResponse.knowledgeFacts omits it by design
          knowledgeFacts: draft.raw.knowledgeFacts.map(kf => ({
            fact: kf.fact,
            sourceEntity: kf.sourceEntity,
            targetEntity: kf.targetEntity,
          })),
        };
        const writeResult = await this.engramManager.processResponse(
          syntheticResponse,
          this.stateManager,
          { defaultEdgeCore: true, defaultEdgeSource: 'ai', includeAllNpcTypes: true },
        );
        if (writeResult !== null) {
          draft.knowledgeFactsProcessed = true;
        }
        // writeResult === null means Engram is disabled — caller can check knowledgeFactsProcessed
      } catch (err) {
        console.warn('[AssistantService] knowledge_facts Engram processing failed (non-blocking):', err);
      }
    }

    // 4. 审计 + system 消息
    this.injectAuditLog.push({
      timestamp: Date.now(),
      sessionId,
      draftMessageId: messageId,
      patchCount: result.commandCount,
    });
    await this.appendSystemMessage(
      sessionId,
      `✅ 已注入 ${draft.validated.length} 个 patch · 可点 [↶ 撤销] 回退`,
      'inject-success',
    );
    eventBus.emit('assistant:payload-injected', { patchCount: result.commandCount });

    return { ok: true, patchCount: result.commandCount };
  }

  /**
   * 撤销上一次注入 —— 与主回合 rollback 同 UX
   *
   * - 仅能撤销最近一次成功的注入（单步快照）
   * - 撤销后 lastInjectSnapshot 清空（不能连续撤销两次）
   * - 在最后一条 inject-success message 上标 rolledBackAt（UI 用于隐藏 [撤销] 按钮）
   * - 追加一条 inject-rolled-back synthetic system 消息
   *
   * @returns RollbackResult
   */
  async rollbackLastInject(sessionId: string): Promise<RollbackResult> {
    const snap = this.lastInjectSnapshot;
    if (!snap) {
      return { ok: false, error: '没有可撤销的注入（每次注入只能撤销一次）' };
    }

    try {
      this.stateManager.rollbackTo(snap.snapshot);
    } catch (err) {
      return { ok: false, error: `回滚失败：${String(err)}` };
    }

    // 标记审计记录
    const auditEntry = this.injectAuditLog[this.injectAuditLog.length - 1];
    if (auditEntry && !auditEntry.rolledBackAt) {
      auditEntry.rolledBackAt = Date.now();
    }

    // 在 conversation 中找到对应的 assistant message，在它的 payloadDraft 上标 rolledBackAt
    if (snap.draftMessageId) {
      const session = await this.conversationStore.load(sessionId);
      const msg = session.messages.find((m) => m.id === snap.draftMessageId);
      if (msg?.payloadDraft) {
        msg.payloadDraft.rolledBackAt = Date.now();
        await this.conversationStore.save(session);
      }
    }

    // 单步：撤销后清空快照
    this.lastInjectSnapshot = null;

    await this.appendSystemMessage(
      sessionId,
      '↶ 已撤销上一次注入，状态树已恢复',
      'inject-rolled-back',
    );
    eventBus.emit('assistant:payload-rolled-back', undefined);
    return { ok: true };
  }

  // ─── 内部工具（Phase 1 已可用，被 Phase 3+ 调用） ───────

  /**
   * 往对话末尾追加一条 synthetic system 消息
   *
   * 用法：注入完成、撤销、AI 失败时引擎主动插入提示。
   */
  protected async appendSystemMessage(
    sessionId: string,
    content: string,
    systemKind: AssistantSystemKind,
  ): Promise<AssistantMessage> {
    const session = await this.conversationStore.load(sessionId);
    const msg: AssistantMessage = {
      id: generateAssistantMessageId(),
      role: 'system',
      content,
      timestamp: Date.now(),
      systemKind,
    };
    appendMessageWithFifoTrim(session, msg, this.settings.maxHistoryTurns);
    await this.conversationStore.save(session);
    return msg;
  }

  /** 单元测试用 —— 暴露内部 audit log */
  _testGetAuditLog() {
    return [...this.injectAuditLog];
  }

  /** 单元测试用 —— 直接设置/清除快照（绕过 applyPayload） */
  _testSetSnapshot(snapshot: typeof this.lastInjectSnapshot): void {
    this.lastInjectSnapshot = snapshot;
  }
}
