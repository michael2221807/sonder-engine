/**
 * card-stripper 单元测试 — Story 5 (P9)
 *
 * 纯函数，无 mock：用真实 buildDefaultCardStripPaths() 配置（从 DEFAULT_ENGINE_PATHS 派生）
 * 喂入一棵覆盖所有 strip 点的 fixture 树，逐项断言：游玩历史/密钥/engram/系统设置清除、
 * plot 进度重置、可变属性重置、NSFW 两态、blank 模式剥 `角色`、且输入零变异（SC-8）。
 */
import { describe, it, expect } from 'vitest';
import { stripStateTreeForCard, getByPath, collectStringsAtPath } from './card-stripper';
import { buildDefaultCardStripPaths } from './card-export-paths';
import type { ExportFlags } from './game-card-bundle.types';

const PATHS = buildDefaultCardStripPaths();

/** All-off baseline flags (nothing optional kept). */
function flags(overrides: Partial<ExportFlags> = {}): ExportFlags {
  return {
    containsNsfw: false,
    includedGenerationHistory: false,
    includedReferenceGallery: false,
    includedSettings: false,
    includedApiTemplate: false,
    includedEngineConfig: false,
    includedWorldBooks: false,
    includedBuiltinOverrides: false,
    includedPromptSettings: false,
    includedHeroinePlan: false,
    includedPlotDirection: false,
    ...overrides,
  };
}

/** A fixture save tree touching every strip/keep/reset path the stripper handles. */
function makeTree(): Record<string, unknown> {
  return {
    元数据: {
      回合序号: 50,
      叙事历史: [{ round: 1, text: 'narration' }],
      推理历史: [{ round: 1 }],
      剧情规划: { plan: 'inner-plan' },
      上次对话前快照: { snap: true },
      当前行动选项: ['行动A'],
      剧情导向: {
        activeArcIndex: 2,
        pendingConfirmation: { pending: true },
        focusArcId: 'arc-a',
        pendingConfirmations: [{ arcId: 'arc-a', nodeId: 'n1', evidence: 'e', round: 5 }],
        arcs: [
          {
            id: 'arc-a',
            status: 'active',
            nodes: [
              {
                id: 'n1',
                status: 'completed', activatedAtRound: 3, completedAtRound: 5, consecutiveReachedCount: 4,
                activatedAtTime: { year: 1, month: 3, day: 1 }, completedAtTime: { year: 1, month: 3, day: 4 },
                completionEvidence: 'the AI said so',
                premise: 'authored premise', stakes: 'authored stakes',
              },
            ],
            gauges: [
              { initialValue: 10, current: 80, boundaryFiredAtRound: 5, lastAutoDecrementRound: 6 },
            ],
          },
          {
            id: 'arc-b',
            status: 'scheduled',
            activation: { mode: 'auto', triggers: [{ type: 'node_completed', arcId: 'arc-a', nodeId: 'n1' }] },
            nodes: [{ id: 'm1', status: 'pending', consecutiveReachedCount: 0 }],
            gauges: [],
          },
        ],
      },
      女主规划: { plan: 'heroine-secret' },
    },
    记忆: { 短期: ['s'], 中期: ['m'], 长期: ['l'], 隐式中期: ['im'] },
    角色: {
      基础信息: { 姓名: '主角', 年龄: 20 },
      属性: { 体质: 15 },
      可变属性: {
        声望: 999,
        体力: { 当前: 10, 上限: 100 },
        精力: { 当前: 5, 上限: 80 },
      },
      效果: [{ name: '中毒' }],
      身体: { 私密描写: '肉棒插入小穴的身体细节文本' },
      图片档案: {
        已选头像图片ID: 'sel-avatar',
        生图历史: [{ id: 'player-hist' }],
        香闺秘档: { 部位A: { assetId: 'player-nsfw' } },
      },
    },
    社交: {
      事件: { 事件记录: [{ e: 'world-event' }] },
      关系: [
        {
          名称: 'NPC1',
          记忆: ['npc-mem'],
          私聊历史: ['npc-chat'],
          私密信息: '私密泄露文本XYZ',
          图片档案: {
            已选立绘图片ID: 'npc-portrait',
            生图历史: [{ id: 'npc-hist' }],
            香闺秘档: { 部位B: { assetId: 'npc-nsfw' } },
          },
        },
      ],
    },
    世界: { 状态: { 心跳: { 历史: [1, 2], 上次心跳回合序号: 5, 上次执行时间: 'ts' } } },
    系统: {
      设置: { prompt: { 游戏设定: 'world-setup' }, theme: 'dark' },
      actionOptions: ['x'],
      扩展: {
        engramMemory: { entities: [{ id: 'e1' }], v2Edges: [{ id: 'edge1' }] },
        image: {
          config: { transformer: { apiKey: 'sk-IMAGE-LEAK', endpoint: 'http://leak' } },
          tasks: [{ prompt: 'task' }],
          sceneArchive: { 当前壁纸图片ID: 'wallpaper', 生图历史: [{ id: 'scene-hist' }] },
          referenceLibrary: [{ assetId: 'ref-1' }],
        },
      },
    },
  };
}

