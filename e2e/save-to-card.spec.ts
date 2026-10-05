/**
 * Save-to-card (转卡) — manual edge selection, NO AI classification (ZERO real API).
 *
 * Converts a seeded save into a shareable .aga-card via the manual path: skip the
 * "开始 AI 整理" button entirely, use 全选 to select edges, fill the title, and export
 * (pure serialization). The seed includes a NON-core edge so the edge panel surfaces a
 * real candidate to classify manually. The export is read-only — the original save is
 * verified untouched afterward.
 *
 * Runs on desktop-1920 only.
 * Run: npx playwright test save-to-card
 */
import { test, expect, seedSave, enterSeededGame, decodeCardFile, NPC_NAME, LOCATION_NAME } from './fixtures/base';
import { makeSeedTree, PROTAGONIST } from './fixtures/seed-tree';

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'save-to-card spec runs on desktop-1920 only');
});

test.describe('Save-to-card (转卡) — manual selection, no AI (offline)', () => {
  test('convert a save to a .aga-card via manual 全选: card valid, original untouched, zero API',
    { tag: ['@regression', '@card', '@save-to-card', '@story-7'] },
    async ({ page, gameShell, savePage, saveToCard, cardExport }, testInfo) => {
      // P9: about 22 s alone on desktop (2026-10-04); a full run under load passed 30 s once.
      test.slow();
      // Seed a NON-core edge (seed-edge-2) so the edge panel shows a candidate to classify.
      const tree = makeSeedTree({
        系统: { 扩展: { engramMemory: { v2Edges: [
          { id: 'seed-edge-1', sourceEntity: PROTAGONIST, targetEntity: NPC_NAME, fact: `${PROTAGONIST}与${NPC_NAME}相识。`, episodes: [], is_embedded: false, createdAtRound: 1, lastSeenRound: 3, core: true, source: 'opening' },
          { id: 'seed-edge-2', sourceEntity: PROTAGONIST, targetEntity: LOCATION_NAME, fact: `${PROTAGONIST}初到${LOCATION_NAME}。`, episodes: [], is_embedded: false, createdAtRound: 2, lastSeenRound: 3, core: false, source: 'opening' },
        ] } } },
      });
      const ids = await seedSave(page, { tree });
      await enterSeededGame(page);
      await gameShell.goTab('save');

      // Open 转卡 for the seeded slot → SaveToCardFlow (reuses CardExportFlow + EdgeClassifyPanel).
      await savePage.openToCard(ids.slotId);

      // Manually select all edges — NO "开始 AI 整理" click → zero API.
      await saveToCard.selectAllEdges.click();

      // Fill the card title and export (pure serialization).
      await cardExport.fillTitle('转卡集成测试');
      await expect(cardExport.exportButton).toBeEnabled({ timeout: 15_000 });
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        cardExport.exportButton.click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/\.aga-card$/);

      // Decode → the card is valid and carries the world (world survived 转卡).
      const cardPath = testInfo.outputPath('to-card.aga-card');
      await download.saveAs(cardPath);
      const envelope = decodeCardFile(cardPath);
      expect(envelope.format).toBe('aga-card');
      expect(envelope.bundle.bundleType).toBe('card');
      const bundleJson = JSON.stringify(envelope.bundle);
      expect(bundleJson).toContain(LOCATION_NAME);
      expect(bundleJson).toContain(NPC_NAME);

      // Original save UNTOUCHED at the STATE-TREE level (SC-8 read-only): the export's
      // markSelectedEdgesCore=true stamp must NOT leak back into the persisted source save —
      // seed-edge-2 stays core:false. (Reads the persisted save tree, not just slot meta.)
      const sourceEdgeCore = await page.evaluate(async ({ p, s }) => {
        const db = await new Promise<IDBDatabase>((res, rej) => {
          const r = indexedDB.open('aga-saves', 1);
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
        const tree = await new Promise<Record<string, unknown> | undefined>((res, rej) => {
          const req = db.transaction('data', 'readonly').objectStore('data').get(`save_${p}_${s}`);
          req.onsuccess = () => res(req.result as Record<string, unknown> | undefined); req.onerror = () => rej(req.error);
        });
        const sys = tree?.['系统'] as Record<string, unknown> | undefined;
        const ext = sys?.['扩展'] as Record<string, unknown> | undefined;
        const engram = ext?.['engramMemory'] as { v2Edges?: Array<{ id: string; core?: boolean }> } | undefined;
        return engram?.v2Edges?.find((e) => e.id === 'seed-edge-2')?.core ?? null;
      }, { p: ids.profileId, s: ids.slotId });
      expect(sourceEdgeCore).toBe(false);

      // And the slot still loads + shows the character (meta-level untouched).
      await page.goto('/');
      await enterSeededGame(page);
      await gameShell.goTab('save');
      await expect(savePage.slot(ids.slotId)).toContainText(ids.protagonist);
      // apiGuard auto-fixture asserts zero egress in teardown.
    });
});
