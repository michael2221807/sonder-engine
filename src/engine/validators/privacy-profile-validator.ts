/**
 * NSFW 私密信息校验器 — GAP_AUDIT §11.2 B
 *
 * 用途：当 `系统.nsfwMode=true` 时，检测哪些 NPC 缺少完整的 `私密信息` 字段、
 *       以及玩家 `角色.身体` 是否完整。返回给调用方（CommandExecutionStage 写 pending flag、
 *       PrivacyProfileRepairPipeline 做 retry 判停条件）。
 *
 * 严格度（用户选择"中等 8 字段"）：
 * - NPC 私密信息必填 8 项：是否为处女/处男、身体部位、性格倾向、性取向、
 *   性癖好、性渴望程度、性交总次数、性伴侣名单
 * - 玩家身体必填字段：身高、体重、三围、敏感点、开发度
 *
 * 性别过滤：
 * - NPC：按 `系统.nsfwGenderFilter` (`all` | `male` | `female`) 过滤
 *   - `all` → 所有 NPC 都要求
 *   - `male` / `female` → 性别匹配的 NPC 才要求
 * - 玩家：不看过滤器，nsfwMode=true 即要求（用户明确确认）
 *
 * 这是纯 utility — 不依赖 pipeline，可被 CommandExecutionStage 和
 * PrivacyProfileRepairPipeline 复用。没有副作用。
 */
import type { StateManager } from '../core/state-manager';
import type { EnginePathConfig } from '../pipeline/types';
import { SYSTEM_PATHS } from '../pipeline/system-paths';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';

/** 性别过滤器类型 — 与 demo nsfw.ts NsfwGenderFilter 同义 */
export type NsfwGenderFilter = 'all' | 'male' | 'female';

/** 检测结果：哪些 NPC 和玩家实体需要补齐 私密信息 */
export interface PrivacyIncompleteReport {
  /** 需要补齐的 NPC 名称列表（已排序，去重） */
  npcNames: string[];
  /** 玩家 角色.身体 是否缺失或不完整 */
  playerBodyMissing: boolean;
  /** 合计数量 — 用于日志 / UI toast */
  get total(): number;
}

/**
 * NPC 私密信息必填 8 字段（中等严格度）
 *
 * 注意：`身体部位` 是数组，空数组视为不完整；`性伴侣名单` 允许空数组
 * （当 是否为处女/处男=true 时是合规的空状态）。
 */
const NPC_REQUIRED_FIELDS = [
  '是否为处女/处男',
  '身体部位',
  '性格倾向',
  '性取向',
  '性癖好',
  '性渴望程度',
  '性交总次数',
  '性伴侣名单',
] as const;

/**
 * 身体部位数组中必须包含的 4 个固定部位名称（精确匹配）。
 *
 * 设计：AI 可自由追加其他条目（乳首、臀部、阳具、后穴等），但这 4 项是
 * `generateSecretPartImage` 的稳定查找键，必须存在。PrivacyProfileRepairPipeline
 * 会在缺失时重新生成。
 */
const REQUIRED_BODY_PART_NAMES = ['嘴', '胸部', '小穴', '屁穴'] as const;

/**
 * 非处女/处男时追加必填的 3 个初夜字段。
 *
 * 条件逻辑：`是否为处女/处男 === false` → 这 3 个字段都必须非空。
 * `true` 时这些字段可缺失或为空。
 */
const NON_VIRGIN_REQUIRED_FIELDS = [
  '初夜夺取者',
  '初夜时间',
  '初夜描述',
] as const;

/** 玩家 角色.身体 必填字段 */
const PLAYER_BODY_REQUIRED_FIELDS = [
  '身高',
  '体重',
  '三围',
  '敏感点',
  '开发度',
] as const;

/**
 * 判断一个 `私密信息` 对象是否完整
 *
 * 中等严格度：
 * - 必填字段必须存在
 * - string 类型不能是空串或"待生成"占位
 * - number 类型不能是 NaN
 * - array 类型：除 `性伴侣名单` 外不能为空数组
 *   （`性伴侣名单` 空数组在 `是否为处女/处男=true` 时是合法状态）
 * - 其他类型（boolean 等）只要存在即可
 */
