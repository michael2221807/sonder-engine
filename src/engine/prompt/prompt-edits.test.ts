import { describe, it, expect } from 'vitest';
import {
  promptContentKey, promptEnabledKey, promptEditIds, readPromptEdits, writePromptEdits, restorePromptEdits,
  hydratePromptRegistry, promptEditsFromSlotOverrides, sanitizePromptEdits, migrateLegacyBuiltinOverrides,
  sameText, MAX_IMPORTED_PROMPT_LENGTH, resplitPromptEdits, promptSplitsDoneKey,
  type EditStorage,
} from './prompt-edits';
import { PromptRegistry } from './prompt-registry';
import type { BuiltinPromptEntry } from './world-book';
import { ALWAYS_ON_PROMPT_IDS } from './builtin-slots';

/** A Storage stand-in over a map, in insertion order. */
function memoryStorage(initial: Record<string, string> = {}): EditStorage & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    dump: () => Object.fromEntries(map),
  };
}

describe('prompt edits (the prompt page)', () => {
  it('reads only the edited or switched-off prompts of the pack, not other packs, weights or meta', () => {
    const s = memoryStorage({
      [promptContentKey('p', 'jailbreak')]: 'MINE',
      [promptEnabledKey('p', 'antiCliche')]: 'false',
      [promptEnabledKey('p', 'writeStyle')]: 'true',
      [promptContentKey('p2', 'jailbreak')]: 'OTHER PACK',
      aga_prompt_weight_p_jailbreak: '5',
      aga_prompt_meta_p_jailbreak: '{}',
    });
    expect(promptEditIds('p', s)).toEqual(['antiCliche', 'jailbreak', 'writeStyle']);
    expect(readPromptEdits('p', undefined, s)).toEqual([
      { id: 'antiCliche', enabled: false },
      { id: 'jailbreak', content: 'MINE' },
    ]);
  });

  it('writes each listed edit exactly as it says; an entry that is no edit or is malformed is skipped', () => {
    const s = memoryStorage({
      [promptContentKey('p', 'a')]: 'old a',
      [promptEnabledKey('p', 'a')]: 'false',
      [promptContentKey('p', 'keep')]: 'kept',
    });
    // Code review M3: a card is data from elsewhere; nothing malformed is stored ("[object Object]", a number).
    const incoming: unknown[] = [{ id: 'a' }, { id: 'b', content: 'new b', enabled: false }, { id: 5, content: 'x' },
      { id: 'c', content: { not: 'text' } }, null, 'mainRound', { id: 'd', content: 'new d', enabled: 'false' }];
    expect(writePromptEdits('p', incoming, s)).toBe(2);
    expect(s.dump()).toEqual({
      [promptContentKey('p', 'a')]: 'old a',
      [promptEnabledKey('p', 'a')]: 'false',
      [promptContentKey('p', 'keep')]: 'kept',
      [promptContentKey('p', 'b')]: 'new b',
      [promptEnabledKey('p', 'b')]: 'false',
      [promptContentKey('p', 'd')]: 'new d',
    });
  });

  it('an always-on prompt is never off: not read as an edit, not taken from a card', () => {
    expect(ALWAYS_ON_PROMPT_IDS.has('mainRound') && ALWAYS_ON_PROMPT_IDS.has('perspectiveSecond')).toBe(true);
    const s = memoryStorage({ [promptEnabledKey('p', 'mainRound')]: 'false', [promptEnabledKey('p', 'jailbreak')]: 'false' });
    expect(readPromptEdits('p', undefined, s)).toEqual([{ id: 'jailbreak', enabled: false }]);
    expect(sanitizePromptEdits([{ id: 'perspectiveSecond', enabled: false }, { id: 'splitGenStep1', content: 'mine', enabled: false }]))
      .toEqual([{ id: 'splitGenStep1', content: 'mine' }]);
  });

  it('restores a snapshot exactly: its prompts edited, every other edit of the pack cleared', () => {
    const s = memoryStorage({ [promptContentKey('p', 'added-by-import')]: 'x', [promptContentKey('q', 'other')]: 'y' });
    restorePromptEdits('p', [{ id: 'jailbreak', content: 'MINE' }], s);
    expect(s.dump()).toEqual({ [promptContentKey('q', 'other')]: 'y', [promptContentKey('p', 'jailbreak')]: 'MINE' });
  });

  it('loads the edits into the registry and puts back the pack text and the switch of the rest', () => {
    const registry = new PromptRegistry();
    for (const id of ['a', 'b', 'c']) registry.register({ id, content: `pack ${id}`, enabled: true });
    registry.setUserContent('c', 'stale');
    registry.setEnabled('c', false);
    hydratePromptRegistry(registry, 'p', ['a', 'b', 'c'],
      memoryStorage({ [promptContentKey('p', 'a')]: 'mine a', [promptEnabledKey('p', 'b')]: 'false' }));
    expect(registry.getEffectiveContent('a')).toBe('mine a');
    expect(registry.getEffectiveContent('b')).toBe('');
    expect(registry.getEffectiveContent('c')).toBe('pack c');
  });

  // Code review M1/M2: loading drops what is no edit, so the store only ever holds the player's real edits.
  it('drops a copy identical to the pack text and an always-on prompt\'s stored off while loading', () => {
    const registry = new PromptRegistry();
    registry.registerPack({ mainRound: 'pack format', jailbreak: 'pack jb' }, new Set(['mainRound']));
    const s = memoryStorage({
      [promptContentKey('p', 'jailbreak')]: 'pack jb',
      [promptEnabledKey('p', 'mainRound')]: 'false',
      [promptContentKey('p', 'mainRound')]: 'my format',
    });
    hydratePromptRegistry(registry, 'p', ['mainRound', 'jailbreak'], s);
    expect(s.dump()).toEqual({ [promptContentKey('p', 'mainRound')]: 'my format' });
    expect(registry.get('jailbreak')?.userContent).toBeUndefined();
    expect(registry.getEffectiveContent('mainRound')).toBe('my format');
    expect(registry.get('mainRound')?.enabled).toBe(true);
  });

  // Code review L2 (2026-10-04): a Windows working copy serves the pack with CRLF, a textarea gives LF back.
  it('line endings alone are no edit: a copy differing only in them is dropped while loading', () => {
    expect(sameText('一\r\n二', '一\n二')).toBe(true);
    expect(sameText('一\n二', '一\n三')).toBe(false);
    const registry = new PromptRegistry();
    registry.registerPack({ jailbreak: '第一行\r\n第二行' }, new Set());
    const s = memoryStorage({ [promptContentKey('p', 'jailbreak')]: '第一行\n第二行' });
    hydratePromptRegistry(registry, 'p', ['jailbreak'], s);
    expect(s.dump()).toEqual({});
  });

  // Code review L5: a card only brings edits of the pack's own prompts, each within a size.
  it('takes only the pack\'s own prompts from a card, each within a size', () => {
    const known = new Set(['jailbreak', 'writeStyle']);
    expect(sanitizePromptEdits([
      { id: 'jailbreak', content: 'ok' },
      { id: 'aga_junk_1', content: 'x' },
      { id: 'writeStyle', content: 'x'.repeat(MAX_IMPORTED_PROMPT_LENGTH + 1) },
    ], known)).toEqual([{ id: 'jailbreak', content: 'ok' }]);
  });

  // Code review L4: the old builder used an override only when it was not switched off and had text.
  it('reads an old card\'s slot overrides as the edits the old builder would have applied', () => {
    const entries = [
      { slotId: 'narrator_role', userContent: '自定义旁白' },
      { slotId: 'write_style', enabled: false },
      { slotId: 'write_anti_cliche', userContent: '没生效的改动', enabled: false },
      { slotId: 'write_emotion_guard', userContent: '   ' },
      { slotId: 'format_prompt', userContent: '旧格式' },
      { slotId: 'no_such_slot', userContent: 'x' },
      'not an entry',
    ] as unknown as BuiltinPromptEntry[];
    expect(promptEditsFromSlotOverrides(entries)).toEqual([
      { id: 'narratorFrame', content: '自定义旁白' },
      { id: 'mainRound', content: '旧格式' },
    ]);
    expect(promptEditsFromSlotOverrides('not a list')).toEqual([]);
  });

  // Code review M4 / P7 A: the retired slot-override store's data joins the page's edits once.
  it('moves the retired store\'s overrides into the page\'s edits once, never over the player\'s own', async () => {
    const library = {
      entries: [
        { slotId: 'narrator_role', userContent: '库里的旁白' },
        { slotId: 'write_style', userContent: '库里的文风' },
      ] as unknown[],
      cleared: 0,
      async loadAllBuiltinOverrides() { return this.entries; },
      async clearBuiltinOverrides() { this.cleared++; this.entries = []; },
    };
    const s = memoryStorage({ [promptContentKey('p', 'writeStyle')]: '我自己的文风' });
    expect(await migrateLegacyBuiltinOverrides(library, 'p', s)).toBe(1);
    expect(s.dump()).toEqual({
      [promptContentKey('p', 'writeStyle')]: '我自己的文风',
      [promptContentKey('p', 'narratorFrame')]: '库里的旁白',
    });
    expect(library.cleared).toBe(1);
    // Moved once: the store is empty now, and an empty store is left alone.
    expect(await migrateLegacyBuiltinOverrides(library, 'p', s)).toBe(0);
    expect(library.cleared).toBe(1);
  });
});

