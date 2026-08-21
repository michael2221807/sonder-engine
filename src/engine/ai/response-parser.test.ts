import { describe, it, expect } from 'vitest';
import { ResponseParser } from '@/engine/ai/response-parser';

const parser = new ResponseParser();

describe('ResponseParser.sanitize', () => {
  it('removes <think> tags', () => {
    expect(parser.sanitize('<think>internal</think>visible')).toBe('visible');
  });

  it('removes <thinking> tags', () => {
    expect(parser.sanitize('<thinking>内部</thinking>外部')).toBe('外部');
  });

  it('removes <reasoning> tags', () => {
    expect(parser.sanitize('<reasoning>step1</reasoning>answer')).toBe('answer');
  });

  it('is case-insensitive', () => {
    expect(parser.sanitize('<THINK>x</THINK>y')).toBe('y');
  });

  it('removes multiple thinking blocks', () => {
    expect(parser.sanitize('<think>a</think>b<think>c</think>d')).toBe('bd');
  });

  it('handles multiline thinking', () => {
    expect(parser.sanitize('<think>\nline1\nline2\n</think>result')).toBe('result');
  });

  it('trims result', () => {
    expect(parser.sanitize('  text  ')).toBe('text');
  });

  it('returns empty for only thinking tags', () => {
    expect(parser.sanitize('<think>all internal</think>')).toBe('');
  });
});

describe('ResponseParser.parse — JSON extraction', () => {
  it('parses direct JSON', () => {
    const raw = '{"text": "叙事内容", "commands": []}';
    const result = parser.parse(raw);
    expect(result.text).toBe('叙事内容');
  });

  it('parses markdown code block', () => {
    const raw = '```json\n{"text": "故事", "commands": []}\n```';
    const result = parser.parse(raw);
    expect(result.text).toBe('故事');
  });

  it('extracts JSON from prose', () => {
    const raw = 'Some intro text\n{"text": "extracted", "commands": []}\nSome outro';
    const result = parser.parse(raw);
    expect(result.text).toBe('extracted');
  });

  it('falls back to pure text when no JSON', () => {
    const raw = '这是一段纯文本叙事，没有任何JSON。';
    const result = parser.parse(raw);
    expect(result.text).toBe(raw);
  });
});

