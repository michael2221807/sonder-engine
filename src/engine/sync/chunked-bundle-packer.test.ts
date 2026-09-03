import { describe, it, expect, vi } from 'vitest';
import {
  pack, packChunks, unpack, gzipCompress, gzipDecompress,
  sha256, sha256String, sha256Blob, ChecksumError,
} from './chunked-bundle-packer';
import type { ChunkManifest } from './chunked-bundle-packer';

// 这个文件里的持久化门用例会真实打包 25MB+ 的 bundle(分块 + gzip + 双层 SHA-256),
// 单独跑约 10s 就绪,但 `npx vitest run` 全量并行时 CPU 争用会把单个用例推过 vitest
// 默认的 5s testTimeout —— 表现为"单跑全绿、全量随机红几个"的假失败。
// 2026-09-03 事故:CI 的 `Run tests` 因此连续三个 commit 变红,build/deploy 被整段
// skip,GitHub Pages 一直停在旧构建(线上功能看不到更新)。这里按文件放宽超时,
// 不动被测逻辑,也不掩盖真实断言失败(超时以外的失败照常红)。
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

async function collectChunks(
  gen: AsyncGenerator<{ path: string; blob: Blob }, ChunkManifest, void>,
): Promise<{ manifest: ChunkManifest; chunks: Map<string, Blob> }> {
  const chunks = new Map<string, Blob>();
  let res = await gen.next();
  while (!res.done) {
    chunks.set(res.value.path, res.value.blob);
    res = await gen.next();
  }
  return { manifest: res.value, chunks };
}

// ─── Realistic mock that mirrors a real BackupBundle ───

const BACKENDS = ['novelai', 'civitai', 'openai', 'sd_webui', 'comfyui'] as const;
const ORIGINS = ['generated', 'reference', 'upload', undefined] as const;
const MIME_TYPES = ['image/png', 'image/webp', 'image/jpeg'] as const;

function makeImageAsset(index: number, base64Size = 1000) {
  const backend = BACKENDS[index % BACKENDS.length];
  const origin = ORIGINS[index % ORIGINS.length];
  const mime = MIME_TYPES[index % MIME_TYPES.length];
  const id = `asset_${String(index).padStart(4, '0')}_${Date.now().toString(36)}`;

  const metadata: Record<string, unknown> = {
    id,
    taskId: `task_${index}_${Math.random().toString(36).slice(2, 8)}`,
    storageKey: `idb://images/${id}`,
    mimeType: mime,
    width: [512, 768, 1024][index % 3],
    height: [512, 1024, 768][index % 3],
    sizeBytes: base64Size * 0.75,
    backend,
    createdAt: 1715000000 + index * 3600,
  };
  if (origin !== undefined) metadata.origin = origin;

  return {
    id,
    metadata,
    base64: String.fromCharCode(65 + (index % 26)).repeat(base64Size),
    mimeType: mime,
  };
}