describe('stripStateTreeForCard — always-strip subtrees', () => {
  it('deletes all gameplay-history paths', () => {
    const out = stripStateTreeForCard(makeTree(), PATHS, flags(), 'fixed');
    expect(getByPath(out, '元数据.回合序号')).toBeUndefined(); // turn counter is play progress (schema default 0 on import)
    expect(getByPath(out, '元数据.叙事历史')).toBeUndefined();
    expect(getByPath(out, '元数据.推理历史')).toBeUndefined();
    expect(getByPath(out, '元数据.剧情规划')).toBeUndefined();
    expect(getByPath(out, '元数据.上次对话前快照')).toBeUndefined();
    expect(getByPath(out, '元数据.当前行动选项')).toBeUndefined();
    expect(getByPath(out, '记忆.短期')).toBeUndefined();
    expect(getByPath(out, '记忆.中期')).toBeUndefined();
    expect(getByPath(out, '记忆.长期')).toBeUndefined();
    expect(getByPath(out, '记忆.隐式中期')).toBeUndefined();
    expect(getByPath(out, '角色.效果')).toBeUndefined();
    expect(getByPath(out, '社交.事件.事件记录')).toBeUndefined(); // OD6: 世界事件全剥离
    expect(getByPath(out, '社交.关系.0.记忆')).toBeUndefined();
    expect(getByPath(out, '社交.关系.0.私聊历史')).toBeUndefined();
    expect(getByPath(out, '世界.状态.心跳.历史')).toBeUndefined();
    expect(getByPath(out, '世界.状态.心跳.上次心跳回合序号')).toBeUndefined();
    expect(getByPath(out, '世界.状态.心跳.上次执行时间')).toBeUndefined();
    expect(getByPath(out, '系统.actionOptions')).toBeUndefined();
    expect(getByPath(out, '系统.扩展.image.tasks')).toBeUndefined();
  });

  it('deletes the image transformer secret subtree', () => {
    const out = stripStateTreeForCard(makeTree(), PATHS, flags(), 'fixed');
    expect(getByPath(out, '系统.扩展.image.config')).toBeUndefined();
  });

  it('clears the engram graph from the state tree (carried separately by the service)', () => {
    const out = stripStateTreeForCard(makeTree(), PATHS, flags(), 'fixed');
    expect(getByPath(out, '系统.扩展.engramMemory')).toBeUndefined();
  });
});

describe('stripStateTreeForCard — system settings (游戏设定)', () => {
  it('strips 系统.设置 wholesale when promptSettings not kept', () => {
    const out = stripStateTreeForCard(makeTree(), PATHS, flags(), 'fixed');
    expect(getByPath(out, '系统.设置')).toBeUndefined();
  });

  it('re-attaches ONLY 系统.设置.prompt (drops sibling UI settings) when kept', () => {
    const out = stripStateTreeForCard(makeTree(), PATHS, flags({ includedPromptSettings: true }), 'fixed');
    expect(getByPath(out, '系统.设置.prompt.游戏设定')).toBe('world-setup');
    expect(getByPath(out, '系统.设置.theme')).toBeUndefined();
  });
});

