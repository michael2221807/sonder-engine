import { describe, it, expect } from 'vitest';
import {
  parseNarrative,
  parseInline,
  highlightNpcNames,
  sanitizeUrl,
  type InlinePart,
} from './formatted-text-parser';

// ─── helpers ──────────────────────────────────────────────────
function kinds(parts: InlinePart[]): string[] {
  return parts.map((p) => p.kind);
}
function textOf(parts: InlinePart[], kind: string): string[] {
  return parts.filter((p) => p.kind === kind).map((p) => p.text ?? '');
}

// ─── AGA markers preserved (existing format — must not break) ──
describe('AGA markers (existing format, unchanged)', () => {
  it('parses environment 【】, dialogue "", and normal', () => {
    const parts = parseInline('【夜色深沉】他走近，"你来了。"然后停下。');
    expect(kinds(parts)).toContain('environment');
    expect(kinds(parts)).toContain('dialogue');
    expect(textOf(parts, 'environment')[0]).toBe('【夜色深沉】');
    expect(textOf(parts, 'dialogue')[0]).toBe('"你来了。"');
  });

  it('treats backtick as psychology (内心), NOT markdown code', () => {
    const parts = parseInline('`她心里在盘算`着下一步。');
    expect(kinds(parts)).toContain('psychology');
    expect(textOf(parts, 'psychology')[0]).toBe('`她心里在盘算`');
    // never emit a code leaf
    expect(kinds(parts)).not.toContain('code');
  });

  it('parses Chinese curly-quote dialogue “”', () => {
    const parts = parseInline('“我明白了”，她说。');
    expect(textOf(parts, 'dialogue')[0]).toBe('“我明白了”');
  });
});

// ─── Judgement blocks (atomic, byte-identical) ────────────────
describe('judgement blocks', () => {
  // PO G2 (2026-09-26): a 〖…〗 without a key before a colon is the narrative's own emphasis, shown in full.
  it('a bracketed thought is shown as text in full; verdicts and system notices stay judgement parts', () => {
    const line = '你就这么睡了过去。〖你那根一直冷冷绷着的弦,在这层被子的黑暗里,彻底松了下来。〗帘外很静。';
    const parts = parseInline(line);
    expect(kinds(parts)).not.toContain('judgement');
    expect(parts.map((p) => p.text ?? '').join('')).toBe('你就这么睡了过去。你那根一直冷冷绷着的弦,在这层被子的黑暗里,彻底松了下来。帘外很静。');
    const system = parseInline('〖系统提示：好感度变化〗她低下头。〖社交:成功,判定值:16,难度:9〗');
    expect(system.filter((p) => p.kind === 'judgement').map((p) => [p.judgement?.type, p.judgement?.result]))
      .toEqual([['系统提示', '好感度变化'], ['社交', '成功']]);
    // A thought may carry the narrative's own markers; they are parsed as usual.
    expect(kinds(parseInline('〖那点东西，`又冷又软`地，翻了一下。〗'))).toContain('psychology');
    // Known edge, kept on the safe side: a colon in the first clause reads as a key, so it stays a chip.
    expect(kinds(parseInline('〖她心里想：别走〗'))).toEqual(['judgement']);
    // An empty bracket leaves nothing; an unclosed 〖 that swallows a real verdict stays hidden in a chip, never prose.
    expect(parseInline('前〖〗后').map((p) => p.text ?? '').join('')).toBe('前后');
    const swallowed = parseInline('A〖走丢的开头，还有更多文字 B〖行动:成功,判定值:10〗C');
    expect(kinds(swallowed)).toContain('judgement');
    expect(swallowed.map((p) => p.text ?? '').join('')).not.toContain('判定值');
  });

  it('extracts 〖...〗 as a judgement part', () => {
    const parts = parseInline('他出手了〖战斗:成功,判定值:18,难度:12〗对方倒下。');
    const j = parts.find((p) => p.kind === 'judgement');
    expect(j).toBeTruthy();
    expect(j?.judgement?.type).toBe('战斗');
    expect(j?.judgement?.result).toBe('成功');
    expect(j?.judgement?.finalValue).toBe('18');
    expect(j?.judgement?.difficulty).toBe('12');
  });

  it('extracts judgement even when wrapped in dialogue quotes', () => {
    const parts = parseInline('"〖社交:失败,判定值:5,难度:14〗"');
    expect(parts.some((p) => p.kind === 'judgement')).toBe(true);
  });

  it('does not apply markdown inside a judgement block', () => {
    // ** must not turn into emphasis inside the atomic block
    const parts = parseInline('〖战斗:成功,备注:**strong**〗');
    const j = parts.find((p) => p.kind === 'judgement');
    expect(j?.judgement?.details.join(',')).toContain('**strong**');
  });
});

