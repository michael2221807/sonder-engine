/**
 * ResponseRepairStage — 主回合响应救援 (2026-04-19)
 *
 * 触发条件：`ctx.parsedResponse.parseOk === false`。意味着 AICallStage 已经
 * 跑完 ResponseParser 的三个 tryParseJson 策略（含 escape sanitizer），但
 * 都没拿到结构化 JSON。这是严重畸形的场景——正常情况下应该通过 sanitizer
 * 救回来，走到 repair 说明 JSON 被切掉了一半 / 缺闭合大括号 / 字段名错误
 * 等更深层的问题。
 *
 * 两阶段救援：
 *   1. **正文抢救**（无 AI 调用）：如果 rawResponse 里有 `<正文>...</正文>`
 *      块，直接把块内容当作 narrative text。这避免 body polish 把一整团
 *      JSON 源码当成叙事去优化。
 *   2. **结构救援**（AI 调用）：针对 commands / mid_term_memory /
 *      action_options / semantic_memory 再发一次请求，让模型只输出这几个
 *      字段的合法 JSON。成功的话合入 parsedResponse，失败就算了——保持
 *      parseOk=false 让下游至少看到 narrative 不崩。
 *
 * 为什么放在 AICall 之后、BodyPolish 之前：
 *   - 在 BodyPolish 前拿到干净的 text 很重要，否则 polish 会把 JSON 源码
 *     当正文去"润色"，结果是把一堆 `{"text":"...` 洗进最终叙事。
 *   - 在 CommandExecution 前拿到 commands 也很重要，否则本回合的时间 /
 *     精力 / NPC 状态全部不推进，用户以为发生了什么但 save 里什么都没变。
 *
 * 不处理：split-gen 第 2 步的 parseOk=false。分步生成的 step2 专门生成
 * 结构化字段，它的格式错误不是这个 stage 的范围（那需要 AICallStage 里
 * 就做 retry，不是事后补救）。
 */
import type { PipelineStage, PipelineContext } from '../types';
import type { AIService } from '../../ai/ai-service';
import type { ResponseParser } from '../../ai/response-parser';
import type { AIMessage } from '../../ai/types';
import {
  emitPromptAssemblyDebug,
  emitPromptResponseDebug,
  extractThinkingFromRaw,
} from '../../core/prompt-debug';

/**
 * 从 raw text 里抽出 `<正文>...</正文>` 块的正文内容
 *
 * 行为与 body-polish-stage.ts 的 `extractBodyFromPolishOutput` 一致，但复制
 * 到这里避免跨 stage 循环依赖。策略：找最后一个开标签（跳过 thinking block
 * 里可能出现的例子）、到匹配关闭标签或结尾之间的内容。失败返回 null（注意：
 * 空字符串也算失败，因为一个空 `<正文></正文>` 不是救援信号）。
 */
