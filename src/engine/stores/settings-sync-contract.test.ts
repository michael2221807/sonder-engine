/**
 * Settings-sync behaviour lock (refactor R4, step 0).
 *
 * The seven device settings (`aga_*` localStorage keys) are copied into the state tree by
 * `syncNsfwFromLocalStorage` / `syncAllSettingsFromLocalStorage` when a save is loaded. Three cases are run and the
 * whole tree after each is stored in `pipeline/__snapshots__/path-contract/settings-sync.json`: every key holds a
 * valid value, every key is absent, every key holds invalid values.
 */
import { beforeEach, describe, it, expect } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useEngineStateStore } from './engine-state';
import { StateManager } from '../core/state-manager';
import { createMockLocalStorage } from '../__test-utils__/local-storage.mock';
import { serializeContract } from '../__test-utils__/path-contract';

const VALID: Record<string, string> = {
  aga_nsfw_settings: JSON.stringify({ nsfwMode: true, nsfwGenderFilter: 'male' }),
  aga_heartbeat_settings: JSON.stringify({ enabled: true, period: 7 }),
  aga_action_options_settings: JSON.stringify({ mode: 'story', pace: 'slow', customPrompt: '多写对白' }),
  aga_cot_settings: JSON.stringify({ enabled: true, judgeEnabled: true, injectStep2: false, ringSize: 4 }),
  aga_body_polish_settings: JSON.stringify({ enabled: true }),
  aga_presence_settings: JSON.stringify({ presenceEnabled: true }),
  aga_image_gen_settings: JSON.stringify({ enabled: true }),
};

const INVALID: Record<string, string> = {
  aga_nsfw_settings: JSON.stringify({ nsfwMode: 'yes', nsfwGenderFilter: 'both' }),
  aga_heartbeat_settings: JSON.stringify({ enabled: 'on', period: 0 }),
  aga_action_options_settings: JSON.stringify({ mode: 'other', pace: 'medium', customPrompt: 5 }),
  aga_cot_settings: JSON.stringify({ enabled: 1, judgeEnabled: 'x', injectStep2: null, ringSize: 0 }),
  aga_body_polish_settings: JSON.stringify({ enabled: 'true' }),
  aga_presence_settings: JSON.stringify({ presenceEnabled: 'true' }),
  aga_image_gen_settings: '{broken json',
};

/** A save that already holds values in every settings path, so "kept" and "overwritten" both show. */
function existingTree(): Record<string, unknown> {
  return {
    元数据: { 回合序号: 3 },
    世界: { 状态: { 心跳: { 配置: { enabled: false, period: 3 } } } },
    系统: {
      nsfwMode: false,
      nsfwGenderFilter: 'female',
      actionOptions: { mode: 'action', pace: 'fast', customPrompt: '' },
      设置: {
        cot: { enabled: false, judgeEnabled: false, injectStep2: true, reasoningRingSize: 3 },
        bodyPolish: false,
        social: { presenceEnabled: false },
      },
      扩展: { image: { enabled: false } },
    },
  };
}

function run(store: Record<string, string>, tree: Record<string, unknown>): Record<string, unknown> {
  setActivePinia(createPinia());
  const state = useEngineStateStore();
  const sm = new StateManager();
  state.linkStateManager(sm);
  const ls = createMockLocalStorage(store);
  ls.install();
  try {
    state.loadGame(JSON.parse(JSON.stringify(tree)) as Record<string, unknown>, 'tianming', 'p1', 's1');
  } finally {
    ls.restore();
  }
  return state.toSnapshot();
}

describe('settings-sync', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('loadGame copies the device settings into the tree', async () => {
    const result: Record<string, unknown> = {};
    for (const [label, tree] of [['emptySave', {}], ['populatedSave', existingTree()]] as const) {
      result[`${label}/valid`] = run(VALID, tree);
      result[`${label}/absent`] = run({}, tree);
      result[`${label}/invalid`] = run(INVALID, tree);
    }
    // markLoaded runs the same two syncs without touching the tree
    {
      setActivePinia(createPinia());
      const state = useEngineStateStore();
      state.linkStateManager(new StateManager());
      const ls = createMockLocalStorage(VALID);
      ls.install();
      try {
        state.markLoaded('tianming', 'p1', 's1');
      } finally {
        ls.restore();
      }
      result['markLoaded/valid'] = state.toSnapshot();
    }
    await expect(serializeContract(result)).toMatchFileSnapshot('../pipeline/__snapshots__/path-contract/settings-sync.json');
  });
});