function makeRealisticBundle(opts: {
  imageCount?: number;
  imageSize?: number;
  noImageAssets?: boolean;
  emptyImageAssets?: boolean;
  profileBundle?: boolean;
  noCustomPresets?: boolean;
  noBundleType?: boolean;
  nullActiveProfile?: boolean;
  multipleProfiles?: boolean;
} = {}): string {
  const {
    imageCount = 5, imageSize = 2000,
    noImageAssets = false, emptyImageAssets = false,
    profileBundle = false, noCustomPresets = false,
    noBundleType = false, nullActiveProfile = false,
    multipleProfiles = false,
  } = opts;

  const bundle: Record<string, unknown> = {
    version: 1,
    exportedAt: '2026-05-09T14:30:00.123Z',
    engineVersion: '0.1.0',
  };

  if (!noBundleType) bundle.bundleType = profileBundle ? 'profile' : 'full';

  if (nullActiveProfile) {
    bundle.activeProfile = null;
  } else {
    bundle.activeProfile = { profileId: 'p_abc123', slotId: 'auto' };
  }

  // Profiles — multiple characters
  const profiles: Record<string, unknown> = {
    p_abc123: {
      name: '李逍遥',
      packId: 'tianming',
      createdAt: '2026-04-01T00:00:00Z',
      slotIds: ['auto', 'manual_1'],
    },
  };
  if (multipleProfiles) {
    profiles.p_def456 = {
      name: '赵灵儿',
      packId: 'tianming',
      createdAt: '2026-04-15T00:00:00Z',
      slotIds: ['auto'],
    };
    profiles.p_ghi789 = {
      name: '林月如',
      packId: 'jianghu',
      createdAt: '2026-05-01T00:00:00Z',
      slotIds: ['auto', 'manual_1', 'manual_2'],
    };
  }
  bundle.profiles = profiles;

  // Saves — complex Chinese state trees
  const saves: Record<string, unknown> = {
    'p_abc123/auto': {
      角色: {
        姓名: '李逍遥',
        属性: { 体力: 100, 内力: 80, 攻击: 45, 防御: 30, 速度: 55, 悟性: 70 },
        状态: ['中毒', '内伤'],
        装备: { 武器: '碧血剑', 防具: '金丝甲', 饰品: '护心镜' },
      },
      世界: {
        天气: '暴风雪',
        时辰: '子时',
        地点: '锁妖塔·第七层',
        节日: null,
        环境: ['妖气弥漫', '阵法干扰', '灵力波动'],
      },
      NPC: {
        赵灵儿: { 好感度: 95, 关系: '恋人', 最近交互: '2026-05-08T20:00:00Z' },
        酒剑仙: { 好感度: 70, 关系: '师父', 最近交互: '2026-05-07T10:00:00Z' },
      },
      系统: {
        回合数: 142,
        剧情阶段: 'act3_climax',
        已触发事件: ['锁妖塔开启', '灵儿觉醒', '拜月教突袭'],
        扩展: {
          image: {
            已选头像图片ID: 'asset_0000',
            已选立绘图片ID: 'asset_0001',
            已选背景图片ID: 'asset_0002',
            生图历史: [],
          },
        },
      },
    },
    'p_abc123/manual_1': {
      角色: { 姓名: '李逍遥', 属性: { 体力: 50, 内力: 30 } },
      世界: { 天气: '晴', 时辰: '午时', 地点: '余杭镇' },
      NPC: {},
      系统: { 回合数: 10, 剧情阶段: 'prologue' },
    },
  };
  if (multipleProfiles) {
    saves['p_def456/auto'] = {
      角色: { 姓名: '赵灵儿', 属性: { 体力: 60, 灵力: 200 } },
      世界: { 天气: '月光', 地点: '仙灵岛' },
    };
    saves['p_ghi789/auto'] = {
      角色: { 姓名: '林月如', 属性: { 体力: 90, 攻击: 80 } },
      世界: { 天气: '阴', 地点: '比武场' },
    };
  }
  bundle.saves = saves;

  // Vectors
  bundle.vectors = {
    'p_abc123/auto': {
      nodes: [
        { id: 'n1', type: 'entity', name: '赵灵儿', embedding: new Array(384).fill(0.1) },
        { id: 'n2', type: 'event', name: '锁妖塔开启', embedding: new Array(384).fill(0.2) },
      ],
      edges: [{ source: 'n1', target: 'n2', type: 'participated_in' }],
    },
  };

  // Configs
  bundle.configs = {
    overlays: [
      { key: 'display.theme', value: 'dark', scope: 'global' },
      { key: 'ai.temperature', value: 0.8, scope: 'pack:tianming' },
      { key: 'ai.maxTokens', value: 4096, scope: 'pack:tianming' },
    ],
  };

  // Prompts
  bundle.prompts = {
    entries: [
      { key: 'tianming/system', value: '你是一个修仙世界的AI叙事引擎，负责推动剧情发展。' },
      { key: 'tianming/battle', value: '战斗描写要简洁，突出招式名称和效果。' },
      { key: 'tianming/body-polish', value: '肉棒/小穴/阴蒂/乳头/蜜液/精液' },
    ],
  };

  // Engine settings — includes null values
  bundle.engineSettings = {
    aga_theme: 'dark',
    aga_lang: 'zh-CN',
    aga_github_sync_token: null,
    aga_github_sync_owner: 'michael2221807',
    aga_github_sync_repo: 'aga-cloud-save',
    'aga-display-density': 'comfortable',
    'aga-sidebar-collapsed': 'false',
    'aga-last-active-tab': 'game',
    aga_font_size: '16',
    aga_nsfw_enabled: 'true',
  };

  // Custom presets
  if (!noCustomPresets) {
    bundle.customPresets = {
      tianming: {
        worlds: [
          { id: 'cw1', name: '冰封雪原', description: '万年寒冰覆盖的极北之地', packId: 'tianming' },
          { id: 'cw2', name: '炎火沙漠', description: '终年酷暑的戈壁沙漠', packId: 'tianming' },
        ],
        origins: [
          { id: 'co1', name: '落魄书生', description: '家道中落的读书人', packId: 'tianming' },
        ],
      },
      jianghu: {
        worlds: [
          { id: 'jw1', name: '中原武林', description: '群雄争霸的武林天下', packId: 'jianghu' },
        ],
      },
    };
  }

  // Image assets
  if (emptyImageAssets) {
    bundle.imageAssets = [];
  } else if (!noImageAssets) {
    bundle.imageAssets = Array.from({ length: imageCount }, (_, i) =>
      makeImageAsset(i, imageSize),
    );
  }

  return JSON.stringify(bundle, null, 2);
}

// ─── gzip compress / decompress ───

describe('gzip compress/decompress', () => {
  it('roundtrips short text with Unicode', async () => {
    const input = '{"hello":"world","中文":"测试","emoji":"🎮"}';
    const compressed = await gzipCompress(input);
    expect(compressed.size).toBeGreaterThan(0);
    expect(await gzipDecompress(compressed)).toBe(input);
  });

  it('roundtrips large repetitive data with good compression', async () => {
    const input = 'A'.repeat(100_000);
    const compressed = await gzipCompress(input);
    expect(compressed.size).toBeLessThan(input.length / 10);
    expect(await gzipDecompress(compressed)).toBe(input);
  });

  it('roundtrips empty string', async () => {
    const compressed = await gzipCompress('');
    expect(await gzipDecompress(compressed)).toBe('');
  });

  it('roundtrips complex JSON with nested Chinese', async () => {
    const obj = { 角色: { 属性: { 体力: 100 } }, arr: [1, '二', null, true] };
    const input = JSON.stringify(obj, null, 2);
    const compressed = await gzipCompress(input);
    expect(await gzipDecompress(compressed)).toBe(input);
  });

  it('maxBytes default (Infinity) keeps legacy unbounded behavior', async () => {
    const input = 'A'.repeat(50_000);
    const compressed = await gzipCompress(input);
    expect(await gzipDecompress(compressed)).toBe(input);          // no arg
    expect(await gzipDecompress(compressed, Infinity)).toBe(input); // explicit Infinity
  });

  it('★maxBytes cap rejects a zip-bomb (decompressed > limit → throws)', async () => {
    const input = 'A'.repeat(2_000_000);          // ~2MB decompressed, tiny compressed
    const compressed = await gzipCompress(input);
    await expect(gzipDecompress(compressed, 1_000)).rejects.toThrow(/exceeds limit/);
  });

  it('maxBytes cap allows output within the limit', async () => {
    const input = 'hello 数据 🎮';
    const compressed = await gzipCompress(input);
    expect(await gzipDecompress(compressed, 1_000_000)).toBe(input); // bounded reader path still correct
  });
});

