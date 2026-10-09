import 'fake-indexeddb/auto';
/**
 * 存档瘦身 D4A — EngramManager.repairVectorDims on the real StateManager and the real VectorStore (fake-indexeddb):
 * the pseudo vectors of a save are cleaned in two steps across opens, so neither the stored save nor the tree a
 * rollback puts back ever says "embedded" for an entry whose vector is gone, and the save check before each round
 * never takes the repair for a loss.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cloneDeep } from 'lodash-es';
import { StateManager } from '../../core/state-manager';
import { eventBus } from '../../core/event-bus';
import { idbAdapter } from '../../persistence/idb-adapter';
import { runSaveHealthCheck } from '../../persistence/save-health';
import { DEFAULT_ENGINE_PATHS as P } from '../../pipeline/types';
import { EngramManager } from './engram-manager';
import { pseudoEmbed } from './embedder';
import { VectorStore } from './vector-store';
import type { AIService } from '../../ai/ai-service';

type Json = Record<string, unknown>;
type Slot = { profileId: string; slotId: string };

const aiService = { getConfigForUsage: () => undefined } as unknown as AIService;

/** A real embedding of dimension 8 (values of both signs). */
const real = (seed: number) => Float32Array.from({ length: 8 }, (_, i) => Math.fround(Math.sin(seed * 5 + i)));
/** What the embedder falls back to when the embedding call fails (384 values, none negative). */
const pseudo = (text: string) => Float32Array.from(pseudoEmbed(text));

const event = (id: string, embedded: boolean) => ({
  id, subject: 'A', action: 'narrative', tags: [], text: `text ${id}`, summary: `summary ${id}`,
  structured_kv: { event: id, role: [], location: [], time_anchor: '', causality: '', logic: [] }, is_embedded: embedded, roundNumber: 1,
});
const entity = (name: string, embedded: boolean) => ({
  name, type: 'npc', summary: '', attributes: {}, firstSeen: 1, lastSeen: 1, mentionCount: 1, is_embedded: embedded,
});
const edge = (id: string, embedded: boolean) => ({
  id, sourceEntity: 'A', targetEntity: 'B', fact: `fact ${id}`, episodes: [], is_embedded: embedded, createdAtRound: 1, lastSeenRound: 1,
});

/**
 * The PO save in small: real vectors for most entries; pseudo vectors for two embedded events, one embedded entity and
 * one embedded edge; a pseudo vector for an event marked not embedded and for an edge no longer held.
 */
function engramTree(marker?: Json): Json {
  return {
    元数据: { 回合序号: 12, 叙事历史: [] },
    系统: {
      扩展: {
        engramMemory: {
          events: [event('e1', true), event('e2', true), event('e3', true), event('pe1', true), event('pe2', true), event('pe3', false)],
          entities: [entity('Alice', true), entity('Bob', true), entity('Pseudo', true)],
          relations: [],
          v2Edges: [edge('g1', true), edge('g2', true), edge('pg1', true)],
          meta: { lastUpdated: 0, eventCount: 6, embeddedEventCount: 5, embeddedEntityCount: 3, schemaVersion: 5, v2PendingReview: null },
        },
        ...(marker ? { saveFormat: marker } : {}),
      },
    },
  };
}

function engramVectors(): Json {
  return {
    eventVectors: { e1: real(1), e2: real(2), e3: real(3), pe1: pseudo('first , 1'), pe2: pseudo('second , 2'), pe3: pseudo('third , 3') },
    entityVectors: { Alice: real(4), Bob: real(5), Pseudo: pseudo('Pseudo') },
    edgeVectors: { g1: real(6), g2: real(7), pg1: pseudo('fact pg1'), gone: pseudo('fact gone') },
    model: 'embed-1',
    dim: 8,
  };
}

const ALL_KEYS = { events: ['e1', 'e2', 'e3', 'pe1', 'pe2'], entities: ['Alice', 'Bob', 'Pseudo'], edges: ['g1', 'g2', 'pg1'] };
const REAL_KEYS = { events: ['e1', 'e2', 'e3'], entities: ['Alice', 'Bob'], edges: ['g1', 'g2'] };

let next = 0;
/** A save on its own slot: its tree in a real StateManager, its vectors in the store, the manager with that slot active. */
async function openSave(tree: Json, vectors: Json = engramVectors()) {
  next++;
  let active: Slot | null = { profileId: `prof_vr${next}`, slotId: 'slot_1' };
  const slot = active;
  await idbAdapter.set(`engram_vectors_${slot.profileId}_${slot.slotId}`, vectors);
  const sm = new StateManager();
  sm.loadTree(cloneDeep(tree));
  const manager = new EngramManager(aiService, undefined, () => active);
  const store = new VectorStore();
  return {
    sm, manager, slot, store,
    /** The save opened (again): its tree, and the trees a rollback could put back. */
    repair: (state: StateManager = sm, rollbackTrees: unknown[] = []) =>
      manager.repairVectorDims(state, P.saveFormat, slot, () => rollbackTrees),
    switchTo(other: Slot | null) { active = other; },
    vectorKeys: async () => {
      const data = await store.load(slot.profileId, slot.slotId);
      return { events: Object.keys(data.eventVectors).sort(), entities: Object.keys(data.entityVectors).sort(), edges: Object.keys(data.edgeVectors).sort() };
    },
  };
}

