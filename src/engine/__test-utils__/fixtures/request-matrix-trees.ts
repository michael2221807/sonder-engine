/**
 * State trees and world books for the prompt-assembly request matrix
 * (pipeline/stages/context-assembly-request-matrix.test.ts).
 *
 * R (rich): a save mid-story. The shape follows e2e/fixtures/seed-tree.ts (copied, not imported: the engine tests
 * must not reach into e2e/), filled out so that every injected block the round assembles is non-empty — eight
 * narrative entries (system lines inside), four memory layers, a reasoning history and a story plan, one NPC in the
 * scene and one away, bookmarked rounds waiting to be injected, a narrative contract, a character vector, a plot
 * thread with a gauge (and a stray copy of that gauge in the save), an archive world book and a slot book of captured
 * settings, a custom action request, weather, a festival and an environment tag.
 *
 * F (fresh): the first round — no history, no memory, no NPC.
 *
 * ★ Like seed-tree.ts, this is a place where Tianming's Chinese field names live; the engine code under test never
 * names them. Values are fixed literals (no clocks, no random ids) so a request built from them is reproducible.
 */
import type { WorldBook } from '../../prompt/world-book';
import { CAPTURED_SETTINGS_BOOK_ID } from '../../prompt/world-book';

type JsonObject = Record<string, unknown>;

const MATRIX_PROTAGONIST = '叶尘';
const MATRIX_LOCATION = '青云城·茶馆';
const MATRIX_NPC_PRESENT = '林婉儿';
const MATRIX_NPC_AWAY = '苏小棠';
const MATRIX_NPC_NEARBY = '陆沉';

/** Plot thread with one active node, one completed node and a gauge named like the stray copy in `系统`. */
function plotDirection(): JsonObject {
  return {
    arcs: [{
      id: 'arc_teahouse',
      title: '茶馆里的旧案',
      synopsis: '林婉儿带来一桩与师门有关的旧案。',
      status: 'active',
      lane: 0,
      gauges: [{
        id: 'g_trust',
        name: '信任度',
        description: '林婉儿对叶尘的信任',
        min: 0,
        max: 100,
        current: 40,
        initialValue: 30,
        unit: '点',
        showInMainPanel: true,
        aiUpdatable: true,
        maxDeltaPerRound: 10,
      }],
      nodes: [
        {
          id: 'n_meet',
          arcId: 'arc_teahouse',
          title: '茶馆初遇',
          narrativeGoal: '建立林婉儿的第一印象',
          directive: '让二人在茶馆交谈。',
          completionHint: '二人交换了姓名',
          completionConditions: [],
          completionMode: 'hint_only',
          activationConditions: [],
          importance: 'skippable',
          opportunityTiers: [],
          status: 'completed',
          activatedAtRound: 1,
          completedAtRound: 3,
          completionEvidence: '二人在茶馆交换了姓名',
          consecutiveReachedCount: 0,
        },
        {
          id: 'n_case',
          arcId: 'arc_teahouse',
          title: '旧案的线索',
          narrativeGoal: '让叶尘得知旧案与师门有关',
          directive: '林婉儿犹豫地透露一条线索，叶尘需要追问。',
          completionHint: '林婉儿说出了师门的名字',
          completionConditions: [],
          completionMode: 'hint_only',
          activationConditions: [],
          importance: 'critical',
          opportunityTiers: [{ tier: 1, afterRounds: 3, prompt: '可以让窗外的雨声打断沉默，催她开口。' }],
          emotionalTone: '压抑而克制',
          premise: '林婉儿昨夜独自出城。',
          stakes: '叶尘第一次知道她也被牵扯其中。',
          status: 'active',
          activatedAtRound: 4,
          consecutiveReachedCount: 0,
        },
      ],
    }],
    activeArcIndex: 0,
    focusArcId: 'arc_teahouse',
  };
}

function richNarrativeHistory(): Array<{ role: string; content: string }> {
  return [
    { role: 'user', content: '我走进青云城的茶馆。' },
    { role: 'assistant', content: '茶馆里人声鼎沸，茶香混着湿木头的气味。\n〖系统提示：地点变化〗\n角落里，林婉儿正低头搅着茶盏。' },
    { role: 'user', content: '我向林婉儿打招呼。' },
    { role: 'assistant', content: '林婉儿抬眼，目光在叶尘身上停了一瞬。\n【系统提示】好感度+2\n“坐吧，”她说，“别站着。”' },
    { role: 'user', content: '我坐下，问她为什么一个人在这里。' },
    { role: 'assistant', content: '窗外开始落雨。她没有直接回答，只把茶盏推到了他面前。' },
    { role: 'user', content: '我问她昨晚去了哪里。' },
    { role: 'assistant', content: '她沉默了片刻。“出城了，”她终于说，“去见一个不该见的人。”' },
  ];
}