export function isPrivacyProfileComplete(obj: unknown): boolean {
  if (obj === null || obj === undefined) return false;
  if (typeof obj !== 'object' || Array.isArray(obj)) return false;

  const data = obj as Record<string, unknown>;

  for (const field of NPC_REQUIRED_FIELDS) {
    const val = data[field];

    if (val === undefined || val === null) return false;

    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed === '') return false;
      if (isPlaceholder(trimmed)) return false;
    } else if (typeof val === 'number') {
      if (Number.isNaN(val)) return false;
    } else if (Array.isArray(val)) {
      // 性伴侣名单允许空数组（处女/处男状态）
      if (val.length === 0 && field !== '性伴侣名单') return false;
    }
  }

  // 身体部位必须包含 4 个固定部位名称（嘴/胸部/小穴/屁穴）。
  // AI 可追加更多条目；此处仅保证固定 4 项存在且其 '特征描述' 非空/占位。
  const parts = data['身体部位'];
  if (!Array.isArray(parts)) return false;
  for (const requiredName of REQUIRED_BODY_PART_NAMES) {
    const match = parts.find((p) =>
      p && typeof p === 'object' && (p as Record<string, unknown>)['部位名称'] === requiredName,
    ) as Record<string, unknown> | undefined;
    if (!match) return false;
    const desc = match['特征描述'];
    if (typeof desc !== 'string' || desc.trim() === '' || isPlaceholder(desc)) return false;
  }

  // 非处女/处男时，初夜 3 字段必填。处女/处男时可缺失。
  if (data['是否为处女/处男'] === false) {
    for (const field of NON_VIRGIN_REQUIRED_FIELDS) {
      const val = data[field];
      if (typeof val !== 'string') return false;
      const trimmed = val.trim();
      if (trimmed === '' || isPlaceholder(trimmed)) return false;
    }
  }

  return true;
}

/**
 * 判断玩家 `角色.身体` 对象是否完整
 *
 * 玩家法身的必填项比 NPC 私密信息少；三围作为对象要求子字段存在。
 */
export function isPlayerBodyComplete(obj: unknown): boolean {
  if (obj === null || obj === undefined) return false;
  if (typeof obj !== 'object' || Array.isArray(obj)) return false;

  const data = obj as Record<string, unknown>;

  for (const field of PLAYER_BODY_REQUIRED_FIELDS) {
    const val = data[field];
    if (val === undefined || val === null) return false;

    if (field === '三围') {
      if (typeof val !== 'object' || Array.isArray(val)) return false;
      const size = val as Record<string, unknown>;
      if (typeof size['胸围'] !== 'number' || Number.isNaN(size['胸围'] as number)) return false;
      if (typeof size['腰围'] !== 'number' || Number.isNaN(size['腰围'] as number)) return false;
      if (typeof size['臀围'] !== 'number' || Number.isNaN(size['臀围'] as number)) return false;
    } else if (field === '敏感点') {
      if (!Array.isArray(val) || val.length === 0) return false;
    } else if (field === '开发度') {
      if (typeof val !== 'object' || Array.isArray(val)) return false;
      if (Object.keys(val as Record<string, unknown>).length === 0) return false;
    } else if (typeof val === 'string') {
      if (val.trim() === '' || isPlaceholder(val)) return false;
    } else if (typeof val === 'number') {
      if (Number.isNaN(val)) return false;
    }
  }

  return true;
}

/**
 * 判断某个 NPC 是否需要生成 私密信息（基于 genderFilter）
 */
function npcMatchesGenderFilter(
  npc: Record<string, unknown>,
  filter: NsfwGenderFilter,
): boolean {
  if (filter === 'all') return true;
  const gender = String(npc['性别'] ?? '');
  if (filter === 'female') return gender === '女' || gender.toLowerCase() === 'female';
  if (filter === 'male') return gender === '男' || gender.toLowerCase() === 'male';
  return false;
}