const loaded = (tree: Json): StateManager => {
  const sm = new StateManager();
  sm.loadTree(cloneDeep(tree));
  return sm;
};

function embeddedFlags(sm: StateManager): Json {
  const engram = sm.get<{ events: Json[]; entities: Json[]; v2Edges: Json[] }>(P.engramMemory)!;
  return {
    events: engram.events.filter((e) => e.is_embedded).map((e) => e.id),
    entities: engram.entities.filter((e) => e.is_embedded).map((e) => e.name),
    edges: engram.v2Edges.filter((e) => e.is_embedded).map((e) => e.id),
  };
}

function requestedSaves() {
  const emit = vi.spyOn(eventBus, 'emit');
  return () => emit.mock.calls.filter(([name]) => name === 'engine:request-save').length;
}

function healthOf(sm: StateManager, slot: Slot) {
  return runSaveHealthCheck({
    tree: sm.toSnapshot(), paths: P, profileId: slot.profileId, slotId: slot.slotId, vectorStore: new VectorStore(),
  });
}

beforeEach(() => {
  // Engram on, as on the PO's game (it is off by default; the repair does nothing then).
  vi.spyOn(EngramManager.prototype, 'isEnabled').mockReturnValue(true);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pseudo-vector repair after a save is opened (存档瘦身 D4A)', () => {
  it('first open: the entries of pseudo vectors are marked not embedded, the marker records it, a save is asked for', async () => {
    const save = await openSave(engramTree());
    const saves = requestedSaves();

    const result = await save.repair();

    expect(result).toEqual({ mainDim: 8, unmarked: 4, removed: 2 });
    expect(embeddedFlags(save.sm)).toEqual(REAL_KEYS);
    expect(save.sm.get(`${P.engramMemory}.meta.embeddedEventCount`)).toBe(3);
    expect(save.sm.get(`${P.engramMemory}.meta.embeddedEntityCount`)).toBe(2);
    // Only the flag: no version (that would claim the tree is in the new save format).
    expect(save.sm.get(P.saveFormat)).toEqual({ vectorDimRepaired: true });
    expect(saves()).toBe(1);
    // Only vectors whose entries the save as opened already says are not embedded go now (pe3, and the edge no longer
    // held); the others stay until no tree marks their entries embedded.
    expect(await save.vectorKeys()).toEqual(ALL_KEYS);
  });

  it('next open: those vectors go, and nothing else changes', async () => {
    const first = await openSave(engramTree());
    await first.repair();
    const saved = first.sm.toSnapshot();

    // The save that landed, opened again (same slot, same vectors), with no round played before it to roll back to.
    const sm = loaded(saved);
    const saves = requestedSaves();
    const result = await first.repair(sm);

    expect(result).toEqual({ mainDim: 8, unmarked: 0, removed: 4 });
    expect(sm.toSnapshot()).toEqual(saved);
    expect(saves()).toBe(0);
    expect(await first.vectorKeys()).toEqual(REAL_KEYS);
    const data = await first.store.load(first.slot.profileId, first.slot.slotId);
    expect(Array.from(data.eventVectors.e2)).toEqual(Array.from(real(2)));
    expect(Array.from(data.edgeVectors.g1)).toEqual(Array.from(real(6)));
  });

  it('keeps a vector while the round-start tree a rollback would put back still marks its entry embedded', async () => {
    const save = await openSave(engramTree());
    const beforeRepair = save.sm.toSnapshot(); // the round-start tree of the round played before the repair
    expect(await save.repair(save.sm, [beforeRepair])).toEqual({ mainDim: 8, unmarked: 4, removed: 2 });
    const saved = save.sm.toSnapshot();

    // Next open: the rollback would put the entries back as embedded, so their vectors stay.
    const second = loaded(saved);
    expect(await save.repair(second, [beforeRepair])).toEqual({ mainDim: 8, unmarked: 0, removed: 0 });
    expect(await save.vectorKeys()).toEqual(ALL_KEYS);
    // Rolled back now, the tree and the vectors still agree.
    const rolledBack = loaded(beforeRepair);
    expect(embeddedFlags(rolledBack)).toEqual(ALL_KEYS);
    expect((await healthOf(rolledBack, save.slot)).damaged).toBe(false);

    // A round played since: its round-start tree has the entries not embedded; at the next open the vectors go.
    const third = loaded(saved);
    expect(await save.repair(third, [saved])).toEqual({ mainDim: 8, unmarked: 0, removed: 4 });
    expect(await save.vectorKeys()).toEqual(REAL_KEYS);
  });

  it('two repairs queued at one open (behind a long engram write) remove nothing the first one just unmarked', async () => {
    const save = await openSave(engramTree());
    let release!: () => void;
    const held = save.manager.withWriteLock(() => new Promise<void>((resolve) => { release = resolve; }));

    const first = save.repair();
    const second = save.repair();
    await new Promise((resolve) => setTimeout(resolve, 0)); // the lock runs what it holds a tick later
    release();
    await held;

    expect(await first).toEqual({ mainDim: 8, unmarked: 4, removed: 2 });
    expect(await second).toEqual({ mainDim: 8, unmarked: 0, removed: 0 });
    // The stored save still marks pe1, pe2, Pseudo and pg1 embedded until the asked-for save lands: their vectors stay.
    expect(await save.vectorKeys()).toEqual(ALL_KEYS);
  });

  it('removes no vector whose entry a round marked embedded while the repair waited for the lock', async () => {
    // Repaired already (step 2 does not run). pe3 is not embedded as the save opens; a round in flight then embeds it
    // again, with a pseudo vector as the embedding call failed once more.
    const save = await openSave(engramTree({ vectorDimRepaired: true }));
    let release!: () => void;
    const held = save.manager.withWriteLock(() => new Promise<void>((resolve) => { release = resolve; }));
    const repair = save.repair();
    save.sm.set(`${P.engramMemory}.events.5.is_embedded`, true, 'system');
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await held;

    expect(await repair).toEqual({ mainDim: 8, unmarked: 0, removed: 1 }); // only the edge no longer held
    expect((await save.vectorKeys()).events).toEqual(['e1', 'e2', 'e3', 'pe1', 'pe2', 'pe3']);
  });

  it('keeps every field of a marker that is there', async () => {
    const save = await openSave(engramTree({ version: 2, migratedAtRound: 132, other: 'kept' }));

    await save.repair();

    expect(save.sm.get(P.saveFormat)).toEqual({ version: 2, migratedAtRound: 132, other: 'kept', vectorDimRepaired: true });
  });

  it('pseudo vectors that come after the repair stay as they are', async () => {
    const tree = engramTree({ version: 2, migratedAtRound: 3, vectorDimRepaired: true });
    const save = await openSave(tree, { ...engramVectors(), eventVectors: { e1: real(1), e2: real(2), e3: real(3), pe1: pseudo('later , 1'), pe2: pseudo('later , 2') } });
    const saves = requestedSaves();

    const result = await save.repair();

    expect(result).toEqual({ mainDim: 8, unmarked: 0, removed: 1 }); // only the edge no longer held
    expect(save.sm.toSnapshot()).toEqual(tree);
    expect(saves()).toBe(0);
    expect((await save.vectorKeys()).events).toEqual(['e1', 'e2', 'e3', 'pe1', 'pe2']);
  });

  it('a save without pseudo vectors: the marker is recorded, no save is asked for, the vector store is not written', async () => {
    const save = await openSave(engramTree(), {
      eventVectors: { e1: real(1), e2: real(2), e3: real(3), pe1: real(8), pe2: real(9) },
      entityVectors: { Alice: real(4), Bob: real(5), Pseudo: real(10) },
      edgeVectors: { g1: real(6), g2: real(7), pg1: real(11) },
      model: 'embed-1', dim: 8,
    });
    const saves = requestedSaves();
    const set = vi.spyOn(idbAdapter, 'set');

    expect(await save.repair()).toEqual({ mainDim: 8, unmarked: 0, removed: 0 });
    expect(save.sm.get(P.saveFormat)).toEqual({ vectorDimRepaired: true });
    expect(embeddedFlags(save.sm)).toEqual(ALL_KEYS);
    expect(saves()).toBe(0);
    expect(set).not.toHaveBeenCalled();
  });

  it('never takes real vectors for pseudo ones when pseudo vectors are most of the save', async () => {
    const tree = engramTree();
    const save = await openSave(tree, {
      eventVectors: { e1: pseudo('a , 1'), e2: pseudo('b , 2'), e3: pseudo('c , 3'), pe1: real(1), pe2: real(2) },
      entityVectors: { Alice: pseudo('Alice'), Bob: pseudo('Bob'), Pseudo: pseudo('P') },
      edgeVectors: { g1: real(3) },
      model: 'embed-1', dim: 384,
    });

    expect(await save.repair()).toEqual({ mainDim: 384, unmarked: 0, removed: 0 });
    expect(embeddedFlags(save.sm)).toEqual(embeddedFlags(loaded(tree)));
    expect(await save.vectorKeys()).toEqual({ events: ['e1', 'e2', 'e3', 'pe1', 'pe2'], entities: ['Alice', 'Bob', 'Pseudo'], edges: ['g1'] });
  });

  it('leaves a damaged tree as it is (the marker has no place in it), and still removes vectors of no entry', async () => {
    const tree = { 元数据: { 回合序号: 2 }, 系统: { 扩展: 'damaged' } };
    const save = await openSave(tree);
    const saves = requestedSaves();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // No engram block can be read: no entry is marked embedded, so every pseudo vector belongs to no entry.
    expect(await save.repair()).toEqual({ mainDim: 8, unmarked: 0, removed: 6 });
    expect(save.sm.toSnapshot()).toEqual(tree);
    expect(saves()).toBe(0);
    expect(warn).toHaveBeenCalledWith('[Engram] Pseudo-vector repair: the save format marker has no place in this tree; entries left as they are');
    expect(await save.vectorKeys()).toEqual(REAL_KEYS);
  });

  it('does nothing while Engram is off', async () => {
    const tree = engramTree();
    const save = await openSave(tree);
    vi.mocked(EngramManager.prototype.isEnabled).mockReturnValue(false);
    const before = await save.store.loadStored(save.slot.profileId, save.slot.slotId);

    expect(await save.repair()).toBeNull();
    expect(save.sm.toSnapshot()).toEqual(tree);
    expect(await save.store.loadStored(save.slot.profileId, save.slot.slotId)).toEqual(before);
  });

  it('stops without touching anything when another save is opened while it reads the vectors', async () => {
    const tree = engramTree();
    const save = await openSave(tree);
    const before = await save.store.loadStored(save.slot.profileId, save.slot.slotId);
    const load = VectorStore.prototype.load;
    vi.spyOn(VectorStore.prototype, 'load').mockImplementation(async function (this: VectorStore, profileId: string, slotId: string) {
      const data = await load.call(this, profileId, slotId);
      save.switchTo({ profileId: 'prof_other', slotId: 'slot_9' });
      return data;
    });
    const saves = requestedSaves();

    expect(await save.repair()).toBeNull();
    expect(save.sm.toSnapshot()).toEqual(tree);
    expect(saves()).toBe(0);
    expect(await save.store.loadStored(save.slot.profileId, save.slot.slotId)).toEqual(before);
  });

  it('does nothing for a save that is no longer the open one, and never throws', async () => {
    const save = await openSave(engramTree());
    save.switchTo(null);
    expect(await save.repair()).toBeNull();

    save.switchTo(save.slot);
    vi.spyOn(VectorStore.prototype, 'load').mockRejectedValue(new Error('store unreadable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await save.repair()).toBeNull();
    expect(warn).toHaveBeenCalledWith('[Engram] Pseudo-vector repair failed (non-blocking):', expect.any(Error));
    expect(save.sm.get(P.saveFormat)).toBeUndefined();
  });

  it('waits for an engram write that holds the write lock', async () => {
    const save = await openSave(engramTree());
    let release!: () => void;
    const held = save.manager.withWriteLock(() => new Promise<void>((resolve) => { release = resolve; }));

    const repair = save.repair();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(save.sm.get(P.saveFormat)).toBeUndefined();

    release();
    await held;
    expect(await repair).toEqual({ mainDim: 8, unmarked: 4, removed: 2 });
  });

  it('the save check never reads the repair as lost vectors, at either open', async () => {
    // A save whose only event vector is a pseudo one: the narrowest case of the check (it alarms when the save has
    // embedded events and the store holds no event vector at all).
    const tree = engramTree();
    const engram = (tree.系统 as { 扩展: { engramMemory: Json } }).扩展.engramMemory;
    engram.events = [event('pe1', true)];
    const save = await openSave(tree, {
      eventVectors: { pe1: pseudo('only , 1') }, entityVectors: { Alice: real(1), Bob: real(2) }, edgeVectors: { g1: real(3), g2: real(4) },
      model: 'embed-1', dim: 8,
    });
    expect((await healthOf(save.sm, save.slot)).damaged).toBe(false);

    await save.repair();
    // The live tree, and the stored one if the asked-for save never lands (the tab closed first).
    expect((await healthOf(save.sm, save.slot)).damaged).toBe(false);
    expect((await healthOf(loaded(tree), save.slot)).damaged).toBe(false);

    // Next open of the save that landed (no round before it to roll back to): the pseudo vector goes.
    const reopened = loaded(save.sm.toSnapshot());
    expect(await save.repair(reopened)).toMatchObject({ removed: 1 });
    expect((await save.vectorKeys()).events).toEqual([]);
    expect((await healthOf(reopened, save.slot)).damaged).toBe(false);
  });
});
