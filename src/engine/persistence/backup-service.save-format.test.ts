import 'fake-indexeddb/auto';
/**
 * Export of an old-format save (存档瘦身 P1 §2.1): the export reads every slot through SaveManager.loadGame, which
 * upgrades the tree in memory — the exported bundle is in the new format and nothing in the databases changes.
 * Runs on the real stores (backup-harness), unlike the save-manager unit tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeBackupHarness, stateTree } from '../__test-utils__/backup-harness';
import { dumpAllIdb, type IdbDump } from '../__test-utils__/snapshot-lock';

vi.setConfig({ testTimeout: 120_000 });

type Json = Record<string, unknown>;

/** A tree as the code before save format 2 wrote it: an old whole snapshot, untrimmed traces, whole-list records. */
function legacyTree(): Json {
  const history: Json[] = [];
  const events: Json[] = [];
  for (let round = 1; round <= 8; round++) {
    const before = [...events];
    events.push({ 事件名称: `事件${round}` });
    history.push({ role: 'user', content: `输入${round}` });
    history.push({
      role: 'assistant',
      content: `正文${round}`,
      _delta: [{ path: '社交.事件.事件记录', action: 'push', oldValue: before, newValue: [...events], timestamp: round, source: 'main' }],
      _engramRead: { candidates: [{ outcome: 'injected' }, { outcome: 'filtered-by-topK' }] },
    });
  }
  const snapshot = { ...stateTree('Old', 7), 元数据: { 回合序号: 7, 叙事历史: history.slice(0, 14) } };
  return { ...stateTree('Old', 8), 元数据: { 回合序号: 8, 叙事历史: history, 上次对话前快照: snapshot }, 社交: { 关系: [], 事件: { 事件记录: events } } };
}

function changedDatabases(before: IdbDump, after: IdbDump): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((n) => JSON.stringify(before[n]) !== JSON.stringify(after[n])).sort();
}

describe('export of an old-format save', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('exports the slot in save format 2 and changes nothing in the databases', async () => {
    const h = await makeBackupHarness('empty');
    await h.addProfile('prof_old', 'Old', ['slot_1']);
    await h.saveSlot('prof_old', 'slot_1', legacyTree());
    const before = await dumpAllIdb();

    const bundle = JSON.parse(await (await h.backup.exportAll()).text()) as { saves: Record<string, Json> };
    const after = await dumpAllIdb();

    // Opening a store the empty fixture never used creates it empty; no database that held anything changed, and
    // the saves themselves are byte for byte what they were.
    expect(changedDatabases(before, after).filter((name) => before[name] !== undefined)).toEqual([]);
    expect(JSON.stringify(after['aga-saves'])).toBe(JSON.stringify(before['aga-saves']));
    expect(before['aga-saves']).toBeDefined();
    const exported = Object.values(bundle.saves)[0];
    const meta = exported.元数据 as Json;
    const extension = (exported.系统 as { 扩展: Json }).扩展;
    expect(meta.上次对话前快照).toBeUndefined();
    expect(extension.rollbackPatch).toMatchObject({ format: 1, base: { round: 8, historyLength: 16 } });
    expect(extension.saveFormat).toEqual({ version: 2, migratedAtRound: 8 });
    const records = (meta.叙事历史 as Json[]).flatMap((e) => (e._delta ?? []) as Json[]);
    expect(records.every((r) => r.oldValue === undefined && 'element' in r)).toBe(true);
  });
});
