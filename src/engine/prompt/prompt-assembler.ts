/**
 * Prompt 组装器 — 按 PromptFlowConfig 组装最终的 AIMessage[]
 *
 * 核心设计（与 demo 的关键差异）：
 * - demo 输出单个 system prompt 字符串
 * - 正式版输出 AIMessage[]，每个模块保持独立的 role 和 depth
 *
 * depth 注入机制：
 * - depth=0: 放在聊天历史之前（系统消息区，最先被 AI 看到）
 * - depth=N: 从聊天历史末尾往前第 N 条之前插入
 *   （越大越靠前，用于将重要上下文放在"最近记忆"附近）
 *
 * 注入顺序策略：
 * - 按 depth 从大到小排序后依次 splice
 * - 大 depth 先插入，避免后续插入导致索引偏移
 *
 * 对应 STEP-03B M2.6 prompt-assembler.ts。
 * 参照 demo: promptAssembler.ts assembleSystemPrompt。
 */
import type { PromptFlowConfig } from '../types';
import type { AIMessage } from '../ai/types';
import type { PromptRegistry } from './prompt-registry';
import type { TemplateEngine } from './template-engine';
import type { RawPromptTransform } from './raw-prompt-transform';

/**
 * 消息来源标签 —— 2026-04-14 新增
 *
 * 用于 PromptAssemblyPanel 的"每条消息出处"显示。
 * 格式：
 * - `module:<promptId>` —— 来自 prompt flow 中的某个模块（如 `module:mainRound`）
 * - `history:user` / `history:assistant` —— 来自 chatHistory 的叙事轮次
 * - `placeholder` —— 安全兜底（system-only 消息时补的 user 占位）
 * - `current_input` —— 当前回合用户输入（由 ContextAssembly 追加，不由 assembler 产出）
 */
export type MessageSourceTag = string;

/** 组装结果 — 包含最终消息和调试用的 sections 信息 */
export interface AssembleResult {
  /** 按 role + depth 构建的消息列表 — 可直接传给 AIService */
  messages: AIMessage[];
  /**
   * 平行数组：每条消息的来源标签
   * messageSources.length === messages.length
   * 2026-04-14 新增，供 PromptAssemblyPanel 显示"这条消息来自哪"。
   */
  messageSources: MessageSourceTag[];
  /** 各模块渲染后的详细信息 — 用于调试面板展示 */
  sections: Array<{
    moduleId: string;
    role: AIMessage['role'];
    depth: number;
    content: string;
  }>;
}

export class PromptAssembler {
  constructor(
    private registry: PromptRegistry,
    private templateEngine: TemplateEngine,
    private transform?: RawPromptTransform,
  ) {}

  /** A round-local view; the shared registry and other pipelines remain unchanged. */
  withTransform(transform?: RawPromptTransform): PromptAssembler {
    return transform ? new PromptAssembler(this.registry, this.templateEngine, transform) : this;
  }

  private content(promptId: string): string | null {
    const raw = this.registry.getEffectiveContent(promptId);
    return raw ? (this.transform?.(promptId, raw) ?? raw) : null;
  }

