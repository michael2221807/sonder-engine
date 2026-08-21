/**
 * EngramManager's out-of-round Canon Capture bridge.
 *
 * These two methods are what the panel and toast call — undo / restore / edit happen
 * outside any pipeline run, so they cannot ride the round's single `processResponse()`
 * write. They shipped in P3 with no coverage at all, which is how the intra-round
 * provenance bug got in; this file closes that hole at the manager level.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EngramManager } from './engram-manager';
import type { CanonMutationInput } from './canon-projection';
import { findCanonEdges } from './canon-projection';
import { ENGRAM_CONFIG_KEY } from './engram-config';
import type { EngramEdge } from './knowledge-edge';
import { isEdgeCurrentlyValid } from './knowledge-edge';
import type { AIService } from '../../ai/ai-service';
import type { StateManager } from '../../core/state-manager';
import { createMockStateManager, type MockStateManager } from '../../__test-utils__';
import { createMockLocalStorage } from '../../__test-utils__/local-storage.mock';

// The engram config lives in localStorage; the test env is `node`, so install a stub.
let storageMock: ReturnType<typeof createMockLocalStorage>;

const ENGRAM_PATH = '系统.扩展.engramMemory';

function enableEngram(mode: 'active' | 'off' = 'active'): void {
  localStorage.setItem(ENGRAM_CONFIG_KEY, JSON.stringify({
    enabled: true,
    knowledgeEdgeMode: mode,
  }));
}

function makeManager(): EngramManager {
  const ai = { generate: vi.fn(async () => '') } as unknown as AIService;
  return new EngramManager(ai, undefined, () => null);
}

function seedState(sm: MockStateManager, edges: EngramEdge[] = []): void {
  sm.set('元数据.回合序号', 7);
  sm.set(ENGRAM_PATH, {
    events: [],
    entities: [
      { name: '林月', type: 'npc', summary: '', attributes: {}, firstSeen: 1, lastSeen: 1, mentionCount: 1, is_embedded: false },
      { name: '玩家', type: 'player', summary: '', attributes: {}, firstSeen: 1, lastSeen: 1, mentionCount: 1, is_embedded: false },
    ],
    relations: [],
    v2Edges: edges,
    meta: { schemaVersion: 5, lastUpdated: 0 },
  });
}

function edgesOf(sm: MockStateManager): EngramEdge[] {
  return sm.get<{ v2Edges?: EngramEdge[] }>(ENGRAM_PATH)?.v2Edges ?? [];
}

const relationship: CanonMutationInput = {
  entryId: 'cap_rel',
  kind: 'relationship',
  statement: '林月是玩家的妹妹。',
  entities: ['林月', '玩家'],
  op: 'add',
};

describe('reprojectCanonEntry', () => {
  beforeEach(() => {
    storageMock = createMockLocalStorage();
    storageMock.install();
    enableEngram();
  });
  afterEach(() => { storageMock.restore(); });

  it('creates a canon edge with full provenance', async () => {
    const { sm } = createMockStateManager({});
    seedState(sm);

    const r = await makeManager().reprojectCanonEntry(sm as unknown as StateManager, relationship);

    expect(r.projected).toBe(true);
    const edges = edgesOf(sm);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source: 'user-canon',
      core: true,
      canonEntryId: 'cap_rel',
      sourceEntity: '林月',
      targetEntity: '玩家',
    });
  });

  it('a short statement survives — the length filter must not eat canon facts', async () => {
    const { sm } = createMockStateManager({});
    seedState(sm);
    await makeManager().reprojectCanonEntry(sm as unknown as StateManager, {
      ...relationship, statement: '林月是玩家的妹妹', // 8 chars, under the AI filter
    });
    expect(edgesOf(sm)).toHaveLength(1);
  });

  it('re-projecting the SAME statement leaves exactly one live edge', async () => {
    // The restore path: invalidate then rebuild. If the statement did not change the
    // derived edge id is identical, so this must end live — not dead, and not doubled.
    const { sm } = createMockStateManager({});
    seedState(sm);
    const mgr = makeManager();

    await mgr.reprojectCanonEntry(sm as unknown as StateManager, relationship);
    await mgr.reprojectCanonEntry(sm as unknown as StateManager, relationship);

    const live = findCanonEdges(edgesOf(sm), 'cap_rel');
    expect(live).toHaveLength(1);
    expect(isEdgeCurrentlyValid(live[0])).toBe(true);
  });

  it('changing the statement kills the old edge and builds a new one', async () => {
    const { sm } = createMockStateManager({});
    seedState(sm);
    const mgr = makeManager();

    await mgr.reprojectCanonEntry(sm as unknown as StateManager, relationship);
    await mgr.reprojectCanonEntry(sm as unknown as StateManager, {
      ...relationship, statement: '林月其实是玩家的表妹，不是亲妹妹。',
    });

    const all = edgesOf(sm).filter((e) => e.canonEntryId === 'cap_rel');
    expect(all.length).toBeGreaterThan(1);            // history kept
    expect(findCanonEdges(edgesOf(sm), 'cap_rel')).toHaveLength(1); // exactly one live
    expect(findCanonEdges(edgesOf(sm), 'cap_rel')[0].fact).toContain('表妹');
  });

  it('a one-entity setting is a deliberate no-op — no fake node, no edge', async () => {
    const { sm } = createMockStateManager({});
    seedState(sm);
    const r = await makeManager().reprojectCanonEntry(sm as unknown as StateManager, {
      entryId: 'cap_trait', kind: 'character', statement: '林月从小怕水。', entities: ['林月'], op: 'add',
    });
    expect(r.projected).toBe(false);
    expect(edgesOf(sm)).toHaveLength(0);
  });

  it('does nothing when the graph is switched off', async () => {
    localStorage.setItem(ENGRAM_CONFIG_KEY, JSON.stringify({ enabled: false, knowledgeEdgeMode: 'off' }));
    const { sm } = createMockStateManager({});
    seedState(sm);
    const r = await makeManager().reprojectCanonEntry(sm as unknown as StateManager, relationship);
    expect(r.projected).toBe(false);
    expect(edgesOf(sm)).toHaveLength(0);
  });

  it('stubs a missing entity but refuses a sentence-like junk name', async () => {
    const { sm } = createMockStateManager({});
    seedState(sm);
    const mgr = makeManager();

    await mgr.reprojectCanonEntry(sm as unknown as StateManager, {
      ...relationship, entryId: 'cap_new', entities: ['张三', '玩家'],
    });
    const entities = sm.get<{ entities: Array<{ name: string }> }>(ENGRAM_PATH)!.entities;
    expect(entities.map((e) => e.name)).toContain('张三');

    // A descriptive phrase masquerading as a name must not become a node — the same
    // guard the in-round capture path applies.
    await mgr.reprojectCanonEntry(sm as unknown as StateManager, {
      ...relationship, entryId: 'cap_junk', entities: ['林月被吓到了的样子', '玩家'],
    });
    const after = sm.get<{ entities: Array<{ name: string }> }>(ENGRAM_PATH)!.entities;
    expect(after.map((e) => e.name)).not.toContain('林月被吓到了的样子');
  });
});

describe('invalidateCanonEntries', () => {
  beforeEach(() => {
    storageMock = createMockLocalStorage();
    storageMock.install();
    enableEngram();
  });
  afterEach(() => { storageMock.restore(); });

  it('invalidates the entry\'s live edges without deleting the rows', async () => {
    const { sm } = createMockStateManager({});
    seedState(sm);
    const mgr = makeManager();
    await mgr.reprojectCanonEntry(sm as unknown as StateManager, relationship);

    const r = await mgr.invalidateCanonEntries(sm as unknown as StateManager, ['cap_rel']);

    expect(r.invalidated).toBe(1);
    expect(edgesOf(sm)).toHaveLength(1);          // row kept — auditable, restorable
    expect(findCanonEdges(edgesOf(sm), 'cap_rel')).toHaveLength(0);
    expect(edgesOf(sm)[0].invalidAtRound).toBe(7);
  });

  it('leaves other entries alone', async () => {
    const { sm } = createMockStateManager({});
    seedState(sm);
    const mgr = makeManager();
    await mgr.reprojectCanonEntry(sm as unknown as StateManager, relationship);
    await mgr.reprojectCanonEntry(sm as unknown as StateManager, {
      entryId: 'cap_other', kind: 'relationship', statement: '张三是玩家的师父。',
      entities: ['张三', '玩家'], op: 'add',
    });

    await mgr.invalidateCanonEntries(sm as unknown as StateManager, ['cap_rel']);

    expect(findCanonEdges(edgesOf(sm), 'cap_rel')).toHaveLength(0);
    expect(findCanonEdges(edgesOf(sm), 'cap_other')).toHaveLength(1);
  });

  it('is a cheap no-op for an unknown id / empty list (no pointless state write)', async () => {
    const { sm } = createMockStateManager({});
    seedState(sm);
    const mgr = makeManager();
    expect((await mgr.invalidateCanonEntries(sm as unknown as StateManager, [])).invalidated).toBe(0);
    expect((await mgr.invalidateCanonEntries(sm as unknown as StateManager, ['nope'])).invalidated).toBe(0);
  });

  it('undo → restore round-trips back to exactly one live edge', async () => {
    const { sm } = createMockStateManager({});
    seedState(sm);
    const mgr = makeManager();

    await mgr.reprojectCanonEntry(sm as unknown as StateManager, relationship);
    await mgr.invalidateCanonEntries(sm as unknown as StateManager, ['cap_rel']);
    expect(findCanonEdges(edgesOf(sm), 'cap_rel')).toHaveLength(0);

    await mgr.reprojectCanonEntry(sm as unknown as StateManager, relationship);
    expect(findCanonEdges(edgesOf(sm), 'cap_rel')).toHaveLength(1);
  });
});