function npc(overrides: JsonObject): JsonObject {
  return {
    类型: '友人',
    性别: '女',
    年龄: 18,
    好感度: 40,
    描述: '青云宗的内门弟子。',
    外貌描述: '眉眼清冷，束着青色发带。',
    背景: '自幼入青云宗。',
    性格特征: ['克制', '敏锐'],
    核心性格特征: '外冷内热',
    关系状态: '互有好感的熟人',
    最后互动时间: '1-03-15-10-30',
    记忆: [{ 内容: '在茶馆与叶尘初次交谈。', 时间: '1-03-15-10-00' }, '雨天里递给叶尘一盏茶。'],
    总结记忆: [],
    私聊历史: [],
    私密信息: { 身体特征: '（私密）腰侧有一道旧伤。', 是否处女: false },
    ...overrides,
  };
}

/** R — a save in the middle of a story, every injected block non-empty. */
export function makeRichTree(): JsonObject {
  return {
    元数据: {
      游戏包名称: '天命',
      回合序号: 9,
      叙事历史: richNarrativeHistory(),
      推理历史: ['上一回合的推理：林婉儿仍在试探，不宜让她立刻说出师门的名字。'],
      剧情规划: '下一步让叶尘追问师门，并埋下后山的伏笔。',
      当前行动选项: [],
      收藏楼层: [
        { id: 'bm_3_1', round: 3, createdAt: 1, name: '茶馆初遇', content: '茶馆里人声鼎沸，林婉儿低头搅着茶盏。', pending: true },
        { id: 'bm_5_2', round: 5, createdAt: 2, name: '', content: '窗外开始落雨。', pending: false },
      ],
      剧情导向: plotDirection(),
    },
    角色: {
      基础信息: { 姓名: MATRIX_PROTAGONIST, 当前位置: MATRIX_LOCATION, 年龄: 20, 性别: '男', 特质: { 名称: '坚毅', 描述: '' } },
      身份: { 出身: { 名称: '寒门', 描述: '' }, 天赋档次: '甲', 天赋: [{ 名称: '剑心', 描述: '' }], 种族: '人族', 先天六维: { 体质: 6, 直觉: 5, 悟性: 7, 气运: 5, 魅力: 5, 心性: 6 } },
      属性: { 体质: 8, 直觉: 6, 悟性: 9, 气运: 5, 魅力: 6, 心性: 7 },
      可变属性: { 地位: { 名称: '散修', 描述: '' }, 声望: 120, 体力: { 当前: 80, 上限: 100 }, 精力: { 当前: 70, 上限: 90 } },
      效果: [],
      背包: { 金钱: { 现金: 0, 铜: 50, 银: 2, 金: 0 }, 物品: {} },
      身体: { 外观: '（私密）肩背有一道浅疤。' },
      图片档案: { 生图历史: [], 已选头像图片ID: '', 已选立绘图片ID: '', 最近生图结果: '' },
    },
    世界: {
      描述: '一个剑修横行的大陆。',
      天气: '小雨',
      节日: { 名称: '中秋', 描述: '街上挂满灯笼', 效果: 'NPC 心情更佳' },
      环境: [{ 名称: '雾气弥漫', 描述: '能见度很低', 效果: '-3感知' }],
      时间: { 年: 1, 月: 3, 日: 15, 小时: 10, 分钟: 30 },
      地点信息: [
        { 名称: '青云城', 描述: '繁华的修真城市。', 连接: [], NPC: [], 坐标: { x: 0, y: 0 }, 类型: '城市', 上级: '' },
        { 名称: MATRIX_LOCATION, 描述: '城中最热闹的茶馆。', 连接: [], NPC: [MATRIX_NPC_PRESENT], 坐标: { x: 1, y: 0 }, 类型: '场所', 上级: '青云城' },
        { 名称: '青云城·后山', 描述: '少有人至的山林。', 连接: [], NPC: [MATRIX_NPC_AWAY], 坐标: { x: 2, y: 3 }, 类型: '野外', 上级: '青云城' },
      ],
      状态: { 心跳: { 配置: { enabled: false, period: 5 }, 上次心跳回合序号: 0, 历史: [], 上次执行时间: '' } },
    },
    社交: {
      关系: [
        npc({ 名称: MATRIX_NPC_PRESENT, 位置: MATRIX_LOCATION, 是否在场: true, 是否主要角色: true, 关注: true }),
        npc({ 名称: MATRIX_NPC_AWAY, 类型: '重点', 位置: '青云城·后山', 是否在场: false, 好感度: 25, 描述: '后山药圃的学徒。', 关系状态: '点头之交', 记忆: ['曾在后山药圃见过一面。'] }),
        npc({ 名称: MATRIX_NPC_NEARBY, 类型: '普通', 位置: MATRIX_LOCATION, 是否在场: false, 好感度: 10, 描述: '茶馆的账房。', 关系状态: '陌生', 记忆: [] }),
      ],
      事件: { 事件记录: [{ 事件描述: '青云城下了第一场秋雨。', 相关人物: [MATRIX_PROTAGONIST], 影响范围: '青云城', 时间: '1-03-14' }] },
    },
    记忆: {
      短期: [
        { round: 7, summary: '叶尘在茶馆坐下，问林婉儿为何独自一人。', timestamp: 7 },
        { round: 8, summary: '林婉儿承认昨夜出城见了一个不该见的人。', timestamp: 8 },
      ],
      中期: [
        { 相关角色: [MATRIX_NPC_PRESENT, MATRIX_PROTAGONIST], 事件时间: '1-03-15-10-00', 记忆主体: '叶尘与林婉儿在茶馆初次交谈。' },
        { 相关角色: [MATRIX_NPC_AWAY], 事件时间: '1-03-10-09-00', 记忆主体: '叶尘在后山药圃见过苏小棠。', 已精炼: true },
      ],
      长期: [
        { id: 'lt_1', category: '世界观', content: '青云宗与山下诸城互不统属，弟子下山须经长老批准。', createdAt: 1 },
      ],
      隐式中期: [
        { 相关角色: [MATRIX_PROTAGONIST, MATRIX_NPC_PRESENT], 事件时间: '1-03-15-10-20', 记忆主体: '林婉儿对“师门”二字格外回避。' },
        { 相关角色: [MATRIX_NPC_AWAY], 事件时间: '1-03-09-08-00', 记忆主体: '苏小棠偷偷采过禁地的草药。' },
      ],
    },
    系统: {
      信任度: 40,
      扩展: {
        engramMemory: {
          events: [],
          entities: [
            { name: MATRIX_NPC_PRESENT, type: 'npc', summary: '青云宗内门弟子。', attributes: {}, firstSeen: 1, lastSeen: 8, mentionCount: 6, is_embedded: false, source: 'opening' },
            { name: MATRIX_NPC_AWAY, type: 'npc', summary: '后山药圃学徒。', attributes: {}, firstSeen: 2, lastSeen: 4, mentionCount: 2, is_embedded: false, source: 'opening' },
            { name: MATRIX_NPC_NEARBY, type: 'npc', summary: '茶馆账房。', attributes: {}, firstSeen: 3, lastSeen: 3, mentionCount: 1, is_embedded: false, source: 'opening' },
          ],
          relations: [],
          v2Edges: [
            { id: 'edge-1', sourceEntity: MATRIX_PROTAGONIST, targetEntity: MATRIX_NPC_PRESENT, fact: '叶尘在茶馆结识了林婉儿。', episodes: [], is_embedded: false, createdAtRound: 3, lastSeenRound: 8, core: true, source: 'opening' },
            { id: 'edge-2', sourceEntity: MATRIX_NPC_PRESENT, targetEntity: MATRIX_NPC_AWAY, fact: '林婉儿与苏小棠同出青云宗。', episodes: [], is_embedded: false, createdAtRound: 2, lastSeenRound: 4, core: false, source: 'opening' },
          ],
          meta: { lastUpdated: 0, eventCount: 0, embeddedEventCount: 0, embeddedEntityCount: 3, schemaVersion: 5, v2PendingReview: null },
        },
        narrativeContract: {
          enabled: true,
          clauses: [
            { id: 'c1', text: '林婉儿对叶尘始终怀有善意，哪怕她隐瞒了什么。', enabled: true, source: 'player', createdRound: 2 },
            { id: 'c2', text: '主线是查清旧案，不要让叶尘被卷入宗门争斗。', enabled: true, source: 'accepted', createdRound: 4 },
            { id: 'c3', text: '（已停用的条款）', enabled: false, source: 'player', createdRound: 5 },
          ],
        },
        characterVectors: {
          enabled: true,
          entries: [
            { id: 'v1', name: MATRIX_NPC_PRESENT, heading: '想把旧案的真相交给叶尘', tension: '怕牵连叶尘 / 不想再独自承担', unconfirmed: '', enabled: true, source: 'player', updatedRound: 6 },
          ],
        },
        slotWorldBooks: [capturedSlotBook()],
      },
      nsfwMode: false,
      nsfwGenderFilter: 'female',
      actionOptions: { mode: 'action', pace: 'fast', customPrompt: '多给出带有社交色彩的选项。' },
      设置: {
        prompt: { perspective: '第二人称', wordCountRequirement: 650, storyStyle: 'general' },
        cot: { enabled: false },
        social: { presenceEnabled: false },
        plot: { enabled: true },
        bodyPolish: false,
      },
    },
  };
}