describe('stripStateTreeForCard — heroine plan + plot direction', () => {
  it('strips heroine plan unless kept', () => {
    expect(getByPath(stripStateTreeForCard(makeTree(), PATHS, flags(), 'fixed'), '元数据.女主规划')).toBeUndefined();
    expect(getByPath(stripStateTreeForCard(makeTree(), PATHS, flags({ includedHeroinePlan: true }), 'fixed'), '元数据.女主规划'))
      .toEqual({ plan: 'heroine-secret' });
  });

  it('strips plot direction unless kept', () => {
    expect(getByPath(stripStateTreeForCard(makeTree(), PATHS, flags(), 'fixed'), '元数据.剧情导向')).toBeUndefined();
  });

  it('resets plot progress to baseline when kept', () => {
    const out = stripStateTreeForCard(makeTree(), PATHS, flags({ includedPlotDirection: true }), 'fixed');
    expect(getByPath(out, '元数据.剧情导向.activeArcIndex')).toBeNull();
    expect(getByPath(out, '元数据.剧情导向.pendingConfirmation')).toBeNull();
    expect(getByPath(out, '元数据.剧情导向.arcs.0.status')).toBe('draft');
    const node = getByPath(out, '元数据.剧情导向.arcs.0.nodes.0') as Record<string, unknown>;
    expect(node.status).toBe('pending');
    expect(node.activatedAtRound).toBeUndefined();
    expect(node.completedAtRound).toBeUndefined();
    expect(node.consecutiveReachedCount).toBe(0);
    const gauge = getByPath(out, '元数据.剧情导向.arcs.0.gauges.0') as Record<string, unknown>;
    expect(gauge.current).toBe(10); // reset to initialValue
    expect(gauge.boundaryFiredAtRound).toBeUndefined();
    expect(gauge.lastAutoDecrementRound).toBeUndefined();
  });

  it('Plot Threads: resets multi-thread runtime fields but keeps authored triggers, ids and premise/stakes', () => {
    const out = stripStateTreeForCard(makeTree(), PATHS, flags({ includedPlotDirection: true }), 'fixed');
    expect(getByPath(out, '元数据.剧情导向.focusArcId')).toBeNull();
    expect(getByPath(out, '元数据.剧情导向.pendingConfirmations')).toEqual([]);

    const node = getByPath(out, '元数据.剧情导向.arcs.0.nodes.0') as Record<string, unknown>;
    expect(node.id).toBe('n1'); // ids are never regenerated — triggers must still resolve after import
    expect(node.activatedAtTime).toBeUndefined();
    expect(node.completedAtTime).toBeUndefined();
    expect(node.completionEvidence).toBeUndefined();
    expect(node.premise).toBe('authored premise');
    expect(node.stakes).toBe('authored stakes');

    const scheduled = getByPath(out, '元数据.剧情导向.arcs.1') as Record<string, unknown>;
    expect(scheduled.id).toBe('arc-b');
    expect(scheduled.status).toBe('draft');
    expect(scheduled.activation).toEqual({
      mode: 'auto',
      triggers: [{ type: 'node_completed', arcId: 'arc-a', nodeId: 'n1' }],
    });
  });
});

describe('stripStateTreeForCard — NSFW two-state', () => {
  it('strips body / private info / secret-part images when NSFW excluded', () => {
    const out = stripStateTreeForCard(makeTree(), PATHS, flags({ containsNsfw: false }), 'fixed');
    expect(getByPath(out, '角色.身体')).toBeUndefined();
    expect(getByPath(out, '社交.关系.0.私密信息')).toBeUndefined();
    expect(getByPath(out, '角色.图片档案.香闺秘档')).toBeUndefined();
    expect(getByPath(out, '社交.关系.0.图片档案.香闺秘档')).toBeUndefined();
  });

  it('keeps NSFW subtrees when adult content is included', () => {
    const out = stripStateTreeForCard(makeTree(), PATHS, flags({ containsNsfw: true }), 'fixed');
    expect(getByPath(out, '角色.身体')).toBeDefined();
    expect(getByPath(out, '社交.关系.0.私密信息')).toBe('私密泄露文本XYZ');
    expect(getByPath(out, '角色.图片档案.香闺秘档')).toBeDefined();
  });
});

