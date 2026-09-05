// App doc: docs/user-guide/pages/game-relationships.md §NPC 私聊 Modal
/**
 * NPC 私聊子管线 — §7.2 GAP_AUDIT（Talk 功能）
 *
 * 独立于主回合的异步 1:1 NPC 对话。
 *
 * 设计 intent 见 `H:\ming\docs\design note` 第五节「npc 对话系统（私聊）」：
 * - 与主故事异步进行（独立于主故事系统，但是仍小范围更新数据）
 * - UI 的话可以在 NPC 页面与其对话，通过 llm 处理
 * - 此类对话仅改变此 NPC 的信息（动机/看法）
 * - 此类对话需要更新 NPC 的记忆让 NPC 在主线故事中能记得对话
 *
 * ### 执行流程
 *
 * 1. UI（RelationshipPanel → NpcChatModal）在用户发送消息时调 `chat(npcName, userMessage)`
 * 2. Pipeline 读取该 NPC 的完整 profile + 玩家上下文 + 世界背景 + 短期记忆 + 已有私聊历史
 * 3. 调用 `promptAssembler.assemble('npcChat', variables)` 组装 prompt
 * 4. 调用 AI（usageType 'npc_chat'），获取响应
 * 5. 解析响应：text / commands / memoryEntry
 * 6. 将玩家消息 和 AI 回复都 append 到该 NPC 的 `私聊历史` 数组
 * 7. 对 `commands` 做**路径限制校验**：只允许写入 `社交.关系[idx].*`（NPC 自己的字段），
 *    其他路径的命令一律拒绝（防止 AI 越权修改玩家/世界/其他 NPC）
 * 8. 通过 `commandExecutor.executeBatch` 执行经校验的 commands
 * 9. 如果有 `memoryEntry`，push 到该 NPC 的 `记忆` 数组（主线 AI 自然可见）
 * 10. emit `ui:debug-prompt` 事件让 PromptAssemblyPanel 可见
 *
 * ### 关键限制
 *
 * - 此管线**不**写主线 `narrativeHistory` — 私聊不应污染主线叙事流
 * - 此管线**不**触发记忆总结 / 心跳 / NPC 生成等下游子管线 — 只是一次轻量 AI 调用
 * - `commands` 中引用其他 NPC 或玩家路径的条目会被静默丢弃（console.warn）
 * - 使用 `'npc_chat'` 独立 usageType — 用户可在 APIPanel 单独配置该功能的 API
 *
 * ### 已知 latent bug（非本管线引入）
 *
 * 状态树路径语法 `社交.关系[名称=X].好感度` 依赖 lodash path 过滤器扩展，
 * 而当前 `state-manager.ts` 用的是标准 lodash-es `get/set`，**不支持** `[名称=X]` 过滤器。
 * 因此本管线通过 **read-full-array → find-by-name → modify → write-full-array**
 * 的方式绕过该问题，保证更新可靠。
 */
import type { StateManager } from '../../core/state-manager';
import type { CommandExecutor } from '../../core/command-executor';
import type { AIService } from '../../ai/ai-service';
import type { AIMessage } from '../../ai/types';
import type { ResponseParser } from '../../ai/response-parser';
import type { PromptAssembler } from '../../prompt/prompt-assembler';
import type { GamePack, Command } from '../../types';
import type { EnginePathConfig, IEngramManager } from '../types';
import type { MemoryManager } from '../../memory/memory-manager';
import { unset as _unset } from 'lodash-es';
import {
  emitPromptAssemblyDebug,
  emitPromptResponseDebug,
  extractThinkingFromRaw,
} from '../../core/prompt-debug';
import { formatMemoryEntry } from '../../social/npc-memory-format';
import { isDuplicateMemory } from '../../social/memory-dedup';
import { buildEnvironmentBlock } from '../../prompt/environment-block';
import { buildNarrativeContractFromState } from '../../prompt/narrative-contract';

/** 单条私聊消息结构 — 存储在 NPC.私聊历史 数组中 */
export interface NpcChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/** 对话调用结果 — 供 UI 显示和错误处理 */
export interface NpcChatResult {
  success: boolean;
  /** NPC 的回复文本（显示在 UI） */
  reply: string;
  /** 错误信息（success=false 时） */
  error?: string;
}