// ─── sha256 ───

describe('sha256', () => {
  it('produces consistent 64-char hex for same input', async () => {
    const h1 = await sha256String('hello world 你好');
    const h2 = await sha256String('hello world 你好');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different inputs produce different hashes', async () => {
    const h1 = await sha256String('data_a');
    const h2 = await sha256String('data_b');
    expect(h1).not.toBe(h2);
  });

  it('sha256 from ArrayBuffer works', async () => {
    const buf = new TextEncoder().encode('test').buffer as ArrayBuffer;
    const hash = await sha256(buf);
    expect(hash).toHaveLength(64);
  });

  it('sha256Blob produces valid hex for compressed data', async () => {
    const compressed = await gzipCompress('some data 数据');
    const hash = await sha256Blob(compressed);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('empty input produces known SHA-256', async () => {
    const hash = await sha256String('');
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('produces correct hash for "hello"', async () => {
    const hash = await sha256String('hello');
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('produces correct hash for Chinese text', async () => {
    const hash = await sha256String('你好世界');
    expect(hash).toBe('beca6335b20ff57ccc47403ef4d9e0b8fccb4442b3151c2e7d50050673d43172');
  });
});

// ─── pack: manifest structure ───

describe('pack — manifest structure', () => {
  it('produces correct manifest metadata', async () => {
    const json = makeRealisticBundle();
    const { manifest } = await pack(json);

    expect(manifest.manifestVersion).toBe(2);
    expect(manifest.engineVersion).toBe('0.1.0');
    expect(manifest.totalSizeBytes).toBe(json.length);
    expect(manifest.bundleChecksum).toHaveLength(64);
    expect(new Date(manifest.createdAt).getTime()).not.toBeNaN();
  });

  it('always has state chunk as first entry', async () => {
    const json = makeRealisticBundle();
    const { manifest } = await pack(json);

    expect(manifest.chunks[0].name).toBe('state');
    expect(manifest.chunks[0].path).toBe('v2/state.gz');
  });

  it('chunk entries have all required fields', async () => {
    const json = makeRealisticBundle({ imageCount: 3 });
    const { manifest, chunks } = await pack(json);

    for (const entry of manifest.chunks) {
      expect(entry.name).toBeTruthy();
      expect(entry.path).toMatch(/^v2\//);
      expect(entry.compressedSize).toBeGreaterThan(0);
      expect(entry.originalSize).toBeGreaterThan(0);
      expect(entry.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(chunks.has(entry.path)).toBe(true);
    }
  });

  it('bundleChecksum matches SHA-256 of input', async () => {
    const json = makeRealisticBundle();
    const expectedHash = await sha256String(json);
    const { manifest } = await pack(json);
    expect(manifest.bundleChecksum).toBe(expectedHash);
  });
});

// ─── packChunks: streaming parity (memory-bounded large-save path) ───

describe('packChunks — streaming generator', () => {
  it('yields the same chunk paths as eager pack(), in order', async () => {
    const json = makeRealisticBundle({ imageCount: 12, imageSize: 5000 });
    const eager = await pack(json);
    const streamed = await collectChunks(packChunks(json));

    expect([...streamed.chunks.keys()]).toEqual([...eager.chunks.keys()]);
    expect(streamed.manifest.chunks.map(c => c.name))
      .toEqual(eager.manifest.chunks.map(c => c.name));
    expect(streamed.manifest.bundleChecksum).toBe(eager.manifest.bundleChecksum);
    expect(streamed.manifest.totalSizeBytes).toBe(eager.manifest.totalSizeBytes);
  });

  it('accepts a Blob source and roundtrips identically', async () => {
    const json = makeRealisticBundle({ imageCount: 8, imageSize: 4000 });
    const blob = new Blob([json], { type: 'application/json' });

    const { manifest, chunks } = await collectChunks(packChunks(blob));
    // The Blob path must yield the exact same checksum as the string path.
    expect(manifest.bundleChecksum).toBe(await sha256String(json));
    // ...and report totalSizeBytes in the SAME unit as the string path
    // (json.length, UTF-16 code units) — NOT the Blob's UTF-8 byte size — so the
    // displayed cloud "存档大小" does not jump when upload() feeds a Blob.
    expect(manifest.totalSizeBytes).toBe(json.length);

    const restored = await unpack(manifest, chunks);
    expect(JSON.parse(restored)).toEqual(JSON.parse(json));
  });

  it('reports totalSizeBytes consistently for string vs Blob even with CJK content (no size-display jump)', async () => {
    // Regression (2026-06-23): feeding a Blob once measured totalSizeBytes as the
    // UTF-8 byte size, which for CJK is ~3x the UTF-16 code-unit count — making the
    // cloud "存档大小" jump (a real user report: ~120000KB → ~165800KB, +38%) on the
    // first post-streaming upload even though the stored chunks were byte-identical.
    const json = JSON.stringify({ note: '修真世界纪元'.repeat(2000), pad: 'asciiPADDING'.repeat(1000) });
    const blob = new Blob([json], { type: 'application/json' });
    // Sanity: this mixed CJK+ASCII content really does differ between the two measures.
    expect(blob.size).toBeGreaterThan(json.length);

    const fromString = await collectChunks(packChunks(json));
    const fromBlob = await collectChunks(packChunks(blob));

    expect(fromString.manifest.totalSizeBytes).toBe(json.length);
    expect(fromBlob.manifest.totalSizeBytes).toBe(json.length); // NOT blob.size (UTF-8)
    expect(fromBlob.manifest.totalSizeBytes).toBe(fromString.manifest.totalSizeBytes);
  });

  it('produces multiple image chunks for a large bundle and unpacks cleanly', async () => {
    // ~60k chars/image * 12 ≈ comfortably over the 20MB chunk target only with
    // big images; use enough to force at least 2 image chunks deterministically.
    const json = makeRealisticBundle({ imageCount: 6, imageSize: 4_000_000 });
    const { manifest, chunks } = await collectChunks(packChunks(json));

    const imgChunks = manifest.chunks.filter(c => c.name.startsWith('img-'));
    expect(imgChunks.length).toBeGreaterThanOrEqual(2);

    const restored = await unpack(manifest, chunks);
    expect(JSON.parse(restored)).toEqual(JSON.parse(json));
  });

  it('state-only bundle (no images) yields a single chunk', async () => {
    const json = makeRealisticBundle({ noImageAssets: true });
    const { manifest, chunks } = await collectChunks(packChunks(json));
    expect(chunks.size).toBe(1);
    expect(manifest.chunks).toHaveLength(1);
    expect(manifest.chunks[0].name).toBe('state');
  });

  it('splits a very large state into multiple state-N chunks and roundtrips', async () => {
    // Force a >8M-char state by stuffing big non-image fields into the bundle,
    // so the state JSON alone exceeds STATE_SLICE_CHARS (the real-world failure:
    // a 50MB state that gzip'd in one Blob and OOM'd). Keep `imageAssets` LAST —
    // unpack re-appends it at the end, so the original must match (null,2 fmt).
    const base = JSON.parse(makeRealisticBundle({ imageCount: 2 })) as Record<string, unknown>;
    const imgs = base.imageAssets;
    delete base.imageAssets;
    base.bigBlobA = '甲'.repeat(5_000_000);      // multi-byte CJK
    base.bigBlobB = 'B'.repeat(5_000_000);        // ascii
    base.bigBlobC = '😀'.repeat(2_500_000);       // surrogate pairs → boundary test
    base.imageAssets = imgs;
    const json = JSON.stringify(base, null, 2);

    const { manifest, chunks } = await collectChunks(packChunks(json));

    const stateParts = manifest.chunks.filter(c => /^state-\d+$/.test(c.name));
    expect(stateParts.length).toBeGreaterThanOrEqual(2);
    expect(manifest.chunks.some(c => c.name === 'state')).toBe(false);
    // images still chunked alongside the split state
    expect(manifest.chunks.some(c => c.name.startsWith('img-'))).toBe(true);

    const restored = await unpack(manifest, chunks);
    expect(JSON.parse(restored)).toEqual(base);
  });

  it('eager pack() also splits large state and unpacks identically', async () => {
    const base = JSON.parse(makeRealisticBundle({ noImageAssets: true })) as Record<string, unknown>;
    base.huge = '世界'.repeat(5_000_000); // ~10M chars of CJK
    const json = JSON.stringify(base, null, 2);

    const { manifest, chunks } = await pack(json);
    expect(manifest.chunks.filter(c => /^state-\d+$/.test(c.name)).length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(await unpack(manifest, chunks))).toEqual(base);
  });

  it('preserves imageAssets key position when keys follow it (worldBooks etc.)', async () => {
    // Mirror the REAL export key order from backup-service.exportAll: imageAssets
    // is NOT last — worldBooks + builtinPromptOverrides follow it. Before the
    // placeholder fix, unpack re-appended imageAssets at the end → key order
    // shifted → whole-bundle SHA-256 mismatch → unpack THREW → cloud save
    // undownloadable. unpack returning at all here proves both checksum layers
    // passed; `toBe(json)` proves byte-identical reassembly.
    const bundle = {
      version: 1,
      exportedAt: '2026-06-15T00:00:00Z',
      profiles: { p1: { name: 'A' } },
      saves: { 'p1/auto': { 角色: { 姓名: '甲' } } },
      vectors: {},
      imageAssets: [
        { id: 'i1', metadata: { id: 'i1', backend: 'novelai', createdAt: 1 }, base64: 'A'.repeat(800), mimeType: 'image/png' },
      ],
      worldBooks: { version: 1, entries: [{ key: 'w', value: '世界书' }] },
      builtinPromptOverrides: { version: 1, entries: [{ id: 'o1', text: '覆盖' }] },
    };
    const json = JSON.stringify(bundle, null, 2);

    const { manifest, chunks } = await pack(json);
    const restored = await unpack(manifest, chunks);
    expect(restored).toBe(json);
  });

  it('throws if a manifest mixes legacy state and split state-N (loud, not silent)', async () => {
    const json = makeRealisticBundle({ imageCount: 1 });
    const { manifest, chunks } = await pack(json); // single 'state'
    // Forge a corrupt manifest that also references a state-0 (duplicate state).
    const stateChunk = manifest.chunks.find(c => c.name === 'state')!;
    const corrupt = { ...manifest, chunks: [...manifest.chunks, { ...stateChunk, name: 'state-0', path: 'v2/state-0.gz' }] };
    const corruptChunks = new Map(chunks);
    corruptChunks.set('v2/state-0.gz', chunks.get(stateChunk.path)!);
    await expect(unpack(corrupt, corruptChunks)).rejects.toThrow(/不一致/);
  });
});

// ─── pack: chunking behavior ───

describe('pack — chunking behavior', () => {
  it('no imageAssets field → state-only', async () => {
    const json = makeRealisticBundle({ noImageAssets: true });
    const { manifest, chunks } = await pack(json);
    expect(manifest.chunks).toHaveLength(1);
    expect(manifest.chunks[0].name).toBe('state');
    expect(chunks.size).toBe(1);
  });

  it('empty imageAssets [] → state-only, array preserved', async () => {
    const json = makeRealisticBundle({ emptyImageAssets: true });
    const { manifest } = await pack(json);
    expect(manifest.chunks).toHaveLength(1);
    expect(manifest.chunks[0].name).toBe('state');
  });

  it('few small images → state + 1 img chunk', async () => {
    const json = makeRealisticBundle({ imageCount: 3, imageSize: 1000 });
    const { manifest } = await pack(json);
    expect(manifest.chunks).toHaveLength(2); // state + img-0
  });

  it('many images → splits into multiple img chunks', async () => {
    const json = makeRealisticBundle({ imageCount: 50, imageSize: 500_000 });
    const { manifest } = await pack(json);

    const imgChunks = manifest.chunks.filter(c => c.name.startsWith('img-'));
    expect(imgChunks.length).toBeGreaterThanOrEqual(2);

    for (let i = 0; i < imgChunks.length; i++) {
      expect(imgChunks[i].name).toBe(`img-${i}`);
      expect(imgChunks[i].path).toBe(`v2/img-${i}.gz`);
    }
  });

  it('single oversized image → 1 img chunk (no crash)', async () => {
    const json = makeRealisticBundle({ imageCount: 1, imageSize: 25_000_000 });
    const { manifest } = await pack(json);
    const imgChunks = manifest.chunks.filter(c => c.name.startsWith('img-'));
    expect(imgChunks).toHaveLength(1);
  });

  it('compression reduces size for typical data', async () => {
    const json = makeRealisticBundle({ imageCount: 10, imageSize: 10_000 });
    const { manifest } = await pack(json);

    const totalCompressed = manifest.chunks.reduce((s, c) => s + c.compressedSize, 0);
    const totalOriginal = manifest.chunks.reduce((s, c) => s + c.originalSize, 0);
    expect(totalCompressed).toBeLessThan(totalOriginal);
  });
});

// ─── unpack: roundtrip identity ───

describe('unpack — roundtrip identity', () => {
  it('full realistic bundle with all fields', async () => {
    const json = makeRealisticBundle({ imageCount: 5, multipleProfiles: true });
    const { manifest, chunks } = await pack(json);
    expect(await unpack(manifest, chunks)).toBe(json);
  });

  it('no imageAssets field (v1 legacy bundle)', async () => {
    const json = makeRealisticBundle({ noImageAssets: true });
    const { manifest, chunks } = await pack(json);
    expect(await unpack(manifest, chunks)).toBe(json);
  });

  it('empty imageAssets array', async () => {
    const json = makeRealisticBundle({ emptyImageAssets: true });
    const { manifest, chunks } = await pack(json);
    expect(await unpack(manifest, chunks)).toBe(json);
  });

  it('many images split across multiple chunks', async () => {
    const json = makeRealisticBundle({ imageCount: 50, imageSize: 500_000 });
    const { manifest, chunks } = await pack(json);
    expect(await unpack(manifest, chunks)).toBe(json);
  });

  it('profile-only bundle (bundleType: profile)', async () => {
    const json = makeRealisticBundle({ profileBundle: true, nullActiveProfile: true });
    const { manifest, chunks } = await pack(json);
    expect(await unpack(manifest, chunks)).toBe(json);
  });

  it('bundle without bundleType (v1 legacy)', async () => {
    const json = makeRealisticBundle({ noBundleType: true, noCustomPresets: true });
    const { manifest, chunks } = await pack(json);
    expect(await unpack(manifest, chunks)).toBe(json);
  });

  it('activeProfile = null', async () => {
    const json = makeRealisticBundle({ nullActiveProfile: true });
    const { manifest, chunks } = await pack(json);
    expect(await unpack(manifest, chunks)).toBe(json);
  });

  it('no customPresets (v1 legacy)', async () => {
    const json = makeRealisticBundle({ noCustomPresets: true });
    const { manifest, chunks } = await pack(json);
    expect(await unpack(manifest, chunks)).toBe(json);
  });

  it('multiple profiles with different packIds', async () => {
    const json = makeRealisticBundle({ multipleProfiles: true, imageCount: 8 });
    const { manifest, chunks } = await pack(json);
    expect(await unpack(manifest, chunks)).toBe(json);
  });

  it('images with mixed backends, origins, mimeTypes', async () => {
    // makeImageAsset cycles through all backends/origins/mimeTypes
    const json = makeRealisticBundle({ imageCount: 15 });
    const { manifest, chunks } = await pack(json);
    const result = await unpack(manifest, chunks);
    expect(result).toBe(json);

    const parsed = JSON.parse(result) as { imageAssets: Array<{ metadata: { backend: string; origin?: string }; mimeType: string }> };
    const backends = new Set(parsed.imageAssets.map(a => a.metadata.backend));
    const mimes = new Set(parsed.imageAssets.map(a => a.mimeType));
    expect(backends.size).toBeGreaterThanOrEqual(3);
    expect(mimes.size).toBeGreaterThanOrEqual(2);
  });

  it('SHA-256 hash matches after roundtrip', async () => {
    const json = makeRealisticBundle({ imageCount: 10, multipleProfiles: true });
    const originalHash = await sha256String(json);
    const { manifest, chunks } = await pack(json);
    const restored = await unpack(manifest, chunks);
    const restoredHash = await sha256String(restored);
    expect(restoredHash).toBe(originalHash);
    expect(manifest.bundleChecksum).toBe(originalHash);
  });
});

// ─── unpack: image ordering ───

describe('unpack — image ordering preservation', () => {
  it('preserves exact image order within single chunk', async () => {
    const json = makeRealisticBundle({ imageCount: 10, imageSize: 1000 });
    const { manifest, chunks } = await pack(json);
    const result = await unpack(manifest, chunks);

    const orig = JSON.parse(json) as { imageAssets: Array<{ id: string }> };
    const rest = JSON.parse(result) as { imageAssets: Array<{ id: string }> };

    expect(rest.imageAssets.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(rest.imageAssets[i].id).toBe(orig.imageAssets[i].id);
    }
  });

  it('preserves order across chunk boundaries', async () => {
    const json = makeRealisticBundle({ imageCount: 50, imageSize: 500_000 });
    const { manifest, chunks } = await pack(json);
    const imgChunkCount = manifest.chunks.filter(c => c.name.startsWith('img-')).length;
    expect(imgChunkCount).toBeGreaterThanOrEqual(2);

    const result = await unpack(manifest, chunks);
    const orig = JSON.parse(json) as { imageAssets: Array<{ id: string }> };
    const rest = JSON.parse(result) as { imageAssets: Array<{ id: string }> };

    expect(rest.imageAssets.length).toBe(50);
    for (let i = 0; i < 50; i++) {
      expect(rest.imageAssets[i].id).toBe(orig.imageAssets[i].id);
    }
  });
});

// ─── Layer 1: per-chunk checksum verification ───

describe('Layer 1: per-chunk checksum', () => {
  it('detects corrupted state chunk (bit flip)', async () => {
    const json = makeRealisticBundle();
    const { manifest, chunks } = await pack(json);

    const stateBlob = chunks.get('v2/state.gz')!;
    const bytes = new Uint8Array(await stateBlob.arrayBuffer());
    bytes[bytes.length - 1] ^= 0xff;
    chunks.set('v2/state.gz', new Blob([bytes]));

    await expect(unpack(manifest, chunks)).rejects.toThrow(ChecksumError);
    await expect(unpack(manifest, chunks)).rejects.toThrow(/state.*校验不通过/);
  });

  it('detects corrupted image chunk', async () => {
    const json = makeRealisticBundle({ imageCount: 5 });
    const { manifest, chunks } = await pack(json);

    const imgBlob = chunks.get('v2/img-0.gz')!;
    const bytes = new Uint8Array(await imgBlob.arrayBuffer());
    bytes[0] ^= 0xff;
    chunks.set('v2/img-0.gz', new Blob([bytes]));

    await expect(unpack(manifest, chunks)).rejects.toThrow(ChecksumError);
    await expect(unpack(manifest, chunks)).rejects.toThrow(/img-0.*校验不通过/);
  });

  it('detects missing state chunk', async () => {
    const json = makeRealisticBundle();
    const { manifest, chunks } = await pack(json);
    chunks.delete('v2/state.gz');

    await expect(unpack(manifest, chunks)).rejects.toThrow(ChecksumError);
    await expect(unpack(manifest, chunks)).rejects.toThrow(/state.*缺失/);
  });

  it('detects missing image chunk', async () => {
    const json = makeRealisticBundle({ imageCount: 5 });
    const { manifest, chunks } = await pack(json);

    const imgEntry = manifest.chunks.find(c => c.name.startsWith('img-'))!;
    chunks.delete(imgEntry.path);

    await expect(unpack(manifest, chunks)).rejects.toThrow(ChecksumError);
    await expect(unpack(manifest, chunks)).rejects.toThrow(/缺失/);
  });

  it('detects chunk replaced with completely different blob', async () => {
    const json = makeRealisticBundle({ imageCount: 3 });
    const { manifest, chunks } = await pack(json);

    chunks.set('v2/state.gz', new Blob(['not gzip data at all']));

    await expect(unpack(manifest, chunks)).rejects.toThrow(ChecksumError);
  });
});

// ─── Layer 2: bundle-level checksum verification ───

describe('Layer 2: bundle checksum', () => {
  it('detects tampered bundleChecksum in manifest', async () => {
    const json = makeRealisticBundle();
    const { manifest, chunks } = await pack(json);
    manifest.bundleChecksum = '0'.repeat(64);

    await expect(unpack(manifest, chunks)).rejects.toThrow(ChecksumError);
    await expect(unpack(manifest, chunks)).rejects.toThrow(/重组校验失败/);
  });

  it('detects swapped image chunk (Layer 1 bypassed)', async () => {
    const json1 = makeRealisticBundle({ imageCount: 3, imageSize: 2000 });
    const { manifest: m1, chunks: c1 } = await pack(json1);

    const json2 = makeRealisticBundle({ imageCount: 3, imageSize: 3000 });
    const { chunks: c2 } = await pack(json2);

    // Swap img-0 data AND update its checksum to bypass Layer 1
    const foreignBlob = c2.get('v2/img-0.gz')!;
    c1.set('v2/img-0.gz', foreignBlob);
    m1.chunks.find(c => c.name === 'img-0')!.checksum = await sha256Blob(foreignBlob);

    await expect(unpack(m1, c1)).rejects.toThrow(ChecksumError);
    await expect(unpack(m1, c1)).rejects.toThrow(/重组校验失败/);
  });

  it('resilient to shuffled manifest chunk order (sorts by name)', async () => {
    const json = makeRealisticBundle({ imageCount: 50, imageSize: 500_000 });
    const { manifest, chunks } = await pack(json);

    const imgChunks = manifest.chunks.filter(c => c.name.startsWith('img-'));
    if (imgChunks.length >= 2) {
      // Reverse the img entries in manifest — unpack sorts by name so this is fine
      const imgIndices = manifest.chunks
        .map((c, i) => c.name.startsWith('img-') ? i : -1)
        .filter(i => i >= 0);

      const reversed = [...imgChunks].reverse();
      for (let j = 0; j < imgIndices.length; j++) {
        manifest.chunks[imgIndices[j]] = reversed[j];
      }

      // Should still succeed thanks to sort-by-name in unpack
      const result = await unpack(manifest, chunks);
      expect(result).toBe(json);
    }
  });
});

// ─── Determinism ───

describe('determinism', () => {
  it('same input produces same bundleChecksum', async () => {
    const json = makeRealisticBundle({ imageCount: 5 });
    const r1 = await pack(json);
    const r2 = await pack(json);
    expect(r1.manifest.bundleChecksum).toBe(r2.manifest.bundleChecksum);
  });

  it('same input produces same per-chunk checksums', async () => {
    const json = makeRealisticBundle({ imageCount: 5 });
    const r1 = await pack(json);
    const r2 = await pack(json);

    for (let i = 0; i < r1.manifest.chunks.length; i++) {
      expect(r1.manifest.chunks[i].checksum).toBe(r2.manifest.chunks[i].checksum);
      expect(r1.manifest.chunks[i].compressedSize).toBe(r2.manifest.chunks[i].compressedSize);
    }
  });
});

// ─── Edge cases ───

describe('edge cases', () => {
  it('engineSettings with null values survive roundtrip', async () => {
    const json = makeRealisticBundle();
    const { manifest, chunks } = await pack(json);
    const result = await unpack(manifest, chunks);

    const parsed = JSON.parse(result) as { engineSettings: Record<string, string | null> };
    expect(parsed.engineSettings.aga_github_sync_token).toBeNull();
    expect(parsed.engineSettings.aga_theme).toBe('dark');
  });

  it('deeply nested state trees survive roundtrip', async () => {
    const json = makeRealisticBundle({ multipleProfiles: true });
    const { manifest, chunks } = await pack(json);
    const result = await unpack(manifest, chunks);

    const parsed = JSON.parse(result) as {
      saves: Record<string, { 角色?: { 属性?: Record<string, number> } }>;
    };
    const save = parsed.saves['p_abc123/auto'];
    expect(save.角色?.属性?.体力).toBe(100);
    expect(save.角色?.属性?.悟性).toBe(70);
  });

  it('prompts with NSFW content survive roundtrip', async () => {
    const json = makeRealisticBundle();
    const { manifest, chunks } = await pack(json);
    const result = await unpack(manifest, chunks);

    const parsed = JSON.parse(result) as {
      prompts: { entries: Array<{ key: string; value: string }> };
    };
    const bodyPolish = parsed.prompts.entries.find(e => e.key.includes('body-polish'));
    expect(bodyPolish?.value).toContain('肉棒');
  });

  it('vector embedding arrays survive roundtrip', async () => {
    const json = makeRealisticBundle();
    const { manifest, chunks } = await pack(json);
    const result = await unpack(manifest, chunks);

    const parsed = JSON.parse(result) as {
      vectors: Record<string, { nodes: Array<{ embedding: number[] }> }>;
    };
    const nodes = parsed.vectors['p_abc123/auto']?.nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes[0].embedding).toHaveLength(384);
  });

  it('customPresets with multiple packs survive roundtrip', async () => {
    const json = makeRealisticBundle({ multipleProfiles: true });
    const { manifest, chunks } = await pack(json);
    const result = await unpack(manifest, chunks);

    const parsed = JSON.parse(result) as {
      customPresets: Record<string, Record<string, unknown[]>>;
    };
    expect(Object.keys(parsed.customPresets)).toContain('tianming');
    expect(Object.keys(parsed.customPresets)).toContain('jianghu');
    expect(parsed.customPresets.tianming.worlds).toHaveLength(2);
  });

  it('image metadata with optional origin field preserved', async () => {
    // makeImageAsset cycles origins: generated, reference, upload, undefined
    const json = makeRealisticBundle({ imageCount: 8 });
    const { manifest, chunks } = await pack(json);
    const result = await unpack(manifest, chunks);

    const parsed = JSON.parse(result) as {
      imageAssets: Array<{ metadata: { origin?: string } }>;
    };
    const origins = parsed.imageAssets.map(a => a.metadata.origin);
    expect(origins).toContain('generated');
    expect(origins).toContain('reference');
    expect(origins).toContain('upload');
    expect(origins).toContain(undefined);
  });

  it('single image (1 asset) roundtrips correctly', async () => {
    const json = makeRealisticBundle({ imageCount: 1 });
    const { manifest, chunks } = await pack(json);
    expect(await unpack(manifest, chunks)).toBe(json);
  });
});

// ─── Story 4: Engram batch-sync source roundtrip ───

describe('Engram batch-sync source roundtrip (Story 4)', () => {
  function makeEngramEdge(src: string, tgt: string, fact: string, source: string, core: boolean) {
    return {
      id: `${src}|${tgt}|${fact.slice(0, 40)}`,
      sourceEntity: src,
      targetEntity: tgt,
      fact,
      episodes: [],
      is_embedded: false,
      createdAtRound: 1,
      lastSeenRound: 1,
      core,
      source,
    };
  }

  function makeBundleWithEngramEdges(edges: unknown[]): string {
    const engramMemory = {
      events: [],
      entities: [
        { name: '张三', type: 'npc', summary: '测试NPC', attributes: {}, firstSeen: 0, lastSeen: 0, mentionCount: 1, is_embedded: false },
        { name: '李四', type: 'npc', summary: '另一个NPC', attributes: {}, firstSeen: 0, lastSeen: 0, mentionCount: 1, is_embedded: false },
      ],
      relations: [],
      v2Edges: edges,
      meta: { lastUpdated: 1716800000000, eventCount: 0, embeddedEventCount: 0, embeddedEntityCount: 0, schemaVersion: 5 },
    };
    return JSON.stringify({
      version: 1,
      exportedAt: '2026-05-27T00:00:00.000Z',
      engineVersion: '0.1.0',
      bundleType: 'full',
      activeProfile: { profileId: 'p_test', slotId: 'auto' },
      profiles: { p_test: { name: '测试', packId: 'tianming', createdAt: '2026-05-27T00:00:00Z', slotIds: ['auto'] } },
      saves: { 'p_test/auto': { 系统: { 扩展: { engramMemory } } } },
      vectors: {},
      configs: {},
      prompts: {},
      engineSettings: {},
    }, null, 2);
  }

  it('exports EngramEdge with source=batch-sync and core=false', async () => {
    const edge = makeEngramEdge('张三', '李四', '张三和李四是同门师兄弟在天剑门共同修行多年', 'batch-sync', false);
    const json = makeBundleWithEngramEdges([edge]);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const saves = parsed.saves as Record<string, Record<string, unknown>>;
    const engram = ((saves['p_test/auto']['系统'] as Record<string, unknown>)['扩展'] as Record<string, unknown>).engramMemory as { v2Edges: Array<{ source: string; core: boolean }> };
    expect(engram.v2Edges[0].source).toBe('batch-sync');
    expect(engram.v2Edges[0].core).toBe(false);
  });

  it('imports BackupBundle preserving batch-sync source after pack/unpack', async () => {
    const edge = makeEngramEdge('张三', '李四', '张三和李四是同门师兄弟在天剑门共同修行多年', 'batch-sync', false);
    const json = makeBundleWithEngramEdges([edge]);
    const { manifest, chunks } = await pack(json);
    const restored = await unpack(manifest, chunks);
    const parsed = JSON.parse(restored) as Record<string, unknown>;
    const saves = parsed.saves as Record<string, Record<string, unknown>>;
    const engram = ((saves['p_test/auto']['系统'] as Record<string, unknown>)['扩展'] as Record<string, unknown>).engramMemory as { v2Edges: Array<{ source: string; core: boolean }> };
    expect(engram.v2Edges[0].source).toBe('batch-sync');
    expect(engram.v2Edges[0].core).toBe(false);
  });

  it('ChunkedBundlePacker pack/unpack preserves source field exactly', async () => {
    const edge = makeEngramEdge('张三', '李四', '张三和李四是同门师兄弟在天剑门共同修行多年', 'batch-sync', false);
    const json = makeBundleWithEngramEdges([edge]);
    const { manifest, chunks } = await pack(json);
    expect(await unpack(manifest, chunks)).toBe(json);
  });

  it('export→import→re-export produces identical SHA-256', async () => {
    const edge = makeEngramEdge('张三', '李四', '张三和李四是同门师兄弟在天剑门共同修行多年', 'batch-sync', false);
    const json = makeBundleWithEngramEdges([edge]);
    const hash1 = await sha256String(json);
    const { manifest, chunks } = await pack(json);
    const restored = await unpack(manifest, chunks);
    const hash2 = await sha256String(restored);
    expect(hash2).toBe(hash1);
  });

  it('mixed source edges (opening + user + batch-sync) all preserved', async () => {
    const edges = [
      makeEngramEdge('张三', '玩家', '张三在开局时与玩家相识建立了初步友好关系', 'opening', true),
      makeEngramEdge('李四', '玩家', '李四是玩家手动添加的重要盟友两人志同道合', 'user', false),
      makeEngramEdge('张三', '李四', '张三和李四是同门师兄弟在天剑门共同修行多年', 'batch-sync', false),
    ];
    const json = makeBundleWithEngramEdges(edges);
    const { manifest, chunks } = await pack(json);
    const restored = await unpack(manifest, chunks);
    const parsed = JSON.parse(restored) as Record<string, unknown>;
    const saves = parsed.saves as Record<string, Record<string, unknown>>;
    const engram = ((saves['p_test/auto']['系统'] as Record<string, unknown>)['扩展'] as Record<string, unknown>).engramMemory as { v2Edges: Array<{ source: string; core: boolean }> };
    expect(engram.v2Edges).toHaveLength(3);
    expect(engram.v2Edges[0].source).toBe('opening');
    expect(engram.v2Edges[0].core).toBe(true);
    expect(engram.v2Edges[1].source).toBe('user');
    expect(engram.v2Edges[2].source).toBe('batch-sync');
    expect(engram.v2Edges[2].core).toBe(false);
  });
});
