import { describe, it, expect } from 'vitest';
import {
  readCharacterVectors,
  emptyCharacterVectors,
  activeVectorEntries,
  resolveVectorScope,
  shortNameForm,
  buildCharacterVectorBlock,
  buildCharacterVectorsFromState,
  resolveCharacterVectorFragments,
  characterVectorsTraceEntry,
  lastNarrativeText,
  CHARACTER_VECTOR_LINE_MAX_CHARS,
  CHARACTER_VECTOR_UNCONFIRMED_MAX_CHARS,
  type CharacterVectorEntry,
} from './character-vectors';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';

const paths = DEFAULT_ENGINE_PATHS;

const FRAGMENTS = {
  characterVectorHeader: '【人物向量】倾向不是结局。',
  characterVectorHeadingLabel: '走向｜',
  characterVectorTensionLabel: '拉扯｜',
  characterVectorUnconfirmedLabel: '【主角尚未证实的事】',
  characterVectorFieldSeparator: ' ',
  characterVectorUnconfirmedSeparator: '；',
};

function entry(over: Partial<CharacterVectorEntry> & { name: string }): CharacterVectorEntry {
  return { id: over.name, heading: '', tension: '', unconfirmed: '', enabled: true, source: 'player', updatedRound: 1, ...over };
}

function mockState(tree: Record<string, unknown>) {
  return {
    get<T>(path: string): T | undefined {
      return path.split('.').reduce<unknown>((acc, k) => (acc != null && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), tree) as T | undefined;
    },
  };
}

function tree(vectors: unknown, relationships: unknown[] = [], history: unknown[] = [], player = '主角') {
  return {
    系统: { 扩展: { characterVectors: vectors } },
    社交: { 关系: relationships },
    元数据: { 叙事历史: history },
    角色: { 基础信息: { 姓名: player } },
  };
}

describe('readCharacterVectors', () => {
  it('degrades missing / malformed data to the empty state', () => {
    expect(readCharacterVectors(mockState({}), paths)).toEqual(emptyCharacterVectors());
    expect(readCharacterVectors(mockState(tree('nope')), paths)).toEqual(emptyCharacterVectors());
    expect(readCharacterVectors(mockState(tree({ enabled: true, entries: 'x' })), paths).entries).toEqual([]);
  });

  it('normalises entries: drops nameless, defaults source / enabled / round, trims and caps lines', () => {
    const long = 'a'.repeat(CHARACTER_VECTOR_LINE_MAX_CHARS + 20);
    const longer = 'b'.repeat(CHARACTER_VECTOR_UNCONFIRMED_MAX_CHARS + 20);
    const s = readCharacterVectors(mockState(tree({ entries: [
      { name: ' 沈墨琛 ', heading: ` ${long} `, unconfirmed: longer, source: 'bogus', updatedRound: 'x' },
      { heading: 'no name' },
      { name: '林晚照', tension: '想靠着她，又怕拖累她', enabled: false, source: 'proposed', updatedRound: 7, id: 'keep' },
    ] })), paths);
    expect(s.enabled).toBe(true);
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0]).toMatchObject({ name: '沈墨琛', source: 'player', enabled: true, updatedRound: 0, id: 'vector-0' });
    expect(s.entries[0]!.heading).toHaveLength(CHARACTER_VECTOR_LINE_MAX_CHARS);
    expect(s.entries[0]!.unconfirmed).toHaveLength(CHARACTER_VECTOR_UNCONFIRMED_MAX_CHARS);
    expect(s.entries[1]).toMatchObject({ name: '林晚照', source: 'proposed', enabled: false, updatedRound: 7, id: 'keep', tension: '想靠着她，又怕拖累她' });
  });

  it('migrates v1 entries on read: toward + direction → heading, never → tension, hidden → unconfirmed; a v2 field always wins', () => {
    const s = readCharacterVectors(mockState(tree({ entries: [
      { name: '沈墨琛', toward: '当藏品', never: '不解释、不承诺', direction: '护在加深', hidden: '晚照的买家是他安排的' },
      { name: '林晚照', toward: '完全信赖' },
      { name: '乔诗诗', toward: '旧的', heading: '新的', hidden: '旧秘密', unconfirmed: '' },
    ] })), paths);
    expect(s.entries[0]).toMatchObject({ heading: '当藏品; 护在加深', tension: '不解释、不承诺', unconfirmed: '晚照的买家是他安排的' });
    expect(s.entries[1]).toMatchObject({ heading: '完全信赖', tension: '', unconfirmed: '' });
    expect(s.entries[2]).toMatchObject({ heading: '新的', unconfirmed: '' });
    expect(s.entries[0]).not.toHaveProperty('toward');
  });
});

