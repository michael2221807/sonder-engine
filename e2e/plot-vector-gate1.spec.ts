import { test, expect, seedSave } from './fixtures/base';

/**
 * Gate 1 in a real browser, with in-page execution (rebuild plan §4, charter I9): cards are bound with the
 * product's own one-time check inside the real page, where storage, network, cookies and the page's
 * built-ins really exist. Every escape family the retired Worker gate probed must be refused at bind time or
 * fail harmlessly, leaving the page exactly as it was; an honest card still binds and runs.
 */
type Outcome = { ok: true } | { ok: false; message: string };

// Not layout-dependent: one viewport is enough (maintainability rule; the viewport matrix is for layout).
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'Card execution, not layout: desktop-1920 only');
});

async function bindCards(page: import('@playwright/test').Page, cards: Array<{ id: string; onPass: string }>): Promise<Outcome[]> {
  return page.evaluate(async cards => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { bindCard } = await load('/src/features/plot-vector/runtime.ts');
    const { tasksAfterSave } = await load('/src/features/plot-vector/genesis/post-save.ts');
    const out: Array<{ ok: true } | { ok: false; message: string }> = [];
    for (const card of cards) {
      const entry = { id: card.id, kind: 'item', capability: { name: card.id, description: card.id } };
      const task = tasksAfterSave({ id: 'acquire', success: true, before: [], after: [entry] })[0];
      try { bindCard(task, { for: card.id, type: 'item', summary: card.id, onPass: card.onPass }); out.push({ ok: true }); }
      catch (error) { out.push({ ok: false, message: error instanceof Error ? error.message : String(error) }); }
    }
    return out;
  }, cards);
}
/** What an escape would change: a global, a prototype, a built-in, storage or a cookie. */
async function pageFingerprint(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    return { esc: g.esc, polluted: ({} as Record<string, unknown>).polluted, minIsMax: Math.min === Math.max,
      isFinite: Number.isFinite.toString(), mathMinProps: Object.getOwnPropertyNames(Math.min).sort().join(),
      storageKeys: Object.keys(localStorage).sort().join(), cookie: document.cookie };
  });
}

