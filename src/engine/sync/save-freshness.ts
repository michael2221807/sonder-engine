// Design doc: docs/design/cloud-slot-freshness.md
// App doc: docs/user-guide/pages/game-save.md §2.2.1（上传/下载按钮高亮 + 旧盖新确认）
/**
 * 存档新鲜度 — "两份存档内容哪份更新"的纯比较逻辑。
 *
 * 只服务云端插槽的**手动**上传 / 下载按钮（CloudSlotsSection.vue）。与自动上传的
 * 基线冲突检测（"云端是否被别的设备改过"，github-sync.ts detectSlotConflict）正交：
 * 自动路径只在无冲突时上传，此时本地必然 ≥ 云端，所以不需要新鲜度。
 *
 * 本地戳与云端戳由**同一个** deriveProfileSaveStamp 推导（云端戳在 exportProfileForSync
 * 时算出写入 manifest slotMeta），上传成功后两边字符串完全一致 ⇒ 'same'，无需时间容差。
 */

import type { ProfileMeta } from '../types/persistence';

/** 一份档案"玩到哪了"的戳：最近一次存档时刻 + 该存档的回合序号。 */
export interface SaveStamp {
  /** ISO 时间；从未存过 / 老数据没有 ⇒ null */
  savedAt: string | null;
  /** 该次存档时的回合序号；旧存档 / 写卡会话 ⇒ null */
  round: number | null;
}

/**
 * - `local-newer`：本地玩得更远 → 建议上传；下载会用旧盖新，需警示
 * - `cloud-newer`：云端玩得更远 → 建议下载；上传会用旧盖新，需确认
 * - `same`：两边一致，无事可做
 * - `unknown`：任一边缺戳（老 manifest / 老存档）→ 维持既有行为，不高亮不加确认
 */
export type SaveFreshness = 'local-newer' | 'cloud-newer' | 'same' | 'unknown';

/**
 * 从档案元数据推导存档戳：取各槽 `lastSavedAt` 最大者，`round` 取**那个槽**的
 * `roundNumber`（不是所有槽的最大回合——回合数跟着"最近玩的那份"走）。
 */
export function deriveProfileSaveStamp(meta: Pick<ProfileMeta, 'slots'>): SaveStamp {
  let savedAt: string | null = null;
  let round: number | null = null;
  for (const slot of Object.values(meta.slots ?? {})) {
    const at = slot.lastSavedAt;
    if (!at) continue;
    if (savedAt === null || at > savedAt) {
      savedAt = at;
      round = typeof slot.roundNumber === 'number' && Number.isFinite(slot.roundNumber) ? slot.roundNumber : null;
    }
  }
  return { savedAt, round };
}

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * 比较规则（docs/design/cloud-slot-freshness.md §4）：
 * 1. 任一边缺时间 / 不可解析 ⇒ unknown
 * 2. 时间为主：晚者为新
 * 3. 回合为辅：时间相同才比回合；都相同 ⇒ same
 * 回合不否决时间：玩家回退一回合再存，本地时间新、回合低，仍判本地新（回退是玩家意志）。
 */
export function compareSaveStamps(
  local: SaveStamp | null | undefined,
  cloud: SaveStamp | null | undefined,
): SaveFreshness {
  const tl = parseTime(local?.savedAt);
  const tc = parseTime(cloud?.savedAt);
  if (tl === null || tc === null) return 'unknown';
  if (tl > tc) return 'local-newer';
  if (tl < tc) return 'cloud-newer';
  const rl = local?.round ?? null;
  const rc = cloud?.round ?? null;
  if (rl !== null && rc !== null) {
    if (rl > rc) return 'local-newer';
    if (rl < rc) return 'cloud-newer';
  }
  return 'same';
}