// ─── markdown inline: emphasis + links ────────────────────────
describe('markdown inline emphasis', () => {
  it('parses **bold**', () => {
    const parts = parseInline('这是**重点**内容');
    const bold = parts.find((p) => p.bold);
    expect(bold?.text).toBe('重点');
    expect(bold?.bold).toBe(true);
  });

  it('parses *italic*', () => {
    const parts = parseInline('这是*强调*内容');
    const em = parts.find((p) => p.italic);
    expect(em?.text).toBe('强调');
  });

  it('parses ***bold italic***', () => {
    const parts = parseInline('***双重***');
    const p = parts.find((x) => x.text === '双重');
    expect(p?.bold).toBe(true);
    expect(p?.italic).toBe(true);
  });

  it('leaves an unmatched single * as literal', () => {
    const parts = parseInline('数字 3 * 5 = 15');
    expect(parts.every((p) => !p.bold && !p.italic)).toBe(true);
    expect(parts.map((p) => p.text).join('')).toContain('3 * 5');
  });

  it('applies emphasis INSIDE dialogue, keeping dialogue kind', () => {
    const parts = parseInline('"我**一定**回来"');
    const boldInDialogue = parts.find((p) => p.bold);
    expect(boldInDialogue?.kind).toBe('dialogue');
    expect(boldInDialogue?.text).toBe('一定');
    // surrounding dialogue chars keep dialogue kind too
    expect(parts.every((p) => p.kind === 'dialogue')).toBe(true);
  });

  it('degrades to literal (no O(n^2) blowup) on pathological delimiter spam', () => {
    // Many space-preceded unclosed '*' would make lazy+backref regexes quadratic.
    // The delimiter budget must bail to plain text quickly.
    const evil = ' **X'.repeat(5000); // 10000 unmatched '*'
    const start = performance.now();
    const parts = parseInline(evil);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    // no emphasis applied — rendered literally
    expect(parts.every((p) => !p.bold && !p.italic)).toBe(true);
    expect(parts.map((p) => p.text).join('')).toBe(evil);
  });

  it('parses a link with safe href', () => {
    const parts = parseInline('见 [文档](https://example.com/doc) 说明');
    const link = parts.find((p) => p.kind === 'link');
    expect(link?.text).toBe('文档');
    expect(link?.href).toBe('https://example.com/doc');
  });
});