describe('ResponseParser.parse — field extraction', () => {
  function parseJson(json: Record<string, unknown>) {
    return parser.parse(JSON.stringify(json));
  }

  it('extracts text field', () => {
    expect(parseJson({ text: '叙事' }).text).toBe('叙事');
  });

  it('extracts commands array', () => {
    const result = parseJson({
      text: 't',
      commands: [{ action: 'set', key: 'a.b', value: 1 }],
    });
    expect(result.commands).toHaveLength(1);
    expect(result.commands![0].action).toBe('set');
  });

  it('accepts tavern_commands as fallback', () => {
    const result = parseJson({
      text: 't',
      tavern_commands: [{ action: 'push', key: 'x', value: 'y' }],
    });
    expect(result.commands).toHaveLength(1);
  });

  it('filters invalid commands', () => {
    const result = parseJson({
      text: 't',
      commands: [
        { action: 'set', key: 'a', value: 1 },
        { key: 'missing-action' },
        { action: 'set' },
        { action: 'unknown_action', key: 'a', value: 1 },
      ],
    });
    expect(result.commands!.length).toBe(1);
  });

  it('normalizes path to key', () => {
    const result = parseJson({
      text: 't',
      commands: [{ action: 'set', path: 'a.b', value: 1 }],
    });
    expect(result.commands![0].key).toBe('a.b');
  });

  it('extracts mid_term_memory', () => {
    const mem = { 相关角色: ['玩家'], 事件时间: '1-01', 记忆主体: '事件摘要' };
    const result = parseJson({ text: 't', mid_term_memory: mem });
    expect(result.midTermMemory).toEqual(mem);
  });

  it('extracts action_options', () => {
    const result = parseJson({
      text: 't',
      action_options: ['选项1', '选项2', '  ', '选项3'],
    });
    expect(result.actionOptions).toEqual(['选项1', '选项2', '选项3']);
  });

  it('extracts semantic_memory', () => {
    const sem = { triples: [{ subject: 'A', predicate: 'is', object: 'B' }] };
    const result = parseJson({ text: 't', semantic_memory: sem });
    expect(result.semanticMemory).toEqual(sem);
  });

  it('extracts judgement', () => {
    const result = parseJson({ text: 't', judgement: '判定内容' });
    expect(result.judgement).toBe('判定内容');
  });

  it('sets raw to sanitized text', () => {
    const result = parser.parse('<think>x</think>{"text":"t"}');
    expect(result.raw).not.toContain('<think>');
  });

  // CR-fix: Chinese key fallbacks (HIGH — regression risk for Chinese game flow)
  it('accepts 指令 as commands fallback', () => {
    const result = parseJson({ text: 't', 指令: [{ action: 'set', key: 'a', value: 1 }] });
    expect(result.commands).toHaveLength(1);
  });

  it('accepts 中期记忆 as midTermMemory fallback', () => {
    const mem = { 相关角色: ['玩家'], 事件时间: '1-01', 记忆主体: '中文记忆' };
    const result = parseJson({ text: 't', 中期记忆: mem });
    expect(result.midTermMemory).toBeDefined();
  });

  it('accepts 行动选项 as actionOptions fallback', () => {
    const result = parseJson({ text: 't', 行动选项: ['选项A', '选项B'] });
    expect(result.actionOptions).toEqual(['选项A', '选项B']);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Sprint CoT-1: captureThinking tests
// ═══════════════════════════════════════════════════════════════

describe('ResponseParser — CoT-1: extractAndSanitize', () => {
  it('captures single thinking block', () => {
    const result = parser.extractAndSanitize('<thinking>内部推理</thinking>visible');
    expect(result.sanitized).toBe('visible');
    expect(result.thinking).toBe('内部推理');
  });

  it('captures multiple thinking blocks and joins them', () => {
    const result = parser.extractAndSanitize(
      '<thinking>第一段</thinking>中间文字<thinking>第二段</thinking>结尾'
    );
    expect(result.sanitized).toBe('中间文字结尾');
    expect(result.thinking).toBe('第一段\n\n第二段');
  });

  it('returns undefined thinking when no blocks present', () => {
    const result = parser.extractAndSanitize('纯文本，没有thinking');
    expect(result.sanitized).toBe('纯文本，没有thinking');
    expect(result.thinking).toBeUndefined();
  });

  it('handles <think> short tag variant', () => {
    const result = parser.extractAndSanitize('<think>思考</think>内容');
    expect(result.thinking).toBe('思考');
    expect(result.sanitized).toBe('内容');
  });

  it('handles <reasoning> tag variant', () => {
    const result = parser.extractAndSanitize('<reasoning>推理</reasoning>结论');
    expect(result.thinking).toBe('推理');
    expect(result.sanitized).toBe('结论');
  });

  it('is case-insensitive', () => {
    const result = parser.extractAndSanitize('<THINKING>大写</THINKING>rest');
    expect(result.thinking).toBe('大写');
  });

  it('handles multiline thinking content', () => {
    const raw = '<thinking>\nline1\nline2\nline3\n</thinking>after';
    const result = parser.extractAndSanitize(raw);
    expect(result.thinking).toBe('line1\nline2\nline3');
    expect(result.sanitized).toBe('after');
  });

  it('strips whitespace-only thinking blocks (captures nothing meaningful)', () => {
    const result = parser.extractAndSanitize('<thinking>   \n  </thinking>rest');
    expect(result.thinking).toBeUndefined();
    expect(result.sanitized).toBe('rest');
  });
});

describe('ResponseParser.parse — CoT-1: captureThinking option', () => {
  it('captureThinking=false (default) — byte-identical baseline', () => {
    const raw = '<thinking>secret reasoning</thinking>{"text":"narrative","commands":[]}';
    const result = parser.parse(raw);
    expect(result.text).toBe('narrative');
    expect(result.thinking).toBeUndefined();
    expect(result.raw).not.toContain('<thinking>');
  });

  it('captureThinking=true — captures thinking + parses JSON normally', () => {
    const raw = '<thinking>step1: analyze context\nstep2: decide</thinking>{"text":"narrative","commands":[{"action":"set","key":"a","value":1}]}';
    const result = parser.parse(raw, { captureThinking: true });
    expect(result.text).toBe('narrative');
    expect(result.thinking).toBe('step1: analyze context\nstep2: decide');
    expect(result.commands).toHaveLength(1);
    expect(result.commands![0].action).toBe('set');
  });

  it('captureThinking=true with no thinking tags — thinking is undefined', () => {
    const raw = '{"text":"no thinking","commands":[]}';
    const result = parser.parse(raw, { captureThinking: true });
    expect(result.text).toBe('no thinking');
    expect(result.thinking).toBeUndefined();
  });

  it('captureThinking=true with pure text (no JSON) — thinking captured, text is sanitized remainder', () => {
    const raw = '<thinking>reasoning</thinking>纯文本叙事';
    const result = parser.parse(raw, { captureThinking: true });
    expect(result.text).toBe('纯文本叙事');
    expect(result.thinking).toBe('reasoning');
  });

  it('captureThinking=false explicitly — same as default', () => {
    const raw = '<thinking>hidden</thinking>{"text":"t"}';
    const result = parser.parse(raw, { captureThinking: false });
    expect(result.thinking).toBeUndefined();
    expect(result.text).toBe('t');
  });

  it('thinking content with command-like text does NOT execute as commands (§3.10)', () => {
    const raw = '<thinking>{"action":"set","key":"角色.health","value":0} — this should not execute</thinking>{"text":"safe","commands":[]}';
    const result = parser.parse(raw, { captureThinking: true });
    expect(result.commands).toEqual([]);
    expect(result.thinking).toContain('should not execute');
  });
});

describe('ResponseParser.parse — CoT pseudo-tag stripping (<正文>, <judge>, etc.)', () => {
  // Regression guard for the "开头的<正文>tag" leak. When CoT is ON the
  // cot-preamble / cot-masquerade / wordCountReq prompts all instruct the AI
  // to wrap narrative in `<正文>...</正文>`. core.md separately demands JSON
  // output. Mixed signals → AI produces JSON but leaks a stray `<正文>` tag
  // into the `text` field. Parser must strip these wrapper tags without
  // touching the inner narrative content.

  it('strips leading <正文> tag from json.text', () => {
    const raw = '{"text":"<正文>林曦走进茶馆","commands":[]}';
    expect(parser.parse(raw).text).toBe('林曦走进茶馆');
  });

  it('strips both <正文> and </正文> wrappers from json.text', () => {
    const raw = '{"text":"<正文>narrative content</正文>","commands":[]}';
    expect(parser.parse(raw).text).toBe('narrative content');
  });

  it('strips <judge> pseudo-tag but keeps inner judgement text', () => {
    const raw = '{"text":"story <judge>〖探索:成功〗</judge> more","commands":[]}';
    // Inner content is preserved; only the wrapper tags go.
    expect(parser.parse(raw).text).toBe('story 〖探索:成功〗 more');
  });

  it('strips <短期记忆> / <变量规划> / <剧情规划> pseudo-tags', () => {
    const raw = '{"text":"a<短期记忆>b</短期记忆>c<剧情规划>d</剧情规划>e","commands":[]}';
    expect(parser.parse(raw).text).toBe('abcde');
  });

  it('preserves 〖...〗 / 【...】 / "..." narrative symbols', () => {
    const raw = '{"text":"<正文>【夜幕降临】\\n林曦说：\\"你好\\"\\n〖社交:成功〗</正文>","commands":[]}';
    const text = parser.parse(raw).text;
    expect(text).toContain('【夜幕降临】');
    expect(text).toContain('〖社交:成功〗');
    expect(text).not.toContain('<正文>');
    expect(text).not.toContain('</正文>');
  });

  it('strips wrappers in non-JSON fallback path', () => {
    // When JSON parse fails entirely and parser falls back to raw sanitized text.
    const raw = '<正文>pure narrative without json</正文>';
    expect(parser.parse(raw).text).toBe('pure narrative without json');
  });

  it('case-insensitive + whitespace-tolerant', () => {
    const raw = '{"text":"<  正文  >text< /正文 >","commands":[]}';
    expect(parser.parse(raw).text).toBe('text');
  });

  it('no-op when no pseudo-tags present', () => {
    const raw = '{"text":"plain narrative","commands":[]}';
    expect(parser.parse(raw).text).toBe('plain narrative');
  });
});

describe('ResponseParser.parse — malformed escape tolerance (2026-04-19)', () => {
  // The \你 stutter bug: model emits `"\你站起身"` (single backslash + CJK,
  // which is invalid JSON). Before the fix, native JSON.parse threw and all
  // three tryParseJson strategies failed — entire response fell through to
  // raw-text fallback, losing commands/memory/options.

  it('recovers commands when text field has stray \\CJK escape', () => {
    const raw = '{"text":"故事前文\\n\\你站起身，走到窗前。","commands":[{"action":"add","path":"世界.时间.分钟","value":30}],"action_options":["选项一"]}';
    const result = parser.parse(raw);
    expect(result.parseOk).toBe(true);
    expect(result.text).toBe('故事前文\n你站起身，走到窗前。');
    expect(result.commands).toHaveLength(1);
    expect(result.commands![0].key).toBe('世界.时间.分钟');
    expect(result.actionOptions).toEqual(['选项一']);
  });

  it('reports parseOk=false only when everything fails', () => {
    const raw = '<正文>pure narrative no JSON</正文>';
    expect(parser.parse(raw).parseOk).toBe(false);
  });

  it('reports parseOk=true for a clean JSON response', () => {
    const raw = '{"text":"clean","commands":[]}';
    expect(parser.parse(raw).parseOk).toBe(true);
  });

  it('handles real payload shape (thinking + 正文 + JSON with \\你)', () => {
    // Simplified version of the actual production failure
    const raw =
      '<thinking>step 1...</thinking>\n' +
      '<正文>\n你站起身。\n</正文>\n' +
      '{"text":"正文内容。\\n\\你站起身。","commands":[{"action":"set","path":"角色.基础信息.当前位置","value":"窗前"}],"action_options":["选项"],"mid_term_memory":null}';
    const result = parser.parse(raw, { captureThinking: true });
    expect(result.parseOk).toBe(true);
    expect(result.text).toContain('你站起身');
    expect(result.text).not.toContain('\\你');
    expect(result.commands).toHaveLength(1);
    expect(result.thinking).toContain('step 1');
  });
});

// ─── Canon Capture: setting_updates normalization (P1) ───────

describe('ResponseParser · setting_updates', () => {
  const parser = new ResponseParser();

  it('extracts the field as an explicit array of raw items', () => {
    const r = parser.parse(JSON.stringify({
      text: 'n',
      setting_updates: [
        { kind: 'character', statement: 'A', evidence: 'a', anchors: ['x'], entities: [] },
      ],
    }));
    expect(r.settingUpdates).toHaveLength(1);
    expect(r.settingUpdates?.[0]).toMatchObject({ kind: 'character', statement: 'A' });
  });

  it('is undefined when the model never emitted the key', () => {
    expect(parser.parse(JSON.stringify({ text: 'n' })).settingUpdates).toBeUndefined();
  });

  it('is undefined when the value is not an array (cannot be trusted as one)', () => {
    expect(parser.parse(JSON.stringify({ text: 'n', setting_updates: 'oops' })).settingUpdates)
      .toBeUndefined();
    expect(parser.parse(JSON.stringify({ text: 'n', setting_updates: { a: 1 } })).settingUpdates)
      .toBeUndefined();
  });

  it('distinguishes "answered with nothing" from "never answered"', () => {
    expect(parser.parse(JSON.stringify({ text: 'n', setting_updates: [] })).settingUpdates)
      .toEqual([]);
  });

  it('keeps malformed ITEMS so the stage can report a reason for each', () => {
    // Dropping them here would turn a reportable rejection into an invisible one.
    const r = parser.parse(JSON.stringify({
      text: 'n',
      setting_updates: [{ kind: 'nope' }, { statement: 42 }],
    }));
    expect(r.settingUpdates).toHaveLength(2);
    expect(r.settingUpdates?.[0].kind).toBe('nope');
    expect(r.settingUpdates?.[1].statement).toBe(42);
  });

  it('skips non-object items (nothing to report a reason about)', () => {
    const r = parser.parse(JSON.stringify({
      text: 'n',
      setting_updates: ['string', 42, null, [], { kind: 'character' }],
    }));
    expect(r.settingUpdates).toHaveLength(1);
  });

  it('bounds a runaway array', () => {
    const many = Array.from({ length: 200 }, () => ({ kind: 'character' }));
    const r = parser.parse(JSON.stringify({ text: 'n', setting_updates: many }));
    expect(r.settingUpdates?.length).toBe(50);
  });

  it('does NOT leak setting_updates into customFields', () => {
    const r = parser.parse(JSON.stringify({ text: 'n', setting_updates: [{ kind: 'character' }] }));
    expect(r.customFields?.['setting_updates']).toBeUndefined();
  });
});