describe('activeVectorEntries', () => {
  it('keeps enabled entries with content, proposed ones included; drops empty and disabled', () => {
    const s = { enabled: true, entries: [
      entry({ name: 'A', heading: 'x' }),
      entry({ name: 'B', unconfirmed: 'h', source: 'proposed' }),
      entry({ name: 'C' }),
      entry({ name: 'D', heading: 'x', enabled: false }),
    ] };
    expect(activeVectorEntries(s).map((e) => e.name)).toEqual(['A', 'B']);
  });
});

describe('resolveVectorScope', () => {
  const rels = [
    { 名称: '沈墨琛', 是否在场: true },
    { 名称: '林晚照', 是否在场: false },
    { 名称: '白诗雅' },
    'garbage',
  ];
  it('picks present NPCs, names in the input and names in the previous narrative, in candidate order', () => {
    const scope = resolveVectorScope({
      relationships: rels,
      candidates: ['白诗雅', '林晚照', '沈墨琛', '乔诗诗', '沈墨琛'],
      userInput: '我给白诗雅发消息',
      lastNarrative: '……林晚照被接走了。',
      paths,
    });
    expect(scope).toEqual(['白诗雅', '林晚照', '沈墨琛']);
  });
  it('yields nothing when nobody is present or mentioned, and tolerates a non-array list', () => {
    expect(resolveVectorScope({ relationships: null, candidates: ['沈墨琛'], paths })).toEqual([]);
    expect(resolveVectorScope({ relationships: rels, candidates: ['乔诗诗'], userInput: '', lastNarrative: '', paths })).toEqual([]);
  });
  it('matches the short form players actually write (林晚照 ← 晚照), never a separated, two-character or non-Han name', () => {
    expect(shortNameForm('林晚照')).toBe('晚照');
    expect(shortNameForm('马蒂尔达·罗西')).toBeUndefined();
    expect(shortNameForm('小明')).toBeUndefined();
    expect(shortNameForm('Kate')).toBeUndefined();
    expect(shortNameForm('Amy')).toBeUndefined();
    const scope = resolveVectorScope({
      relationships: [{ 名称: '林晚照', 是否在场: false }, { 名称: '马蒂尔达·罗西', 是否在场: false }],
      candidates: ['林晚照', '马蒂尔达·罗西'],
      userInput: '直到第三天晚照才回来了',
      lastNarrative: '罗西没有出现。',
      paths,
    });
    expect(scope).toEqual(['林晚照']);
  });
});

describe('buildCharacterVectorBlock', () => {
  const fragments = resolveCharacterVectorFragments(FRAGMENTS);
  const vectors = { enabled: true, entries: [
    entry({ name: '沈墨琛', heading: '往护偏，独她一份', tension: '护了，却不认、不承诺', unconfirmed: '晚照的买家是他安排的' }),
    entry({ name: '林晚照', heading: '往更信赖偏' }),
    entry({ name: '主角', heading: '不该出现' }),
  ] };

  it('renders header, one line per in-scope entry (only non-empty fields) and one unconfirmed line', () => {
    const block = buildCharacterVectorBlock({ vectors, scope: ['沈墨琛', '林晚照', '主角'], protagonistName: '主角', fragments });
    expect(block).toBe([
      '【人物向量】倾向不是结局。',
      '- 沈墨琛：走向｜往护偏，独她一份 拉扯｜护了，却不认、不承诺',
      '- 林晚照：走向｜往更信赖偏',
      '【主角尚未证实的事】晚照的买家是他安排的',
    ].join('\n'));
    expect(block).not.toContain('不该出现');
  });

  it('is empty when disabled, when the scope has no entries, when the pack has no header, or when only unconfirmed deeds exist without their label', () => {
    expect(buildCharacterVectorBlock({ vectors: { ...vectors, enabled: false }, scope: ['沈墨琛'], protagonistName: '', fragments })).toBe('');
    expect(buildCharacterVectorBlock({ vectors, scope: ['乔诗诗'], protagonistName: '', fragments })).toBe('');
    expect(buildCharacterVectorBlock({ vectors, scope: ['沈墨琛'], protagonistName: '', fragments: resolveCharacterVectorFragments({}) })).toBe('');
    const unconfirmedOnly = { enabled: true, entries: [entry({ name: '程彦', unconfirmed: '没得手是沈阻止的' })] };
    expect(buildCharacterVectorBlock({ vectors: unconfirmedOnly, scope: ['程彦'], protagonistName: '', fragments: { ...fragments, unconfirmedLabel: '' } })).toBe('');
    expect(buildCharacterVectorBlock({ vectors: unconfirmedOnly, scope: ['程彦'], protagonistName: '', fragments })).toBe('【人物向量】倾向不是结局。\n【主角尚未证实的事】没得手是沈阻止的');
  });
});

