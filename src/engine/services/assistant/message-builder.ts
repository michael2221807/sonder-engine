/**
 * MessageBuilder — 装配发给 AIService.generate 的 messages 数组
 *
 * 装配顺序：
 * 1. system: assistantJailbreak（每次都注入）
 * 2. system: assistantInjectionContract（仅当当前 turn 含 target attachment）
 * 3. 历史消息（FIFO 已 trim 后的 user/assistant/system 序列）
 *    - user：渲染时仅展示 attachment label，不重发完整 snapshot（5.1-B 决策）
 *    - assistant：原文；含 patches 的 JSON 会被 stripPayloadJson 替换成占位语
 *    - system (synthetic)：转成 system role 注入
 * 4. user (current turn): 包含完整 attachment payload（snapshot + schema fragment）+ user prompt
 *
 * 对应 docs/status/plan-assistant-utility-2026-04-14.md §4 + Phase 4。
 */
import type { AIMessage } from '../../ai/types';
import type { GamePack } from '../../types';
import type { PromptTextSource } from '../../prompt/prompt-assembler';
import type {
  AssistantMessage,
  AttachmentPayload,
  AttachmentSummary,
} from './types';

export interface BuildMessagesInput {
  history: AssistantMessage[];        // FIFO trim 后的历史
  userPrompt: string;
  attachments: AttachmentPayload[];   // 当前 turn 的完整附件
  gamePack: GamePack | null;
  /** Story 3: when true, injects assistantWorldBuilder prompt module */
  worldBuilderMode?: boolean;
  /** The prompts as the prompt page left them (item 2, PO 2026-10-05); without it, the pack's text. */
  prompts?: PromptTextSource;
}

export class MessageBuilder {
  build(input: BuildMessagesInput): AIMessage[] {
    const messages: AIMessage[] = [];
    const packPrompts = input.gamePack?.prompts;
    const text = (id: string): string =>
      (input.prompts ? input.prompts.effectiveText(id, packPrompts) : packPrompts?.[id] ?? '').trim();

    // 1. Jailbreak
    const jailbreak = text('assistantJailbreak');
    if (jailbreak) {
      messages.push({ role: 'system', content: jailbreak });
    }

    // 1.5. World Builder mode prompt (Story 3 — between jailbreak and injection contract)
    if (input.worldBuilderMode) {
      const worldBuilder = text('assistantWorldBuilder');
      if (worldBuilder) {
        messages.push({ role: 'system', content: worldBuilder });
      }
    }

    // 2. Injection contract（仅 Mode B）
    const hasTarget = input.attachments.some((a) => a.scope === 'target');
    if (hasTarget) {
      const contract = text('assistantInjectionContract');
      if (contract) {
        messages.push({ role: 'system', content: contract });
      }
    }

    // 3. 历史
    for (const msg of input.history) {
      const aiMsg = this.renderHistoryMessage(msg);
      if (aiMsg) messages.push(aiMsg);
    }

    // 4. 当前 turn
    messages.push({
      role: 'user',
      content: this.renderCurrentUserTurn(input.userPrompt, input.attachments),
    });

    return messages;
  }

  /**
   * 历史消息渲染：
   * - user：prompt 文本 + attachment label（不带 snapshot）
   * - assistant：原文
   * - system synthetic：转成简短的 system 提示
   */
  private renderHistoryMessage(msg: AssistantMessage): AIMessage | null {
    if (msg.role === 'user') {
      return {
        role: 'user',
        content: this.renderHistoryUserContent(msg.content, msg.attachments ?? []),
      };
    }
    if (msg.role === 'assistant') {
      return { role: 'assistant', content: this.stripPayloadJson(msg.content) };
    }
    // system synthetic：仅注入 inject-success / inject-rolled-back，
    // 让 AI 知道 "上一次注入已应用 / 已撤销"
    if (msg.role === 'system' && msg.systemKind) {
      const sysContent = this.renderHistorySystemContent(msg);
      if (sysContent) return { role: 'system', content: sysContent };
    }
    return null;
  }

  private renderHistoryUserContent(prompt: string, attachments: AttachmentSummary[]): string {
    if (attachments.length === 0) return prompt;
    const labels = attachments.map((a) => `[${a.scope === 'target' ? '✏ 目标' : '📖 参考'}: ${a.label}]`);
    return `${prompt}\n\n（用户当时附加：${labels.join(' ')} —— 数据快照不再附上）`;
  }

