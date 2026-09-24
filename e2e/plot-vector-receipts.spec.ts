import { test, expect, seedSave } from './fixtures/base';
import type { Page } from '@playwright/test';

/**
 * Gate 1 · R4 ability-generation receipts with REAL IndexedDB, real page reloads, the real
 * adapter, the real product Worker and the real RequestJournal. Only the network call is a
 * stand-in; it counts every paid send in localStorage so the count survives reloads.
 */
type Network = 'switch-slot' | 'hang' | 'reply';
interface Outcome {
  sends: number;
  task: { status: string; raw: boolean; error?: string } | null;
  cards: string[];
  tea: unknown;
  receipt: string;
  otherSlotWritten: boolean;
}

async function play(page: Page, slotId: string, roundNumber: number, opts: { addTea?: boolean; network: Network; await?: boolean }): Promise<Outcome> {
  return page.evaluate(async ({ slotId, roundNumber, opts }) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { StateManager } = await load('/src/engine/core/state-manager.ts');
    const { AgaPlotVectorAdapter } = await load('/src/features/plot-vector/aga-adapter.ts');
    const { RequestJournal, BrowserRequestStore } = await load('/src/features/plot-vector/request-journal.ts');
    const { writePlotVectorControl } = await load('/src/engine/plot-vector/feature-control.ts');
    const { DEFAULT_ENGINE_PATHS: P } = await load('/src/engine/pipeline/types.ts');
    const { POSITIVE_EXAMPLES } = await load('/src/features/plot-vector/genesis/test-fixtures.ts');
    const { idbAdapter } = await load('/src/engine/persistence/idb-adapter.ts');
    writePlotVectorControl(true);
    type SavedTree = {
      系统?: { 扩展?: { plotVector?: { tasks?: Array<{ task: { key: string }; status: string; raw?: string; error?: string }>;
        cards?: Array<{ task: { entry: { id: string } } }> } } };
      角色?: { 背包?: { 物品?: { tea?: unknown } } };
    };
    const saveKey = (id: string) => `e2e_r4_save_${id}`;
    const reply = JSON.stringify(POSITIVE_EXAMPLES[0].output);
    let slot = { profileId: 'e2e-r4', slotId };
    const state = new StateManager();
    state.loadTree((await idbAdapter.get(saveKey(slotId))) ?? {});
    const saves = {
      assertCurrent: async () => {},
      saveGame: async (_p: string, s: string, data: unknown, _meta: unknown, commit?: { guard: () => void; committed: () => void }) => {
        await idbAdapter.setGuarded(saveKey(s), data, commit?.guard ?? (() => {}));
        commit?.committed();
      },
    };
    const paid = async (): Promise<string> => {
      localStorage.setItem('e2e_r4_sends', String(Number(localStorage.getItem('e2e_r4_sends') ?? 0) + 1));
      if (opts.network === 'hang') return new Promise<string>(() => {});
      if (opts.network === 'switch-slot') slot = { ...slot, slotId: `${slotId}-other` };
      return reply;
    };
    const ai = { generate: async (o: { messages: unknown[]; checkpoint?: { run: (r: unknown, s: () => Promise<string>) => Promise<string> } }) =>
      o.checkpoint ? o.checkpoint.run({ config: { model: 'stand-in' }, messages: o.messages, stream: false }, paid) : paid() };
    const journal = new RequestJournal(new BrowserRequestStore('e2e-r4-receipts'));
    const adapter = new AgaPlotVectorAdapter(state, ai, saves, () => slot, undefined, journal);
    const ctx = await adapter.prepare({ generationId: crypto.randomUUID(), roundNumber, stateSnapshot: state.toSnapshot(), userInput: '继续',
      actionQueuePrompt: '', chatHistory: [], worldEventTriggered: false, messages: [{ role: 'user', content: '继续' }], meta: { plotVectorLifecycle: {} } });
    if (opts.addTea) state.set(`${P.inventoryItems}.tea`, { 名称: '茶', 数量: 1 });
    await adapter.beforeSave(ctx);
    await saves.saveGame('e2e-r4', slotId, state.toSnapshot(), undefined); // the round's own autosave
    ctx.meta.plotVectorCommitted();
    const post = adapter.afterSave(ctx).catch(() => {});
    if (opts.await === false) {
      // Wait until the request is claimed in the real ledger, then leave it in flight.
      const lookup = async () => {
        const saved = (await idbAdapter.get(saveKey(slotId))) as SavedTree | undefined;
        const key = saved?.系统?.扩展?.plotVector?.tasks?.[0]?.task?.key;
        return key ? (await journal.genesis({ profileId: 'e2e-r4', slotId }, key).lookup()).kind : 'none';
      };
      for (let i = 0; i < 200 && (await lookup()) !== 'unknown'; i++) await new Promise(r => setTimeout(r, 25));
    } else await post;
    const saved = ((await idbAdapter.get(saveKey(slotId))) ?? {}) as SavedTree;
    const vector = saved.系统?.扩展?.plotVector;
    const row = vector?.tasks?.[0];
    const receipt = row ? (await journal.genesis({ profileId: 'e2e-r4', slotId }, row.task.key).lookup()).kind : 'none';
    return {
      sends: Number(localStorage.getItem('e2e_r4_sends') ?? 0),
      task: row ? { status: row.status, raw: typeof row.raw === 'string', ...(row.error ? { error: String(row.error) } : {}) } : null,
      cards: (vector?.cards ?? []).map(c => c.task.entry.id),
      tea: saved.角色?.背包?.物品?.tea ?? null,
      receipt,
      otherSlotWritten: (await idbAdapter.get(saveKey(`${slotId}-other`))) !== undefined,
    };
  }, { slotId, roundNumber, opts });
}