/** F — the first round of a new save. */
export function makeFreshTree(): JsonObject {
  return {
    元数据: {
      游戏包名称: '天命',
      回合序号: 1,
      叙事历史: [],
      推理历史: [],
      剧情规划: '',
      当前行动选项: [],
    },
    角色: {
      基础信息: { 姓名: MATRIX_PROTAGONIST, 当前位置: '青云城', 年龄: 20, 性别: '男', 特质: { 名称: '坚毅', 描述: '' } },
      身份: { 出身: { 名称: '寒门', 描述: '' }, 天赋档次: '甲', 天赋: [{ 名称: '剑心', 描述: '' }], 种族: '人族', 先天六维: { 体质: 6, 直觉: 5, 悟性: 7, 气运: 5, 魅力: 5, 心性: 6 } },
      属性: { 体质: 8, 直觉: 6, 悟性: 9, 气运: 5, 魅力: 6, 心性: 7 },
      可变属性: { 地位: { 名称: '散修', 描述: '' }, 声望: 0, 体力: { 当前: 100, 上限: 100 }, 精力: { 当前: 90, 上限: 90 } },
      效果: [],
      背包: { 金钱: { 现金: 0, 铜: 50, 银: 0, 金: 0 }, 物品: {} },
      身体: {},
    },
    世界: {
      描述: '一个剑修横行的大陆。',
      天气: '晴',
      节日: { 名称: '平日', 描述: '', 效果: '' },
      环境: [],
      时间: { 年: 1, 月: 1, 日: 1, 小时: 8, 分钟: 0 },
      地点信息: [
        { 名称: '青云城', 描述: '繁华的修真城市。', 连接: [], NPC: [], 坐标: { x: 0, y: 0 }, 类型: '城市', 上级: '' },
      ],
      状态: { 心跳: { 配置: { enabled: false, period: 5 }, 上次心跳回合序号: 0, 历史: [], 上次执行时间: '' } },
    },
    社交: { 关系: [], 事件: { 事件记录: [] } },
    记忆: { 短期: [], 中期: [], 长期: [], 隐式中期: [] },
    系统: {
      扩展: {},
      nsfwMode: false,
      nsfwGenderFilter: 'female',
      设置: { prompt: { perspective: '第二人称', wordCountRequirement: 650, storyStyle: 'general' }, cot: { enabled: false }, social: { presenceEnabled: false } },
    },
  };
}

