import { describe, it, expect } from 'vitest';
import { runSaveHealthCheck, canRecordWorldBookBaseline, type SaveHealthDeps } from './save-health';
import {
  readWorldBookBaseline,
  buildStorageHealthBaseline,
  baselineDiffers,
  computeWorldBookIntegrity,
} from './save-health-baseline';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';

const paths = DEFAULT_ENGINE_PATHS;

function tree(over: {
  avatar?: string;
  worldBookIds?: string[];
  embedded?: number;
  round?: number;
} = {}): Record<string, unknown> {
  const events = Array.from({ length: over.embedded ?? 0 }, (_, i) => ({ id: `ev${i}`, is_embedded: true }));
  return {
    元数据: { 回合序号: over.round ?? 12 },
    角色: { 图片档案: { 已选头像图片ID: over.avatar ?? '', 已选立绘图片ID: '', 生图历史: [] } },
    系统: {
      扩展: {
        engramMemory: { events: [...events, { id: 'pending', is_embedded: false }] },
        ...(over.worldBookIds ? { storageHealth: buildStorageHealthBaseline(over.worldBookIds, 11) } : {}),
      },
    },
  };
}

function deps(over: Partial<SaveHealthDeps> & { tree?: Record<string, unknown> } = {}): SaveHealthDeps {
  return {
    tree: over.tree ?? tree(),
    paths,
    profileId: 'p1',
    slotId: 'auto',
    imageCache: { listAll: async () => [{ id: 'img_a' }] },
    worldBookStorage: { loadWorldBooks: async () => [{ id: 'wb_1' }] },
    vectorStore: { load: async () => ({ eventVectors: { ev0: [1] } }) },
    ...over,
  };
}

describe('runSaveHealthCheck — healthy', () => {
  it('reports no damage when every referenced image, recorded book and embedded event is present', async () => {
    const r = await runSaveHealthCheck(deps({ tree: tree({ avatar: 'img_a', worldBookIds: ['wb_1'], embedded: 1 }) }));
    expect(r.damaged).toBe(false);
    expect(r.issues).toEqual([]);
    expect(r.images).toEqual({ referenced: 1, present: 1, missingIds: [] });
    expect(r.worldBooks).toMatchObject({ expected: 1, present: 1, unreadable: false, presentIds: ['wb_1'] });
    expect(r.vectors).toEqual({ embeddedEvents: 1, storedEventVectors: 1, unreadable: false });
    expect(r.round).toBe(12);
    expect(canRecordWorldBookBaseline(r)).toBe(true);
  });

  it('a save that never recorded a baseline and has no images or embeddings is healthy — never a false alarm on old saves', async () => {
    const r = await runSaveHealthCheck(deps({
      tree: tree(),
      worldBookStorage: { loadWorldBooks: async () => [] },
      vectorStore: { load: async () => ({ eventVectors: {} }) },
    }));
    expect(r.damaged).toBe(false);
  });

  it('deleting SOME books is a normal edit, not damage', async () => {
    const r = await runSaveHealthCheck(deps({
      tree: tree({ worldBookIds: ['wb_1', 'wb_2'] }),
      worldBookStorage: { loadWorldBooks: async () => [{ id: 'wb_2' }] },
    }));
    expect(r.damaged).toBe(false);
    expect(r.worldBooks.present).toBe(1);
  });

  it('a vector store that lags behind Engram is not damage — only a TOTAL loss is', async () => {
    const r = await runSaveHealthCheck(deps({
      tree: tree({ embedded: 10 }),
      vectorStore: { load: async () => ({ eventVectors: { ev0: [1] } }) },
    }));
    expect(r.damaged).toBe(false);
  });
});

