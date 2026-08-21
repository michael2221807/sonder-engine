import { describe, it, expect, vi } from 'vitest';
import { CapturedSettingCoordinator } from './captured-setting-coordinator';
import type { CapturedEngramBridge } from './captured-setting-coordinator';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { createMockStateManager, type MockStateManager } from '../__test-utils__';
import {
  addCapturedEntry,
  createCapturedBook,
  MAX_ACTIVE_CAPTURED_ENTRIES,
  type CapturedSettingLabels,
} from './captured-entry-mutations';
import type { WorldBook } from './world-book';

const paths = DEFAULT_ENGINE_PATHS;

const labels: CapturedSettingLabels = {
  bookTitle: '自动设定集',
  kind: { character: '人物设定', relationship: '关系设定', world_fact: '世界设定' },
};

function seed(sm: MockStateManager, count = 1): string[] {
  let book = createCapturedBook(labels);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = addCapturedEntry(book, {
      kind: 'character',
      statement: `设定 ${i}。`,
      evidence: `设定 ${i}`,
      anchors: [`锚点${i}`],
      entities: [],
    }, { round: 1, inputHash: 'h', labels });
    book = r.book;
    ids.push(r.entry.id);
  }
  sm.set(paths.slotWorldBooks, [book]);
  return ids;
}

function makeBridge(over: Partial<CapturedEngramBridge> = {}): CapturedEngramBridge {
  return {
    isActive: () => true,
    invalidate: vi.fn(async () => {}),
    reproject: vi.fn(async () => {}),
    ...over,
  };
}

function makeCoordinator(
  sm: MockStateManager,
  over: {
    persist?: () => void | Promise<void>;
    engram?: CapturedEngramBridge;
    /** Set false to reproduce a coordinator built WITHOUT the label dep. */
    withLabels?: boolean;
    round?: number;
  } = {},
) {
  const persist = over.persist ?? vi.fn();
  const coordinator = new CapturedSettingCoordinator({
    stateManager: sm,
    paths,
    persist,
    engram: over.engram,
    getLabels: over.withLabels === false ? undefined : () => labels,
    getRound: () => over.round ?? 9,
  });
  return { coordinator, persist };
}

function books(sm: MockStateManager): WorldBook[] {
  return sm.get<WorldBook[]>(paths.slotWorldBooks) ?? [];
}

function entry(sm: MockStateManager, id: string) {
  return books(sm)[0]?.entries.find((e) => e.id === id);
}

