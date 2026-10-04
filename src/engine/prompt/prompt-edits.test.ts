import { describe, it, expect } from 'vitest';
import {
  promptContentKey, promptEnabledKey, promptEditIds, readPromptEdits, writePromptEdits, restorePromptEdits,
  hydratePromptRegistry, promptEditsFromSlotOverrides, type EditStorage,
} from './prompt-edits';
import { PromptRegistry } from './prompt-registry';
import type { BuiltinPromptEntry } from './world-book';

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

  it('writes each listed prompt exactly as its edit says and leaves the others alone', () => {
    const s = memoryStorage({
      [promptContentKey('p', 'a')]: 'old a',
      [promptEnabledKey('p', 'a')]: 'false',
      [promptContentKey('p', 'keep')]: 'kept',
    });
    expect(writePromptEdits('p', [{ id: 'a' }, { id: 'b', content: 'new b', enabled: false }], s)).toBe(2);
    expect(s.dump()).toEqual({
      [promptContentKey('p', 'keep')]: 'kept',
      [promptContentKey('p', 'b')]: 'new b',
      [promptEnabledKey('p', 'b')]: 'false',
    });
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

  it('reads an old card\'s slot overrides as edits of the prompts their slots name', () => {
    const entries = [
      { slotId: 'narrator_role', userContent: '自定义旁白' },
      { slotId: 'write_style', enabled: false },
      { slotId: 'write_emotion_guard', userContent: '   ' },
      { slotId: 'no_such_slot', userContent: 'x' },
    ] as unknown as BuiltinPromptEntry[];
    expect(promptEditsFromSlotOverrides(entries)).toEqual([
      { id: 'narratorFrame', content: '自定义旁白' },
      { id: 'writeStyle', enabled: false },
    ]);
  });
});