export function extractNarrativeFromWrapper(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const openRe = /<\s*正文\s*>/gi;
  let lastOpen: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(raw)) !== null) {
    lastOpen = m;
  }
  if (!lastOpen) return null;
  const afterOpen = raw.slice(lastOpen.index + lastOpen[0].length);
  const closeMatch = afterOpen.match(/<\s*\/\s*正文\s*>/i);
  const body = closeMatch ? afterOpen.slice(0, closeMatch.index) : afterOpen;
  const trimmed = body.replace(/^[\t ]+|[\t ]+$/gm, '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Canon Capture provenance gate (design §5.6).
 *
 * `ResponseRepairStage` hands the model the ENTIRE malformed output — narrative
 * included — and asks it to rebuild the JSON. A prompt rule saying "do not infer
 * settings from the narrative" cannot be enforced: the repair model is perfectly
 * capable of inventing a plausible `setting_updates` array from the prose.
 *
 * So the gate is code, not prompt: unless the original malformed output actually
 * contains the field, anything the repair returns for it is discarded outright.
 * (Candidates that DO pass still go through every `SettingCaptureStage` check —
 * repair is not a back door around the evidence rule.)
 */
export function hasSettingUpdatesTrace(raw: string | undefined): boolean {
  if (!raw || typeof raw !== 'string') return false;
  return /["']?setting_updates["']?\s*:/u.test(raw);
}

const SETTING_UPDATES_REPAIR_FIELD =
  '- `setting_updates` —— 玩家本回合用 `<设定>` 标记的长期设定数组，' +
  '**只能从畸形原文中原样提取**，绝对不允许从叙事正文推断或补写；找不到就输出 `[]`';

const REPAIR_SYSTEM_PROMPT = [
  '你是一个 JSON 修复助手。',
  '用户会给你一段 **畸形** 的 LLM 输出（包含叙事正文 + 本应是 JSON 的结构化字段，但 JSON 被破坏了）。',
  '你的任务是从中**提取**下列字段，重新输出一个**合法的** JSON 对象：',
  '',
  '- `text` —— 本回合叙事正文（优先从 `<正文>...</正文>` 块或 `"text": "..."` 片段提取）',
  '- `commands` —— 状态变更指令数组（每项 `{action, path, value}`）',
  '- `mid_term_memory` —— 中期记忆对象（相关角色 / 事件时间 / 记忆主体），若无则 `null`',
  '- `action_options` —— 3-5 个短字符串，玩家下一步可选行动',
  '- `knowledge_facts` —— 知识事实数组 `[{fact, source_entity, target_entity}]`，若无则 `[]`',
  '',
  '**硬规则**：',
  '1. 只输出一个合法 JSON 对象。不加任何解释、前缀、后缀、代码围栏、thinking 标签。',
  '2. 不虚构信息。如果原文里某字段缺失或不清晰，就写合理的默认值（commands: [], action_options: []），不要编造。',
  '3. 不要改写 `text` 的内容——只做 JSON 转义修正（例如把多吐的 `\\你` 改回 `你`，把 `\\n` 保留为换行）。',
  '4. `commands` 里的 `action` 必须是 `set` / `add` / `push` / `delete` / `pull` 之一。',
  '5. 保留所有 `〖...〗` 判定块 byte-identical。',
].join('\n');

export class ResponseRepairStage implements PipelineStage {
  name = 'ResponseRepair';

  constructor(
    private aiService: AIService,
    private responseParser: ResponseParser,
  ) {}

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    const parsed = ctx.parsedResponse;
    if (!parsed || parsed.parseOk !== false) return ctx;
    if (!ctx.rawResponse || !ctx.rawResponse.trim()) return ctx;

    ctx.onProgress?.({ i18nKey: 'engine.progress.responseRepair', message: '[ResponseRepair:救援中]' });

    // Step 1: 正文抢救 —— 零成本
    let recoveredText: string | null = extractNarrativeFromWrapper(ctx.rawResponse);

    // Step 2: 结构救援 —— AI 调用
    let recoveredCommands = parsed.commands;
    let recoveredMemory = parsed.midTermMemory;
    let recoveredOptions = parsed.actionOptions;
    let recoveredKnowledgeFacts = parsed.knowledgeFacts;
    let recoveredSettingUpdates = parsed.settingUpdates;
    let structureRescued = false;

    try {
      // Only ask for `setting_updates` when the malformed output actually had it —
      // asking for a field that was never there invites the model to invent one.
      const wantSettingUpdates = hasSettingUpdatesTrace(ctx.rawResponse);
      const systemPrompt = wantSettingUpdates
        ? REPAIR_SYSTEM_PROMPT.replace(
            '\n\n**硬规则**：',
            `\n${SETTING_UPDATES_REPAIR_FIELD}\n\n**硬规则**：`,
          )
        : REPAIR_SYSTEM_PROMPT;

      const messages: AIMessage[] = [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `<畸形输出>\n${ctx.rawResponse}\n</畸形输出>\n\n请输出修复后的合法 JSON 对象。`,
        },
      ];

      const repairGenId = `${ctx.generationId ?? ''}_repair`;

      emitPromptAssemblyDebug({
        flow: 'responseRepair',
        variables: {},
        messages,
        messageSources: ['builder:responseRepair_system', 'current_input'],
        generationId: repairGenId,
        roundNumber: ctx.roundNumber,
      });

      const raw = await this.aiService.generate({
        messages,
        stream: false,
        usageType: 'field_repair',
        generationId: repairGenId,
        signal: ctx.abortSignal,
      });

      emitPromptResponseDebug({
        flow: 'responseRepair',
        generationId: repairGenId,
        thinking: extractThinkingFromRaw(raw),
        rawResponse: raw,
      });

      const repaired = this.responseParser.parse(raw);
      if (repaired.parseOk) {
        structureRescued = true;
        if (repaired.commands && repaired.commands.length > 0) {
          recoveredCommands = repaired.commands;
        } else if (!recoveredCommands) {
          recoveredCommands = [];
        }
        if (repaired.midTermMemory != null) recoveredMemory = repaired.midTermMemory;
        if (repaired.actionOptions && repaired.actionOptions.length > 0) {
          recoveredOptions = repaired.actionOptions;
        }
        if (repaired.knowledgeFacts) recoveredKnowledgeFacts = repaired.knowledgeFacts;
        // Provenance gate: accept repaired settings ONLY if the original output
        // carried the field. Otherwise discard, however plausible they look.
        if (wantSettingUpdates && repaired.settingUpdates) {
          recoveredSettingUpdates = repaired.settingUpdates;
        }
        // If <正文> wasn't found but repair gave clean text, use it.
        if (!recoveredText && repaired.text && repaired.text.trim()) {
          recoveredText = repaired.text;
        }
      } else {
        console.debug('[ResponseRepair] repair AI call returned non-JSON; structure still broken');
      }
    } catch (err) {
      console.debug('[ResponseRepair] AI repair call failed:', err);
      // 不 throw —— 管线继续走，至少保留正文抢救的成果。
    }

    // If neither rescue path helped at all, keep ctx unchanged (parseOk still false).
    if (!recoveredText && !structureRescued) return ctx;

    return {
      ...ctx,
      parsedResponse: {
        ...parsed,
        text: recoveredText ?? parsed.text,
        commands: recoveredCommands,
        midTermMemory: recoveredMemory,
        actionOptions: recoveredOptions,
        knowledgeFacts: recoveredKnowledgeFacts,
        settingUpdates: recoveredSettingUpdates,
        parseOk: structureRescued,
      },
      meta: {
        ...ctx.meta,
        responseRepairApplied: true,
        responseRepairNarrativeRescued: recoveredText !== null,
        responseRepairStructureRescued: structureRescued,
      },
    };
  }
}
