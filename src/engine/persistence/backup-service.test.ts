/**
 * backup-service 单元测试
 *
 * 覆盖范围：
 * - 纯函数：shape 校验、localStorage 收集/擦除、composite key 编解码
 * - 不覆盖：IDB 往返（需要 fake-indexeddb，留作后续独立 integration 测试）
 *
 * 2026-04-13：对应"全量备份恢复"重构后的新格式（含 activeProfile + bundleType）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _testExports } from './backup-service';
import { createMockLocalStorage } from '@/engine/__test-utils__/local-storage.mock';

const {
  isValidBundleShape,
  collectLocalStorageSettings,
  wipeLocalStorageSettings,
  compositeSlotKey,
  parseCompositeKey,
  hasVectorContent,
  collectAssetIdsFromTree,
  bundleImagesLookDropped,
  BACKUP_FORMAT_VERSION,
} = _testExports;

// ─── isValidBundleShape ─────────────────────────────────────────

describe('isValidBundleShape', () => {
  const makeValid = () => ({
    version: 1,
    exportedAt: '2026-04-13T00:00:00Z',
    engineVersion: '0.1.0',
    profiles: {},
    saves: {},
    vectors: {},
    configs: {},
    prompts: {},
    engineSettings: {},
  });

  it('accepts a minimal valid v1 bundle (no optional fields)', () => {
    expect(isValidBundleShape(makeValid())).toBe(true);
  });

  it('accepts a v1.1 bundle with activeProfile + bundleType (new format)', () => {
    const bundle = {
      ...makeValid(),
      bundleType: 'full',
      activeProfile: { profileId: 'p1', slotId: 'auto' },
    };
    expect(isValidBundleShape(bundle)).toBe(true);
  });

  it('accepts a single-profile bundle with bundleType=profile + activeProfile=null', () => {
    const bundle = {
      ...makeValid(),
      bundleType: 'profile',
      activeProfile: null,
    };
    expect(isValidBundleShape(bundle)).toBe(true);
  });

  it('rejects null/undefined', () => {
    expect(isValidBundleShape(null)).toBe(false);
    expect(isValidBundleShape(undefined)).toBe(false);
  });

  it('rejects non-object values', () => {
    expect(isValidBundleShape('hello')).toBe(false);
    expect(isValidBundleShape(42)).toBe(false);
    expect(isValidBundleShape(true)).toBe(false);
  });

  it('rejects missing required fields', () => {
    const base = makeValid() as Record<string, unknown>;
    for (const key of [
      'version', 'exportedAt', 'engineVersion',
      'profiles', 'saves', 'vectors', 'configs', 'prompts', 'engineSettings',
    ]) {
      const clone = { ...base };
      delete clone[key];
      expect(isValidBundleShape(clone), `missing ${key} should fail`).toBe(false);
    }
  });

  it('rejects wrong types for nested containers', () => {
    expect(isValidBundleShape({ ...makeValid(), profiles: null })).toBe(false);
    expect(isValidBundleShape({ ...makeValid(), saves: 'not an object' })).toBe(false);
    expect(isValidBundleShape({ ...makeValid(), version: 'v1' })).toBe(false);
  });

  it('BACKUP_FORMAT_VERSION is still 1 (v1 bundles remain valid after 2026-04-13 changes)', () => {
    expect(BACKUP_FORMAT_VERSION).toBe(1);
  });

  // 2026-04-14 Phase 4：customPresets 字段是 optional，新旧 bundle 都能通过
  it('accepts bundle with customPresets field (2026-04-14 +)', () => {
    expect(
      isValidBundleShape({
        ...makeValid(),
        customPresets: {
          tianming: {
            worlds: [
              { id: 'user_a_b', source: 'user', createdAt: 1, generatedBy: 'manual', name: 'X' },
            ],
          },
        },
      }),
    ).toBe(true);
  });

  it('accepts bundle WITHOUT customPresets field (backward compat)', () => {
    expect(isValidBundleShape(makeValid())).toBe(true);
  });
});

// ─── collectLocalStorageSettings ────────────────────────────────

describe('collectLocalStorageSettings', () => {
  let mock: ReturnType<typeof createMockLocalStorage>;

  beforeEach(() => {
    mock = createMockLocalStorage();
    mock.install();
  });

  afterEach(() => {
    mock.restore();
  });

  it('collects only aga_* prefixed keys', () => {
    localStorage.setItem('aga_api_management', '{"foo":1}');
    localStorage.setItem('aga_user_settings', '{"theme":"dark"}');
    localStorage.setItem('unrelated_key', 'should not be collected');
    localStorage.setItem('app_other_setting', 'nope');

    const collected = collectLocalStorageSettings();
    expect(Object.keys(collected).sort()).toEqual([
      'aga_api_management',
      'aga_user_settings',
    ]);
    expect(collected['aga_api_management']).toBe('{"foo":1}');
  });

  it('collects both aga_ and aga- prefixed keys (legacy)', () => {
    localStorage.setItem('aga_new_style', 'A');
    localStorage.setItem('aga-legacy-style', 'B');
    localStorage.setItem('something-else', 'C');

    const collected = collectLocalStorageSettings();
    expect(Object.keys(collected).sort()).toEqual([
      'aga-legacy-style',
      'aga_new_style',
    ]);
  });

  it('collects dynamic prompt keys (aga_prompt_*)', () => {
    localStorage.setItem('aga_prompt_tianming_mainRound', 'custom content');
    localStorage.setItem('aga_prompt_enabled_tianming_mainRound', 'true');
    localStorage.setItem('aga_prompt_weight_tianming_mainRound', '8');

    const collected = collectLocalStorageSettings();
    expect(Object.keys(collected)).toHaveLength(3);
    expect(collected['aga_prompt_tianming_mainRound']).toBe('custom content');
  });

  it('returns empty object when no aga keys exist', () => {
    localStorage.setItem('foo', 'bar');
    expect(collectLocalStorageSettings()).toEqual({});
  });

  it('collects aga_tts_settings (配音偏好 travels with the backup)', () => {
    // TTS global voice prefs (speaker/dialect/rate/auto-narrate) live in this key;
    // they must ride the engineSettings snapshot so backup + cloud-sync carry them.
    const tts = '{"enabled":true,"defaultSpeaker":"jok老师","defaultInstruct":"四川话"}';
    localStorage.setItem('aga_tts_settings', tts);
    const collected = collectLocalStorageSettings();
    expect(collected['aga_tts_settings']).toBe(tts);
  });

  it('EXCLUDES device-local cloud-sync keys (baseline + pending never travel)', () => {
    // Device-local sync bookkeeping: exporting it and restoring on another device
    // would corrupt that device's conflict detection / re-upload logic. Must not
    // appear in the bundle.
    localStorage.setItem('aga_user_settings', '{"theme":"dark"}');
    localStorage.setItem('aga_github_sync_token', 'ghp_secret');   // token DOES travel (own repo)
    localStorage.setItem('aga_github_sync_baseline', '2026-07-12T00:00:00.000Z');
    localStorage.setItem('aga_github_sync_pending', '1');
    // 存档插槽 epic（2026-07-23）：per-slot map 版键同样绝不入备份
    localStorage.setItem('aga_github_sync_baselines', '{"p1":"2026-07-23T00:00:00Z"}');
    localStorage.setItem('aga_github_sync_pending_map', '{"p1":true}');
    // 设备指纹（2026-08-21）：审计用设备 ID 随备份迁移会让两台设备同指纹
    localStorage.setItem('aga_device_id', 'dev_11223344');

    const collected = collectLocalStorageSettings();
    expect(collected).not.toHaveProperty('aga_github_sync_baseline');
    expect(collected).not.toHaveProperty('aga_github_sync_pending');
    expect(collected).not.toHaveProperty('aga_github_sync_baselines');
    expect(collected).not.toHaveProperty('aga_github_sync_pending_map');
    expect(collected).not.toHaveProperty('aga_device_id');
    expect(collected).toHaveProperty('aga_user_settings');
    expect(collected).toHaveProperty('aga_github_sync_token');
  });
});

// ─── wipeLocalStorageSettings ───────────────────────────────────

describe('wipeLocalStorageSettings', () => {
  let mock: ReturnType<typeof createMockLocalStorage>;

  beforeEach(() => {
    mock = createMockLocalStorage();
    mock.install();
  });

  afterEach(() => {
    mock.restore();
  });

  it('removes all aga_ and aga- prefixed keys', () => {
    localStorage.setItem('aga_api_management', 'X');
    localStorage.setItem('aga_user_settings', 'Y');
    localStorage.setItem('aga-legacy', 'Z');

    wipeLocalStorageSettings();

    expect(localStorage.getItem('aga_api_management')).toBeNull();
    expect(localStorage.getItem('aga_user_settings')).toBeNull();
    expect(localStorage.getItem('aga-legacy')).toBeNull();
  });

  it('preserves non-aga keys', () => {
    localStorage.setItem('aga_foo', 'wipe me');
    localStorage.setItem('other_key', 'keep me');
    localStorage.setItem('app_setting', 'keep me too');

    wipeLocalStorageSettings();

    expect(localStorage.getItem('aga_foo')).toBeNull();
    expect(localStorage.getItem('other_key')).toBe('keep me');
    expect(localStorage.getItem('app_setting')).toBe('keep me too');
  });

  it('handles many keys without index drift (collect-then-delete pattern)', () => {
    // 10 个 aga_ 键 + 10 个 other 键交错
    for (let i = 0; i < 10; i++) {
      localStorage.setItem(`aga_key_${i}`, String(i));
      localStorage.setItem(`other_${i}`, String(i));
    }

    wipeLocalStorageSettings();

    for (let i = 0; i < 10; i++) {
      expect(localStorage.getItem(`aga_key_${i}`)).toBeNull();
      expect(localStorage.getItem(`other_${i}`)).toBe(String(i));
    }
  });

  it('is idempotent (safe to call twice)', () => {
    localStorage.setItem('aga_foo', 'X');
    wipeLocalStorageSettings();
    wipeLocalStorageSettings(); // should not throw
    expect(localStorage.getItem('aga_foo')).toBeNull();
  });

  it('PRESERVES device-local cloud-sync keys across a foreign full-restore wipe', () => {
    // A full-backup restore wipes all aga_* keys, but this device's own sync
    // bookkeeping must survive — it describes THIS device's relationship to the
    // cloud, which importing someone else's backup does not change.
    localStorage.setItem('aga_api_management', 'X');
    localStorage.setItem('aga_github_sync_baseline', '2026-07-12T00:00:00.000Z');
    localStorage.setItem('aga_github_sync_pending', '1');
    localStorage.setItem('aga_github_sync_baselines', '{"p1":"t"}');
    localStorage.setItem('aga_github_sync_pending_map', '{"p1":true}');
    localStorage.setItem('aga_device_id', 'dev_11223344');

    wipeLocalStorageSettings();

    expect(localStorage.getItem('aga_api_management')).toBeNull();
    expect(localStorage.getItem('aga_github_sync_baseline')).toBe('2026-07-12T00:00:00.000Z');
    expect(localStorage.getItem('aga_github_sync_pending')).toBe('1');
    expect(localStorage.getItem('aga_github_sync_baselines')).toBe('{"p1":"t"}');
    expect(localStorage.getItem('aga_github_sync_pending_map')).toBe('{"p1":true}');
    expect(localStorage.getItem('aga_device_id')).toBe('dev_11223344');
  });
});

// ─── compositeSlotKey / parseCompositeKey ───────────────────────

describe('compositeSlotKey', () => {
  it('combines profileId and slotId with "/"', () => {
    expect(compositeSlotKey('profile-123', 'slot-auto')).toBe('profile-123/slot-auto');
  });

  it('handles IDs containing underscores (IDB uses "_", composite uses "/")', () => {
    expect(compositeSlotKey('profile_with_underscore', 'slot_1')).toBe(
      'profile_with_underscore/slot_1',
    );
  });
});

describe('parseCompositeKey', () => {
  it('splits at the first "/"', () => {
    expect(parseCompositeKey('profile-123/slot-auto')).toEqual({
      profileId: 'profile-123',
      slotId: 'slot-auto',
    });
  });

  it('handles slotIds that themselves contain "/"', () => {
    // 当前实现使用 indexOf，第一个 / 前是 profileId，之后全是 slotId
    expect(parseCompositeKey('p1/slot/with/slashes')).toEqual({
      profileId: 'p1',
      slotId: 'slot/with/slashes',
    });
  });

  it('throws on malformed key without separator', () => {
    expect(() => parseCompositeKey('no_slash_here')).toThrow();
  });

  it('throws when key starts with "/"', () => {
    expect(() => parseCompositeKey('/slot-only')).toThrow();
  });

  it('throws when key ends with "/"', () => {
    expect(() => parseCompositeKey('profile-only/')).toThrow();
  });

  it('round-trip: compose then parse returns original parts', () => {
    const original = { profileId: 'p_abc', slotId: 's_123' };
    const composed = compositeSlotKey(original.profileId, original.slotId);
    expect(parseCompositeKey(composed)).toEqual(original);
  });
});

// ─── hasVectorContent ───────────────────────────────────────────

describe('hasVectorContent', () => {
  it('returns false for empty event + empty entity vectors', () => {
    expect(hasVectorContent({ eventVectors: {}, entityVectors: {} })).toBe(false);
  });

  it('returns true when eventVectors has content', () => {
    expect(
      hasVectorContent({
        eventVectors: { 'evt-1': [0.1, 0.2] },
        entityVectors: {},
      }),
    ).toBe(true);
  });

  it('returns true when entityVectors has content', () => {
    expect(
      hasVectorContent({
        eventVectors: {},
        entityVectors: { 'ent-1': [0.3, 0.4] },
      }),
    ).toBe(true);
  });

  it('returns true when both non-empty', () => {
    expect(
      hasVectorContent({
        eventVectors: { e: [1] },
        entityVectors: { n: [2] },
      }),
    ).toBe(true);
  });
});

// ─── collectAssetIdsFromTree ─────────────────────────────────

describe('collectAssetIdsFromTree', () => {
  it('collects standard asset IDs from NPC archives', () => {
    const ids = new Set<string>();
    collectAssetIdsFromTree({
      社交: {
        关系: [
          { 图片档案: { 已选头像图片ID: 'avatar1', 已选立绘图片ID: 'portrait1', 已选背景图片ID: '', 生图历史: [] } },
        ],
      },
    } as Record<string, unknown>, ids);
    expect(ids.has('avatar1')).toBe(true);
    expect(ids.has('portrait1')).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('does not collect referenceLibrary assets when includeReferenceAssets=false', () => {
    const ids = new Set<string>();
    collectAssetIdsFromTree({
      系统: { 扩展: { image: { referenceLibrary: [{ assetId: 'ref1' }, { assetId: 'ref2' }] } } },
    } as Record<string, unknown>, ids, false);
    expect(ids.has('ref1')).toBe(false);
    expect(ids.has('ref2')).toBe(false);
  });

  it('collects referenceLibrary assets when includeReferenceAssets=true', () => {
    const ids = new Set<string>();
    collectAssetIdsFromTree({
      系统: { 扩展: { image: { referenceLibrary: [{ assetId: 'ref1' }, { assetId: 'ref2' }] } } },
    } as Record<string, unknown>, ids, true);
    expect(ids.has('ref1')).toBe(true);
    expect(ids.has('ref2')).toBe(true);
  });

  // ── 参考重绘用过的图必须随档（PO 2026-08-29「参考图需要入存档」）──
  // 此前 providerMeta.reference 只写不读：默认不勾「包含参考素材」时恢复即丢图，
  // 任务归档里的 sourceAssetIds 全变悬空引用。

  it('collects task reference sourceAssetIds — 不受 includeReferenceAssets 门控', () => {
    const tree = {
      系统: { 扩展: { image: { tasks: [
        { id: 't1', providerMeta: { reference: { mode: 'image_to_image', sourceAssetIds: ['r1', 'r2'], provider: 'volcengine' } } },
      ] } } },
    } as Record<string, unknown>;
    for (const flag of [false, true]) {
      const ids = new Set<string>();
      collectAssetIdsFromTree(tree, ids, flag);
      expect(ids.has('r1')).toBe(true);
      expect(ids.has('r2')).toBe(true);
    }
  });

  it('collects the legacy single sourceAssetId too（未迁移的树也要保住图）', () => {
    const ids = new Set<string>();
    collectAssetIdsFromTree({
      系统: { 扩展: { image: { tasks: [
        { id: 'old', providerMeta: { reference: { mode: 'image_to_image', sourceAssetId: 'legacy1', provider: 'novelai' } } },
      ] } } },
    } as Record<string, unknown>, ids);
    expect(ids.has('legacy1')).toBe(true);
  });

  it('skips the empty-string placeholders used for unpersisted references', () => {
    const ids = new Set<string>();
    collectAssetIdsFromTree({
      系统: { 扩展: { image: { tasks: [
        { id: 't', providerMeta: { reference: { mode: 'image_to_image', sourceAssetIds: ['', 'real', ''], provider: 'volcengine' } } },
      ] } } },
    } as Record<string, unknown>, ids);
    expect(ids.has('')).toBe(false);
    expect(ids.has('real')).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('脏数据不炸：null 任务 / 无 providerMeta / reference 非对象', () => {
    const ids = new Set<string>();
    expect(() => collectAssetIdsFromTree({
      系统: { 扩展: { image: { tasks: [
        null,
        { id: 'a' },
        { id: 'b', providerMeta: {} },
        { id: 'c', providerMeta: { reference: null } },
        { id: 'd', providerMeta: { reference: { sourceAssetIds: 'not-an-array' } } },
      ] } } },
    } as Record<string, unknown>, ids)).not.toThrow();
    expect(ids.size).toBe(0);
  });

  it('ignores empty assetId in referenceLibrary', () => {
    const ids = new Set<string>();
    collectAssetIdsFromTree({
      系统: { 扩展: { image: { referenceLibrary: [{ assetId: '' }, { assetId: 'valid' }] } } },
    } as Record<string, unknown>, ids, true);
    expect(ids.has('')).toBe(false);
    expect(ids.has('valid')).toBe(true);
  });
});

// ─── bundleImagesLookDropped (anti-amplification detection) ─────

describe('bundleImagesLookDropped', () => {
  const withRefButNoImages = () => ({
    version: 1, exportedAt: 'x', engineVersion: '0.1.0',
    profiles: {}, saves: {
      'p1/auto': { 角色: { 图片档案: { 已选头像图片ID: 'asset_abc' } } },
    },
    vectors: {}, configs: {}, prompts: {}, engineSettings: {},
    imageAssets: [] as unknown[],
  });

  it('true: bundle references image assets but carries zero image payloads (evicted-cache fingerprint)', () => {
    expect(bundleImagesLookDropped(withRefButNoImages() as never)).toBe(true);
  });

  it('true: imageAssets field entirely absent but state references assets', () => {
    const b = withRefButNoImages() as Record<string, unknown>;
    delete b.imageAssets;
    expect(bundleImagesLookDropped(b as never)).toBe(true);
  });

  it('false: bundle carries image payloads (healthy backup)', () => {
    const b = withRefButNoImages() as Record<string, unknown>;
    b.imageAssets = [{ id: 'asset_abc', metadata: { id: 'asset_abc' }, base64: 'AA', mimeType: 'image/png' }];
    expect(bundleImagesLookDropped(b as never)).toBe(false);
  });

  it('false: bundle references no image assets at all (legitimately imageless save)', () => {
    const b = {
      version: 1, exportedAt: 'x', engineVersion: '0.1.0',
      profiles: {}, saves: { 'p1/auto': { 角色: { 姓名: '李明' } } },
      vectors: {}, configs: {}, prompts: {}, engineSettings: {}, imageAssets: [],
    };
    expect(bundleImagesLookDropped(b as never)).toBe(false);
  });
});