  /**
   * The pack's prompts as a round sends them: the player's edited text or the pack's, '' when switched off; a
   * `required` prompt keeps its text even when switched off, and one the registry does not know keeps the pack's
   * text. Untransformed: the story request's builder applies the round's transform itself.
   */
  effectivePrompts(packPrompts: Readonly<Record<string, string>>, required: ReadonlySet<string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, text] of Object.entries(packPrompts)) {
      out[id] = !this.registry.has(id) ? text
        : required.has(id) ? this.registry.getRequiredContent(id) : this.registry.getEffectiveContent(id);
    }
    return out;
  }

  /**
   * 按 flow 配置组装 prompt → AIMessage[]
   *
   * @param flow 当前使用的 prompt flow 配置
   * @param variables 模板变量（由 ContextAssemblyStage 收集）
   * @param chatHistory 已有的叙事消息列表（user/assistant 交替）
   */
  assemble(
    flow: PromptFlowConfig,
    variables: Record<string, string>,
    chatHistory: AIMessage[] = [],
  ): AssembleResult {
    const sections: AssembleResult['sections'] = [];

    // 按 order 排序模块
    const sortedModules = [...flow.modules].sort((a, b) => a.order - b.order);

    // 分两类收集：depth=0 的前置消息 和 depth>0 的注入消息
    // 2026-04-14：同时跟踪每条消息的来源模块 ID（用于 debug panel 的出处显示）
    const depthZeroMessages: AIMessage[] = [];
    const depthZeroSources: MessageSourceTag[] = [];
    const depthInjections: Array<{ depth: number; message: AIMessage; source: MessageSourceTag }> = [];

    for (const mod of sortedModules) {
      // 条件检查：如果模块设置了 condition，对应变量必须为 truthy
      if (mod.condition && !variables[mod.condition]) {
        console.debug(`[PromptAssembler] Skipped "${mod.promptId}" — condition "${mod.condition}" is falsy`);
        continue;
      }

      // 获取模块内容（优先用户覆盖 → 默认内容）
      const content = this.content(mod.promptId);
      if (!content) {
        console.debug(`[PromptAssembler] Skipped "${mod.promptId}" — empty content (not registered or disabled)`);
        continue;
      }

      // 模板变量替换
      const rendered = this.templateEngine.render(content, variables);
      const role = mod.role ?? 'system';
      const depth = mod.depth ?? 0;

      // 记录 section（调试用）
      sections.push({ moduleId: mod.promptId, role, depth, content: rendered });

      const message: AIMessage = { role, content: rendered };
      const source: MessageSourceTag = `module:${mod.promptId}`;
      if (depth === 0) {
        depthZeroMessages.push(message);
        depthZeroSources.push(source);
      } else {
        depthInjections.push({ depth, message, source });
      }
    }

    // 构建最终消息列表 + 并行来源数组
    const finalMessages: AIMessage[] = [...depthZeroMessages];
    const finalSources: MessageSourceTag[] = [...depthZeroSources];

    // historyClone 每项都打 history:<role> 标签
    const historyClone: AIMessage[] = [...chatHistory];
    const historySources: MessageSourceTag[] = chatHistory.map((m) => `history:${m.role}`);

    // 按 depth 从大到小排序后注入；同时同步 sources 数组
    depthInjections.sort((a, b) => b.depth - a.depth);
    for (const inj of depthInjections) {
      const insertIdx = Math.max(0, historyClone.length - inj.depth);
      historyClone.splice(insertIdx, 0, inj.message);
      historySources.splice(insertIdx, 0, inj.source);
    }

    finalMessages.push(...historyClone);
    finalSources.push(...historySources);

    // 安全守护：如果最终消息全是 system 角色（没有 user/assistant），追加一条 user
    // placeholder。详见下方注释保留的原说明。
    if (finalMessages.length > 0 && finalMessages.every((m) => m.role === 'system')) {
      finalMessages.push({ role: 'user', content: '请根据以上设定开始。' });
      finalSources.push('placeholder');
    }

    return { messages: finalMessages, messageSources: finalSources, sections };
  }

  /**
   * 渲染单个 prompt 模块为字符串（不包含 flow/depth 逻辑）
   *
   * 2026-04-11 新增 —— 供 `ContextAssemblyStage` 在 post-history 位置插入
   * `narratorEnforcement`（或其他短 prompt）使用。调用方负责把返回的字符串
   * 包装成合适 role 的 message 追加到消息列表末尾。
   *
   * 与 `assemble()` 的区别：
   * - 不需要 flow 配置（直接按 promptId 查 registry）
   * - 不返回 sections 调试信息（调用方通常只需要字符串）
   * - 不做 depth 注入（调用方决定消息的位置和 role）
   * - 走和 `assemble()` 同一套 `registry.getEffectiveContent` + `templateEngine.render`，
   *   用户覆盖和变量替换行为一致
   *
   * @param promptId 要渲染的 prompt ID（须在 manifest.prompts 里注册）
   * @param variables 模板变量
   * @returns 渲染后的字符串；promptId 不存在或内容为空时返回 null
   */
  renderSingle(promptId: string, variables: Record<string, string>): string | null {
    const content = this.content(promptId);
    if (!content) return null;
    return this.templateEngine.render(content, variables);
  }
}