// ─── sanitizeUrl ──────────────────────────────────────────────
describe('sanitizeUrl', () => {
  it('allows http/https/mailto and relative', () => {
    expect(sanitizeUrl('https://a.com')).toBe('https://a.com');
    expect(sanitizeUrl('http://a.com')).toBe('http://a.com');
    expect(sanitizeUrl('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(sanitizeUrl('/game/relationships')).toBe('/game/relationships');
    expect(sanitizeUrl('#anchor')).toBe('#anchor');
  });

  it('blocks javascript: and data: schemes', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('#');
    expect(sanitizeUrl('data:text/html,<script>')).toBe('#');
    expect(sanitizeUrl('  JavaScript:alert(1)')).toBe('#');
  });

  it('blocks tab/newline scheme-obfuscation bypass', () => {
    expect(sanitizeUrl('java\tscript:alert(1)')).toBe('#');
    expect(sanitizeUrl('java\nscript:alert(1)')).toBe('#');
    expect(sanitizeUrl('java\r\nscript:alert(1)')).toBe('#');
  });

  it('blocks protocol-relative //host as cross-origin', () => {
    expect(sanitizeUrl('//evil.com/x')).toBe('#');
    expect(sanitizeUrl('/game/relationships')).toBe('/game/relationships');
  });

  it('parsed malicious link href is neutralised', () => {
    const parts = parseInline('[x](javascript:alert(1))');
    const link = parts.find((p) => p.kind === 'link');
    expect(link?.href).toBe('#');
  });
});

// ─── block-level markdown ─────────────────────────────────────
describe('block parsing', () => {
  it('parses ATX headings with levels', () => {
    const blocks = parseNarrative('# 第一章\n\n正文段落');
    const h = blocks.find((b) => b.type === 'heading');
    expect(h?.type).toBe('heading');
    if (h?.type === 'heading') expect(h.level).toBe(1);
  });

  it('parses horizontal rule', () => {
    const blocks = parseNarrative('上文\n\n---\n\n下文');
    expect(blocks.some((b) => b.type === 'hr')).toBe(true);
  });

  it('parses an unordered list', () => {
    const blocks = parseNarrative('- 苹果\n- 香蕉\n- 樱桃');
    const list = blocks.find((b) => b.type === 'list');
    expect(list?.type).toBe('list');
    if (list?.type === 'list') {
      expect(list.ordered).toBe(false);
      expect(list.items).toHaveLength(3);
      expect(list.items[0].parts.map((p) => p.text).join('')).toBe('苹果');
    }
  });

  it('parses an ordered list', () => {
    const blocks = parseNarrative('1. 一\n2. 二\n3. 三');
    const list = blocks.find((b) => b.type === 'list');
    if (list?.type === 'list') {
      expect(list.ordered).toBe(true);
      expect(list.items).toHaveLength(3);
    }
  });

  it('parses a blockquote as recursable inner text', () => {
    const blocks = parseNarrative('> 引用的话\n> 第二行');
    const q = blocks.find((b) => b.type === 'blockquote');
    expect(q?.type).toBe('blockquote');
    if (q?.type === 'blockquote') expect(q.text).toBe('引用的话\n第二行');
  });

  it('captures a nested list as childText', () => {
    const blocks = parseNarrative('- 顶层\n  - 子项一\n  - 子项二');
    const list = blocks.find((b) => b.type === 'list');
    if (list?.type === 'list') {
      expect(list.items).toHaveLength(1);
      expect(list.items[0].childText).toContain('子项一');
      expect(list.items[0].childText).toContain('子项二');
    }
  });

  it('splits paragraphs on blank lines and keeps soft breaks within', () => {
    const blocks = parseNarrative('第一段行一\n第一段行二\n\n第二段');
    const paras = blocks.filter((b) => b.type === 'paragraph');
    expect(paras).toHaveLength(2);
    if (paras[0].type === 'paragraph') expect(paras[0].lines).toHaveLength(2);
  });

  it('keeps a lone plain narrative as a single paragraph (no regressions)', () => {
    const blocks = parseNarrative('他走进房间，看了一眼四周。');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
  });

  it('does not treat a mid-sentence dash as a rule', () => {
    const blocks = parseNarrative('这是一句——带破折号的话。');
    expect(blocks.every((b) => b.type !== 'hr')).toBe(true);
  });
});

// ─── Tables (GFM pipe tables) ─────────────────────────────────
describe('table parsing', () => {
  const md = '| 编号 | 课程 | 学分 |\n|:-----|:----:|-----:|\n| SSC-101 | 形象管理 | 1 |\n| SSC-102 | 心理建设 | 2 |';

  it('parses a pipe table into a table block', () => {
    const blocks = parseNarrative(md);
    const table = blocks.find((b) => b.type === 'table');
    expect(table?.type).toBe('table');
    if (table?.type === 'table') {
      expect(table.headers).toHaveLength(3);
      expect(table.headers[0].map((p) => p.text).join('')).toBe('编号');
      expect(table.rows).toHaveLength(2);
      expect(table.rows[0][0].map((p) => p.text).join('')).toBe('SSC-101');
    }
  });

  it('reads per-column alignment from the delimiter row', () => {
    const blocks = parseNarrative(md);
    const table = blocks.find((b) => b.type === 'table');
    if (table?.type === 'table') {
      expect(table.align).toEqual(['left', 'center', 'right']);
    }
  });

  it('normalizes rows to the header column count (pad + truncate)', () => {
    const t = '| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |';
    const blocks = parseNarrative(t);
    const table = blocks.find((b) => b.type === 'table');
    if (table?.type === 'table') {
      expect(table.rows[0]).toHaveLength(3); // padded
      expect(table.rows[1]).toHaveLength(3); // truncated
      expect(table.rows[0][1]).toEqual([]);  // missing cell → empty
    }
  });

  it('renders markdown inside cells', () => {
    const t = '| 名称 | 说明 |\n|---|---|\n| **粗** | 见 [文档](https://x.com) |';
    const blocks = parseNarrative(t);
    const table = blocks.find((b) => b.type === 'table');
    if (table?.type === 'table') {
      expect(table.rows[0][0].find((p) => p.bold)?.text).toBe('粗');
      expect(table.rows[0][1].find((p) => p.kind === 'link')?.href).toBe('https://x.com');
    }
  });

  it('does NOT treat a lone pipe line as a table (no delimiter row)', () => {
    const blocks = parseNarrative('他说 A | B 都行。\n然后离开了。');
    expect(blocks.every((b) => b.type !== 'table')).toBe(true);
  });

  it('rejects a table when delimiter column count does not match the header (GFM)', () => {
    // 3-col header, 2-col delimiter → not a valid GFM table → stays prose
    const blocks = parseNarrative('| a | b | c |\n|---|---|\n| 1 | 2 | 3 |');
    expect(blocks.every((b) => b.type !== 'table')).toBe(true);
  });

  it('parses a table without leading/trailing pipes', () => {
    const t = 'a | b\n--- | ---\n1 | 2';
    const blocks = parseNarrative(t);
    const table = blocks.find((b) => b.type === 'table');
    expect(table?.type).toBe('table');
    if (table?.type === 'table') expect(table.headers).toHaveLength(2);
  });

  it('parses a table inside a blockquote inner text (recursive render path)', () => {
    // parseNarrative on a blockquote yields a blockquote block whose raw text
    // is re-parsed by the recursive component; that inner text must parse to a table.
    const outer = parseNarrative('> | a | b |\n> |---|---|\n> | 1 | 2 |');
    const q = outer.find((b) => b.type === 'blockquote');
    expect(q?.type).toBe('blockquote');
    if (q?.type === 'blockquote') {
      const inner = parseNarrative(q.text);
      expect(inner.some((b) => b.type === 'table')).toBe(true);
    }
  });
});

// ─── NPC highlight ────────────────────────────────────────────
describe('highlightNpcNames', () => {
  it('splits normal parts on NPC names', () => {
    const parts = parseInline('林月走过来。');
    const hl = highlightNpcNames(parts, ['林月']);
    expect(hl.some((p) => p.kind === 'npc-name' && p.text === '林月')).toBe(true);
  });

  it('preserves bold/italic flags when splitting on NPC names', () => {
    const parts = parseInline('**林月很强**');
    const hl = highlightNpcNames(parts, ['林月']);
    const npc = hl.find((p) => p.kind === 'npc-name');
    expect(npc?.bold).toBe(true);
  });

  it('does not highlight names inside dialogue/psychology parts', () => {
    const parts = parseInline('"林月你好"');
    const hl = highlightNpcNames(parts, ['林月']);
    expect(hl.every((p) => p.kind !== 'npc-name')).toBe(true);
  });

  // 2026-08-03 fix: names inside 【环境】 narration were never highlighted
  // because only `normal` parts were split (user report: 沈鹤龄 in full-para
  // 【】 blocks had no highlight/hover card).
  it('highlights names inside environment 【】 parts', () => {
    const parts = parseInline('【林月站在檐下，望着雨幕。】');
    const hl = highlightNpcNames(parts, ['林月']);
    const npc = hl.find((p) => p.kind === 'npc-name');
    expect(npc?.text).toBe('林月');
    // surrounding pieces stay environment-kind (keep umber italic style)
    expect(hl.filter((p) => p.kind === 'environment').length).toBeGreaterThanOrEqual(2);
  });

  it('environment-sourced npc-name inherits italic to match narration rhythm', () => {
    const parts = parseInline('【林月来了】');
    const hl = highlightNpcNames(parts, ['林月']);
    const npc = hl.find((p) => p.kind === 'npc-name');
    expect(npc?.italic).toBe(true);
  });

  it('name filling the entire 【】 interior splits into bracket/npc/bracket with no empty parts', () => {
    const parts = parseInline('【林月】');
    const hl = highlightNpcNames(parts, ['林月']);
    expect(hl.map((p) => [p.kind, p.text])).toEqual([
      ['environment', '【'],
      ['npc-name', '林月'],
      ['environment', '】'],
    ]);
  });

  it('splits multiple name occurrences across normal and environment parts', () => {
    const parts = parseInline('林月说：【林月的影子被灯拉长。】');
    const hl = highlightNpcNames(parts, ['林月']);
    expect(hl.filter((p) => p.kind === 'npc-name').length).toBe(2);
  });
});