/**
 * 历史保留长度默认值 — 避免私聊历史无限增长拖累 prompt
 *
 * CR-R7 修复：改为可配置。pack rules/npc-chat.json 可覆盖此值（字段名 maxChatHistory）。
 */
const DEFAULT_MAX_CHAT_HISTORY = 20;

export class NpcChatPipeline {
  /**
   * CR-R7: 历史保留长度 — 从 pack rules/npc-chat.json 读取 `maxChatHistory`
   * 字段（可选）；未配置时用 DEFAULT_MAX_CHAT_HISTORY。
   */
  private readonly maxChatHistory: number;
  private readonly nameKey: string;
  private readonly chatHistoryKey: string;

  private _lastChatSnapshot: Record<string, unknown> | null = null;
  private _lastChatNpcName: string | null = null;
  private _lastChatRound: number = -1;
  private _isChatInFlight = false;

  constructor(
    private stateManager: StateManager,
    private commandExecutor: CommandExecutor,
    private aiService: AIService,
    private responseParser: ResponseParser,
    private promptAssembler: PromptAssembler,
    private gamePack: GamePack,
    private paths: EnginePathConfig,
    private memoryManager: MemoryManager,
    private engramManager?: IEngramManager,
  ) {
    this.nameKey = paths.npcFieldNames?.name ?? '名称';
    this.chatHistoryKey = paths.npcFieldNames?.privateChatHistory ?? '私聊历史';

    const rule = (gamePack.rules ?? {}) as Record<string, unknown>;
    const npcChatRule = rule.npcChat as { maxChatHistory?: unknown } | undefined;
    const configured = npcChatRule?.maxChatHistory;
    this.maxChatHistory =
      typeof configured === 'number' && configured > 0 && configured <= 200
        ? Math.floor(configured)
        : DEFAULT_MAX_CHAT_HISTORY;
  }

  /**
   * CR-R7: 游戏加载时对所有 NPC 的 私聊历史 做一次性回溯性 trim
   *
   * 由 `main.ts` 在创角/读档后调用一次。保证即使旧存档有超长历史（或未来
   * maxChatHistory 缩小），所有 NPC 的历史都被收敛到当前上限。
   */
  trimAllChatHistories(): number {
    const list = this.stateManager.get<Array<Record<string, unknown>>>(this.paths.relationships);
    if (!Array.isArray(list)) return 0;

    let trimmedCount = 0;
    const newList = list.map((npc) => {
      if (!npc || typeof npc !== 'object') return npc;
      const history = npc[this.chatHistoryKey];
      if (!Array.isArray(history) || history.length <= this.maxChatHistory) return npc;
      trimmedCount += history.length - this.maxChatHistory;
      return {
        ...npc,
        [this.chatHistoryKey]: history.slice(history.length - this.maxChatHistory),
      };
    });

    if (trimmedCount > 0) {
      this.stateManager.set(this.paths.relationships, newList, 'system');
      console.log(`[NpcChat] Trimmed ${trimmedCount} old chat messages across NPCs`);
    }
    return trimmedCount;
  }