describe('buildCharacterVectorsFromState', () => {
  const stored = { enabled: true, entries: [
    entry({ name: '沈墨琛', heading: '往护偏' }),
    entry({ name: '林晚照', heading: '往更信赖偏' }),
    entry({ name: '乔诗诗', heading: '想帮衬' }),
  ] };
  const rels = [{ 名称: '沈墨琛', 是否在场: true }, { 名称: '林晚照' }, { 名称: '乔诗诗' }];
  const history = [{ role: 'user', content: 'x' }, { role: 'assistant', content: '乔诗诗发来消息。' }, { role: 'user', content: 'y' }];

  it('projects by presence / input / previous narrative for the main round', () => {
    const state = mockState(tree(stored, rels, history));
    const r = buildCharacterVectorsFromState(state, paths, FRAGMENTS, { userInput: '', lastNarrative: lastNarrativeText(state, paths) });
    expect(r.scope).toEqual(['沈墨琛', '乔诗诗']);
    expect(r.block).toContain('- 沈墨琛：');
    expect(r.block).toContain('- 乔诗诗：');
    expect(r.block).not.toContain('林晚照');
  });

  it('`only` restricts to one NPC (private chat) and `all` takes every entry (plot decomposition)', () => {
    const state = mockState(tree(stored, rels, history));
    expect(buildCharacterVectorsFromState(state, paths, FRAGMENTS, { only: '林晚照' }).scope).toEqual(['林晚照']);
    expect(buildCharacterVectorsFromState(state, paths, FRAGMENTS, { only: '路人' }).block).toBe('');
    expect(buildCharacterVectorsFromState(state, paths, FRAGMENTS, { all: true }).scope).toEqual(['沈墨琛', '林晚照', '乔诗诗']);
  });

  it('a save without the feature yields an empty block (byte-identical prompts)', () => {
    const r = buildCharacterVectorsFromState(mockState(tree(undefined, rels, history)), paths, FRAGMENTS, { userInput: '沈墨琛' });
    expect(r.block).toBe('');
    expect(r.scope).toEqual([]);
  });

  it('a v1 save renders through the same builder after migration', () => {
    const legacy = { enabled: true, entries: [{ name: '沈墨琛', toward: '当藏品', never: '不解释', hidden: '他叫停了调教' }] };
    const r = buildCharacterVectorsFromState(mockState(tree(legacy, rels, history)), paths, FRAGMENTS, { userInput: '' });
    expect(r.block).toBe('【人物向量】倾向不是结局。\n- 沈墨琛：走向｜当藏品 拉扯｜不解释\n【主角尚未证实的事】他叫停了调教');
  });
});

describe('helpers', () => {
  it('lastNarrativeText returns the last assistant entry or empty', () => {
    expect(lastNarrativeText(mockState(tree(undefined, [], [{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }])), paths)).toBe('a');
    expect(lastNarrativeText(mockState({}), paths)).toBe('');
  });
  it('trace entry keeps tokens unchanged', () => {
    expect(characterVectorsTraceEntry(12, 3, 2)).toMatchObject({ target: 'vectors', action: 'keep', before: 12, after: 12, detail: { entries: 3, scope: 2 } });
  });
});