test('a reply received after a slot switch is kept locally, never written to the other slot, and binds free after a reload',
  { tag: ['@plot-vector', '@gate-1'] }, async ({ page }) => {
    await seedSave(page);
    await page.evaluate(() => localStorage.setItem('e2e_r4_sends', '0'));
    const first = await play(page, 'A', 1, { addTea: true, network: 'switch-slot' });
    expect(first).toMatchObject({ sends: 1, task: { status: 'sending', raw: false }, cards: [], receipt: 'raw', otherSlotWritten: false });
    expect(first.tea).toMatchObject({ 名称: '茶', 数量: 1 });
    await page.reload();
    await page.evaluate(async () => {
      const path = '/src/engine/plot-vector/feature-control.ts';
      const { writePlotVectorControl } = await import(/* @vite-ignore */ path);
      writePlotVectorControl(false); writePlotVectorControl(true); // a new feature epoch must not change the request identity
    });
    const next = await play(page, 'A', 2, { network: 'reply' });
    expect(next).toMatchObject({ sends: 1, task: { status: 'bound', raw: true }, cards: ['item:tea'], receipt: 'raw', otherSlotWritten: false });
    expect(next.tea).toMatchObject({ 名称: '茶', 数量: 1 });
  });

test('an unknown request (claimed, page closed before any reply) is never re-sent or failed after reloads; the item stays',
  { tag: ['@plot-vector', '@gate-1'] }, async ({ page }) => {
    await seedSave(page);
    await page.evaluate(() => localStorage.setItem('e2e_r4_sends', '0'));
    const first = await play(page, 'U', 1, { addTea: true, network: 'hang', await: false });
    expect(first).toMatchObject({ sends: 1, task: { status: 'sending', raw: false }, receipt: 'unknown' });
    await page.reload(); // the in-flight request dies with the page
    const second = await play(page, 'U', 2, { network: 'reply' });
    await page.reload();
    const third = await play(page, 'U', 3, { network: 'reply' });
    for (const outcome of [second, third]) {
      expect(outcome).toMatchObject({ sends: 1, task: { status: 'sending', raw: false }, cards: [], receipt: 'unknown' });
      expect(outcome.task?.error).toBeUndefined();
      expect(outcome.tea).toMatchObject({ 名称: '茶', 数量: 1 });
    }
  });

test('a task marked as sent but with no ledger record at all is not sent, and looking it up creates no record',
  { tag: ['@plot-vector', '@gate-1'] }, async ({ page }) => {
    await seedSave(page);
    await page.evaluate(() => localStorage.setItem('e2e_r4_sends', '0'));
    const first = await play(page, 'N', 1, { addTea: true, network: 'hang', await: false });
    expect(first.receipt).toBe('unknown');
    // The player clears local recovery records (the settings action), then reloads.
    await page.evaluate(async () => {
      const path = '/src/features/plot-vector/request-journal.ts';
      const { BrowserRequestStore } = await import(/* @vite-ignore */ path);
      await new BrowserRequestStore('e2e-r4-receipts').clear(() => {});
    });
    await page.reload();
    const next = await play(page, 'N', 2, { network: 'reply' });
    expect(next).toMatchObject({ sends: 1, task: { status: 'sending', raw: false }, cards: [], receipt: 'none' });
    expect(next.tea).toMatchObject({ 名称: '茶', 数量: 1 });
  });
