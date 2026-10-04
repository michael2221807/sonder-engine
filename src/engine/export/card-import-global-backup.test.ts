/**
 * card-import-global-backup 单元测试 — Story 6 方案A（全局设置可反悔）
 *
 * 锁定：导入前按 opt-in 精确快照各全局存储；还原时 localStorage 逐键复原(含删除曾不存在的键)、
 * IDB 存储 clear+importAll 整体复原。localStorage 走 createMockLocalStorage。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockLocalStorage } from '@/engine/__test-utils__/local-storage.mock';
import {
  captureGlobalSettingsBackup,
  restoreGlobalSettingsBackup,
  type GlobalBackupDeps,
} from './card-import-global-backup';
import type { GlobalOptInFlag } from './game-card-import.types';
import { eventBus } from '../core/event-bus';

function makeDeps() {
  const spies = {
    configExportAll: vi.fn(async () => [{ domainId: 'd', packId: 'p', patches: {}, version: 1, updatedAt: 0 }]),
    configImportAll: vi.fn(async () => {}),
    configClear: vi.fn(async () => {}),
    promptExportAll: vi.fn(async () => [{ key: 'k', value: 'v' }]),
    promptImportAll: vi.fn(async () => {}),
    promptClear: vi.fn(async () => {}),
    configReplaceAll: vi.fn(async () => {}),
    promptReplaceAll: vi.fn(async () => {}),
  };
  const deps: GlobalBackupDeps = {
    configStore: { exportAll: spies.configExportAll, importAll: spies.configImportAll, clear: spies.configClear, replaceAll: spies.configReplaceAll } as never,
    promptStorage: { exportAll: spies.promptExportAll, importAll: spies.promptImportAll, clear: spies.promptClear, replaceAll: spies.promptReplaceAll } as never,
  };
  return { deps, spies };
}

function optset(...flags: GlobalOptInFlag[]): Set<GlobalOptInFlag> {
  return new Set(flags);
}

let mock: ReturnType<typeof createMockLocalStorage>;
beforeEach(() => { mock = createMockLocalStorage(); mock.install(); });
afterEach(() => mock.restore());

describe('captureGlobalSettingsBackup', () => {
  it('无 opt-in + 无 nsfw → hasChanges=false，不读任何 IDB', async () => {
    const { deps, spies } = makeDeps();
    const b = await captureGlobalSettingsBackup(deps, 'tianming', optset(), false);
    expect(b.hasChanges).toBe(false);
    expect(b.localStorage).toEqual({});
    expect(spies.configExportAll).not.toHaveBeenCalled();
    expect(b.promptEdits).toBeUndefined();
  });

  it('settings opt-in → 快照 localStorage 白名单键，hasChanges=true', async () => {
    localStorage.setItem('aga_user_settings', '{"theme":"light"}');
    const { deps } = makeDeps();
    const b = await captureGlobalSettingsBackup(deps, 'tianming', optset('settings'), false);
    expect(b.hasChanges).toBe(true);
    expect(b.localStorage.aga_user_settings).toBe('{"theme":"light"}');
    expect('aga_nsfw_settings' in b.localStorage).toBe(true); // 全量白名单
    expect(b.localStorage.aga_nsfw_settings).toBeNull(); // 不存在 → null
  });

  it('enableNsfw → 也触发 localStorage 快照', async () => {
    const { deps } = makeDeps();
    const b = await captureGlobalSettingsBackup(deps, 'tianming', optset(), true);
    expect(b.hasChanges).toBe(true);
    expect('aga_nsfw_settings' in b.localStorage).toBe(true);
  });

  it('仅 authorGameplaySettings opt-in → 也触发 localStorage 快照 + hasChanges', async () => {
    localStorage.setItem('aga_cot_settings', '{"on":false}');
    const { deps, spies } = makeDeps();
    const b = await captureGlobalSettingsBackup(deps, 'tianming', optset('authorGameplaySettings'), false);
    expect(b.hasChanges).toBe(true);
    expect(b.localStorage.aga_cot_settings).toBe('{"on":false}'); // 玩法子集键被快照
    expect(spies.configExportAll).not.toHaveBeenCalled();          // 不碰 IDB
  });

  it('configOverlays opt-in → 快照 configStore.exportAll', async () => {
    const { deps, spies } = makeDeps();
    const b = await captureGlobalSettingsBackup(deps, 'tianming', optset('configOverlays'), false);
    expect(spies.configExportAll).toHaveBeenCalledTimes(1);
    expect(b.configOverlays).toHaveLength(1);
    expect(b.hasChanges).toBe(true);
  });

  it('builtinPromptOverrides opt-in → 快照提示词页的改动（本包）', async () => {
    const { deps } = makeDeps();
    localStorage.setItem('aga_prompt_tianming_jailbreak', 'MINE');
    localStorage.setItem('aga_prompt_enabled_tianming_antiCliche', 'false');
    localStorage.setItem('aga_prompt_other_jailbreak', 'OTHER PACK');
    const b = await captureGlobalSettingsBackup(deps, 'tianming', optset('builtinPromptOverrides'), false);
    expect(b.promptEdits).toEqual({ packId: 'tianming', entries: [{ id: 'antiCliche', enabled: false }, { id: 'jailbreak', content: 'MINE' }] });
    expect(b.hasChanges).toBe(true);
  });
});

describe('restoreGlobalSettingsBackup', () => {
  it('localStorage：有旧值→setItem 还原；旧值 null→removeItem', async () => {
    const { deps } = makeDeps();
    // 模拟：导入把 aga_user_settings 改成 dark，把 aga_text_speed 从无变有
    localStorage.setItem('aga_user_settings', '{"theme":"dark"}');
    localStorage.setItem('aga_text_speed', '5');
    await restoreGlobalSettingsBackup(deps, {
      localStorage: { aga_user_settings: '{"theme":"light"}', aga_text_speed: null },
      hasChanges: true,
    });
    expect(localStorage.getItem('aga_user_settings')).toBe('{"theme":"light"}'); // 还原旧值
    expect(localStorage.getItem('aga_text_speed')).toBeNull();                   // 曾不存在 → 删除
  });

  it('configOverlays：原子 replaceAll(snapshot)（非 clear+importAll 两事务）', async () => {
    const { deps, spies } = makeDeps();
    const snapshot = [{ domainId: 'd', packId: 'p', patches: {}, version: 1, updatedAt: 0 }];
    const res = await restoreGlobalSettingsBackup(deps, { localStorage: {}, configOverlays: snapshot as never, hasChanges: true });
    expect(spies.configReplaceAll).toHaveBeenCalledWith(snapshot);
    expect(spies.configClear).not.toHaveBeenCalled(); // 不再用非原子的 clear+importAll
    expect(res.failed).toEqual([]);
  });

  it('promptOverrides：原子 replaceAll(snapshot)', async () => {
    const { deps, spies } = makeDeps();
    const snapshot = [{ key: 'k', value: 'v' }];
    await restoreGlobalSettingsBackup(deps, { localStorage: {}, promptOverrides: snapshot as never, hasChanges: true });
    expect(spies.promptReplaceAll).toHaveBeenCalledWith(snapshot);
  });

  it('promptEdits：本包改动按快照整体复原（导入加的被清掉），并通知注册表重读', async () => {
    const { deps } = makeDeps();
    const emit = vi.spyOn(eventBus, 'emit');
    localStorage.setItem('aga_prompt_tianming_writeStyle', 'from the card');
    localStorage.setItem('aga_prompt_tianming_jailbreak', 'from the card');
    await restoreGlobalSettingsBackup(deps, {
      localStorage: {},
      promptEdits: { packId: 'tianming', entries: [{ id: 'jailbreak', content: 'MINE' }] },
      hasChanges: true,
    });
    expect(localStorage.getItem('aga_prompt_tianming_writeStyle')).toBeNull();
    expect(localStorage.getItem('aga_prompt_tianming_jailbreak')).toBe('MINE');
    expect(emit).toHaveBeenCalledWith('prompt:edits-replaced', { packId: 'tianming' });
    emit.mockRestore();
  });

  it('★per-store 隔离：config 还原抛错不阻断 prompt/提示词改动 还原，failed 收集', async () => {
    const { deps, spies } = makeDeps();
    spies.configReplaceAll.mockRejectedValueOnce(new Error('idb down'));
    const res = await restoreGlobalSettingsBackup(deps, {
      localStorage: {},
      configOverlays: [{ domainId: 'd', packId: 'p', patches: {}, version: 1, updatedAt: 0 }] as never,
      promptOverrides: [{ key: 'k', value: 'v' }] as never,
      promptEdits: { packId: 'tianming', entries: [{ id: 'jailbreak', content: 'MINE' }] },
      hasChanges: true,
    });
    expect(res.failed).toEqual(['configOverlays']);          // 仅 config 失败
    expect(spies.promptReplaceAll).toHaveBeenCalled();        // prompt 仍被还原（未被阻断）
    expect(localStorage.getItem('aga_prompt_tianming_jailbreak')).toBe('MINE'); // 提示词改动仍被还原
  });

  it('capture→restore 往返：localStorage 完整复原', async () => {
    localStorage.setItem('aga_user_settings', '{"theme":"light"}'); // 玩家原值
    const { deps } = makeDeps();
    const backup = await captureGlobalSettingsBackup(deps, 'tianming', optset('settings'), false);
    // 模拟导入覆盖
    localStorage.setItem('aga_user_settings', '{"theme":"dark"}');
    localStorage.setItem('aga_cot_settings', '{"on":true}'); // 导入新增的键（原本无）
    await restoreGlobalSettingsBackup(deps, backup);
    expect(localStorage.getItem('aga_user_settings')).toBe('{"theme":"light"}'); // 还原
    expect(localStorage.getItem('aga_cot_settings')).toBeNull();                 // 还原前不存在 → 删除
  });
});
