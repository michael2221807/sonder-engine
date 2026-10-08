/**
 * AI reply corpus — the raw replies the reply-parsing snapshot test (`ai/reply-parsing-corpus.test.ts`) feeds to
 * every parser, so a refactor of the parsing code can prove it reads each reply exactly as before.
 *
 * Each case carries its `source`: the existing test it comes from, the incident it records, or the probe
 * (`H:/aga-temp/code-audit/tmp/e05-probe*.mjs`) that found the shape. Cases are inputs only; what each parser
 * makes of them lives in the snapshot files. Adding a case changes every snapshot — that is a deliberate act, not
 * something a refactor may do.
 */

export interface ReplyCase {
  readonly id: string;
  readonly source: string;
  readonly raw: string;
}

/** A narrative a round stored, with the raw reply the same round kept (`_rawResponse`). */
export interface StoredPair {
  readonly id: string;
  readonly source: string;
  readonly stored: string;
  readonly raw: unknown;
}

const STORY = '【楼道那盏声控灯，在你踩上最后一级台阶时，又"啪"地熄了。】\n\n你轻手轻脚地，推开了寝室那扇门。';
/** As models write it: the inner quotes unescaped, the line breaks raw. */
const LOOSE = `{"text":"${STORY}"}`;
const ENVELOPED = String.raw`{"text":"【Nove那扇玻璃门里的暖黄灯，落在身后了。】\n\n你那颗脑子，\"嗡\"地，白了半分。`;
/** A reply that escaped its story twice: after one JSON decode the story still holds a literal `\n` and `\"`. */
const TWICE_JSON = String.raw`{"text":"第一段\\n\\n他说\\\"走\\\"。","commands":[]}`;
const COT_SHAPE = `\n\n<正文>\n${STORY}\n</正文>\n\n<短期记忆>\n记下这一夜。\n</短期记忆>\n\n<变量规划>\n锚点+2\n</变量规划>\n\n<剧情规划>\n- 保留：会诊\n</剧情规划>`;
const FULL = {
  text: '码头的风很凉，林月停在栈桥前。',
  commands: [
    { action: 'add', path: '世界.时间.分钟', value: 20 },
    { action: 'set', key: '角色.位置', value: '码头' },
  ],
  mid_term_memory: { 相关角色: ['林月'], 事件时间: '1-01-15-08-30', 记忆主体: '带林月到码头。' },
  action_options: ['靠近水边', '牵住她的手', '  换条路走  ', '', 7],
  judgement: { type: '力量', dc: 12, roll: 15, success_rate: 60, grade: '成功' },
  semantic_memory: { long_term_memories: ['林月怕水'] },
  knowledge_facts: [{ fact: '林月害怕靠近深水区域', source_entity: '林月', target_entity: '码头' }],
  setting_updates: [{ kind: 'character', statement: '林月从小怕水。', evidence: '她从小怕水', anchors: ['林月'], entities: ['林月'] }],
  memoryEntry: '  她站在水边没有动。  ',
  plot_evaluation: { stage: 'rising', note: '透传' },
};

