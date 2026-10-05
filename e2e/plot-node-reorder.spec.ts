/**
 * Plot Direction — node drag-reorder + insert-between (MOCK DATA, ZERO real API).
 *
 * Covers the draggable node-chain editing shipped 2026-07-02:
 *  1. dragging a pending node's handle reorders the chain (plotStore.moveNode);
 *  2. the hover gap strip between two nodes inserts a new node at that exact
 *     position — including gaps that are not "after node X" reachable before
 *     (e.g. before the first node).
 *
 * Seeds a DRAFT arc (all nodes pending → every gap is a valid target) so the
 * run stays fully offline. Runs on desktop-1920 only (pointer drag).
 * Run: npx playwright test plot-node-reorder
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { makeSeedTree } from './fixtures/seed-tree';

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'plot node reorder spec runs on desktop-1920 only');
});

function pendingNode(id: string, title: string): Record<string, unknown> {
  return {
    id,
    arcId: 'arc_seed_draft',
    title,
    narrativeGoal: '',
    directive: title,
    completionHint: title,
    completionConditions: [],
    completionMode: 'hint_only',
    activationConditions: [],
    importance: 'skippable',
    opportunityTiers: [],
    status: 'pending',
    consecutiveReachedCount: 0,
  };
}

/** A draft arc with three pending nodes — every node draggable, every gap valid. */
function treeWithDraftArc(): Record<string, unknown> {
  return makeSeedTree({
    元数据: {
      剧情导向: {
        activeArcIndex: null,
        arcs: [
          {
            id: 'arc_seed_draft',
            title: '草稿弧线',
            synopsis: '',
            status: 'draft',
            gauges: [],
            nodes: [
              pendingNode('node_a', '节点甲'),
              pendingNode('node_b', '节点乙'),
              pendingNode('node_c', '节点丙'),
            ],
          },
        ],
      },
    },
  });
}

async function nodeTitles(page: import('@playwright/test').Page): Promise<string[]> {
  return page.locator('[data-testid="plot-node-item"] .node-item__title').allTextContents();
}

test.describe('Plot Direction — node drag-reorder + insert-between (offline)', () => {
  test('drag a node above the first node: chain order changes and persists in the panel',
    { tag: ['@regression', '@plot'] },
    async ({ page, gameShell }) => {
      // P9: 22-27 s alone on this machine; with 3-4 processes in parallel it passes 30 s.
      test.slow();
      await seedSave(page, { tree: treeWithDraftArc() });
      await enterSeededGame(page);
      await gameShell.goTab('plot');

      expect(await nodeTitles(page)).toEqual(['节点甲', '节点乙', '节点丙']);

      // ── Drag 节点丙's handle to above 节点甲's midpoint.
      const handle = page.getByTestId('plot-drag-handle').nth(2);
      const firstRow = page.getByTestId('plot-node-item').nth(0);
      const hb = (await handle.boundingBox())!;
      const fb = (await firstRow.boundingBox())!;

      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down();
      // Cross the 5px activation threshold, then land above the first row's midpoint.
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 10, { steps: 4 });
      await page.mouse.move(fb.x + fb.width / 2, fb.y + 2, { steps: 10 });
      await page.mouse.up();

      await expect
        .poll(() => nodeTitles(page))
        .toEqual(['节点丙', '节点甲', '节点乙']);

      // ── Insert between the (new) 1st and 2nd node via the gap strip.
      // Gap index 1 = before the node now at index 1 (节点甲).
      await page.getByTestId('plot-gap-insert').nth(1).click();
      await page.getByPlaceholder('如：发现好友作弊').fill('插队节点');
      await page.getByRole('button', { name: '添加', exact: true }).click();

      await expect
        .poll(() => nodeTitles(page))
        .toEqual(['节点丙', '插队节点', '节点甲', '节点乙']);
      // apiGuard auto-fixture asserts zero egress in teardown.
    });
});
