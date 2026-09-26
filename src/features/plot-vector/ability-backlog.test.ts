/**
 * The backlog (rebuild plan §6, charter I20): every saved item, talent, status and environment without a
 * usable ability for its current content — entries that were there before the feature was on included. A
 * stored row means an attempt failed; no row means the entry has not been tried yet.
 */
import { describe, expect, it } from 'vitest';
import { abilityBacklog } from './ability-backlog';
import { bindCard, initialVectorState, type VectorTaskRow } from './runtime';
import { capabilityKey, type SavedElement } from './genesis/post-save';

const item: SavedElement = { id: 'item:tea', kind: 'item', capability: { name: '茶', description: '一壶热茶' } };
const talent: SavedElement = { id: 'talent:name:口才', kind: 'talent', capability: { name: '口才', description: '会说话' } };
const status: SavedElement = { id: 'effect:name:发烧', kind: 'effect', capability: { name: '发烧', description: '头很沉' } };
const tag: SavedElement = { id: 'environment:name:微风', kind: 'environment', capability: { name: '微风', description: '街道上的风' } };
const task = (entry: SavedElement) => ({ key: capabilityKey(entry), actionId: 'x', entry });
const rowFor = (entry: SavedElement, fields: Partial<VectorTaskRow> = {}): VectorTaskRow => ({ task: task(entry), ...fields });
const card = (entry: SavedElement) => bindCard(task(entry), { for: String(entry.capability.name), type: 'item', summary: 's', onPass: 'return { push: 1 };' });

describe('ability backlog', () => {
  it('every kind of entry without a card is listed, never-tried ones as waiting', () => {
    const backlog = abilityBacklog(initialVectorState(), [item, talent, status, tag]);
    expect(backlog.map(b => [b.id, b.kind, b.name, b.state])).toEqual([
      ['item:tea', 'item', '茶', 'waiting'], ['talent:name:口才', 'talent', '口才', 'waiting'],
      ['effect:name:发烧', 'effect', '发烧', 'waiting'], ['environment:name:微风', 'environment', '微风', 'waiting'],
    ]);
    // A never-tried entry carries a fresh row (not stored) so Step3 and the player can start its attempts.
    expect(backlog[0].row).toEqual({ task: { key: capabilityKey(item), actionId: 'backlog', entry: item } });
  });
  it.each([
    ['a reply that did not pass the check', rowFor(item, { raw: '{}', error: 'bad' }), 'bad'],
    ['a request that got no reply', rowFor(item, { error: 'network' }), 'network'],
    ['a Step3 retry (its own reason wins)', rowFor(item, { error: 'first', retry: { attempts: 1, autoRounds: 1, source: 'step3', error: 'later' } }), 'later'],
    ['a player retry that got no reply', rowFor(item, { retry: { attempts: 1, autoRounds: 0, source: 'manual' } }), undefined],
  ] as const)('a stored row is a failed attempt: %s', (_label, row, problem) => {
    const [entry] = abilityBacklog({ ...initialVectorState(), tasks: [row] }, [item]);
    expect(entry).toMatchObject({ id: 'item:tea', state: 'failed' });
    expect(entry.problem).toBe(problem);
    expect(entry.row).toBe(row);
  });
  it('an entry with a card for its current content is not listed; a changed entry is', () => {
    const state = { ...initialVectorState(), cards: [card(item), card(tag)] };
    expect(abilityBacklog(state, [item, tag])).toEqual([]);
    // An item reworded keeps its card; an environment whose effect changed does not.
    const reworded = { ...item, capability: { ...item.capability, description: '换了说法' } };
    const changed = { ...tag, capability: { ...tag.capability, 效果: '更冷了' } };
    expect(abilityBacklog(state, [reworded, changed]).map(b => b.id)).toEqual(['environment:name:微风']);
  });
  it('only entries in the save count; rows of entries that are gone are ignored', () => {
    const gone = rowFor({ ...item, id: 'item:gone' }, { error: 'x' });
    expect(abilityBacklog({ ...initialVectorState(), tasks: [gone] }, [])).toEqual([]);
  });
});