export const AI_REPLY_CORPUS: readonly ReplyCase[] = [
  // ── Well-formed replies ──
  { id: 'normal-full', source: 'ai-call-split-merge.test.ts STEP1/STEP2 shapes + e05-probe1 (every extracted field and one custom key)', raw: JSON.stringify(FULL) },
  { id: 'normal-minimal', source: 'ai-call-split-merge.test.ts STEP1', raw: JSON.stringify({ text: '码头的风很凉，林月停在栈桥前。' }) },
  { id: 'normal-cn-aliases', source: 'response-parser.ts key aliases (叙事文本/指令/中期记忆/行动选项/记忆条目/tavern_commands)', raw: JSON.stringify({ 叙事文本: '别名正文', 指令: [{ action: 'push', key: '背包', value: 'a' }], 中期记忆: '一句话记忆', 行动选项: ['走', '停'], 记忆条目: '别名记忆' }) },
  { id: 'normal-tavern-commands', source: 'response-parser.ts legacy key `tavern_commands`', raw: JSON.stringify({ text: '旧键名', tavern_commands: [{ type: 'delete', path: 'x.y' }] }) },
  { id: 'commands-invalid-mixed', source: 'e05-probe1.mjs cmd(...)', raw: JSON.stringify({ text: 'n', commands: [{ action: 'remove', key: 'a' }, { op: 'set', key: 'b', value: 1 }, { action: 'update', path: 'c', value: 2 }, { action: 'set', key: 'ok', value: 1 }, { action: 'set', key: 5, value: 1 }, 'str', null] }) },
  { id: 'commands-not-array', source: 'e05-probe1.mjs cmd(not array)', raw: JSON.stringify({ text: 'n', commands: { action: 'set', key: 'a', value: 1 } }) },
  { id: 'setting-updates-variants', source: 'e05-probe1.mjs su(...)', raw: JSON.stringify({ text: 'n', setting_updates: ['设定A', { kind: 'world_fact', statement: 'x' }, null, [1], { kind: 'character' }] }) },
  { id: 'memory-entry-long', source: 'e05-probe1.mjs memoryEntry 100 chars (80-char soft limit)', raw: JSON.stringify({ text: 'n', memoryEntry: '字'.repeat(100) }) },
  { id: 'knowledge-facts-filter', source: 'response-parser.ts normalizeKnowledgeFacts (short fact, same entity, missing target)', raw: JSON.stringify({ text: 'n', knowledge_facts: [{ fact: '太短', source_entity: 'a', target_entity: 'b' }, { fact: '这是一条足够长的事实陈述', source_entity: 'a', target_entity: 'a' }, { fact: '这是一条足够长的事实陈述', source_entity: 'a' }, { fact: '这是一条足够长的事实陈述', source_entity: ' 甲 ', target_entity: ' 乙 ' }] }) },
  { id: 'judgement-string', source: 'e05-probe1.mjs judgement typeof', raw: JSON.stringify({ text: 'n', judgement: '判定内容', semantic_memory: 'not-an-object' }) },
  { id: 'extract-keys-nested', source: 'json-extract.test.ts (semantic_memory.long_term_memories nested; refined; vectors)', raw: JSON.stringify({ text: 'n', semantic_memory: { long_term_memories: ['a', 'b'] }, refined: '精炼后的文本', vectors: [[0.1, 0.2]], extra_out: { k: 1 } }) },

  // ── Thinking blocks ──
  { id: 'think-lower', source: 'response-parser.test.ts <think> prefix', raw: `<think>先想一想</think>${JSON.stringify({ text: '想完了' })}` },
  { id: 'think-upper-multiline', source: 'response-parser.ts flags gi (case-insensitive)', raw: `<THINKING>\n第一行\n第二行\n</THINKING>\n${JSON.stringify({ text: '大写块' })}` },
  { id: 'think-reasoning-thought-two-blocks', source: 'response-parser.ts THINKING_TAGS (reasoning + thought, joined by a blank line)', raw: `<reasoning>理由一</reasoning>\n<thought>念头二</thought>\n${JSON.stringify({ text: '两块' })}` },
  { id: 'think-unclosed', source: 'truncated CoT reply: opening tag never closed', raw: `<thinking>想到一半就断了 ${JSON.stringify({ text: '不会被读到' })}` },
  { id: 'think-with-half-json', source: 'preset-ai-generator.test.ts "<thinking> hides a draft JSON" (CR P1-2)', raw: `<thinking>\n{"text": "草稿", "commands": [\n</thinking>\n${JSON.stringify({ text: '正式', commands: [{ action: 'set', key: 'a', value: 1 }] })}` },
  { id: 'think-mismatched-close', source: 'response-parser.ts THINKING_TAG_PATTERN: open and close are matched independently', raw: `<think>开\n</thinking>${JSON.stringify({ text: '错配' })}` },
  { id: 'think-only', source: 'a reply that is only thinking', raw: '<think>只有思考，没有正文</think>' },
  { id: 'think-empty-block', source: 'response-parser.ts extractAndSanitize: empty block yields no thinking', raw: `<think>   </think>${JSON.stringify({ text: '空块' })}` },
  { id: 'think-then-tag-reply', source: 'response-narrative-tag.test.ts thinking before <正文>{...}</正文>', raw: `<thinking>先想一想</thinking>\n<正文>${LOOSE}</正文>` },

  // ── <正文> tag in every position ──
  { id: 'tag-whole-reply-json', source: 'response-narrative-tag.test.ts the whole reply inside <正文>', raw: `<正文>${JSON.stringify({ text: STORY, commands: [{ action: 'set', key: '世界.天气', value: '晴' }], action_options: ['走', '停'] })}</正文>` },
  { id: 'tag-whole-reply-loose', source: 'response-narrative-tag.test.ts LOOSE inside <正文>', raw: `<正文>${LOOSE}</正文>` },
  { id: 'tag-inside-json-string', source: 'response-narrative-tag.test.ts a tag inside the JSON string', raw: JSON.stringify({ text: `<正文>${STORY}</正文>` }) },
  { id: 'tag-inside-loose-json-string', source: 'response-narrative-tag.test.ts a loose reply with the tag inside its string', raw: `{"text":"<正文>${STORY}</正文>","commands":[{"action":"set","key":"x","value":1}],"action_options":["走"]}` },
  { id: 'tag-story-then-json', source: 'ai-call-split-merge.test.ts tagged=true', raw: `<thinking>草稿变量规划</thinking>\n<正文>她把借来的书放回包里。</正文>\n${JSON.stringify({ commands: [{ action: 'set', path: 'draft_id', value: {} }], action_options: ['草稿选项'] })}` },
  { id: 'tag-placeholder-in-json', source: 'response-parser.ts "longer of tag and json.text wins"', raw: `<正文>${STORY}</正文>\n${JSON.stringify({ text: '(见上方正文)', commands: [] })}` },
  { id: 'tag-unclosed', source: 'truncated reply: <正文> never closed', raw: `<正文>\n${STORY}` },
  { id: 'tag-after-stray-brace', source: 'response-narrative-tag.test.ts a stray brace in prose before the tag', raw: `好的，{先看看。\n<正文>${STORY}</正文>` },
  { id: 'tag-fenced-reply', source: 'response-narrative-tag.test.ts a fenced reply in the tag', raw: '<正文>```json\n' + JSON.stringify({ text: STORY }) + '\n```</正文>' },
  { id: 'tag-prose-looks-like-json', source: 'response-narrative-tag.test.ts prose in the tag that merely starts like JSON', raw: '<正文>{"系统":"警告"}——屏幕亮了。</正文>' },
  { id: 'tag-extra-json-after', source: 'response-narrative-tag.test.ts fields written after a reply in the tag still count', raw: `<正文>${LOOSE}</正文>\n${JSON.stringify({ commands: [{ action: 'set', key: 'x', value: 1 }], action_options: ['走', '停', '回头'] })}` },
  { id: 'cot-protocol-shape', source: 'response-narrative-tag.test.ts the CoT protocol shape', raw: COT_SHAPE },
  { id: 'tag-in-unparseable-json', source: 'response-parser.ts "tag inside the JSON string of a reply too loose to parse"', raw: `{"text":"<正文>他喊"走",然后又说"快"。\n第二段</正文>","commands":[{"action":"set","key":"x","value":1}],"action_options":["走"]}` },
  { id: 'tag-in-string-loose-escapes', source: 'response-parser.ts decodeLooseJsonString: a tag in a too-loose JSON string whose story still holds JSON escapes', raw: String.raw`{"text":"<正文>第一段\n他说\"走\"\u4f60\你\/\t好` + '\n第二段</正文>","commands":[{"action":"set","key":"x","value":1}]}' },
  { id: 'cot-pseudo-tags-in-text', source: 'response-parser.ts stripNarrativeWrapperTags', raw: JSON.stringify({ text: '<正文>开头碎片 <judge>判定</judge> < /变量规划 > 结尾' }) },

  // ── Truncated and loose JSON ──
  { id: 'truncated-envelope', source: 'response-envelope-salvage.test.ts ENVELOPED / e2e/broken-step1-envelope.spec.ts STEP1', raw: ENVELOPED },
  { id: 'truncated-in-commands', source: 'a reply cut off inside its commands array', raw: '{"text":"正文走完了","commands":[{"action":"set","key":"a","value":' },
  { id: 'truncated-in-unicode-escape', source: 'response-envelope-salvage.test.ts cut-off \\u escape', raw: String.raw`{"text":"abc\u4f` },
  { id: 'unescaped-quotes-in-story', source: 'response-envelope-salvage.test.ts a quote the model forgot to escape', raw: '{"text":"他喊"走",然后又说"快"。","commands":[' },
  { id: 'raw-linebreak-in-string', source: 'response-envelope-salvage.test.ts a raw line break inside the string', raw: '{"text":"第一段\n第二段，\\"嗡\\"地"}' },
  { id: 'invalid-escape-stutter', source: 'json-escape-sanitize.test.ts the \\你 stutter bug', raw: '{"text":"他说\\你好","commands":[]}' },
  { id: 'invalid-escape-valid-mix', source: 'json-escape-sanitize.test.ts valid double backslash and \\uXXXX beside a bad one', raw: '{"text":"\\\\你 \\u4f60 \\x \\q","action_options":["\\a"]}' },
  { id: 'heal-quotes-evidence', source: 'json-escape-sanitize.ts healUnescapedQuotes (round-62: evidence quotes the player in plain English quotes)', raw: '{"commands":[],"setting_updates":[{"kind":"character","statement":"林月怕水","evidence":"玩家写道 "她从小怕水" 然后继续","anchors":["林月"],"entities":["林月"]}]}' },
  { id: 'loose-bare-keys-after-story', source: 'response-envelope-salvage.test.ts a reply key written without double quotes', raw: '{"text":"正文", commands:[{action:"set"' },
  { id: 'trailing-comma-object', source: 'response-envelope-salvage.test.ts trailing comma / broken tail after the story', raw: String.raw`{"text":"正文\"引\"" , "commands":[{"action":"set",}]` },

  // ── Not an object ──
  { id: 'bare-number', source: 'e05-probe1.mjs bare number 42', raw: '42' },
  { id: 'bare-string', source: 'e05-probe1.mjs bare string', raw: '"hello"' },
  { id: 'bare-array', source: 'e05-probe1.mjs bare array', raw: '["a","b"]' },
  { id: 'bare-true', source: 'e05-probe1.mjs bare true', raw: 'true' },
  { id: 'bare-null', source: 'JSON null is a successful parse that is not an object', raw: 'null' },
  { id: 'double-encoded-envelope', source: 'e05-probe1.mjs double-encoded envelope', raw: JSON.stringify(JSON.stringify({ text: '你好', commands: [{ action: 'set', key: 'a', value: 1 }] })) },
  { id: 'fenced-array', source: 'e05-probe1.mjs fenced array', raw: '```json\n[{"x":1},{"y":2}]\n```' },
  { id: 'escaped-twice-in-json', source: 'response-narrative-tag.test.ts TWICE_JSON', raw: TWICE_JSON },
  { id: 'escaped-twice-in-tag', source: 'response-narrative-tag.test.ts a story escaped twice in the tag', raw: `\n\n<正文>\n${TWICE_JSON}\n</正文>\n\n<短期记忆>\n记下这一夜。\n</短期记忆>` },

  // ── Fences, prose, several blocks ──
  { id: 'fence-json', source: 'preset-ai-generator.test.ts fenced ```json', raw: '好的，下面是结果：\n```json\n{"name":"末世","description":"灰烬之地","talent_cost":3}\n```\n以上。' },
  { id: 'fence-no-language', source: 'json-extract.test.ts fence without a language tag', raw: '```\n{"name":"无语言","description":"d"}\n```' },
  { id: 'fence-upper-json', source: 'response-parser.ts REPLY_HEAD accepts ```JSON', raw: '```JSON\n{"text":"大写围栏","commands":[]}\n```' },
  { id: 'fence-unclosed', source: 'response-parser.ts "unclosed fence from truncated output"', raw: '```json\n{"text":"没闭合的围栏","commands":[]}' },
  { id: 'prose-then-json', source: 'response-parser.ts strategy 3 (first { to last })', raw: `下面是回复：\n${JSON.stringify({ text: '前有散文', commands: [] })}` },
  { id: 'json-then-prose', source: 'response-parser.ts strategy 3 (first { to last })', raw: `${JSON.stringify({ text: '后有散文', commands: [] })}\n\n（以上为本回合内容）` },
  { id: 'multi-json-blocks-cot-then-final', source: 'payload-parser / preset CoT-then-final: draft block then the answer', raw: `{"name":"半成品"}\n\n${JSON.stringify({ name: '完整版', description: '全部必填齐', summary: '摘要', patches: [{ target: 'a.b', op: 'set-field', value: 1 }], refined: 'r' })}` },
  { id: 'multi-json-blocks-equal-score', source: 'preset-ai-generator.test.ts equal blocks: the last one wins', raw: '{"name":"早","description":"D1"}\n\n{"name":"晚","description":"D2"}' },
  { id: 'multi-json-text-twice', source: 'two reply objects in one reply: strategy 3 spans both and fails', raw: '{"text":"甲"}\n{"text":"乙"}' },
  { id: 'assistant-payload-full', source: 'payload-parser.test.ts patches + knowledge_facts + insert-item position', raw: '我来调整一下。\n```json\n' + JSON.stringify({ summary: '改了两处', patches: [{ target: '角色.名字', op: 'set-field', value: '林月', rationale: '统一称呼' }, { target: '背包', op: 'insert-item', value: 'x', position: { after: { by: 'id', value: 'k' } } }, { target: 'bad', op: 'nope' }], knowledge_facts: [{ sourceEntity: 'A', targetEntity: 'B', fact: 'A 认识 B' }] }) + '\n```' },
  { id: 'loose-json-knowledge-facts', source: 'batch-solidify-pipeline.ts parseAIResponse (knowledge_facts after a preamble and a thinking tag)', raw: `<think>算一下 {"a":1}</think>\n结果如下：\n${JSON.stringify({ knowledge_facts: [{ source_entity: '甲', target_entity: '乙', fact: '甲认识乙' }], entity_descriptions: [{ name: '甲', summary: '一个人' }] })}` },
  { id: 'combined-response-field-repair', source: 'field-repair.ts parseCombinedResponse (commands, entity_descriptions, edge_updates, extra output)', raw: `<reasoning>想</reasoning>${JSON.stringify({ commands: [{ action: 'set', key: 'a', value: 1 }, { action: 'set' }, 3], entity_descriptions: [{ name: ' 甲 ', summary: ' 一个人 ' }, { name: '', summary: 'x' }], edge_updates: [{ edge_id: ' [E1] ', action: ' invalidate ', reason: ' 过期 ' }, { edge_id: 'E2', action: 'keep' }, { edge_id: 3 }], extra_out: { done: true } })}` },

  // ── Sidecars ──
  { id: 'sidecars-after-json', source: 'response-sidecars.test.ts a block after the JSON', raw: `${JSON.stringify({ text: STORY, commands: [] })}\n\n<短期记忆>\n记下这一夜。\n</短期记忆>\n<变量规划>锚点+2</变量规划>` },
  { id: 'sidecar-inside-json-string', source: 'response-sidecars.test.ts the same characters inside a JSON string are never taken', raw: JSON.stringify({ text: '文中写着 <短期记忆>不是旁路</短期记忆> 这样', commands: [] }) + '\n<剧情规划>真旁路</剧情规划>' },
  { id: 'sidecar-unclosed', source: 'response-parser.ts liftSidecars: an unclosed opening tag takes the rest', raw: `${JSON.stringify({ text: '正文', commands: [] })}\n<短期记忆>断在这里` },
  { id: 'sidecar-repeated', source: 'response-parser.ts liftSidecars: several blocks of one tag join by a blank line', raw: `<短期记忆>甲</短期记忆>${JSON.stringify({ text: '正文' })}<短期记忆>乙</短期记忆>` },

  // ── Degenerate ──
  { id: 'empty', source: 'empty reply', raw: '' },
  { id: 'whitespace-only', source: 'whitespace-only reply', raw: ' \n\t ' },
  { id: 'plain-prose', source: 'a reply with no JSON at all', raw: STORY },
  { id: 'prose-with-braces', source: 'e05 probe: prose with its own braces, no envelope', raw: '他念出那行字：{"系统":"警告"}，然后沉默了。' },
  { id: 'prose-quoting-envelope', source: 'response-narrative-tag.test.ts a story that quotes JSON further down', raw: '他念出那行字：{"text":"x"}' },
  { id: 'unbalanced-brace-prose-envelope', source: 'response-parser.ts envelopeValueStart fallback: unbalanced brace in prose hides the envelope', raw: '好的，{\n{"text":"藏在后面的正文","commands":[' },
  { id: 'stream-long-prose', source: 'ai-call.ts stream unwrapper PASSTHROUGH after 48 chars', raw: '这是一段没有任何信封的长文字，会在四十八个字之后被放行，其中夹着 <正文> 和 <judge>x</judge> 这样的伪标签，直到结束。' },
  { id: 'unicode-escapes-and-emoji', source: 'response-envelope-salvage.test.ts \\u escapes and astral characters', raw: String.raw`{"text":"笑😀了\u4f60\u597d\t\/\你"` },
];

