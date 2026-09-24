import { test, expect, seedSave } from './fixtures/base';

/**
 * Gate 1 in a real browser: the default VectorWorkerClient runs the REAL product Worker source
 * (sandboxed iframe + supervisor + child Worker). Nothing here replaces `workerSource`.
 * Resource cases are bounded on purpose: an exception, a CPU hang cut by the supervisor deadline,
 * cancellation, and one bounded 64 MB string operation. That last case only shows the operation
 * completes inside the Worker, the page's own heap metric does not grow by that amount and the
 * frame is removed; it does not measure whether the string was materialized in the Worker heap or
 * released there. No GB-scale OOM is attempted, so OOM isolation is not claimed.
 */
type Outcome = { ok: true } | { ok: false; message: string };

async function validateCards(page: import('@playwright/test').Page, cards: Array<{ id: string; onVisit: string }>, timeoutMs?: number): Promise<Outcome[]> {
  return page.evaluate(async ({ cards, timeoutMs }) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { VectorWorkerClient } = await load('/src/features/plot-vector/worker-client.ts');
    const { tasksAfterSave } = await load('/src/features/plot-vector/genesis/post-save.ts');
    const out: Array<{ ok: true } | { ok: false; message: string }> = [];
    for (const card of cards) {
      const entry = { id: card.id, kind: 'item', capability: { name: card.id, description: card.id } };
      const task = tasksAfterSave({ id: 'acquire', success: true, before: [], after: [entry] })[0];
      const output = { version: 2, card: { name: card.id, description: card.id, behaviorSummary: card.id, hooks: { onVisit: card.onVisit, onRoundAccepted: null } } };
      const client = timeoutMs ? new VectorWorkerClient(undefined, timeoutMs) : new VectorWorkerClient();
      try { await client.execute({ kind: 'validate', task, output, attempts: 1 }); out.push({ ok: true }); }
      catch (error) { out.push({ ok: false, message: error instanceof Error ? error.message : String(error) }); }
    }
    return out;
  }, { cards, timeoutMs });
}
const HONEST = { id: 'HONEST', onVisit: "return { effects: [{ kind: 'add', channel: 'J', amount: 1 }] };" };

test('the real product Worker blocks intrinsic rewrites, prototype pollution, dynamic-code escapes and validator tampering',
  { tag: ['@plot-vector', '@gate-1'] }, async ({ page }) => {
    await seedSave(page);
    const attacks = [
      { id: 'MATH', onVisit: "Math.min = Math.max; return { effects: [{ kind: 'add', channel: 'Y', amount: -3 }] };", reason: /read.only|Cannot assign/i },
      { id: 'PROTO', onVisit: "Object.defineProperty(Object.getPrototypeOf({}), 'polluted', { value: 1 }); return { effects: [] };", reason: /not extensible|Cannot define/i },
      { id: 'CTOR', onVisit: "ctx.rng['constr' + 'uctor']('this.escaped = 1')(); return { effects: [] };", reason: /dynamic code/ },
      { id: 'GEN', onVisit: "const o = { *m() {} }; o.m['constr' + 'uctor']('this.escaped = 1')().next(); return { effects: [] };", reason: /dynamic code/ },
      { id: 'VALIDATOR', onVisit: "try { Number.isFinite = Boolean; } catch (e) {} return { effects: [{ kind: 'add', channel: 'J', amount: NaN }] };", reason: /outside/ },
      { id: 'LOOK', onVisit: "return typeof self === 'undefined' && typeof postMessage === 'undefined' && typeof console === 'undefined' ? { effects: [] } : { effects: 'visible' };", reason: null },
    ];
    const results = await validateCards(page, attacks.flatMap(a => [a, HONEST]));
    attacks.forEach((attack, i) => {
      const got = results[i * 2];
      if (attack.reason) { expect(got.ok, attack.id).toBe(false); expect((got as { message: string }).message, attack.id).toMatch(attack.reason); }
      else expect(got, attack.id).toEqual({ ok: true });
      expect(results[i * 2 + 1], `honest after ${attack.id}`).toEqual({ ok: true });
    });
    await expect(page.locator('iframe[sandbox]')).toHaveCount(0);
  });

test('card exceptions and CPU hangs end inside the Worker; frames are removed and the next ability still validates',
  { tag: ['@plot-vector', '@gate-1'] }, async ({ page }) => {
    await seedSave(page);
    const [thrown, honestAfterThrow] = await validateCards(page, [
      { id: 'THROW', onVisit: "return { effects: 'x'.repeat(-1) };" }, HONEST]);
    expect(thrown.ok).toBe(false); expect((thrown as { message: string }).message).toMatch(/Invalid count/);
    expect(honestAfterThrow).toEqual({ ok: true });
    // Catastrophic regex backtracking: no loop tokens, effectively endless, tiny memory.
    const hang = { id: 'HANG', onVisit: "return /^(a+)+$/.test('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!') ? { effects: [] } : { effects: [] };" };
    const started = Date.now();
    const [timed] = await validateCards(page, [hang], 1500);
    expect(timed.ok).toBe(false); expect((timed as { message: string }).message).toContain('超时');
    expect(Date.now() - started).toBeLessThan(10_000);
    await expect(page.locator('iframe[sandbox]')).toHaveCount(0);
    const cancelled = await page.evaluate(async onVisit => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { VectorWorkerClient } = await load('/src/features/plot-vector/worker-client.ts');
      const { tasksAfterSave } = await load('/src/features/plot-vector/genesis/post-save.ts');
      const entry = { id: 'HANG', kind: 'item', capability: { name: 'HANG', description: 'HANG' } };
      const task = tasksAfterSave({ id: 'acquire', success: true, before: [], after: [entry] })[0];
      const client = new VectorWorkerClient();
      const pending = client.execute({ kind: 'validate', task, attempts: 1,
        output: { version: 2, card: { name: 'HANG', description: 'HANG', behaviorSummary: 'HANG', hooks: { onVisit, onRoundAccepted: null } } } })
        .then(() => 'resolved', (e: Error) => e.message);
      await new Promise(resolve => setTimeout(resolve, 300));
      client.cancelAll();
      return pending;
    }, hang.onVisit);
    expect(cancelled).toContain('取消');
    await expect(page.locator('iframe[sandbox]')).toHaveCount(0);
    expect(await validateCards(page, [HONEST])).toEqual([{ ok: true }]);
  });

test('a bounded 64 MB string operation completes inside the Worker, the page heap metric stays flat, and the frame is removed',
  { tag: ['@plot-vector', '@gate-1'] }, async ({ page }) => {
    await seedSave(page);
    const heap = () => page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? -1);
    const before = await heap();
    const [big] = await validateCards(page, [{ id: 'BIG', onVisit: "const s = 'x'.repeat(67108864); return { effects: s.length > 0 ? [{ kind: 'add', channel: 'J', amount: 1 }] : [] };" }]);
    expect(big).toEqual({ ok: true });
    const after = await heap();
    if (before >= 0) expect(after - before).toBeLessThan(16 * 1024 * 1024);
    await expect(page.locator('iframe[sandbox]')).toHaveCount(0);
  });
