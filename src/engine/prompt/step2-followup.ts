/**
 * The fixed "user" turn that ends the Step 2 request of a split-gen round when no prompt-page text overrides it
 * (`ctx.meta.splitStep2Followup`). Moved out of `ai-call.ts` verbatim (R1 step 1): same text, same branches.
 *
 * It is the LAST instruction the model reads, so what it enumerates overrides everything earlier:
 *  - `captureActive`: on a tagged round the field list must include `setting_updates` (Canon Capture, 2026-08-25);
 *    on an untagged round the text is byte-identical to the pre-capture version.
 *  - `optionsOff`: the player turned action options off (PO 2026-10-03); the instruction must not ask for them.
 */
export interface Step2FollowupFlags {
  captureActive: boolean;
  optionsOff: boolean;
}

export function buildStep2FollowupUser({ captureActive, optionsOff }: Step2FollowupFlags): string {
  return (
    '请基于上面的叙事正文，输出 step2 的结构化数据。要求：\n\n' +
    (optionsOff
      ? (captureActive
        ? '1. **完整输出**：commands / mid_term_memory / knowledge_facts / setting_updates 四个字段必须全部给出，不得用 "(略)" / "(省略)" / "(略 N 条类似)" 之类敷衍，不得中途截断。\n'
        : '1. **完整输出**：commands / mid_term_memory / knowledge_facts 三个字段必须全部给出，不得用 "(略)" / "(省略)" / "(略 N 条类似)" 之类敷衍，不得中途截断。\n')
      : captureActive
        ? '1. **完整输出**：commands / action_options / mid_term_memory / knowledge_facts / setting_updates 五个字段必须全部给出，不得用 "(略)" / "(省略)" / "(略 N 条类似)" 之类敷衍，不得中途截断。\n'
        : '1. **完整输出**：commands / action_options / mid_term_memory / knowledge_facts 四个字段必须全部给出，不得用 "(略)" / "(省略)" / "(略 N 条类似)" 之类敷衍，不得中途截断。\n') +
    (optionsOff
      ? '2. **不要输出 action_options**：玩家已关闭行动选项。\n'
      : '2. **action_options 必须 3-5 个**（按 `actionOptions` 或 `actionOptionsStory` 模块要求的长度），绝不可空数组或只给 1-2 个。\n') +
    '3. **commands 必须完整**：若本回合正文描述了多个状态变化（位置/时间/NPC/物品/体力/技能等），每条都要对应一条 command；不得合并省略。\n' +
    '4. **格式铁律**：直接输出一个合法 JSON 对象 —— 无 ``` 代码围栏、无前后缀文字、无 `<thinking>` 标签。不重复或扩写正文（正文已由 step1 生成）。\n' +
    (captureActive
      ? '5. **setting_updates 绝不可省略**：本回合玩家输入包含设定标记，必须按系统提示词中「设定提取协议」的工作方法，把标记内容吃透并拆解为一条或多条独立设定，输出到 setting_updates 数组（每条含 kind / statement / evidence / anchors / entities）。漏掉该字段等于丢弃玩家明确要求记录的设定。\n'
      : '') +
    '\n现在请输出这个 JSON 对象。'
  );
}