describe('CapturedSettingCoordinator — the three things a direct mutation would skip', () => {
  it('retract updates the book, invalidates the Engram edge, AND persists', async () => {
    const { sm } = createMockStateManager({});
    const [id] = seed(sm);
    const engram = makeBridge();
    const { coordinator, persist } = makeCoordinator(sm, { engram });

    const r = await coordinator.retract(id);

    expect(r.ok).toBe(true);
    expect(entry(sm, id)?.enabled).toBe(false);
    expect(entry(sm, id)?.capturedSetting?.status).toBe('retracted');
    expect(engram.invalidate).toHaveBeenCalledWith(id);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('restore re-projects instead of leaving the graph empty', async () => {
    const { sm } = createMockStateManager({});
    const [id] = seed(sm);
    const engram = makeBridge();
    const { coordinator } = makeCoordinator(sm, { engram });

    await coordinator.retract(id);
    const r = await coordinator.restore(id);

    expect(r.ok).toBe(true);
    expect(entry(sm, id)?.capturedSetting?.status).toBe('active');
    expect(engram.reproject).toHaveBeenCalled();
  });

  it('restore is refused when the active cap is full — and nothing is persisted', async () => {
    const { sm } = createMockStateManager({});
    const ids = seed(sm, MAX_ACTIVE_CAPTURED_ENTRIES + 1);
    const { coordinator, persist } = makeCoordinator(sm);

    const victim = ids[ids.length - 1];
    await coordinator.retract(victim);
    (persist as ReturnType<typeof vi.fn>).mockClear();

    const r = await coordinator.restore(victim);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('capacity');
    expect(entry(sm, victim)?.enabled).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('CapturedSettingCoordinator — edit semantics decide the graph action', () => {
  it('editing the CONTENT re-projects (the setting now asserts something else)', async () => {
    const { sm } = createMockStateManager({});
    const [id] = seed(sm);
    const engram = makeBridge();
    const { coordinator } = makeCoordinator(sm, { engram });

    await coordinator.edit(id, { content: '完全不同的设定。' });

    expect(entry(sm, id)?.content).toBe('完全不同的设定。');
    expect(engram.reproject).toHaveBeenCalled();
  });

  it('editing entityRefs re-projects (the edge endpoints changed)', async () => {
    const { sm } = createMockStateManager({});
    const [id] = seed(sm);
    const engram = makeBridge();
    const { coordinator } = makeCoordinator(sm, { engram });

    await coordinator.edit(id, { entityRefs: ['林月', '玩家'] });
    expect(engram.reproject).toHaveBeenCalled();
  });

  it('editing only keywords / title leaves the graph alone', async () => {
    // Those change how the entry is FOUND, not what it asserts.
    const { sm } = createMockStateManager({});
    const [id] = seed(sm);
    const engram = makeBridge();
    const { coordinator } = makeCoordinator(sm, { engram });

    await coordinator.edit(id, { keywords: ['新关键词'], title: '新标题' });

    expect(engram.reproject).not.toHaveBeenCalled();
    expect(engram.invalidate).not.toHaveBeenCalled();
    expect(entry(sm, id)?.keywords).toEqual(['新关键词']);
  });

  it('pin never touches the graph but still persists', async () => {
    const { sm } = createMockStateManager({});
    const [id] = seed(sm);
    const engram = makeBridge();
    const { coordinator, persist } = makeCoordinator(sm, { engram });

    await coordinator.pin(id, true);

    expect(entry(sm, id)?.injectionMode).toBe('always');
    expect(entry(sm, id)?.capturedSetting?.pinnedByUser).toBe(true);
    expect(engram.reproject).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalled();
  });

  it('setEnabled(false) invalidates, setEnabled(true) re-projects', async () => {
    const { sm } = createMockStateManager({});
    const [id] = seed(sm);
    const engram = makeBridge();
    const { coordinator } = makeCoordinator(sm, { engram });

    await coordinator.setEnabled(id, false);
    expect(engram.invalidate).toHaveBeenCalledWith(id);
    expect(entry(sm, id)?.enabled).toBe(false);

    await coordinator.setEnabled(id, true);
    expect(engram.reproject).toHaveBeenCalled();
  });
});

describe('CapturedSettingCoordinator — failure handling', () => {
  it('a failed persist rolls the book back — no half-applied change', async () => {
    const { sm } = createMockStateManager({});
    const [id] = seed(sm);
    const { coordinator } = makeCoordinator(sm, {
      persist: () => { throw new Error('disk full'); },
    });

    const r = await coordinator.retract(id);

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('persist_failed');
    // The entry is back to how it was — the UI can honestly say "not saved".
    expect(entry(sm, id)?.enabled).not.toBe(false);
    expect(entry(sm, id)?.capturedSetting?.status).toBe('active');
  });

  it('a failed Engram sync is non-fatal but is REPORTED, not swallowed', async () => {
    const { sm } = createMockStateManager({});
    const [id] = seed(sm);
    const engram = makeBridge({ invalidate: vi.fn(async () => { throw new Error('graph down'); }) });
    const { coordinator, persist } = makeCoordinator(sm, { engram });

    const r = await coordinator.retract(id);

    expect(r.ok).toBe(true);
    expect(r.engramDegraded).toBe(true);
    expect(entry(sm, id)?.enabled).toBe(false); // world book is the authority
    expect(persist).toHaveBeenCalled();
  });

  it('skips the graph entirely when Engram is switched off', async () => {
    const { sm } = createMockStateManager({});
    const [id] = seed(sm);
    const engram = makeBridge({ isActive: () => false });
    const { coordinator } = makeCoordinator(sm, { engram });

    const r = await coordinator.retract(id);

    expect(r.ok).toBe(true);
    expect(r.engramDegraded).toBeUndefined();
    expect(engram.invalidate).not.toHaveBeenCalled();
  });

  it('works with no Engram bridge at all (P2 ships before P3)', async () => {
    const { sm } = createMockStateManager({});
    const [id] = seed(sm);
    const { coordinator } = makeCoordinator(sm);
    await expect(coordinator.retract(id)).resolves.toMatchObject({ ok: true });
  });

  it('reports not_found / no_book instead of silently doing nothing', async () => {
    const { sm } = createMockStateManager({});
    const { coordinator } = makeCoordinator(sm);
    expect(await coordinator.retract('nope')).toMatchObject({ ok: false, reason: 'no_book' });

    seed(sm);
    expect(await coordinator.retract('nope')).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('leaves unrelated slot books untouched', async () => {
    const { sm } = createMockStateManager({});
    const [id] = seed(sm);
    sm.set(paths.slotWorldBooks, [
      { id: 'other', title: 'Other', entries: [] },
      ...books(sm),
    ]);
    const { coordinator } = makeCoordinator(sm);

    await coordinator.retract(id);

    expect(books(sm).map((b) => b.id)).toContain('other');
    expect(books(sm).find((b) => b.id === 'other')?.entries).toHaveLength(0);
  });
});

describe('CapturedSettingCoordinator.addManual — the post-failure fallback', () => {
  it('records a hand-typed setting, creating the book on demand', async () => {
    // A save that never produced an automatic capture still needs somewhere to put one.
    const { sm } = createMockStateManager({});
    const { coordinator, persist } = makeCoordinator(sm, { round: 12 });

    const r = await coordinator.addManual({ content: '这个世界有两个月亮。', keywords: ['月亮'] });

    expect(r.ok).toBe(true);
    expect(books(sm)).toHaveLength(1);
    expect(books(sm)[0].origin).toBe('system-captured');
    expect(r.entry?.content).toBe('这个世界有两个月亮。');
    expect(r.entry?.capturedSetting?.source).toBe('user-edited');
    expect(r.entry?.capturedSetting?.capturedRound).toBe(12);
    expect(persist).toHaveBeenCalled();
  });

  it('a keyword-less manual entry is pinned, not left silently unreachable', async () => {
    const { sm } = createMockStateManager({});
    const { coordinator } = makeCoordinator(sm);

    const r = await coordinator.addManual({ content: '没有明显关键词的设定。' });

    expect(r.entry?.injectionMode).toBe('always');
    expect(r.entry?.capturedSetting?.pinnedByUser).toBe(true);
  });

  it('appends into an existing captured book without disturbing it', async () => {
    const { sm } = createMockStateManager({});
    seed(sm, 2);
    const { coordinator } = makeCoordinator(sm);

    await coordinator.addManual({ content: '手动补的设定。', keywords: ['手动'] });

    expect(books(sm)[0].entries).toHaveLength(3);
    expect(books(sm)).toHaveLength(1);
  });

  it('refuses empty content', async () => {
    const { sm } = createMockStateManager({});
    const { coordinator, persist } = makeCoordinator(sm);
    expect((await coordinator.addManual({ content: '   ' })).ok).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it('refuses once the active cap is full', async () => {
    const { sm } = createMockStateManager({});
    seed(sm, MAX_ACTIVE_CAPTURED_ENTRIES);
    const { coordinator } = makeCoordinator(sm);
    const r = await coordinator.addManual({ content: '再来一条。' });
    expect(r).toMatchObject({ ok: false, reason: 'capacity' });
  });

  it('rolls back when persisting fails', async () => {
    const { sm } = createMockStateManager({});
    const { coordinator } = makeCoordinator(sm, {
      persist: () => { throw new Error('disk full'); },
    });

    const r = await coordinator.addManual({ content: '会失败的设定。' });

    expect(r).toMatchObject({ ok: false, reason: 'persist_failed' });
    expect(books(sm)).toHaveLength(0); // nothing left behind
  });

  it('reports internal_error when the label dependency was never wired', async () => {
    // Regression for a shipped defect: the production coordinator was built without
    // `getLabels`, which made EVERY manual add fail with a generic error — the feature
    // existed, was unit-tested in isolation, and was dead at the only call site.
    const { sm } = createMockStateManager({});
    const { coordinator } = makeCoordinator(sm, { withLabels: false });
    expect(await coordinator.addManual({ content: 'x' }))
      .toMatchObject({ ok: false, reason: 'internal_error' });
  });
});
