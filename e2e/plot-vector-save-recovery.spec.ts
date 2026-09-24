import { test, expect, seedSave, enterSeededGame } from './fixtures/base';

test('concurrent protected saves have one winner and a stale window cannot recreate a deleted save',
  {tag: ['@plot-vector', '@story-d146']}, async ({page}) => {
    await seedSave(page);
    const result = await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { SaveManager } = await load('/src/engine/persistence/save-manager.ts');
      const { ProfileManager } = await load('/src/engine/persistence/profile-manager.ts');
      const { idbAdapter } = await load('/src/engine/persistence/idb-adapter.ts');
      const pm = new ProfileManager(); await pm.initialize();
      const {profileId, slotId} = pm.getRoot().activeProfile;
      const a = new SaveManager(pm, {enabled: () => true}), b = new SaveManager(pm, {enabled: () => true});
      const beforeA = await a.loadGame(profileId, slotId), beforeB = await b.loadGame(profileId, slotId);
      a.adoptLoadedGame(profileId, slotId, beforeA); b.adoptLoadedGame(profileId, slotId, beforeB);
      const outcomes = await Promise.allSettled([
        a.saveGame(profileId, slotId, {...beforeA, testWriter: 'a'}),
        b.saveGame(profileId, slotId, {...beforeB, testWriter: 'b'}),
      ]);
      const loser = outcomes[0].status === 'rejected' ? a : b;
      await loser.loadGame(profileId, slotId);
      const stale = await loser.assertCurrent(profileId, slotId).then(() => false, () => true);
      await a.deleteGame(profileId, slotId);
      const late = await b.saveGame(profileId, slotId, beforeB).then(() => false, () => true);
      return {winners: outcomes.filter(o => o.status === 'fulfilled').length, stale, late,
        absent: await idbAdapter.get(`save_${profileId}_${slotId}`) === undefined};
    });
    expect(result).toEqual({winners: 1, stale: true, late: true, absent: true});
  });

test('recovery management requires opt-out and acknowledgement, preserves the save, and rejects late replies',
  {tag: ['@plot-vector', '@story-d146']}, async ({page, gameShell, plotVector}, testInfo) => {
    await seedSave(page); await enterSeededGame(page); await gameShell.goTab('settings');
    await page.evaluate(async () => {
      const path = '/src/features/plot-vector/request-journal.ts';
      const { BrowserRequestStore } = await import(/* @vite-ignore */ path);
      const store = new BrowserRequestStore();
      await store.claim('pending-test', 'fingerprint', 'owner', () => {});
      await store.claim('done-test', 'fingerprint', 'owner', () => {});
      await store.complete('done-test', 'owner', 'recovery fixture', () => {});
    });
    await plotVector.toggleFeature(); await plotVector.openRecovery();
    await expect(plotVector.recovery.getByRole('status')).toContainText('结果未确认 1 条');
    await expect(plotVector.clearRecords).toBeDisabled();
    await plotVector.toggleFeature(); await expect(plotVector.clearRecords).toBeDisabled();
    await plotVector.acknowledgeClear(); await plotVector.clearRecords.click();
    await expect(plotVector.recovery.getByRole('status')).toContainText('可恢复 0 条 · 结果未确认 0 条');
    const result = await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const {BrowserRequestStore} = await load('/src/features/plot-vector/request-journal.ts');
      const {idbAdapter} = await load('/src/engine/persistence/idb-adapter.ts');
      const root = await idbAdapter.get('storage_root');
      const {profileId, slotId} = root.activeProfile;
      const lateRejected = await new BrowserRequestStore().complete('pending-test', 'owner', 'late', () => {}).then(() => false, () => true);
      return {lateRejected, saved: !!await idbAdapter.get(`save_${profileId}_${slotId}`)};
    });
    expect(result).toEqual({lateRejected: true, saved: true});
    if (testInfo.repeatEachIndex === 0) await plotVector.recovery.screenshot({path: 'e2e/screenshots/plot-vector-recovery.png'});
    await page.evaluate(async () => {
      const path = '/src/ui/i18n/index.ts';
      const {setI18nLocale} = await import(/* @vite-ignore */ path);
      await setI18nLocale('en');
    });
    await expect(plotVector.recovery.locator('summary')).toHaveText('Local generation recovery records');
    await expect(plotVector.recovery.getByRole('button', {name: 'Clear local recovery records', exact: true})).toBeDisabled();
    if (testInfo.repeatEachIndex === 0) await plotVector.recovery.screenshot({path: 'e2e/screenshots/plot-vector-recovery-en.png'});
  });

test('old reply bodies expire without allowing resend; slot cleanup leaves other records intact',
  {tag: ['@plot-vector', '@story-d146']}, async ({page}) => {
    await seedSave(page);
    const result = await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const {BrowserRequestStore, RequestJournal} = await load('/src/features/plot-vector/request-journal.ts');
      const store = new BrowserRequestStore();
      const slot = {profileId: 'p', slotId: 's'};
      const cp = new RequestJournal(store).checkpoint({slot}, {}, () => {}, () => {});
      const request = {config: {}, messages: [], stream: false};
      await cp.run(request, async () => 'recovery fixture');
      // Age only the stored fixture, without changing the application clock.
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('aga-vector-requests-v1', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result, tx = db.transaction('requests', 'readwrite');
          const cursor = tx.objectStore('requests').openCursor();
          cursor.onsuccess = () => { if (cursor.result) {
            cursor.result.update({...cursor.result.value, createdAt: Date.now() - 31 * 86400000}); cursor.result.continue();
          } };
          tx.oncomplete = () => {db.close(); resolve();}; tx.onabort = () => {db.close(); reject(tx.error);};
        };
      });
      const expired = await store.summary();
      let sends = 0;
      const refused = await cp.run(request, async () => { sends++; return 'unexpected'; }).then(() => false, () => true);
      await store.claim('unrelated', 'f', 'o', () => {});
      await store.removeSlot(slot);
      return {expired, refused, sends, remaining: await store.summary()};
    });
    expect(result).toEqual({expired: {completed: 0, unknown: 0, expired: 1}, refused: true, sends: 0,
      remaining: {completed: 0, unknown: 1, expired: 0}});
  });