/** The book of captured settings that lives in the save (slot-owned): one entry that fires on the NPC's name. */
function capturedSlotBook(): WorldBook {
  return {
    id: CAPTURED_SETTINGS_BOOK_ID,
    title: '自动设定集',
    enabled: true,
    ownership: 'slot',
    origin: 'system-captured',
    createdAt: 1,
    updatedAt: 1,
    entries: [{
      id: 'cap_1',
      title: '林婉儿怕水',
      content: '林婉儿从小怕水，从不靠近深水。',
      type: 'world_lore',
      scope: ['main'],
      injectionMode: 'match_any',
      keywords: [MATRIX_NPC_PRESENT],
      enabled: true,
      matchSource: 'focused',
      createdAt: 1,
      updatedAt: 1,
      capturedSetting: {
        schemaVersion: 1,
        source: 'user-captured',
        kind: 'character',
        evidence: '她从小怕水',
        capturedRound: 5,
        inputHash: 'hash-cap-1',
        status: 'active',
        entityRefs: [MATRIX_NPC_PRESENT],
        injectedCount: 0,
      },
    }],
  };
}

/** The archive book (profile-owned, handed in through the stage's world-book getter): an always entry and a keyword entry. */
export function makeArchiveWorldBook(): WorldBook {
  return {
    id: 'wb_archive',
    title: '大陆档案',
    description: '关于青云大陆的背景资料',
    outline: '青云大陆由三宗七城构成。',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    entries: [
      {
        id: 'wb_e1',
        title: '三宗七城',
        content: '大陆分为三宗七城，青云城是七城之首，青云宗坐落其东。',
        type: 'world_lore',
        scope: ['all'],
        injectionMode: 'always',
        priority: 10,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'wb_e2',
        title: '茶馆规矩',
        content: '青云城的茶馆不收修士的灵石，只收铜钱。',
        type: 'world_lore',
        scope: ['main'],
        injectionMode: 'match_any',
        keywords: ['茶馆'],
        priority: 5,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
}