export const STORED_PAIRS: readonly StoredPair[] = [
  { id: 'stored-bare-envelope', source: 'response-narrative-tag.test.ts repairStoredNarrative(LOOSE)', stored: LOOSE, raw: LOOSE },
  { id: 'stored-in-tag-envelope', source: 'response-narrative-tag.test.ts repairStoredNarrative(<正文>LOOSE</正文>)', stored: `<正文>${LOOSE}</正文>`, raw: `<正文>${LOOSE}</正文>` },
  { id: 'stored-valid-json-envelope', source: 'response-narrative-tag.test.ts repairStoredNarrative(JSON.stringify)', stored: JSON.stringify({ text: STORY }), raw: JSON.stringify({ text: STORY }) },
  { id: 'stored-plain-story', source: 'response-narrative-tag.test.ts a story left alone', stored: STORY, raw: JSON.stringify({ text: STORY }) },
  { id: 'stored-story-quotes-json', source: 'response-narrative-tag.test.ts a story that quotes JSON further down', stored: '他念出那行字：{"text":"x"}', raw: '他念出那行字：{"text":"x"}' },
  { id: 'stored-truncated-envelope', source: 'e2e/broken-step1-envelope.spec.ts: stored raw envelope of a cut-off reply', stored: ENVELOPED, raw: ENVELOPED },
  { id: 'stored-escaped-twice', source: 'response-narrative-tag.test.ts rereadStoredNarrative: a story with a second layer of escapes', stored: '第一段\\n\\n他说\\"走\\"。', raw: TWICE_JSON },
  { id: 'stored-escaped-twice-in-tag', source: 'response-narrative-tag.test.ts a story escaped twice in the tag', stored: '第一段\\n\\n他说\\"走\\"。', raw: `\n\n<正文>\n${TWICE_JSON}\n</正文>\n\n<短期记忆>\n记下这一夜。\n</短期记忆>` },
  { id: 'stored-own-backslash', source: 'response-parser.ts escapedTwice: a story that shows a backslash of its own', stored: '路径是 C:\\new\\table，\n他看了一眼。', raw: JSON.stringify({ text: '路径是 C:\\new\\table，\n他看了一眼。' }) },
  { id: 'stored-escaped-twice-raw-differs', source: 'rereadStoredNarrative: raw does not give the stored text decoded', stored: '甲\\n乙', raw: JSON.stringify({ text: '完全不同的故事' }) },
  { id: 'stored-escaped-twice-no-raw', source: 'rereadStoredNarrative: no raw reply', stored: '甲\\n乙', raw: undefined },
  { id: 'stored-escaped-twice-raw-not-string', source: 'rereadStoredNarrative: raw reply is not a string', stored: '甲\\n乙', raw: 42 },
  { id: 'stored-empty-envelope', source: 'repairStoredNarrative: an envelope with nothing to read', stored: '{"text":""}', raw: '{"text":""}' },
  { id: 'stored-empty', source: 'repairStoredNarrative: empty text', stored: '', raw: '' },
];
