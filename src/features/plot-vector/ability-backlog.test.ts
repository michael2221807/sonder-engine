/**
 * Which obtained entries are shown as "ability not ready". Any attempt that did not give a usable ability
 * counts as failed, whether its reply was unusable or never came back; Step3 or the player fills it later.
 * Only a received first reply still waiting for its free check, a bound entry and a queued one are not listed.
 */
import { describe, expect, it } from 'vitest';
import { abilityBacklog } from './ability-backlog';
import { initialVectorState, type VectorTaskRow } from './runtime';
import { capabilityKey, type SavedElement } from './genesis/post-save';

const item: SavedElement = { id: 'item:tea', kind: 'item', capability: { name: '茶' } };
const tag: SavedElement = { id: 'environment:name:微风', kind: 'environment', capability: { name: '微风', description: '街道上的风' } };
const rowFor = (entry: SavedElement, fields: Partial<VectorTaskRow>): VectorTaskRow =>
  ({ task: { key: capabilityKey(entry), actionId: 'x', entry }, status: 'failed', ...fields });
const stateOf = (row: VectorTaskRow) => abilityBacklog({ ...initialVectorState(), tasks: [row] }, [item, tag])[0]?.state;

describe('ability backlog classification', () => {
  it.each([
    ['first reply received and rejected', rowFor(item, { raw: '{}' }), 'failed'],
    ['first request failed without a reply', rowFor(item, { error: 'network' }), 'failed'],
    ['first request left, page closed before its reply', rowFor(item, { status: 'sending' }), 'failed'],
    ['first reply received, free check pending next round', rowFor(item, { status: 'sending', raw: '{}' }), undefined],
    ['environment tag Step2 wrote without a usable ability', rowFor(tag, { error: '缺少能力' }), 'failed'],
    ['latest try was Step3 (counted as it left)', rowFor(item, { raw: '{}', retry: { attempts: 1, autoRounds: 1, source: 'step3' } }), 'failed'],
    ['player retry got a reply that did not validate', rowFor(item, { retry: { attempts: 1, autoRounds: 0, source: 'manual', raw: '{}' } }), 'failed'],
    ['player retry got no reply', rowFor(item, { raw: '{}', retry: { attempts: 1, autoRounds: 0, source: 'manual' } }), 'failed'],
    ['environment tag after a Step3 try', rowFor(tag, { retry: { attempts: 1, autoRounds: 1, source: 'step3' } }), 'failed'],
    ['already bound', rowFor(item, { status: 'bound', raw: '{}' }), undefined],
    ['waiting for its first generation', rowFor(item, { status: 'pending' }), undefined],
  ] as const)('%s', (_label, row, expected) => {
    expect(stateOf(row)).toBe(expected);
  });

  it('only current sources count, and an entry that already has a card is never listed', () => {
    const gone = rowFor({ ...item, id: 'item:gone' }, { raw: '{}' });
    expect(abilityBacklog({ ...initialVectorState(), tasks: [gone] }, [item, tag])).toEqual([]);
    const card = { task: rowFor(item, {}).task } as unknown as import('./genesis/post-save').BoundCard;
    expect(abilityBacklog({ ...initialVectorState(), cards: [card], tasks: [rowFor(item, { raw: '{}' })] }, [item])).toEqual([]);
  });
});
