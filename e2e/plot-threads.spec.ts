/**
 * Plot Threads — parallel threads + scheduler view (MOCK DATA, ZERO real API).
 *
 * Design: docs/design/plot-parallel-threads-scheduler.md (P4 checklist).
 * Seeds TWO active threads (one focus, one with a critical-node gate) and ONE
 * scheduled thread gated on the focus thread's node, then asserts the
 * user-visible multi-thread surfaces:
 *   1. list view shows one confirmation card per thread (G7) + the activate cap;
 *   2. timeline view renders one lane per thread, the focus lane marked, the
 *      scheduled lane with its trigger hint, the gate badge on the right block;
 *   3. clicking a lane head switches focus (persisted to the state tree);
 *   4. the axis toggle flips round ↔ date without leaving the view;
 *   5. the trigger picker schedules a draft thread (status + hint change).
 *
 * Runs on desktop-1920 only. Run: npx playwright test plot-threads
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { makeSeedTree } from './fixtures/seed-tree';


function node(id: string, arcId: string, title: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, arcId, title, narrativeGoal: `${title}的事件`, directive: title, completionHint: title,
    completionConditions: [], completionMode: 'hint_only', activationConditions: [],
    importance: 'skippable', opportunityTiers: [], status: 'pending', consecutiveReachedCount: 0, ...over,
  };
}

function treeWithThreads(): Record<string, unknown> {
  return makeSeedTree({
    元数据: {
      回合序号: 12,
      剧情导向: {
        activeArcIndex: 0,
        focusArcId: 'arc_a',
        pendingConfirmations: [
          { arcId: 'arc_b', nodeId: 'b1', evidence: '匿名信的笔迹与社长一致', round: 11 },
        ],
        arcs: [
          {
            id: 'arc_a', title: '高考冲刺篇', synopsis: '高考前最后一个月，'.repeat(40), status: 'active', lane: 0, gauges: [],
            nodes: [
              node('a0', 'arc_a', '组建学习小组', { status: 'completed', activatedAtRound: 3, completedAtRound: 5, activatedAtTime: { year: 1, month: 3, day: 1 }, completedAtTime: { year: 1, month: 3, day: 3 } }),
              node('a1', 'arc_a', '模拟考异常', { status: 'active', activatedAtRound: 6, maxRounds: 8, activatedAtTime: { year: 1, month: 3, day: 4 } }),
              node('a2', 'arc_a', '道德抉择', { importance: 'critical', maxRounds: 6 }),
              node('a3', 'arc_a', '放榜', { maxRounds: 4 }),
            ],
          },
          {
            id: 'arc_b', title: '社团风波', synopsis: '', status: 'active', lane: 1, gauges: [],
            nodes: [
              node('b1', 'arc_b', '匿名信', { status: 'active', activatedAtRound: 9, maxRounds: 6, importance: 'critical', activatedAtTime: { year: 1, month: 3, day: 6 } }),
              node('b2', 'arc_b', '真相大白'),
            ],
          },
          {
            id: 'arc_s', title: '修罗场', synopsis: '', status: 'scheduled', lane: 2, gauges: [],
            activation: { mode: 'auto', triggers: [{ type: 'node_completed', arcId: 'arc_a', nodeId: 'a2' }] },
            nodes: [node('s1', 'arc_s', '误会'), node('s2', 'arc_s', '对峙')],
          },
          {
            id: 'arc_d', title: '毕业旅行', synopsis: '', status: 'draft', lane: 3, gauges: [],
            nodes: [node('d1', 'arc_d', '提议')],
          },
        ],
      },
    },
    系统: { 设置: { plot: { enabled: true, maxActiveThreads: 2, timelineAxis: 'round' } } },
  });
}

test.describe('Plot Threads — parallel threads & scheduler (offline)', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1920', 'desktop scheduler specs run on desktop-1920 only');
  });
  test('list view: one confirmation card per thread; activate is capped by maxActiveThreads',
    { tag: ['@regression', '@plot', '@plot-threads'] },
    async ({ page, gameShell }) => {
      await seedSave(page, { tree: treeWithThreads() });
      await enterSeededGame(page);
      await gameShell.goTab('plot');
      await page.getByTestId('plot-view-list').click();

      // The gate belongs to 社团风波 and is visible regardless of which arc is displayed.
      const gates = page.getByTestId('plot-confirm-gate');
      await expect(gates).toHaveCount(1);
      await expect(gates.first()).toContainText('匿名信');
      await expect(gates.first()).toContainText('社团风波');

      // Cap = 2 and two threads are active → the draft thread's activate button is disabled.
      await page.locator('.arc-switcher .arc-chip', { hasText: '毕业旅行' }).click();
      await expect(page.getByTestId('plot-activate-arc')).toBeDisabled();
      // A long synopsis wraps inside the arc card instead of running off it in one line (2026-08-23).
      await page.locator('.arc-switcher .arc-chip', { hasText: '高考冲刺篇' }).click();
      const syn = (await page.locator('.arc-synopsis').boundingBox())!;
      const card = (await page.locator('.arc-header').boundingBox())!;
      expect(syn.x + syn.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
      expect(syn.height).toBeGreaterThan(30); // more than one 12px/1.5 line
      await page.screenshot({ path: '.playwright-mcp/plot-threads-list.png' });
    });

  test('timeline view: lanes, focus, scheduled hint, gate badge, focus switch, axis toggle',
    { tag: ['@regression', '@plot', '@plot-threads'] },
    async ({ page, gameShell }) => {
      test.slow();
      await seedSave(page, { tree: treeWithThreads() });
      await enterSeededGame(page);
      // The gate badge pulses; freeze animations so clicks are stable (skill gotcha).
      await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
      await gameShell.goTab('plot');
      await page.getByTestId('plot-view-timeline').click();

      const sched = page.getByTestId('plot-scheduler');
      await expect(sched).toBeVisible();
      const heads = sched.getByTestId('plot-sched-lane-head');
      await expect(heads).toHaveCount(4);
      // Active first (focus on top), then scheduled, then draft.
      await expect(heads.nth(0)).toContainText('高考冲刺篇');
      await expect(heads.nth(0)).toHaveClass(/lane-head--focus/);
      await expect(heads.nth(1)).toContainText('社团风波');
      await expect(heads.nth(2)).toContainText('修罗场');
      await expect(heads.nth(2)).toContainText('道德抉择'); // "⇠ 高考冲刺篇·道德抉择 之后"
      await expect(heads.nth(3)).toContainText('毕业旅行');

      // Blocks: 4 + 2 + 2 + 1; the gate badge sits on 匿名信 only.
      await expect(sched.getByTestId('plot-sched-block')).toHaveCount(9);
      await expect(sched.getByTestId('plot-sched-gate')).toHaveCount(1);
      await page.screenshot({ path: '.playwright-mcp/plot-threads-timeline-round.png' });

      // Gate badge → popover with the evidence; "还没有" dismisses it and clears the gate.
      await sched.getByTestId('plot-sched-gate').click();
      const pop = page.getByTestId('plot-sched-gate-pop'); // teleported to body, not inside the track
      await expect(pop).toContainText('匿名信的笔迹');
      const box = (await pop.boundingBox())!;
      const vp = page.viewportSize()!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(vp.height); // buttons reachable even on a lower lane
      await expect(pop.getByRole('button', { name: '还没有' })).toBeVisible();
      await pop.getByRole('button', { name: '还没有' }).click();
      await expect(sched.getByTestId('plot-sched-gate')).toHaveCount(0);

      // Focus switch: click the 社团风波 head → it becomes focus and moves to the top.
      await heads.nth(1).click();
      await expect(heads.nth(0)).toContainText('社团风波');
      await expect(heads.nth(0)).toHaveClass(/lane-head--focus/);

      // Axis toggle: date mode relabels the ruler (seed has date stamps → not degraded).
      await page.getByTestId('plot-axis-date').click();
      await expect(sched.locator('.tick__label', { hasText: '月' }).first()).toBeVisible(); // a recorded stamp renders as a real date
      await page.screenshot({ path: '.playwright-mcp/plot-threads-timeline-date.png' });
      await page.getByTestId('plot-axis-round').click();
      await expect(sched.locator('.tick__label').first()).toHaveText('R1');

      // The page itself never scrolls sideways — only the track does.
      // (documentElement.scrollWidth is inflated by the decorative app-glow-bloom in every view; body is the real measure.)
      const widths = await page.evaluate(() => {
        const track = document.querySelector('[data-testid="plot-scheduler-track"]') as HTMLElement;
        return { body: document.body.scrollWidth - document.documentElement.clientWidth, track: track.scrollWidth - track.clientWidth };
      });
      expect(widths.body).toBeLessThanOrEqual(0);
      expect(widths.track).toBeGreaterThan(0);
    });

  test('multi-thread decomposition UI: mode switch, gated buttons, degraded path with zero egress (the LLM step is not offline-testable)',
    { tag: ['@regression', '@plot', '@plot-threads'] },
    async ({ page, gameShell }) => {
      test.slow();
      await seedSave(page, { tree: treeWithThreads() });
      await enterSeededGame(page);
      await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
      await gameShell.goTab('plot');
      await page.locator('.panel-header .header-btn').click();

      // Switch to "several threads": the title field disappears, the decompose + commit buttons appear gated.
      const mode = page.getByTestId('plot-decompose-mode');
      await expect(mode).toBeVisible();
      await mode.click();
      await page.getByRole('option', { name: '拆成多条线' }).click();
      const run = page.getByTestId('plot-decompose-threads');
      const commit = page.getByTestId('plot-threads-commit');
      await expect(run).toBeDisabled();      // no outline yet
      await expect(commit).toBeDisabled();   // nothing to write yet
      await page.getByPlaceholder('简述这段剧情的主线走向...').fill('高考前最后一个月，社团里有人在散播匿名信。');
      await expect(run).toBeEnabled();

      // Offline: the API is disabled by the seed → the degraded message shows, nothing is written.
      await run.click();
      await expect(page.locator('.decompose-status--error')).toBeVisible();
      await expect(commit).toBeDisabled();
      await expect(page.getByTestId('plot-threads-preview')).toHaveCount(0);
      // apiGuard (auto-fixture) asserts zero egress in teardown.
    });

  test('trigger picker schedules a draft thread',
    { tag: ['@regression', '@plot', '@plot-threads'] },
    async ({ page, gameShell }) => {
      test.slow(); // two reloads (seed + enter) plus a modal round-trip exceed the default budget
      await seedSave(page, { tree: treeWithThreads() });
      await enterSeededGame(page);
      await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
      await gameShell.goTab('plot');
      await page.getByTestId('plot-view-timeline').click();

      const sched = page.getByTestId('plot-scheduler');
      // The draft lane (last) exposes the ⇠ anchor.
      await sched.getByTestId('plot-sched-anchor').last().click();
      await page.getByTestId('plot-trigger-add').click();
      await expect(page.getByTestId('plot-trigger-list').locator('li')).toHaveCount(1);
      await page.getByTestId('plot-trigger-save').click();

      const heads = sched.getByTestId('plot-sched-lane-head');
      // Now two scheduled lanes (修罗场 + 毕业旅行), none draft.
      await expect(heads.nth(3)).toContainText('毕业旅行');
      await expect(heads.nth(3)).not.toContainText('草稿');
      await page.screenshot({ path: '.playwright-mcp/plot-threads-scheduled.png' });
    });

  // ─── 2026-08-23 UI bug batch (user acceptance round 1) ───

  test('timeline geometry: track fills the panel, blocks never overlap, CRIT tag stays inside its block',
    { tag: ['@regression', '@plot', '@plot-threads'] },
    async ({ page, gameShell }) => {
      test.slow();
      await seedSave(page, { tree: treeWithThreads() });
      await enterSeededGame(page);
      await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
      await gameShell.goTab('plot');
      await page.getByTestId('plot-view-timeline').click();
      const sched = page.getByTestId('plot-scheduler');
      await expect(sched.getByTestId('plot-sched-block')).toHaveCount(9);

      // ① proportions: the track is at least 320px tall even with 4 rows (was rows×64 = a thin strip).
      const trackBox = (await page.getByTestId('plot-scheduler-track').boundingBox())!;
      expect(trackBox.height).toBeGreaterThanOrEqual(320);

      // ② no overlap: within each lane, blocks are disjoint on x and content stays inside the block.
      const lanes = await page.locator('[data-plot-lane]').all();
      for (const lane of lanes) {
        const boxes: Array<{ x: number; width: number }> = [];
        for (const b of await lane.getByTestId('plot-sched-block').all()) boxes.push((await b.boundingBox())!);
        boxes.sort((p, q) => p.x - q.x);
        for (let i = 1; i < boxes.length; i++) expect(boxes[i].x).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width - 0.5);
      }
      const crit = sched.locator('.blk__crit').first();
      const critBox = (await crit.boundingBox())!;
      const critBlk = (await crit.locator('xpath=ancestor::*[@data-testid="plot-sched-block"]').boundingBox())!;
      expect(critBox.x + critBox.width).toBeLessThanOrEqual(critBlk.x + critBlk.width + 0.5);
      await page.screenshot({ path: '.playwright-mcp/plot-ui-fix-geometry.png' });
    });

  test('hover hints on blocks and lane heads are viewport-fixed: inside the viewport and not covered by the sticky head/ruler',
    { tag: ['@regression', '@plot', '@plot-threads'] },
    async ({ page, gameShell }) => {
      test.slow();
      await seedSave(page, { tree: treeWithThreads() });
      await enterSeededGame(page);
      await page.addStyleTag({ content: '*,*::before,*::after{transition-delay:0s!important;transition-duration:0s!important;animation:none!important}' });
      await gameShell.goTab('plot');
      await page.getByTestId('plot-view-timeline').click();
      const sched = page.getByTestId('plot-scheduler');

      // The FIRST lane's first block: its hint opens upward into the ruler area — previously clipped by the track.
      const firstBlock = sched.getByTestId('plot-sched-block').first();
      await firstBlock.hover();
      const bubble = page.locator('body > .tt-bubble--fixed.tt-bubble--hot');
      await expect(bubble).toBeVisible();
      const bb = (await bubble.boundingBox())!;
      const vp = page.viewportSize()!;
      expect(bb.x).toBeGreaterThanOrEqual(0);
      expect(bb.y).toBeGreaterThanOrEqual(0);
      expect(bb.x + bb.width).toBeLessThanOrEqual(vp.width);
      expect(bb.width).toBeGreaterThan(60); // not squeezed into a narrow column
      // Hit-test the bubble centre: whatever is on top there must be the bubble itself
      // (the bubble is pointer-events:none by design, so let it receive hits for the probe only).
      const topIsBubble = await page.evaluate(([x, y]) => {
        const b = document.querySelector<HTMLElement>('body > .tt-bubble--fixed.tt-bubble--hot');
        if (!b) return false;
        b.style.pointerEvents = 'auto';
        const el = document.elementFromPoint(x, y);
        b.style.pointerEvents = '';
        return el === b;
      }, [bb.x + bb.width / 2, bb.y + bb.height / 2]);
      expect(topIsBubble).toBe(true);
      await page.screenshot({ path: '.playwright-mcp/plot-ui-fix-tooltip.png' });

      // A lower lane's head title hint (used to be covered by the lane below's sticky head).
      await sched.getByTestId('plot-sched-lane-head').nth(2).locator('.lane-head__title').hover();
      await expect(page.locator('body > .tt-bubble--fixed.tt-bubble--hot')).toContainText('只有活跃线');
    });

  test('AgaSelect inside a modal: the option list is hit-testable (not clipped by the modal body)',
    { tag: ['@regression', '@plot', '@plot-threads'] },
    async ({ page, gameShell }) => {
      test.slow();
      await seedSave(page, { tree: treeWithThreads() });
      await enterSeededGame(page);
      await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
      await gameShell.goTab('plot');

      // Create dialog — the mode select is the LAST control in a short body; its list used to be fully clipped.
      await page.locator('.panel-header .header-btn').click();
      await page.getByTestId('plot-decompose-mode').click();
      const opt = page.getByRole('option', { name: '拆成多条线' });
      await expect(opt).toBeVisible();
      const ob = (await opt.boundingBox())!;
      const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.textContent?.trim() ?? '', [ob.x + ob.width / 2, ob.y + ob.height / 2]);
      expect(hit).toBe('拆成多条线');
      await page.screenshot({ path: '.playwright-mcp/plot-ui-fix-select-modal.png' });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      // Trigger picker — the mode select sits at the bottom of the dialog.
      await page.getByTestId('plot-view-timeline').click();
      await page.getByTestId('plot-scheduler').getByTestId('plot-sched-anchor').last().click();
      const modeSelect = page.locator('.tp-mode .aga-select__trigger');
      await modeSelect.click();
      const manual = page.getByRole('option', { name: '只作提示，手动开始' });
      await expect(manual).toBeVisible();
      const mb = (await manual.boundingBox())!;
      const hit2 = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.textContent?.trim() ?? '', [mb.x + mb.width / 2, mb.y + mb.height / 2]);
      expect(hit2).toBe('只作提示，手动开始');
      await page.screenshot({ path: '.playwright-mcp/plot-ui-fix-select-picker.png' });
    });

  test('block drag: a pending block reorders among its siblings; a draft thread first block dragged to a round schedules it',
    { tag: ['@regression', '@plot', '@plot-threads'] },
    async ({ page, gameShell }) => {
      test.slow();
      await seedSave(page, { tree: treeWithThreads() });
      await enterSeededGame(page);
      await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
      await gameShell.goTab('plot');
      await page.getByTestId('plot-view-timeline').click();
      const sched = page.getByTestId('plot-scheduler');
      const blockOrder = () => page.locator('[data-plot-lane]').first().getByTestId('plot-sched-block').evaluateAll(els => els.map(e => e.getAttribute('data-node-id')));

      // Reorder: 高考冲刺篇 = [组建学习小组 ✓, 模拟考异常 ▶, 道德抉择, 放榜]. Drag 放榜 left over 道德抉择.
      const lane0 = page.locator('[data-plot-lane]').first();
      const a2 = lane0.locator('[data-node-id="a2"]');
      const a3 = lane0.locator('[data-node-id="a3"]');
      await expect(a3).toHaveAttribute('data-drag-role', 'reorder');
      const a2b = (await a2.boundingBox())!;
      const a3b = (await a3.boundingBox())!;
      await page.mouse.move(a3b.x + a3b.width / 2, a3b.y + a3b.height / 2);
      await page.mouse.down();
      await page.mouse.move(a3b.x + a3b.width / 2 - 30, a3b.y + a3b.height / 2, { steps: 4 });
      await page.mouse.move(a2b.x + 10, a2b.y + a2b.height / 2, { steps: 10 });
      await expect(lane0.getByTestId('plot-sched-drop')).toBeVisible();
      await page.screenshot({ path: '.playwright-mcp/plot-ui-fix-drag-reorder.png' });
      await page.mouse.up();
      expect(await blockOrder()).toEqual(['a0', 'a1', 'a3', 'a2']);
      // Persisted in the state tree (survives a view switch).
      await page.getByTestId('plot-view-list').click();
      await page.getByTestId('plot-view-timeline').click();
      expect(await blockOrder()).toEqual(['a0', 'a1', 'a3', 'a2']);

      // Dragging a block into the completed/active prefix is refused (store floor) — no drop cue, no change.
      const a3n = page.locator('[data-plot-lane]').first().locator('[data-node-id="a3"]');
      const a0b = (await page.locator('[data-plot-lane]').first().locator('[data-node-id="a0"]').boundingBox())!;
      const a3nb = (await a3n.boundingBox())!;
      await page.mouse.move(a3nb.x + a3nb.width / 2, a3nb.y + a3nb.height / 2);
      await page.mouse.down();
      await page.mouse.move(a0b.x + 5, a0b.y + a0b.height / 2, { steps: 10 });
      await expect(page.locator('[data-plot-lane]').first().getByTestId('plot-sched-drop')).toHaveCount(0);
      await page.mouse.up();
      expect(await blockOrder()).toEqual(['a0', 'a1', 'a3', 'a2']);

      // Schedule: the draft lane (毕业旅行, last) — drag its first block ~5 rounds to the right.
      const draftLane = page.locator('[data-plot-lane]').last();
      const d1 = draftLane.locator('[data-node-id="d1"]');
      await expect(d1).toHaveAttribute('data-drag-role', 'schedule');
      const d1b = (await d1.boundingBox())!;
      await page.mouse.move(d1b.x + 20, d1b.y + d1b.height / 2);
      await page.mouse.down();
      await page.mouse.move(d1b.x + 20 + 44 * 5, d1b.y + d1b.height / 2, { steps: 12 });
      await expect(draftLane.getByTestId('plot-sched-drop-round')).toContainText('第 18 回合起'); // 13 (now+1) + 5
      await page.screenshot({ path: '.playwright-mcp/plot-ui-fix-drag-schedule.png' });
      await page.mouse.up();
      const heads = sched.getByTestId('plot-sched-lane-head');
      await expect(heads.nth(3)).toContainText('第 18 回合起');
      // Keyboard equivalent: → on the (now scheduled) first block bumps the round by one.
      await page.locator('[data-plot-lane]').last().locator('[data-node-id="d1"]').focus();
      await page.keyboard.press('ArrowRight');
      await expect(sched.getByTestId('plot-sched-lane-head').nth(3)).toContainText('第 19 回合起');
    });

  test('single-thread decompose reports its outcome as a toast in the timeline view (offline → error)',
    { tag: ['@regression', '@plot', '@plot-threads'] },
    async ({ page, gameShell }) => {
      test.slow();
      await seedSave(page, { tree: treeWithThreads() });
      await enterSeededGame(page);
      await gameShell.goTab('plot');
      await page.getByTestId('plot-view-timeline').click();
      await page.locator('.panel-header .header-btn').click();
      await page.locator('.modal-form input.form-input').first().fill('临时线');
      await page.getByPlaceholder('简述这段剧情的主线走向...').fill('一段需要 AI 拆解的大纲。');
      await page.locator('.modal-footer .arc-btn--activate').click();
      // Offline: the call fails fast, so the header strip may already be gone — the toast is the durable signal.
      // Disabled API → either a thrown error ("拆解失败: …") or an empty result ("AI 拆解未返回有效结果…").
      await expect(page.locator('.toast-container').getByText(/拆解失败|拆解未返回/).first()).toBeVisible({ timeout: 10_000 });
      // The new thread landed as a lane in the timeline, where the player actually is.
      await expect(page.getByTestId('plot-scheduler').getByTestId('plot-sched-lane-head').filter({ hasText: '临时线' })).toHaveCount(1);
      // Blocks glide (not snap) to a new column: `left` is transitioned (this test does not freeze animations).
      const glide = await page.locator('.blk-tt').first().evaluate(el => {
        const cs = getComputedStyle(el);
        return { prop: cs.transitionProperty, dur: cs.transitionDuration };
      });
      expect(glide.prop).toContain('left');
      expect(parseFloat(glide.dur)).toBeGreaterThan(0);
    });
});

test.describe('Plot Threads — scheduler on a phone (offline)', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-390', 'mobile scheduler spec runs on mobile-390 only');
  });

  test('390px: compact lane heads leave most of the width to the blocks; track pans sideways; touch drag reorders',
    { tag: ['@regression', '@plot', '@plot-threads', '@mobile'] },
    async ({ page }) => {
      test.slow();
      await seedSave(page, { tree: treeWithThreads() });
      await enterSeededGame(page);
      await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
      // Phone nav: the sidebar lives behind the "更多面板" drawer button.
      await page.getByRole('button', { name: '更多面板' }).click();
      await page.locator('.sidebar a[href="/game/plot"]').first().click();
      await page.waitForURL(/\/game\/plot$/);
      await page.getByTestId('plot-view-timeline').click();
      const sched = page.getByTestId('plot-scheduler');
      await expect(sched.getByTestId('plot-sched-lane-head')).toHaveCount(4);
      await page.screenshot({ path: '.playwright-mcp/plot-mobile-timeline.png' });

      // Head ≤ 30% of the viewport; the block area gets the rest.
      const head = (await sched.getByTestId('plot-sched-lane-head').first().boundingBox())!;
      const vp = page.viewportSize()!;
      expect(head.width).toBeLessThanOrEqual(vp.width * 0.3);
      // The page never scrolls sideways; the track does.
      const widths = await page.evaluate(() => {
        const track = document.querySelector('[data-testid="plot-scheduler-track"]') as HTMLElement;
        return { body: document.body.scrollWidth - document.documentElement.clientWidth, track: track.scrollWidth - track.clientWidth };
      });
      expect(widths.body).toBeLessThanOrEqual(0);
      expect(widths.track).toBeGreaterThan(0);

      // Touch drag on a pending block (sideways swipe > 12px) reorders it; the track does not pan instead.
      const lane0 = page.locator('[data-plot-lane]').first();
      const a3 = lane0.locator('[data-node-id="a3"]');
      const a2 = lane0.locator('[data-node-id="a2"]');
      // Pan the track so 道德抉择's centre sits ~130px in and 放榜 (right after it) is on screen too.
      await page.evaluate(() => {
        const track = document.querySelector('[data-testid="plot-scheduler-track"]') as HTMLElement;
        const tt = document.querySelector('[data-node-id="a2"]')!.closest('.blk-tt') as HTMLElement;
        const laneTrack = tt.offsetParent as HTMLElement;
        track.scrollLeft = laneTrack.offsetLeft + tt.offsetLeft + tt.offsetWidth / 2 - 130;
      });
      const a2b = (await a2.boundingBox())!;
      const a3b = (await a3.boundingBox())!;
      expect(a3b.x + a3b.width / 2).toBeLessThan(vp.width);
      const cdp = await page.context().newCDPSession(page);
      const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
        cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
      await touch('touchStart', a3b.x + a3b.width / 2, a3b.y + a3b.height / 2);
      const from = a3b.x + a3b.width / 2;
      const to = a2b.x + a2b.width / 2 - 8; // past 道德抉择's centre → lands before it
      for (let i = 1; i <= 10; i++) await touch('touchMove', from + (to - from) * (i / 10), a3b.y + a3b.height / 2);
      await touch('touchEnd', 0, 0);
      const order = await lane0.getByTestId('plot-sched-block').evaluateAll(els => els.map(e => e.getAttribute('data-node-id')));
      expect(order).toEqual(['a0', 'a1', 'a3', 'a2']);
      await page.screenshot({ path: '.playwright-mcp/plot-mobile-after-drag.png' });
    });
});