describe('stripStateTreeForCard — image history / reference gallery', () => {
  it('strips generation history unless opted in (selected images survive)', () => {
    const off = stripStateTreeForCard(makeTree(), PATHS, flags(), 'fixed');
    expect(getByPath(off, '角色.图片档案.生图历史')).toBeUndefined();
    expect(getByPath(off, '社交.关系.0.图片档案.生图历史')).toBeUndefined();
    expect(getByPath(off, '系统.扩展.image.sceneArchive.生图历史')).toBeUndefined();
    expect(getByPath(off, '角色.图片档案.已选头像图片ID')).toBe('sel-avatar'); // selection kept
    expect(getByPath(off, '系统.扩展.image.sceneArchive.当前壁纸图片ID')).toBe('wallpaper');

    const on = stripStateTreeForCard(makeTree(), PATHS, flags({ includedGenerationHistory: true }), 'fixed');
    expect(getByPath(on, '角色.图片档案.生图历史')).toBeDefined();
  });

  it('strips reference library unless opted in', () => {
    expect(getByPath(stripStateTreeForCard(makeTree(), PATHS, flags(), 'fixed'), '系统.扩展.image.referenceLibrary')).toBeUndefined();
    expect(getByPath(stripStateTreeForCard(makeTree(), PATHS, flags({ includedReferenceGallery: true }), 'fixed'), '系统.扩展.image.referenceLibrary')).toBeDefined();
  });
});

describe('stripStateTreeForCard — variable attribute reset', () => {
  it('resets reputation→0 and each vital current→cap', () => {
    const out = stripStateTreeForCard(makeTree(), PATHS, flags(), 'fixed');
    expect(getByPath(out, '角色.可变属性.声望')).toBe(0);
    expect(getByPath(out, '角色.可变属性.体力.当前')).toBe(100); // == 上限
    expect(getByPath(out, '角色.可变属性.精力.当前')).toBe(80);
  });
});

describe('stripStateTreeForCard — protagonist mode', () => {
  it('blank mode drops the 角色 subtree entirely', () => {
    const out = stripStateTreeForCard(makeTree(), PATHS, flags(), 'blank');
    expect(getByPath(out, '角色')).toBeUndefined();
  });

  it('fixed/template mode retains the (trimmed) 角色 subtree', () => {
    const out = stripStateTreeForCard(makeTree(), PATHS, flags(), 'fixed');
    expect(getByPath(out, '角色.基础信息.姓名')).toBe('主角');
    expect(getByPath(out, '角色.属性.体质')).toBe(15); // CONTRACT-OD4: derived attrs retained for fixed
  });
});

describe('stripStateTreeForCard — purity', () => {
  it('never mutates the input tree (SC-8)', () => {
    const tree = makeTree();
    const snapshot = structuredClone(tree);
    stripStateTreeForCard(tree, PATHS, flags({ containsNsfw: true, includedPlotDirection: true }), 'blank');
    expect(tree).toEqual(snapshot);
  });
});

describe('collectStringsAtPath', () => {
  it('gathers every string leaf under a wildcard path', () => {
    const tree = makeTree();
    const found = collectStringsAtPath(tree, '社交.关系.*.私密信息'.split('.'));
    expect(found).toContain('私密泄露文本XYZ');
  });

  it('recurses into nested objects/arrays at the target', () => {
    const tree = makeTree();
    const found = collectStringsAtPath(tree, '角色.身体'.split('.'));
    expect(found).toContain('肉棒插入小穴的身体细节文本');
  });
});
