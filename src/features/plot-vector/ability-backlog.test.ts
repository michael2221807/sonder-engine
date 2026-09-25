/**
 * Which obtained entries are shown as "ability not ready", and in which state, judged by the latest attempt:
 * a received but unusable reply may be retried by Step3; a request that never got a reply stays "no result"
 * (only a free recovery or the player's explicit retry); a player retry still out is "retrying".
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
    ['first request failed without a reply', rowFor(item, { error: 'network' }), 'unknown'],
    ['first request left, outcome never recorded', rowFor(item, { status: 'sending' }), 'unknown'],
    ['first reply received, free check pending next round', rowFor(item, { status: 'sending', raw: '{}' }), undefined],
    ['environment tag Step2 wrote without a usable ability', rowFor(tag, { error: '缺少能力' }), 'failed'],
    ['latest try was Step3 (counted as it left)', rowFor(item, { raw: '{}', retry: { attempts: 1, autoRounds: 1, source: 'step3' } }), 'failed'],
    ['player retry got a reply that did not validate', rowFor(item, { retry: { attempts: 1, autoRounds: 0, source: 'manual', raw: '{}' } }), 'failed'],
    ['player retry got no reply (the old first reply does not count)', rowFor(item, { raw: '{}', retry: { attempts: 1, autoRounds: 0, source: 'manual' } }), 'unknown'],
    ['environment tag after a Step3 try', rowFor(tag, { retry: { attempts: 1, autoRounds: 1, source: 'step3' } }), 'failed'],
    ['environment tag after a player retry that got no reply', rowFor(tag, { retry: { attempts: 2, autoRounds: 2, source: 'manual' } }), 'unknown'],
    ['environment tag after a player retry whose reply did not validate', rowFor(tag, { retry: { attempts: 2, autoRounds: 2, source: 'manual', raw: 'x' } }), 'failed'],
    ['player retry still out', rowFor(item, { raw: '{}', retry: { attempts: 1, autoRounds: 0, source: 'manual', sending: true } }), 'retrying'],
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