/**
 * 读取当前 NSFW 设置（优先状态树，回退 localStorage，再回退默认）
 *
 * 与 demo AIBidirectionalSystem.ts:2981-2986 的 fallback 链一致：
 * 1. 状态树 系统.nsfwMode / 系统.nsfwGenderFilter（本次 save 级覆盖）
 * 2. localStorage aga_nsfw_settings（用户 user 级偏好）
 * 3. 硬编码默认：false / 'female'
 */
export function readNsfwSettings(stateManager: StateManager): {
  nsfwMode: boolean;
  nsfwGenderFilter: NsfwGenderFilter;
} {
  const stateMode = stateManager.get<unknown>(SYSTEM_PATHS.nsfwMode);
  const stateFilter = stateManager.get<unknown>(SYSTEM_PATHS.nsfwGenderFilter);

  let lsMode: boolean | undefined;
  let lsFilter: NsfwGenderFilter | undefined;
  try {
    const raw = localStorage.getItem('aga_nsfw_settings');
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.nsfwMode === 'boolean') lsMode = parsed.nsfwMode;
      if (parsed.nsfwGenderFilter === 'all' || parsed.nsfwGenderFilter === 'male' || parsed.nsfwGenderFilter === 'female') {
        lsFilter = parsed.nsfwGenderFilter;
      }
    }
  } catch { /* localStorage 不可用时静默回退 */ }

  const nsfwMode =
    typeof stateMode === 'boolean' ? stateMode :
    typeof lsMode === 'boolean' ? lsMode :
    false;

  const nsfwGenderFilter: NsfwGenderFilter =
    (stateFilter === 'all' || stateFilter === 'male' || stateFilter === 'female') ? stateFilter :
    lsFilter ?? 'female';

  return { nsfwMode, nsfwGenderFilter };
}

/**
 * 检测缺失的私密信息 — 扫描状态树返回 incomplete 报告
 *
 * 调用方：
 * - `CommandExecutionStage` 执行 AI commands 后调用
 * - `PrivacyProfileRepairPipeline` 每次 repair 尝试后重新调用以判停
 *
 * 假设：调用方已经确认 nsfwMode=true（false 时没必要调）
 */
export function findIncompletePrivacy(
  stateManager: StateManager,
  paths: EnginePathConfig,
  genderFilter: NsfwGenderFilter,
): PrivacyIncompleteReport {
  const npcNames: string[] = [];
  const relationships = stateManager.get<Array<Record<string, unknown>>>(paths.relationships);

  if (Array.isArray(relationships)) {
    for (const npc of relationships) {
      if (!npc || typeof npc !== 'object') continue;
      if (!npcMatchesGenderFilter(npc, genderFilter)) continue;

      const privacy = npc['私密信息'];
      if (!isPrivacyProfileComplete(privacy)) {
        const name = String(npc['名称'] ?? '').trim();
        if (name) npcNames.push(name);
      }
    }
  }

  const playerBody = stateManager.get<unknown>(DEFAULT_ENGINE_PATHS.playerBody);
  const playerBodyMissing = !isPlayerBodyComplete(playerBody);

  // 去重 + 排序，保证幂等
  const uniqueSorted = Array.from(new Set(npcNames)).sort();

  return {
    npcNames: uniqueSorted,
    playerBodyMissing,
    get total() {
      return uniqueSorted.length + (playerBodyMissing ? 1 : 0);
    },
  };
}

// ─── 内部辅助 ──────────────────────────────────────────────

/**
 * 识别常见的"占位符"字符串
 *
 * AI 可能偷懒返回"待生成"、"暂无"、"无" 等，视为不完整。
 * 这里的名单基于 demo 提示词明确禁止的词。
 */
function isPlaceholder(s: string): boolean {
  const PLACEHOLDERS = ['待生成', '待ai生成', '暂无', '无', '未知', '未定义', 'tbd', 'todo', 'placeholder'];
  const lower = s.toLowerCase().trim();
  return PLACEHOLDERS.includes(lower);
}
