import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { makeSeedTree } from './fixtures/seed-tree';

test('an unnumbered transfer from the real round pipeline saves and survives reload without an API call',
  { tag: ['@plot-vector', '@story-d181'] }, async ({ page, gameShell, plotVector }) => {
    const ref = 'held_supply';
    await seedSave(page, { tree: makeSeedTree({ 角色: { 背包: { 物品: {
      [ref]: { 名称: '代管用品', 描述: '交还给原主人', 数量: 1 },
    } } } }) });
    await enterSeededGame(page);
    await gameShell.goTab('settings');
    await plotVector.toggleFeature();
    await gameShell.goTab('');

    await page.evaluate(() => {
      localStorage.setItem('aga_ai_settings', JSON.stringify({ maxRetries: 0, splitGen: true, streaming: false }));
      const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Record<string, unknown> } } };
      const host = app.__vue_app__._context.provides.gameOrchestrator as {
        _aiService: { generate: (options: { usageType?: string }) => Promise<string> };
      };
      let mainCalls = 0;
      host._aiService.generate = async options => {
        // The sparse e2e seed may trigger a post-save field-repair request.
        // Keep that offline without treating it as another main-round step.
        if (options.usageType !== 'main') throw new Error('offline background model request');
        mainCalls++;
        document.documentElement.dataset.mainCalls = String(mainCalls);
        if (mainCalls === 1) return JSON.stringify({ text: '你把代管用品交还给原主人，随后聊了几句。' });
        if (mainCalls === 2) return JSON.stringify({
          state_updates: { version: 1, actions: [{ op: 'transfer', ref: 'held_supply' }] },
          commands: [], action_options: ['继续交谈', '起身离开', '稍作休息'],
          mid_term_memory: { 相关角色: [], 事件时间: '1-03-15-10-30', 记忆主体: '本轮交还代管用品并交谈。' },
          knowledge_facts: [],
        });
        throw new Error('unexpected extra model call in offline test');
      };
    });

    await gameShell.send('把代管用品交还给原主人。');
    const saved = () => page.evaluate(async () => {
      const path = '/src/engine/persistence/idb-adapter.ts';
      const { idbAdapter } = await import(/* @vite-ignore */ path);
      const root = await idbAdapter.get('storage_root');
      const { profileId, slotId } = root.activeProfile;
      const tree = await idbAdapter.get(`save_${profileId}_${slotId}`);
      return { round: tree.元数据.回合序号, held: tree.角色.背包.物品.held_supply,
        cash: tree.角色.背包.金钱.现金 };
    });
    await expect.poll(saved).toEqual({ round: 4, held: undefined, cash: 0 });
    await expect(page.locator('html')).toHaveAttribute('data-main-calls', '2');
    await expect.poll(() => page.evaluate(() => {
      const app = document.querySelector('#app') as unknown as { __vue_app__: { _context: { provides: Record<string, unknown> } } };
      return (app.__vue_app__._context.provides.gameOrchestrator as { isBusy: boolean }).isBusy;
    })).toBe(false);

    await page.reload();
    await enterSeededGame(page);
    expect(await saved()).toEqual({ round: 4, held: undefined, cash: 0 });
  });
