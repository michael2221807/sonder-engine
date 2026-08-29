import { describe, it, expect, vi, beforeEach } from 'vitest';
import { migrateImageState } from './save-migration';

function createMockStateManager() {
  const store: Record<string, unknown> = {};
  return {
    get: vi.fn(<T>(path: string): T | undefined => {
      const parts = path.split('.');
      let current: unknown = store;
      for (const part of parts) {
        if (current == null || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[part];
      }
      return current as T | undefined;
    }),
    set: vi.fn((path: string, value: unknown, _source?: string) => {
      const parts = path.split('.');
      let current: Record<string, unknown> = store;
      for (let i = 0; i < parts.length - 1; i++) {
        if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
          current[parts[i]] = {};
        }
        current = current[parts[i]] as Record<string, unknown>;
      }
      current[parts[parts.length - 1]] = JSON.parse(JSON.stringify(value));
    }),
    _store: store,
  };
}

describe('migrateImageState', () => {
  let sm: ReturnType<typeof createMockStateManager>;

  beforeEach(() => { sm = createMockStateManager(); });

  it('initializes full image subtree for pre-image save', () => {
    const result = migrateImageState(sm as unknown as import('../core/state-manager').StateManager);
    expect(result).toBe(true);
    expect(sm.set).toHaveBeenCalled();
    const imageRoot = sm.get('系统.扩展.image');
    expect(imageRoot).toBeDefined();
    expect((imageRoot as Record<string, unknown>).enabled).toBe(false);
  });

  it('adds civitai config to existing save without it', () => {
    sm.set('系统.扩展.image', { enabled: true, config: { novelai: { sampler: 'k_euler' } } }, 'system');
    sm.set.mockClear();

    const result = migrateImageState(sm as unknown as import('../core/state-manager').StateManager);
    expect(result).toBe(true);

    const civitai = sm.get('系统.扩展.image.config.civitai') as Record<string, unknown> | undefined;
    expect(civitai).toBeDefined();
    expect(civitai?.scheduler).toBe('EulerA');
    expect(civitai?.allowMatureContent).toBe(false);
    expect(civitai?.steps).toBe(25);
    expect(civitai?.cfgScale).toBe(7);
    expect(civitai?.seed).toBe(-1);
    expect(civitai?.clipSkip).toBe(2);
  });

  it('does not overwrite existing civitai config', () => {
    sm.set('系统.扩展.image', {
      enabled: true,
      config: {
        civitai: { allowMatureContent: true, scheduler: 'DDIM', steps: 30, cfgScale: 5, seed: 42, clipSkip: 1, outputFormat: 'jpeg', additionalNetworksJson: '{}', controlNetsJson: '', loras: [] },
        reference: { enabled: true },
        understanding: { defaultEngine: 'civitai_vlm' },
      },
      referenceLibrary: [],
    }, 'system');
    sm.set.mockClear();

    const result = migrateImageState(sm as unknown as import('../core/state-manager').StateManager);
    expect(result).toBe(false);

    const civitai = sm.get('系统.扩展.image.config.civitai') as Record<string, unknown> | undefined;
    expect(civitai?.allowMatureContent).toBe(true);
    expect(civitai?.scheduler).toBe('DDIM');
    expect(civitai?.steps).toBe(30);
  });

  it('does not affect other provider configs', () => {
    sm.set('系统.扩展.image', {
      enabled: true,
      config: { novelai: { sampler: 'k_euler_ancestral', steps: 28 } },
    }, 'system');

    migrateImageState(sm as unknown as import('../core/state-manager').StateManager);

    const novelai = sm.get('系统.扩展.image.config.novelai') as Record<string, unknown> | undefined;
    expect(novelai?.sampler).toBe('k_euler_ancestral');
    expect(novelai?.steps).toBe(28);
  });

  it('does not run full init when image root already exists with all fields', () => {
    sm.set('系统.扩展.image', {
      enabled: false,
      // maxNewTokensBumped 也算「全字段齐备」的一员（2026-08-28 一次性提额标记）
      config: { civitai: { scheduler: 'Euler', loras: [] }, reference: { enabled: true }, understanding: { defaultEngine: 'civitai_vlm', maxNewTokensBumped: true } },
      referenceLibrary: [],
    }, 'system');
    sm.set.mockClear();

    const result = migrateImageState(sm as unknown as import('../core/state-manager').StateManager);
    expect(result).toBe(false);
    expect(sm.set).not.toHaveBeenCalled();
  });

  it('adds loras[] to existing civitai config without it', () => {
    sm.set('系统.扩展.image', {
      enabled: true,
      config: {
        civitai: { allowMatureContent: true, scheduler: 'DDIM', steps: 30, cfgScale: 5, seed: 42, clipSkip: 1, outputFormat: 'jpeg', additionalNetworksJson: '{}', controlNetsJson: '' },
      },
    }, 'system');
    sm.set.mockClear();

    const result = migrateImageState(sm as unknown as import('../core/state-manager').StateManager);
    expect(result).toBe(true);

    const loras = sm.get('系统.扩展.image.config.civitai.loras');
    expect(loras).toEqual([]);

    // Existing fields must be preserved
    const civitai = sm.get('系统.扩展.image.config.civitai') as Record<string, unknown> | undefined;
    expect(civitai?.allowMatureContent).toBe(true);
    expect(civitai?.scheduler).toBe('DDIM');
  });

  it('adds loras[] when existing civitai config has loras: null', () => {
    sm.set('系统.扩展.image', {
      enabled: true,
      config: { civitai: { scheduler: 'Euler', loras: null } },
    }, 'system');
    sm.set.mockClear();

    const result = migrateImageState(sm as unknown as import('../core/state-manager').StateManager);
    expect(result).toBe(true);
    expect(sm.get('系统.扩展.image.config.civitai.loras')).toEqual([]);
  });

  it('does not overwrite existing loras array', () => {
    const existingLoras = [{ id: 'test', name: 'Test LoRA', air: 'urn:air:sdxl:lora:civitai:1@2', enabled: true, strength: 1 }];
    sm.set('系统.扩展.image', {
      enabled: true,
      config: {
        civitai: { scheduler: 'Euler', loras: existingLoras },
        reference: { enabled: true },
        understanding: { defaultEngine: 'civitai_vlm' },
      },
      referenceLibrary: [],
    }, 'system');
    sm.set.mockClear();

    const result = migrateImageState(sm as unknown as import('../core/state-manager').StateManager);
    expect(result).toBe(false);

    const loras = sm.get('系统.扩展.image.config.civitai.loras') as unknown[];
    expect(loras).toEqual(existingLoras);
  });

  it('adds reference config to existing save without it', () => {
    sm.set('系统.扩展.image', {
      enabled: true,
      config: { civitai: { scheduler: 'Euler', loras: [] }, understanding: { defaultEngine: 'civitai_vlm' } },
    }, 'system');
    sm.set.mockClear();

    const result = migrateImageState(sm as unknown as import('../core/state-manager').StateManager);
    expect(result).toBe(true);

    const reference = sm.get('系统.扩展.image.config.reference') as Record<string, unknown> | undefined;
    expect(reference).toBeDefined();
    expect(reference?.enabled).toBe(true);
    expect(reference?.defaultDenoiseStrength).toBe(0.65);
    // 旧 wd/caption 键已随 wdTagging/JoyCaption 拆除（重建 epic D5）
    const civitaiRef = reference?.civitai as Record<string, unknown> | undefined;
    expect(civitaiRef?.imageToImageEnabled).toBe(true);
    expect(civitaiRef?.wdThreshold).toBeUndefined();
  });

  it('adds referenceLibrary to existing save without it', () => {
    sm.set('系统.扩展.image', {
      enabled: true,
      config: { civitai: { scheduler: 'Euler', loras: [] }, reference: { enabled: true } },
    }, 'system');
    sm.set.mockClear();

    const result = migrateImageState(sm as unknown as import('../core/state-manager').StateManager);
    expect(result).toBe(true);

    const refLib = sm.get('系统.扩展.image.referenceLibrary');
    expect(refLib).toEqual([]);
  });

  it('does not overwrite existing reference config', () => {
    sm.set('系统.扩展.image', {
      enabled: true,
      config: {
        civitai: { scheduler: 'Euler', loras: [] },
        reference: { enabled: false, defaultDenoiseStrength: 0.5 },
        understanding: { defaultEngine: 'general_llm' },
      },
      referenceLibrary: [{ id: 'existing' }],
    }, 'system');
    sm.set.mockClear();

    const result = migrateImageState(sm as unknown as import('../core/state-manager').StateManager);
    expect(result).toBe(false);

    const reference = sm.get('系统.扩展.image.config.reference') as Record<string, unknown> | undefined;
    expect(reference?.enabled).toBe(false);
    expect(reference?.defaultDenoiseStrength).toBe(0.5);
    const refLib = sm.get('系统.扩展.image.referenceLibrary') as unknown[];
    expect(refLib).toHaveLength(1);
  });

  it('full init includes reference config and referenceLibrary', () => {
    migrateImageState(sm as unknown as import('../core/state-manager').StateManager);

    const reference = sm.get('系统.扩展.image.config.reference') as Record<string, unknown> | undefined;
    expect(reference).toBeDefined();
    expect(reference?.enabled).toBe(true);
    const refLib = sm.get('系统.扩展.image.referenceLibrary');
    expect(refLib).toEqual([]);
  });

  it('adds understanding config with defaults to existing save without it（重建 epic §4）', () => {
    sm.set('系统.扩展.image', {
      enabled: true,
      config: { civitai: { scheduler: 'Euler', loras: [] }, reference: { enabled: true } },
      referenceLibrary: [],
    }, 'system');
    sm.set.mockClear();

    const result = migrateImageState(sm as unknown as import('../core/state-manager').StateManager);
    expect(result).toBe(true);

    const u = sm.get('系统.扩展.image.config.understanding') as Record<string, unknown> | undefined;
    expect(u?.defaultEngine).toBe('civitai_vlm');
    expect(u?.civitaiModel).toBe('claude-sonnet-5');
    expect(u?.temperature).toBe(0.2);
    expect(u?.maxNewTokens).toBe(600);
  });

  it('migrates user-changed legacy captionTemperature/captionMaxNewTokens into understanding', () => {
    sm.set('系统.扩展.image', {
      enabled: true,
      config: {
        civitai: { scheduler: 'Euler', loras: [] },
        reference: { enabled: true, civitai: { captionTemperature: 0.7, captionMaxNewTokens: 480, wdThreshold: 0.35 } },
      },
      referenceLibrary: [],
    }, 'system');
    sm.set.mockClear();

    migrateImageState(sm as unknown as import('../core/state-manager').StateManager);
    const u = sm.get('系统.扩展.image.config.understanding') as Record<string, unknown> | undefined;
    expect(u?.temperature).toBe(0.7);
    expect(u?.maxNewTokens).toBe(480);
  });

  it('legacy values equal to old defaults (0.2 / 160) are not migrated — new defaults win', () => {
    sm.set('系统.扩展.image', {
      enabled: true,
      config: {
        civitai: { scheduler: 'Euler', loras: [] },
        reference: { enabled: true, civitai: { captionTemperature: 0.2, captionMaxNewTokens: 160 } },
      },
      referenceLibrary: [],
    }, 'system');
    sm.set.mockClear();

    migrateImageState(sm as unknown as import('../core/state-manager').StateManager);
    const u = sm.get('系统.扩展.image.config.understanding') as Record<string, unknown> | undefined;
    expect(u?.temperature).toBe(0.2);
    expect(u?.maxNewTokens).toBe(600); // 旧默认 160 面向 JoyCaption → 新默认 600（人体优先提示词）
  });

  it('does not overwrite existing understanding config (idempotent)', () => {
    sm.set('系统.扩展.image', {
      enabled: true,
      config: {
        civitai: { scheduler: 'Euler', loras: [] },
        reference: { enabled: true },
        // maxNewTokensBumped=true → 已过一次性提额，本用例只验证「不覆盖既有配置」
        understanding: { defaultEngine: 'general_llm', civitaiModel: 'gpt-4o-mini', temperature: 0.9, maxNewTokens: 500, maxNewTokensBumped: true },
      },
      referenceLibrary: [],
    }, 'system');
    sm.set.mockClear();

    const result = migrateImageState(sm as unknown as import('../core/state-manager').StateManager);
    expect(result).toBe(false);
    const u = sm.get('系统.扩展.image.config.understanding') as Record<string, unknown> | undefined;
    expect(u?.defaultEngine).toBe('general_llm');
    expect(u?.civitaiModel).toBe('gpt-4o-mini');
  });

  it('bumps a stale default maxNewTokens 300 → 600 once（2026-08-28 人体细节强化）', () => {
    sm.set('系统.扩展.image', {
      enabled: true,
      config: {
        civitai: { scheduler: 'Euler', loras: [] },
        reference: { enabled: true },
        understanding: { defaultEngine: 'civitai_vlm', civitaiModel: 'claude-sonnet-5', temperature: 0.2, maxNewTokens: 300 },
      },
      referenceLibrary: [],
    }, 'system');
    sm.set.mockClear();

    expect(migrateImageState(sm as unknown as import('../core/state-manager').StateManager)).toBe(true);
    const base = '系统.扩展.image.config.understanding';
    expect(sm.get(`${base}.maxNewTokens`)).toBe(600);
    expect(sm.get(`${base}.maxNewTokensBumped`)).toBe(true);

    // 二次加载：不再改写（用户此后主动设回 300 也不会被抢）
    sm.set(`${base}.maxNewTokens`, 300, 'system');
    expect(migrateImageState(sm as unknown as import('../core/state-manager').StateManager)).toBe(false);
    expect(sm.get(`${base}.maxNewTokens`)).toBe(300);
  });

  it('does not bump a user-customized maxNewTokens', () => {
    sm.set('系统.扩展.image', {
      enabled: true,
      config: {
        civitai: { scheduler: 'Euler', loras: [] },
        reference: { enabled: true },
        understanding: { defaultEngine: 'civitai_vlm', civitaiModel: 'claude-sonnet-5', temperature: 0.2, maxNewTokens: 150 },
      },
      referenceLibrary: [],
    }, 'system');
    sm.set.mockClear();

    migrateImageState(sm as unknown as import('../core/state-manager').StateManager);
    expect(sm.get('系统.扩展.image.config.understanding.maxNewTokens')).toBe(150);
    expect(sm.get('系统.扩展.image.config.understanding.maxNewTokensBumped')).toBe(true);
  });

  // ── 多图参考重绘 epic S2（2026-08-29）：历史任务归档单值 → 有序数组 ──

  describe('task reference sourceAssetId → sourceAssetIds[]', () => {
    function seedWithTasks(tasks: unknown[]): void {
      sm.set('系统.扩展.image', {
        enabled: true,
        config: {
          civitai: { scheduler: 'Euler', loras: [] },
          reference: { enabled: true },
          understanding: { defaultEngine: 'civitai_vlm', maxNewTokensBumped: true },
        },
        referenceLibrary: [],
        tasks,
      }, 'system');
      sm.set.mockClear();
    }
    const run = () => migrateImageState(sm as unknown as import('../core/state-manager').StateManager);
    const refOf = (i: number) => sm.get(`系统.扩展.image.tasks.${i}.providerMeta.reference`) as Record<string, unknown>;

    it('旧单值迁成单元素数组，且旧字段保留（双向兼容）', () => {
      seedWithTasks([{
        id: 't1',
        providerMeta: { reference: { mode: 'image_to_image', sourceAssetId: 'asset_a', denoiseStrength: 0.6, provider: 'novelai' } },
      }]);
      expect(run()).toBe(true);
      expect(refOf(0).sourceAssetIds).toEqual(['asset_a']);
      expect(refOf(0).sourceAssetId).toBe('asset_a');   // 老版本读同一存档仍取得到
      expect(refOf(0).denoiseStrength).toBe(0.6);       // 其余字段不动
    });

    it('幂等：已是数组的不动，二次运行不改数据', () => {
      seedWithTasks([{
        id: 't1',
        providerMeta: { reference: { mode: 'image_to_image', sourceAssetIds: ['a', 'b', 'c'], provider: 'volcengine' } },
      }]);
      expect(run()).toBe(false);
      expect(refOf(0).sourceAssetIds).toEqual(['a', 'b', 'c']);
    });

    it('多个任务混合：只迁需要迁的那些', () => {
      seedWithTasks([
        { id: 'old', providerMeta: { reference: { mode: 'image_to_image', sourceAssetId: 'x', provider: 'civitai' } } },
        { id: 'new', providerMeta: { reference: { mode: 'image_to_image', sourceAssetIds: ['y', 'z'], provider: 'volcengine' } } },
        { id: 'noref', providerMeta: { civitai: { loras: [] } } },
        { id: 'nometa' },
      ]);
      expect(run()).toBe(true);
      expect(refOf(0).sourceAssetIds).toEqual(['x']);
      expect(refOf(1).sourceAssetIds).toEqual(['y', 'z']);
    });

    it('脏数据不炸：空串 / 非字符串 / null 任务一律跳过', () => {
      seedWithTasks([
        null,
        { id: 'empty', providerMeta: { reference: { mode: 'image_to_image', sourceAssetId: '', provider: 'civitai' } } },
        { id: 'wrongtype', providerMeta: { reference: { mode: 'image_to_image', sourceAssetId: 42, provider: 'civitai' } } },
      ]);
      expect(run()).toBe(false);
    });

    it('没有 tasks 数组时不做任何事', () => {
      seedWithTasks([]);
      expect(run()).toBe(false);
    });
  });

  it('full init includes understanding defaults', () => {
    migrateImageState(sm as unknown as import('../core/state-manager').StateManager);
    const u = sm.get('系统.扩展.image.config.understanding') as Record<string, unknown> | undefined;
    expect(u?.defaultEngine).toBe('civitai_vlm');
    expect(u?.civitaiModel).toBe('claude-sonnet-5');
  });

  it('full init includes loras[] in civitai defaults', () => {
    migrateImageState(sm as unknown as import('../core/state-manager').StateManager);

    const civitai = sm.get('系统.扩展.image.config.civitai') as Record<string, unknown> | undefined;
    expect(civitai).toBeDefined();
    expect(civitai?.loras).toEqual([]);
    expect(civitai?.scheduler).toBe('EulerA');
  });
});