// Code review M1 (2026-10-05): core was split into core and coreNarrative. An edit of core made before still holds
// the sections now in coreNarrative, so they went out twice and the player's version never reached split Step 1.
describe('resplitPromptEdits (a prompt the pack split in two)', () => {
  const OLD = ['# Rules', 'You are the GM.', '---', '## A. Output', 'json only', '---', '## B. Purity', 'camera only',
    '---', '## C. NPC', '### C1. Names', 'random names', '### C2. Object', 'full object', '---', '## D. Autonomy',
    'never decide for the player'].join('\n');
  const DEFAULTS = {
    core: ['# Rules', 'You are the GM.', '---', '## A. Output', 'json only', '---', '## C. NPC', '### C2. Object',
      'full object'].join('\n'),
    coreNarrative: ['# Rules · story', 'You are the GM.', '---', '## B. Purity', 'camera only', '---', '## C. NPC',
      '### C1. Names', 'random names', '---', '## D. Autonomy', 'never decide for the player'].join('\n'),
  };
  const SPLIT = [{ from: 'core', to: 'coreNarrative' }];
  const key = (id: string) => promptContentKey('p', id);
  const upgradedNote = { [promptSplitsDoneKey('p')]: JSON.stringify(['core>coreNarrative']) };

  it('an old edit left as the pack wrote it becomes no edit at all', () => {
    const s = memoryStorage({ [key('core')]: OLD });
    expect(resplitPromptEdits('p', SPLIT, DEFAULTS, s)).toBe(1);
    // No edit left — only the note that this device has had the upgrade.
    expect(s.dump()).toEqual(upgradedNote);
  });

  it('the player\'s changes land in the prompt their section now belongs to, and nowhere twice', () => {
    const edited = OLD.replace('camera only', 'camera only, MINE').replace('full object', 'full object, MINE TOO');
    const s = memoryStorage({ [key('core')]: edited });
    resplitPromptEdits('p', SPLIT, DEFAULTS, s);
    const core = s.getItem(key('core'))!, story = s.getItem(key('coreNarrative'))!;
    expect(core).toContain('full object, MINE TOO');
    expect(core).not.toContain('camera only');
    expect(story).toContain('camera only, MINE');
    expect(story).toContain('random names');
    expect(story).not.toContain('full object');
    expect(story.startsWith('# Rules · story')).toBe(true);
    // The parent heading kept on both sides stays on both.
    expect(core).toContain('## C. NPC');
    expect(story).toContain('## C. NPC');
  });

  const upgraded = { [promptSplitsDoneKey('p')]: JSON.stringify(['core>coreNarrative']) };

  it('after the upgrade leaves an edit of the new kind alone', () => {
    const fresh = memoryStorage({ ...upgraded, [key('core')]: DEFAULTS.core.replace('json only', 'json only!') });
    expect(resplitPromptEdits('p', SPLIT, DEFAULTS, fresh)).toBe(0);
    expect(fresh.getItem(key('core'))).toContain('json only!');
    expect(fresh.getItem(promptEnabledKey('p', 'coreNarrative'))).toBeNull();
  });

  // Re-review L2: the player's own edit of the new prompt wins; the old copies of its sections are only dropped.
  it('when the player edited the new prompt already, keeps it and drops the copies from the old one', () => {
    const both = memoryStorage({ [key('core')]: OLD.replace('json only', 'json only!'), [key('coreNarrative')]: 'MY STORY RULES' });
    expect(resplitPromptEdits('p', SPLIT, DEFAULTS, both)).toBe(1);
    expect(both.getItem(key('coreNarrative'))).toBe('MY STORY RULES');
    expect(both.getItem(key('core'))).toContain('json only!');
    expect(both.getItem(key('core'))).not.toContain('camera only');
  });

  // Re-review M1: the switch is carried over once, on the upgrade; a later "off" of the old prompt is only that.
  it('a switched-off old prompt switches the new one off on the upgrade only, unless the player chose for it', () => {
    const off = memoryStorage({ [promptEnabledKey('p', 'core')]: 'false' });
    resplitPromptEdits('p', SPLIT, DEFAULTS, off);
    expect(off.getItem(promptEnabledKey('p', 'coreNarrative'))).toBe('false');
    const chosen = memoryStorage({ [promptEnabledKey('p', 'core')]: 'false', [promptEnabledKey('p', 'coreNarrative')]: 'true' });
    resplitPromptEdits('p', SPLIT, DEFAULTS, chosen);
    expect(chosen.getItem(promptEnabledKey('p', 'coreNarrative'))).toBe('true');
    const later = memoryStorage({ ...upgraded, [promptEnabledKey('p', 'core')]: 'false' });
    resplitPromptEdits('p', SPLIT, DEFAULTS, later);
    expect(later.getItem(promptEnabledKey('p', 'coreNarrative'))).toBeNull();
  });

  // Re-review M2: an old edit that deleted every moved section keeps them out: the new prompt is switched off.
  it('an old edit without any of the moved sections switches the new prompt off', () => {
    const deleted = ['# Rules', 'You are the GM.', '---', '## A. Output', 'json only', '---', '## C. NPC', '### C2. Object', 'full object'].join('\n')
      + '\nMY EXTRA';
    const s = memoryStorage({ [key('core')]: deleted });
    expect(resplitPromptEdits('p', SPLIT, DEFAULTS, s)).toBe(1);
    expect(s.getItem(promptEnabledKey('p', 'coreNarrative'))).toBe('false');
    expect(s.getItem(key('core'))).toContain('MY EXTRA');
  });

  // Re-review M3: a sub-section the player added under a moved section moves with it.
  it('a sub-section the player added follows its section', () => {
    const added = OLD.replace('camera only', 'camera only\n### B9. My addition\nmy own rule');
    const s = memoryStorage({ [key('core')]: added });
    resplitPromptEdits('p', SPLIT, DEFAULTS, s);
    expect(s.getItem(key('coreNarrative'))).toContain('### B9. My addition\nmy own rule');
    expect(s.getItem(key('core')) ?? '').not.toContain('My addition');
  });
});