test('in-page cards cannot reach or change the page: escapes are refused at bind, rewrites fail harmlessly',
  { tag: ['@plot-vector', '@gate-1'] }, async ({ page }) => {
    await seedSave(page);
    const before = await pageFingerprint(page);
    const requests: string[] = [];
    page.on('request', request => { if (!request.url().startsWith(new URL(page.url()).origin)) requests.push(request.url()); });
    const attacks = [
      { id: 'CTOR', onPass: "ctx.rng['constr' + 'uctor']('glob' + 'alThis.esc = 1')(); return {};", reason: /forbidden token: \[/ },
      { id: 'STRCTOR', onPass: "const k = 'constr' + 'uctor'; return ('a')[k][k]('fet' + 'ch(1)')();", reason: /forbidden token: \[/ },
      { id: 'PROTO', onPass: "({})['__pro' + 'to__'].polluted = 1; return {};", reason: /forbidden token: __/ },
      { id: 'ESCAPE', onPass: 'ctx.rng.\\u0063onstructor("x")(); return {};', reason: /forbidden token: \\/ },
      { id: 'GEN', onPass: "const o = { *m() {} }; return o.m() ? {} : {};", reason: /can be called/ },
      { id: 'DESTRUCTURE', onPass: 'const { toString: t } = {}; const o = { push: t }; return {};', reason: /destructuring/ },
      { id: 'REDOS', onPass: "return /^(a+)+$/.test('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!') ? {} : {};", reason: /regular expressions/ },
      { id: 'GETTER', onPass: 'const bomb = { get in() { return ctx.step === 6 ? bomb.in : {}; } }; return ctx.step === 6 ? bomb.in : { push: 1 };', reason: /getters and setters/ },
      // P5 (docs/design/plot-vector-rebuild-plan.md §13.3): costs without bound, refused before anything runs.
      { id: 'BIGINT', onPass: 'const a = 3n ** 300000000n; return { push: 1 };', reason: /no BigInt/ },
      { id: 'SPREAD', onPass: "let x = 'social'; x = x + x; return { ...x };", reason: /spread/ },
      { id: 'TEXT', onPass: "return { convert: { from: 'socialsocial', to: 'push', amount: 1 } };", reason: /channel name/ },
      { id: 'RECURSE', onPass: 'const o = { m(n) { return n ? o.m(n - 1) + o.m(n - 1) : 0; } }; return { push: o.m(60) };', reason: /can be called/ },
      { id: 'STORAGE', onPass: "localStorage.clear(); return {};", reason: /forbidden token: localStorage/ },
      // Rewrites of what a body can reach throw on every sample (all of it is frozen and its own): refused.
      { id: 'MATH', onPass: 'Math.min = Math.max; return { social: -3 };', reason: /every sample/ },
      { id: 'VALIDATOR', onPass: 'Number.isFinite = isNaN; return { chance: 1 };', reason: /every sample/ },
      { id: 'DECORATE', onPass: 'Math.min.push = 1; return { chance: 1 };', reason: /every sample/ },
    ];
    const outcomes = await bindCards(page, attacks);
    for (const [i, attack] of attacks.entries()) {
      const outcome = outcomes[i];
      expect(outcome.ok, attack.id).toBe(false);
      if (!outcome.ok) expect(outcome.message, attack.id).toMatch(attack.reason);
    }
    // Page globals read as undefined inside a card; an honest card binds.
    const [look, honest] = await bindCards(page, [
      { id: 'LOOK', onPass: "return typeof console === typeof undefined && typeof navigator === typeof undefined && typeof location === typeof undefined ? { chance: 1 } : { chance: 2 };" },
      { id: 'HONEST', onPass: 'return { chance: 1 };' },
    ]);
    expect([look, honest]).toEqual([{ ok: true }, { ok: true }]);
    const seen = await page.evaluate(async () => {
      const path = '/src/features/plot-vector/contract/compile.ts';
      const { runPass, compilePass } = await import(/* @vite-ignore */ path);
      return runPass(compilePass("return typeof console === typeof undefined && typeof navigator === typeof undefined && typeof location === typeof undefined ? { chance: 1 } : { chance: 2 };"),
        { push: 0, drag: 0, social: 0, chance: 0, pass: 1, step: 1, back: false, level: 0, stored: 0 }, 'gate');
    });
    expect(seen).toEqual({ ok: true, value: { chance: 1 } });
    expect(await pageFingerprint(page)).toEqual(before);
    expect(requests).toEqual([]);
  });

test('a card that throws drops only that pass; the trip ends promptly and the next card still binds',
  { tag: ['@plot-vector', '@gate-1'] }, async ({ page }) => {
    await seedSave(page);
    const result = await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { initialVectorState, bindCard, prepareVector } = await load('/src/features/plot-vector/runtime.ts');
      const { tasksAfterSave } = await load('/src/features/plot-vector/genesis/post-save.ts');
      const entries = [
        { id: 'item:flaky', kind: 'item', capability: { name: '时灵时不灵', description: '偶尔失灵' } },
        { id: 'item:steady', kind: 'item', capability: { name: '稳当', description: '每次都行' } },
      ];
      const tasks = tasksAfterSave({ id: 'acquire', success: true, before: [], after: entries });
      const cards = [
        bindCard(tasks[0], { for: '时灵时不灵', type: 'item', summary: '第一次经过会失灵。', onPass: 'if (ctx.pass === 1) return ctx.rng.push.push; return { chance: 1 };' }),
        bindCard(tasks[1], { for: '稳当', type: 'item', summary: '每次经过机会 +1。', onPass: 'return { chance: 1 };' }),
      ];
      const state = { ...initialVectorState(), cards, layout: { placements: { '01': 'item:flaky', '02': 'item:steady' }, tray: [] } };
      const started = performance.now();
      const prepared = prepareVector(state, entries, 'gate-throw', { ruleId: 'gate', payload: { 'S+': 0, 'S-': 0, Y: 0, J: 0 }, visitBudget: 11, contributions: [] });
      const ms = performance.now() - started;
      const flaky = prepared.result.trace.filter((e: { owner?: { id: string } }) => e.owner?.id === 'item:flaky');
      return { status: prepared.result.status, visits: prepared.result.visits, ms,
        flaky: flaky.map((e: { status: string; reasonCode?: string }) => [e.status, e.reasonCode ?? null]),
        steady: prepared.result.trace.filter((e: { owner?: { id: string }; status: string }) => e.owner?.id === 'item:steady' && e.status === 'applied').length };
    });
    expect(result.status).toBe('done');
    expect(result.visits).toBe(11);
    expect(result.flaky).toEqual([['notTriggered', 'cardError'], ['applied', null]]);
    expect(result.steady).toBe(2);
    expect(result.ms).toBeLessThan(1000);
    expect(await bindCards(page, [{ id: 'NEXT', onPass: 'return { push: 1 };' }])).toEqual([{ ok: true }]);
  });