  /**
   * 主入口：玩家向指定 NPC 发一句话，返回 NPC 的回复
   *
   * @param npcName     目标 NPC 的 `名称` 字段值（作为唯一标识）
   * @param userMessage 玩家本次输入的消息
   * @param onStreamChunk  CR-R14：可选的流式回调。当 aiService 启用流式时
   *                       每收到一个 delta 即调用一次。UI 层（NpcChatModal）
   *                       可以拼接 chunk 到一条"pending"气泡上实时展示。
   *                       传 undefined 时退回非流式（一次性返回最终文本）。
   *
   *                       注意：commands / memoryEntry 必须从解析完整响应后才能
   *                       提取，所以流式只覆盖"用户看到的正文逐字输出"这一面，
   *                       副作用仍在响应完成后一次性提交。
   */
  async chat(
    npcName: string,
    userMessage: string,
    onStreamChunk?: (chunk: string) => void,
  ): Promise<NpcChatResult> {
    // CR-R27 (2026-04-11): 规范化用户输入
    // 1. 统一换行符为 \n（消除 Windows \r\n 和 老 Mac \r 混用）
    // 2. 压缩 ≥3 个连续换行为 2 个（防止复制粘贴带来的垂直空白炸屏）
    // 3. 整体 trim
    // 4. 限长 2000 字符（防止一次粘贴整本小说）—— 超长时截断并 warn
    const MAX_USER_INPUT_LENGTH = 2000;
    if (this._isChatInFlight) {
      return { success: false, reply: '', error: '上一条消息仍在处理中' };
    }
    this._isChatInFlight = true;
    try {

    const normalized = userMessage
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!normalized) {
      return { success: false, reply: '', error: '消息不能为空' };
    }
    const trimmed = normalized.length > MAX_USER_INPUT_LENGTH
      ? normalized.slice(0, MAX_USER_INPUT_LENGTH)
      : normalized;
    if (trimmed.length < normalized.length) {
      console.warn(`[NpcChat] user input truncated from ${normalized.length} → ${MAX_USER_INPUT_LENGTH} chars`);
    }

    // ── 1. 获取 NPC 对象 + index（后续 append 历史需要）──
    const npcInfo = this.findNpc(npcName);
    if (!npcInfo) {
      return { success: false, reply: '', error: `未找到 NPC「${npcName}」` };
    }
    const { npc, index } = npcInfo;

    // ── 1b. Capture snapshot BEFORE any state writes (for rollback support) ──
    const snapshot = this.stateManager.toSnapshot();
    _unset(snapshot, this.paths.preRoundSnapshot);
    this._lastChatSnapshot = snapshot;
    this._lastChatNpcName = npcName;
    this._lastChatRound = this.stateManager.get<number>(this.paths.roundNumber) ?? 0;

    // ── 2. 立即把玩家消息 append 到私聊历史 ──
    // 这样即使后续 AI 调用失败，用户消息也已经保存
    const userMsg: NpcChatMessage = {
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    };
    this.appendChatMessage(index, userMsg);

    // ── 3. 组装 prompt 变量 ──
    const variables = this.buildVariables(npcName, npc, trimmed);

    // ── 4. 调 AI ──
    const flow = this.gamePack.promptFlows['npcChat'];
    if (!flow) {
      const err = '[NpcChat] Pack 未注册 npcChat flow';
      console.error(err);
      return { success: false, reply: '', error: err };
    }

    let rawResponse: string;
    try {
      const assembled = this.promptAssembler.assemble(flow, variables);

      // 2026-04-11 fix: post-history 追加 narratorEnforcement + 实际用户输入作为
      // 真正的 user message。之前的 npcChat flow 用纯 system prompt 把 USER_INPUT
      // 埋在系统消息里 —— 同主回合一样的问题：
      //   1. messages 没有以 user 结尾 → Claude prefill
      //   2. 反截断强化不生效
      //   3. jailbreak 框架被前面的 system 冲淡
      // 修复后结构：
      //   [system: npcChat prompt (含 NPC profile / history / user input 上下文)]
      //   [user: narratorEnforcement + <玩家输入>实际输入</玩家输入>]
      // enforcement 渲染和主回合用同一个 narratorEnforcement.md，保持一致。
      const enforcement = this.promptAssembler.renderSingle('narratorEnforcement', variables);
      const finalMessages: AIMessage[] = [...assembled.messages];
      const finalSources = [...assembled.messageSources];
      finalMessages.push({
        role: 'user',
        content: enforcement
          ? `${enforcement}\n\n<玩家输入>\n${trimmed}\n</玩家输入>`
          : trimmed,
      });
      finalSources.push('current_input');

      // Correlation id so PromptAssemblyPanel can match pre-call assembly to
      // the post-call response (thinking + raw).
      const generationId = `npcChat_${npcName}_${Date.now()}`;

      emitPromptAssemblyDebug({
        flow: 'npcChat',
        variables,
        messages: finalMessages,
        messageSources: finalSources,
        generationId,
      });

      // CR-R14: 有 onStreamChunk 时走流式；aiService 内部会按 UsageType 查询分配的
      // API 配置，如果该 API 支持流式且全局 streaming 设置开启就真正 SSE，
      // 否则降级为一次性返回（此时 onStreamChunk 不会被调用，但调用方仍能拿到完整响应）。
      rawResponse = await this.aiService.generate({
        messages: finalMessages,
        usageType: 'npc_chat',
        stream: !!onStreamChunk,
        onStreamChunk,
      });

      emitPromptResponseDebug({
        flow: 'npcChat',
        generationId,
        thinking: extractThinkingFromRaw(rawResponse),
        rawResponse,
      });
    } catch (err) {
      const msg = `[NpcChat] AI 调用失败: ${err instanceof Error ? err.message : String(err)}`;
      console.error(msg);
      return { success: false, reply: '', error: msg };
    }

    // ── 5. 解析响应 ──
    const parsed = this.responseParser.parse(rawResponse);
    const replyText = (parsed.text ?? '').trim();

    if (!replyText) {
      console.warn('[NpcChat] AI 返回空 text', { raw: rawResponse.slice(0, 200) });
      return { success: false, reply: '', error: 'AI 返回空回复' };
    }

    // ── 6. 作用域限制 + 执行 commands ──
    // CR-R8/R15: 只允许修改本 NPC 自己的字段，严格按 npcIndex 匹配
    // npcName + npcIndex 一起传入 filterScopedCommands 以支持过滤器和索引两种语法
    // CR 2026-07-05: index 是 AI 调用 await 之前捕获的，等待期间 NpcDedupModule
    // 的同名融合可能收缩/重排 关系 数组 —— 在校验索引形式命令前必须重新解析，
    // 否则索引形式命令会落在错误的 NPC 上（过滤器形式不受影响，执行时按名重解析）
    const preExecInfo = this.findNpc(npcName);
    const scopeIndex = preExecInfo?.index ?? index;
    const scopedCommands = this.filterScopedCommands(parsed.commands ?? [], npcName, scopeIndex);
    if (scopedCommands.length > 0) {
      this.commandExecutor.executeBatch(scopedCommands);
    }

    // ── 7. Append AI 回复到私聊历史 ──
    // 注意：index 在执行 commands 之后可能变化（如果 commands 重排了 关系 数组）
    // 所以我们重新查找 index 确保 append 到正确位置
    const refreshedInfo = this.findNpc(npcName);
    const appendIndex = refreshedInfo?.index ?? index;
    const aiMsg: NpcChatMessage = {
      role: 'assistant',
      content: replyText,
      timestamp: Date.now(),
    };
    this.appendChatMessage(appendIndex, aiMsg);

    // ── 8. memoryEntry 同步到 NPC.记忆 ──
    // 主线 AI 组装 prompt 时 GAME_STATE_JSON 带上该数组，自然可见
    // CR-R2 修复：改用 ResponseParser 原生解析的 memoryEntry 字段
    if (parsed.memoryEntry) {
      this.appendNpcMemory(appendIndex, parsed.memoryEntry);
    }

    // ── 9. Engram knowledge graph update ──
    if (this.engramManager?.isEnabled() && replyText) {
      try {
        await this.engramManager.processResponse(parsed, this.stateManager);
      } catch (engramErr) {
        console.warn('[NpcChat] Engram processResponse failed (non-blocking):', engramErr);
      }
    }

    return { success: true, reply: replyText };

    } finally {
      this._isChatInFlight = false;
    }
  }

  // ─── Rollback ─────────────────────────────────────────────

  get canRollbackChat(): boolean { return this._lastChatSnapshot !== null; }
  get lastChatNpcName(): string | null { return this._lastChatNpcName; }

  rollbackLastChat(): { success: boolean; error?: string } {
    if (this._isChatInFlight) {
      return { success: false, error: '消息处理中，无法回退' };
    }
    if (!this._lastChatSnapshot) {
      return { success: false, error: '没有可回退的私聊快照' };
    }
    const currentRound = this.stateManager.get<number>(this.paths.roundNumber) ?? 0;
    if (currentRound !== this._lastChatRound) {
      return { success: false, error: '快照期间已推进回合，回退可能导致数据丢失，已阻止' };
    }
    this.stateManager.rollbackTo(this._lastChatSnapshot);
    if (this.engramManager?.isEnabled()) {
      this.engramManager.syncVectorsToState(this.stateManager).catch((e: unknown) =>
        console.warn('[NpcChat] Engram vector sync after rollback failed (non-blocking):', e),
      );
    }
    this._lastChatSnapshot = null;
    this._lastChatNpcName = null;
    this._lastChatRound = -1;
    return { success: true };
  }

  // ─── 内部方法 ──────────────────────────────────────────────

  /**
   * 在 `社交.关系` 数组中按 `名称` 找 NPC
   *
   * 不使用 `社交.关系[名称=X].*` 过滤器路径语法，因为当前
   * state-manager 基于 lodash-es/get 不支持该语法。
   */
  private findNpc(
    npcName: string,
  ): { npc: Record<string, unknown>; index: number } | null {
    const list = this.stateManager.get<Array<Record<string, unknown>>>(this.paths.relationships);
    if (!Array.isArray(list)) return null;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item && typeof item === 'object' && item[this.nameKey] === npcName) {
        return { npc: item, index: i };
      }
    }
    return null;
  }

  /**
   * Append 一条消息到 NPC 的私聊历史
   *
   * 超过 `maxChatHistory`（来自 pack config）时丢弃最旧的 N 条。
   * 用 read-modify-write 整个 `社交.关系` 数组，避免 lodash path 过滤器问题。
   */
  private appendChatMessage(index: number, msg: NpcChatMessage): void {
    const list = this.stateManager.get<Array<Record<string, unknown>>>(this.paths.relationships);
    if (!Array.isArray(list) || index < 0 || index >= list.length) return;

    const npc = { ...list[index] };
    const history = Array.isArray(npc[this.chatHistoryKey])
      ? [...(npc[this.chatHistoryKey] as unknown[])]
      : [];
    history.push(msg);

    // 保留最近 this.maxChatHistory 条
    if (history.length > this.maxChatHistory) {
      history.splice(0, history.length - this.maxChatHistory);
    }

    npc[this.chatHistoryKey] = history;
    const newList = [...list];
    newList[index] = npc;
    this.stateManager.set(this.paths.relationships, newList, 'system');
  }

  /**
   * Append 一条 memoryEntry 到 NPC 的 `记忆` 数组
   *
   * 与 `私聊历史` 独立：`记忆` 是摘要式的长期线索，会出现在主线
   * `GAME_STATE_JSON` 中供主线 AI 感知此次私聊的结果。
   */
  private appendNpcMemory(index: number, entry: string): void {
    const list = this.stateManager.get<Array<Record<string, unknown>>>(this.paths.relationships);
    if (!Array.isArray(list) || index < 0 || index >= list.length) return;

    const npc = { ...list[index] };
    const memoryKey = this.paths.npcFieldNames?.memory ?? '记忆';
    const memoryList = Array.isArray(npc[memoryKey])
      ? [...(npc[memoryKey] as unknown[])]
      : [];

    if (isDuplicateMemory(entry, memoryList)) {
      const nameKey = this.paths.npcFieldNames?.name ?? '名称';
      console.debug(
        `[NpcChat] Suppressed duplicate memory for ${String(npc[nameKey])}: ${entry.slice(0, 50)}…`,
      );
      return;
    }

    memoryList.push(entry);
    npc[memoryKey] = memoryList;

    const newList = [...list];
    newList[index] = npc;
    this.stateManager.set(this.paths.relationships, newList, 'system');
  }

  /**
   * CR-R8 / CR-R15 修复（2026-04-11）：严格作用域校验
   *
   * 只允许命令写入**当前对话 NPC**的字段，不允许：
   * - 非 `社交.关系` 前缀的路径（涉及其他实体）
   * - `社交.关系` 根路径（会替换整个数组）
   * - `社交.关系[N]` 索引指向其他 NPC（通过 index 或 filter 语法）
   * - `社交.关系[名称=其他 NPC名]` 过滤器指向其他 NPC
   *
   * 依赖 CR-R1 已修复的 StateManager 过滤器路径解析器 —
   * 但我们在这里要做**前置**校验，所以需要独立解析过滤器段。
   *
   * 被拒绝的命令记录到 warnSet（同一 session 同样的 root+reason 只 warn 一次）。
   */
  private filterScopedCommands(commands: Command[], npcName: string, npcIndex: number): Command[] {
    const relationshipsPath = this.paths.relationships; // e.g. '社交.关系'
    const allowed: Command[] = [];
    const rejected: string[] = [];

    for (const cmd of commands) {
      const path = cmd.key ?? '';

      // 1. 必须以 relationshipsPath 开头
      if (!path.startsWith(relationshipsPath)) {
        rejected.push(`${path}（非社交.关系子路径）`);
        continue;
      }

      // 2. 不能正好等于 relationshipsPath（会替换整个数组）
      if (path === relationshipsPath) {
        rejected.push(`${path}（整个关系数组不可整体覆盖）`);
        continue;
      }

      // 3. 提取紧跟 relationshipsPath 之后的那一段，判断是否指向当前 NPC
      //    可能的格式：
      //    a. `社交.关系[N].字段`           — 索引形式，N 必须 === npcIndex
      //    b. `社交.关系[名称=X].字段`       — 过滤器形式，X 必须 === npcName
      //    c. `社交.关系.字段`              — 整个数组的字段（如 '社交.关系.length'），拒绝
      //
      //    relationshipsPath 长度 = '社交.关系'.length = 5（中文字符计数）
      //    下一个字符必须是 '[' 或 '.' 否则格式畸形
      const rest = path.slice(relationshipsPath.length); // e.g. `[名称=X].好感度` or `[3].好感度`
      if (rest.startsWith('.')) {
        // 形式 c：直接访问整个数组字段（或键名不规范）
        rejected.push(`${path}（未指向具体 NPC 元素）`);
        continue;
      }
      if (!rest.startsWith('[')) {
        // 其他畸形格式
        rejected.push(`${path}（格式不识别）`);
        continue;
      }

      // 解析 `[...]` 中内容
      const closeBracket = rest.indexOf(']');
      if (closeBracket === -1) {
        rejected.push(`${path}（括号不闭合）`);
        continue;
      }
      const bracketContent = rest.slice(1, closeBracket);

      // 过滤器形式 `[名称=X]`
      const filterMatch = bracketContent.match(/^([^=]+)=(.+)$/);
      if (filterMatch) {
        const [, filterField, filterValue] = filterMatch;
        // 必须是 `[名称=当前NPC名]`
        if (filterField.trim() !== this.nameKey || filterValue.trim() !== npcName) {
          rejected.push(`${path}（过滤器指向其他 NPC）`);
          continue;
        }
        allowed.push(cmd);
        continue;
      }

      // 索引形式 `[N]`
      const idxNum = Number(bracketContent);
      if (Number.isInteger(idxNum)) {
        if (idxNum !== npcIndex) {
          rejected.push(`${path}（索引 ${idxNum} 不是当前 NPC 的 ${npcIndex}）`);
          continue;
        }
        allowed.push(cmd);
        continue;
      }

      // 其他不识别格式
      rejected.push(`${path}（未识别的括号内容）`);
    }

    if (rejected.length > 0) {
      console.warn(
        `[NpcChat] 拒绝 ${rejected.length} 条越权命令（NPC「${npcName}」）:`,
        rejected,
      );
    }

    return allowed;
  }

  /** 组装 prompt 变量 */
  private buildVariables(
    npcName: string,
    npc: Record<string, unknown>,
    userMessage: string,
  ): Record<string, string> {
    const playerName = this.stateManager.get<string>(this.paths.playerName) ?? '玩家';
    const playerLocation = this.stateManager.get<string>(this.paths.playerLocation) ?? '未知';
    const worldDesc = this.stateManager.get<string>(this.paths.worldDescription) ?? '';
    const gameTime = this.formatGameTime();

    // P2 env-tags port (2026-04-19): inject env block so NPC private chat
    // can reference weather / festival / environment in their replies
    // ("这雨下得好大" / "元宵节快乐"). npcChat does NOT emit env/weather/festival
    // writes — its commands are restricted to `社交.关系[名称=X].*` paths.
    const environmentBlock = buildEnvironmentBlock({
      weather: this.stateManager.get<unknown>(this.paths.weather),
      festival: this.stateManager.get<unknown>(this.paths.festival),
      environment: this.stateManager.get<unknown>(this.paths.environmentTags),
    });

    // Narrative Contract (R2 second batch, 2026-09-05): a private chat develops a
    // character directly, so the player's clauses (e.g. an NPC's true colours) and
    // the focal cast reach it through the same block the main round gets. Empty
    // contract → '' → the `narrativeContract` flow module is skipped.
    const { block: narrativeContractBlock } = buildNarrativeContractFromState(
      this.stateManager, this.paths, this.gamePack.engineFragments,
    );

    return {
      NPC_NAME: npcName,
      NPC_PROFILE: this.formatNpcProfile(npc),
      PLAYER_NAME: playerName,
      PLAYER_LOCATION: playerLocation,
      WORLD_DESCRIPTION: worldDesc || '（无世界背景描述）',
      GAME_TIME: gameTime,
      SHORT_TERM_MEMORY: this.formatShortTermMemory(),
      CHAT_HISTORY: this.formatChatHistory(npc),
      USER_INPUT: userMessage,
      ENVIRONMENT_BLOCK: environmentBlock,
      NARRATIVE_CONTRACT: narrativeContractBlock ? '1' : '',
      NARRATIVE_CONTRACT_BLOCK: narrativeContractBlock,
    };
  }

  /** 组装 NPC profile 文本块 */
  private formatNpcProfile(npc: Record<string, unknown>): string {
    const lines: string[] = [];
    const push = (label: string, value: unknown): void => {
      if (value === undefined || value === null) return;
      if (typeof value === 'string' && !value.trim()) return;
      if (Array.isArray(value) && value.length === 0) return;
      if (typeof value === 'object' && !Array.isArray(value)) return; // 跳过嵌套对象
      const formatted = Array.isArray(value) ? (value as string[]).join('、') : String(value);
      lines.push(`- **${label}**：${formatted}`);
    };

    push(this.nameKey, npc[this.nameKey]);
    push('类型', npc['类型']);
    push('性别', npc['性别']);
    push('年龄', npc['年龄']);
    push('当前位置', npc['位置']);
    push('好感度', npc['好感度']);
    push('描述', npc['描述']);
    push('背景', npc['背景']);
    push('性格特征', npc['性格特征']);
    push('内心想法', npc['内心想法']);
    push('在做事项', npc['在做事项']);

    const memoryKey = this.paths.npcFieldNames?.memory ?? '记忆';
    const memory = npc[memoryKey];
    if (Array.isArray(memory) && memory.length > 0) {
      lines.push(`- **过往记忆**：`);
      for (const m of memory.slice(-10)) {
        const rendered = formatMemoryEntry(m);
        if (!rendered) continue;
        lines.push(`  - ${rendered}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 游戏内时间文本表示
   *
   * CR-R25 (2026-04-11): 支持中/英两套字段名 fallback。
   * 原实现只读 `年/月/日/小时/分钟`，但不同 pack 可能用 `year/month/day/hour/minute`。
   * 本函数同时尝试两套键名，任一命中即使用；两者都缺则返回 "未知"。
   * 不引入 locale 服务，只是最小 fallback —— 契约仍是中文 key 优先。
   */
  private formatGameTime(): string {
    const t = this.stateManager.get<Record<string, unknown>>(this.paths.gameTime);
    if (!t || typeof t !== 'object') return '未知';
    const pick = (cn: string, en: string): unknown => t[cn] ?? t[en];
    const year = pick('年', 'year') ?? 0;
    const month = pick('月', 'month') ?? 0;
    const day = pick('日', 'day') ?? 0;
    const hour = pick('小时', 'hour');
    const minute = pick('分钟', 'minute');
    let s = `${year}年${month}月${day}日`;
    if (typeof hour === 'number' && typeof minute === 'number') {
      s += ` ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
    return s;
  }

  /** 短期记忆摘要 — 让 NPC 知道主线最近发生了什么 */
  private formatShortTermMemory(): string {
    const entries = this.memoryManager.getShortTermEntries();
    if (entries.length === 0) return '（暂无最近剧情）';
    return entries
      .slice(-5) // 最近 5 条
      .map((e) => `[第${e.round}回合] ${e.summary}`)
      .join('\n\n');
  }

  /** 格式化该 NPC 已有的私聊历史，供 prompt 注入 */
  private formatChatHistory(npc: Record<string, unknown>): string {
    const history = npc[this.chatHistoryKey];
    if (!Array.isArray(history) || history.length === 0) {
      return '（首次私聊）';
    }

    return (history as NpcChatMessage[])
      .slice(-this.maxChatHistory)
      .map((msg) => {
        const who = msg.role === 'user' ? '玩家' : (npc[this.nameKey] ?? 'NPC');
        return `**${who}**：${msg.content}`;
      })
      .join('\n\n');
  }
}
