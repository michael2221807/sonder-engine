import { describe, it, expect } from 'vitest';
import {
  promptContentKey, promptEnabledKey, promptEditIds, readPromptEdits, writePromptEdits, restorePromptEdits,
  hydratePromptRegistry, promptEditsFromSlotOverrides, sanitizePromptEdits, migrateLegacyBuiltinOverrides,
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