describe('runSaveHealthCheck — the three silent losses', () => {
  it('flags a referenced image missing from the cache, with the ids', async () => {
    const r = await runSaveHealthCheck(deps({
      tree: tree({ avatar: 'img_gone' }),
      imageCache: { listAll: async () => [] },
    }));
    expect(r.damaged).toBe(true);
    expect(r.issues).toEqual(['images_missing']);
    expect(r.images).toEqual({ referenced: 1, present: 0, missingIds: ['img_gone'] });
  });

  it('an unreadable image cache counts every referenced image as missing', async () => {
    const r = await runSaveHealthCheck(deps({
      tree: tree({ avatar: 'img_a' }),
      imageCache: { listAll: async () => { throw new Error('NotFoundError'); } },
    }));
    expect(r.issues).toEqual(['images_missing']);
    expect(r.images.missingIds).toEqual(['img_a']);
  });

  it('flags a wiped world-book library when the tree recorded books', async () => {
    const r = await runSaveHealthCheck(deps({
      tree: tree({ worldBookIds: ['wb_1'] }),
      worldBookStorage: { loadWorldBooks: async () => [] },
    }));
    expect(r.issues).toEqual(['world_books_lost']);
    expect(r.worldBooks).toMatchObject({ expected: 1, present: 0 });
    // Recording an empty list now would erase the expectation that caught the wipe.
    expect(canRecordWorldBookBaseline(r)).toBe(false);
  });

  it('flags an unreadable world-book library (store missing / db broken)', async () => {
    const r = await runSaveHealthCheck(deps({
      tree: tree({ worldBookIds: ['wb_1'] }),
      worldBookStorage: { loadWorldBooks: async () => { throw new Error('NotFoundError'); } },
    }));
    expect(r.issues).toEqual(['world_books_unreadable']);
    expect(r.worldBooks.unreadable).toBe(true);
    expect(canRecordWorldBookBaseline(r)).toBe(false);
  });

  it('flags a vector store that holds nothing while Engram has embedded events', async () => {
    const r = await runSaveHealthCheck(deps({
      tree: tree({ embedded: 3 }),
      vectorStore: { load: async () => ({ eventVectors: {} }) },
    }));
    expect(r.issues).toEqual(['vectors_lost']);
    expect(r.vectors).toEqual({ embeddedEvents: 3, storedEventVectors: 0, unreadable: false });
  });

  it('a vector store that cannot be READ is its own finding, distinct from an empty one', async () => {
    const r = await runSaveHealthCheck(deps({
      tree: tree({ embedded: 3 }),
      vectorStore: { load: async () => { throw new Error('NotFoundError'); } },
    }));
    expect(r.issues).toEqual(['vectors_unreadable']);
    expect(r.vectors).toEqual({ embeddedEvents: 3, storedEventVectors: 0, unreadable: true });
  });

  it('reports all three at once, in a stable order', async () => {
    const r = await runSaveHealthCheck(deps({
      tree: tree({ avatar: 'img_gone', worldBookIds: ['wb_1'], embedded: 2 }),
      imageCache: { listAll: async () => [] },
      worldBookStorage: { loadWorldBooks: async () => [] },
      vectorStore: { load: async () => ({ eventVectors: {} }) },
    }));
    expect(r.issues).toEqual(['images_missing', 'world_books_lost', 'vectors_lost']);
  });

  it('reads the three stores concurrently, not one after another', async () => {
    // Each read resolves only after ALL three have been started — a sequential
    // implementation would deadlock here and time out.
    let started = 0;
    let release: () => void = () => {};
    const allStarted = new Promise<void>((res) => { release = res; });
    const gate = async <T,>(value: T): Promise<T> => {
      started += 1;
      if (started === 3) release();
      await allStarted;
      return value;
    };
    const r = await runSaveHealthCheck(deps({
      tree: tree({ avatar: 'img_a', worldBookIds: ['wb_1'], embedded: 1 }),
      imageCache: { listAll: () => gate([{ id: 'img_a' }]) },
      worldBookStorage: { loadWorldBooks: () => gate([{ id: 'wb_1' }]) },
      vectorStore: { load: () => gate({ eventVectors: { ev0: [1] } }) },
    }));
    expect(r.damaged).toBe(false);
  });

  it('fingerprint is stable for the same findings and changes when a NEW loss appears', async () => {
    const a = await runSaveHealthCheck(deps({ tree: tree({ avatar: 'img_gone' }), imageCache: { listAll: async () => [] } }));
    const b = await runSaveHealthCheck(deps({ tree: tree({ avatar: 'img_gone' }), imageCache: { listAll: async () => [] } }));
    const c = await runSaveHealthCheck(deps({
      tree: tree({ avatar: 'img_gone', worldBookIds: ['wb_1'] }),
      imageCache: { listAll: async () => [] },
      worldBookStorage: { loadWorldBooks: async () => [] },
    }));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });

  it('skips a store whose port is absent (feature off / degraded boot) instead of guessing', async () => {
    const r = await runSaveHealthCheck(deps({
      tree: tree({ avatar: 'img_gone', worldBookIds: ['wb_1'], embedded: 2 }),
      imageCache: undefined, worldBookStorage: undefined, vectorStore: undefined,
    }));
    expect(r.damaged).toBe(false);
  });
});

describe('storage-health baseline helpers', () => {
  it('reads ids from the tree and tolerates absence / malformed records', () => {
    expect(readWorldBookBaseline({}, paths.storageHealth)).toEqual([]);
    expect(readWorldBookBaseline({ 系统: { 扩展: { storageHealth: { worldBookIds: 'nope' } } } }, paths.storageHealth)).toEqual([]);
    expect(readWorldBookBaseline({ 系统: { 扩展: { storageHealth: { worldBookIds: ['b', '', 'a', 3] } } } }, paths.storageHealth)).toEqual(['b', 'a']);
  });

  it('buildStorageHealthBaseline de-duplicates and sorts; baselineDiffers is order-insensitive', () => {
    const t = { 系统: { 扩展: { storageHealth: buildStorageHealthBaseline(['b', 'a', 'a'], 5) } } };
    expect(readWorldBookBaseline(t, paths.storageHealth)).toEqual(['a', 'b']);
    expect(baselineDiffers(t, paths.storageHealth, ['b', 'a'])).toBe(false);
    expect(baselineDiffers(t, paths.storageHealth, ['a'])).toBe(true);
    expect(baselineDiffers({}, paths.storageHealth, [])).toBe(false);
  });

  it('computeWorldBookIntegrity: only TOTAL absence against a recorded expectation is degraded', () => {
    const p1 = tree({ worldBookIds: ['wb_1', 'wb_2'] });
    const p2 = tree({ worldBookIds: ['wb_9'] });
    const p3 = tree();
    const r = computeWorldBookIntegrity(
      new Map([['p1', [p1]], ['p2', [p2]], ['p3', [p3]]]),
      new Map([['p1', 1], ['p2', 0], ['p3', 0]]),
      paths.storageHealth,
    );
    expect(r).toEqual({ expectedBooks: 3, exportedBooks: 1, degradedProfiles: ['p2'] });
  });

  it('computeWorldBookIntegrity takes the max across a profile\'s slots (an older slot may predate the record)', () => {
    const r = computeWorldBookIntegrity(
      new Map([['p1', [tree(), tree({ worldBookIds: ['wb_1'] })]]]),
      new Map([['p1', 0]]),
      paths.storageHealth,
    );
    expect(r.degradedProfiles).toEqual(['p1']);
    expect(r.expectedBooks).toBe(1);
  });
});