  private renderHistorySystemContent(msg: AssistantMessage): string | null {
    switch (msg.systemKind) {
      case 'inject-success':
        return `[系统]上一次的 patch 已成功注入到游戏数据。`;
      case 'inject-rolled-back':
        return `[系统]上一次的注入已被用户撤销，状态树已恢复到注入前。`;
      case 'inject-failed':
        return `[系统]上一次注入因校验失败被取消。`;
      case 'cleared':
      case 'ai-error':
      default:
        return null;
    }
  }

  /**
   * 当前 turn 的 user message —— 含完整 attachment 数据
   *
   * 格式：
   *   <用户 prompt>
   *
   *   ## 附件（参考）：世界·描述
   *   当前值: ...
   *   schema: ...
   *
   *   ## 附件（目标）：社交·关系
   *   ...
   */
  private renderCurrentUserTurn(prompt: string, attachments: AttachmentPayload[]): string {
    if (attachments.length === 0) return prompt;

    const sections: string[] = [prompt];
    const contextAttachments = attachments.filter((a) => a.scope === 'context');
    const targetAttachments = attachments.filter((a) => a.scope === 'target');

    if (contextAttachments.length > 0) {
      sections.push('## 附件（参考，只读）');
      for (const a of contextAttachments) {
        sections.push(this.renderAttachmentBlock(a));
      }
    }

    if (targetAttachments.length > 0) {
      sections.push('## 附件（目标，需要你按 patch 协议修改这条）');
      for (const a of targetAttachments) {
        sections.push(this.renderAttachmentBlock(a));
      }
    }

    return sections.join('\n\n');
  }

  /** 单条 attachment 的展开块（含 snapshot + 关键 schema 提示） */
  private renderAttachmentBlock(a: AttachmentPayload): string {
    const lines: string[] = [`### ${a.label} （路径：\`${a.path}\`）`];
    if (a.nsfwStripped) {
      lines.push('⚠ 提示：因 NSFW 模式关闭，敏感子树（如 `私密信息` / `角色.身体`）已剥离');
    }

    // schema 提示：仅展示 type/$comment/required，避免太长
    const schemaSummary = summarizeSchema(a.schemaFragment);
    if (schemaSummary) {
      lines.push('**字段契约**：');
      lines.push('```');
      lines.push(schemaSummary);
      lines.push('```');
    }

    lines.push('**当前值**：');
    lines.push('```json');
    lines.push(JSON.stringify(a.snapshot, null, 2));
    lines.push('```');
    return lines.join('\n');
  }

  /**
   * 从历史 assistant 消息中剥掉 JSON payload 块，只保留自然语言。
   * 避免 AI 看到上一轮的 patches 并在新回复中重复它们。
   */
  private stripPayloadJson(content: string): string {
    const stripped = content
      .replace(/```json\s*\{[\s\S]*?"patches"\s*:[\s\S]*?```/g, '[此处的 patch 数据已省略]')
      .replace(/\{[\s\S]*?"patches"\s*:\s*\[[\s\S]*?\]\s*\}/g, '[patch 数据已省略]');
    return stripped.trim() || content;
  }
}

/**
 * 把 schema 片段压成给 AI 看的简短描述
 *
 * 输出格式：
 *   type: <type>
 *   - <field>: <type>（<必填? + 范围? + comment 摘要>）
 */
function summarizeSchema(schema: Record<string, unknown>): string {
  if (!schema || Object.keys(schema).length === 0) return '';
  const lines: string[] = [];
  const type = schema['type'];
  if (typeof type === 'string') lines.push(`type: ${type}`);

  const props = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (props) {
    const required = (schema['required'] as string[]) ?? [];
    for (const [key, sub] of Object.entries(props)) {
      lines.push(`- ${key}: ${describeField(sub, required.includes(key))}`);
    }
  }

  // array 的 items
  const items = schema['items'] as Record<string, unknown> | undefined;
  if (items && type === 'array') {
    lines.push('items:');
    const sub = summarizeSchema(items);
    sub.split('\n').forEach((l) => lines.push('  ' + l));
  }

  return lines.join('\n');
}

function describeField(sub: Record<string, unknown>, required: boolean): string {
  const parts: string[] = [];
  const type = sub['type'];
  if (typeof type === 'string') parts.push(type);
  if (required) parts.push('必填');
  if (typeof sub['minimum'] === 'number') parts.push(`min=${sub['minimum']}`);
  if (typeof sub['maximum'] === 'number') parts.push(`max=${sub['maximum']}`);
  if (Array.isArray(sub['enum'])) parts.push(`enum=${JSON.stringify(sub['enum'])}`);
  const comment = sub['$comment'];
  if (typeof comment === 'string' && comment.length > 0) {
    const trimmed = comment.length > 80 ? comment.slice(0, 80) + '…' : comment;
    parts.push(`「${trimmed}」`);
  }
  return parts.join('，');
}
