/**
 * Canonical seedable save factory (extracted from game-card-epic.spec.ts).
 *
 * ★ This is the ONE file that holds 天命 (Tianming) pack-specific Chinese field
 * names and named constants. Reusable helpers must stay pack-agnostic; the
 * pack-adjacent literals live here (same precedent as snapshot-sanitizer).
 *
 * The tree is shaped so the game-card export coverage gate (D18) passes: every
 * NPC in 社交.关系 and every location in 世界.地点信息 has a matching
 * 系统.扩展.engramMemory.entities entry BY NAME. Image generation is gated off
 * (系统.扩展.image.enabled = false) so no image path can ever reach the network.
 */

import type { GameStateTree } from '@/engine/types/state';

export const PROFILE_ID = 'profile_e2e';
export const SLOT_ID = 'auto';
export const LOCATION_NAME = '青云城';
export const NPC_NAME = '林婉儿';
export const PROTAGONIST = '叶尘';
/** Optional inventory revision fixture; absent in legacy/default seeds. */
export const VECTOR_NOTEBOOK_ITEM = { 名称: '随身日记', 描述: '记录日常', 数量: 1, 能力版本: 1 };

// NOTE: GameStateTree is `Record<string, unknown>` by design (the tree's shape is
// defined by the Game Pack schema at runtime, not statically). Binding the seed to it
// is semantic/future-proofing only — it does NOT make a state-schema drift a tsc error
// (no static contract exists to drift against). Treat the export D18 coverage gate +
// the persistence unit tests as the real schema guard, not typecheck:e2e.
type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges plain objects; arrays and primitives are REPLACED wholesale.
 * (Overriding 叙事历史 / 关系 / edges means "use mine", not "concat".)
 */
export function deepMerge<T extends JsonObject>(base: T, override?: JsonObject): T {
  if (!override) return base;
  const out: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

/** A minimal but UI-renderable + export-valid state tree. */
function baseSeedTree(): GameStateTree {
  return {
    元数据: {
      游戏包名称: '天命',
      回合序号: 3,
      叙事历史: [
        { role: 'user', content: '我环顾四周。' },
        { role: 'assistant', content: '青云城的喧嚣扑面而来……' },
      ],
      推理历史: [],
      剧情规划: '',
      女主规划: { stageProgression: [], heroineEntries: [], interactionEvents: [], scenePlans: [] },
      当前行动选项: [],
    },
    角色: {
      基础信息: { 姓名: PROTAGONIST, 当前位置: LOCATION_NAME, 年龄: 20, 性别: '男', 特质: { 名称: '坚毅', 描述: '' } },
      身份: { 出身: { 名称: '寒门', 描述: '' }, 天赋档次: '甲', 天赋: [{ 名称: '剑心', 描述: '' }], 种族: '人族', 先天六维: { 体质: 6, 直觉: 5, 悟性: 7, 气运: 5, 魅力: 5, 心性: 6 } },
      属性: { 体质: 8, 直觉: 6, 悟性: 9, 气运: 5, 魅力: 6, 心性: 7 },
      可变属性: { 地位: { 名称: '散修', 描述: '' }, 声望: 120, 体力: { 当前: 80, 上限: 100 }, 精力: { 当前: 70, 上限: 90 } },
      效果: [],
      背包: { 金钱: { 现金: 0, 铜: 50, 银: 2, 金: 0 }, 物品: {} },
      身体: {},
      图片档案: { 生图历史: [], 已选头像图片ID: '', 已选立绘图片ID: '', 最近生图结果: '' },
    },
    世界: {
      描述: '一个剑修横行的大陆。',
      天气: '晴',
      节日: { 名称: '平日', 描述: '', 效果: '' },
      环境: [],
      时间: { 年: 1, 月: 3, 日: 15, 小时: 10, 分钟: 30 },
      地点信息: [
        { 名称: LOCATION_NAME, 描述: '繁华的修真城市。', 连接: [], NPC: [NPC_NAME], 坐标: { x: 0, y: 0 }, 类型: '城市', 上级: '' },
      ],
      状态: { 心跳: { 配置: { enabled: false, period: 5 }, 上次心跳回合序号: 0, 历史: [], 上次执行时间: '' } },
    },
    社交: {
      关系: [
        { 名称: NPC_NAME, 类型: '友人', 好感度: 40, 位置: LOCATION_NAME, 描述: '青云宗的内门弟子。', 性别: '女', 年龄: 18, 记忆: [], 私聊历史: [] },
      ],
      事件: { 事件记录: [] },
    },
    记忆: { 短期: [], 中期: [], 长期: [], 隐式中期: [] },
    系统: {
      扩展: {
          // Persisted component data must survive save/export even with the feature off.
          // Cards, growth and last.progress are produced by the real runtime in
          // plot-vector-board.spec.ts, not invented here.
        plotVector: { version: 2, cards: [], tasks: [], growth: {}, session: { round: 1, carriedAccounts: {}, committed: [] } },
        engramMemory: {
          events: [],
          entities: [
            { name: NPC_NAME, type: 'npc', summary: '青云宗内门弟子。', attributes: {}, firstSeen: 1, lastSeen: 3, mentionCount: 2, is_embedded: false, source: 'opening' },
            { name: LOCATION_NAME, type: 'location', summary: '繁华修真城市。', attributes: {}, firstSeen: 1, lastSeen: 3, mentionCount: 2, is_embedded: false, source: 'opening' },
          ],
          relations: [],
          v2Edges: [
            { id: 'seed-edge-1', sourceEntity: PROTAGONIST, targetEntity: NPC_NAME, fact: `${PROTAGONIST}在${LOCATION_NAME}结识了${NPC_NAME}。`, episodes: [], is_embedded: false, createdAtRound: 1, lastSeenRound: 3, core: true, source: 'opening' },
          ],
          meta: { lastUpdated: 0, eventCount: 0, embeddedEventCount: 0, embeddedEntityCount: 0, schemaVersion: 5, v2PendingReview: null },
        },
        语义记忆: { triples: [], meta: { lastUpdated: 0, tripleCount: 0 } },
        image: { enabled: false, config: {}, sceneArchive: { 生图历史: [], 当前壁纸图片ID: '' }, tasks: [], persistentWallpaper: '' },
      },
      nsfwMode: false,
      nsfwGenderFilter: 'female',
      设置: { prompt: { perspective: '第二人称', wordCountRequirement: 650, storyStyle: 'general' }, cot: { enabled: false }, social: { presenceEnabled: false }, bodyPolish: false },
    },
  };
}

/**
 * Builds the seed tree, deep-merging optional overrides so a spec can vary
 * 回合序号 / 叙事历史 / 关系 / edges without copy-pasting the whole tree.
 */
export function makeSeedTree(overrides?: JsonObject): GameStateTree {
  return deepMerge(baseSeedTree(), overrides);
}
