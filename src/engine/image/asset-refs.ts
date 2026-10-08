import { TIANMING_IMAGE_ARCHIVE_KEYS } from '../pack/tianming-coupling';
// Which cached image assets a state tree still references. Shared by the backup collector,
// the save-health gate, game-card export and the task-eviction cleanup in image-service.
// Moved verbatim from persistence/backup-service (R3 step 3); the Set insertion order decides
// the order of exported assets, so do not reorder the scans.

/**
 * 从 GameStateTree 中提取所有被引用的图片 asset ID。
 *
 * 扫描路径：
 * - 角色.图片档案.已选头像图片ID / 已选立绘图片ID / 已选背景图片ID
 * - 角色.图片档案.生图历史[].id + 最近生图结果
 * - 社交.关系[].图片档案 — 同上
 * - 社交.关系[].图片档案.香闺秘档.{胸部|小穴|屁穴}.assetId
 * - 系统.扩展.image.sceneArchive.当前壁纸图片ID + 生图历史[].id
 */
export function collectAssetIdsFromTree(tree: Record<string, unknown>, ids: Set<string>, includeReferenceAssets = false): void {
  const addIfValid = (val: unknown) => {
    if (typeof val === 'string' && val.trim()) ids.add(val.trim());
  };

  const SELECTION_FIELDS = [TIANMING_IMAGE_ARCHIVE_KEYS.selectedAvatarId, '已选立绘图片ID', '已选背景图片ID'];

  const extractFromArchive = (archive: unknown) => {
    if (!archive || typeof archive !== 'object' || Array.isArray(archive)) return;
    const a = archive as Record<string, unknown>;
    for (const f of SELECTION_FIELDS) addIfValid(a[f]);
    addIfValid(a['最近生图结果']);
    // 生图历史 — every entry's id is an asset reference
    const history = a[TIANMING_IMAGE_ARCHIVE_KEYS.generationHistory];
    if (Array.isArray(history)) {
      for (const entry of history) {
        if (entry && typeof entry === 'object') addIfValid((entry as Record<string, unknown>).id);
      }
    }
    // 香闺秘档
    const secret = a[TIANMING_IMAGE_ARCHIVE_KEYS.secretChamber];
    if (secret && typeof secret === 'object') {
      for (const part of Object.values(secret as Record<string, unknown>)) {
        if (part && typeof part === 'object') addIfValid((part as Record<string, unknown>).assetId);
      }
    }
  };

  // Player archive
  const player = tree['角色'] as Record<string, unknown> | undefined;
  if (player) extractFromArchive(player['图片档案']);

  // NPC archives
  const social = tree['社交'] as Record<string, unknown> | undefined;
  const relationships = social?.['关系'];
  if (Array.isArray(relationships)) {
    for (const npc of relationships) {
      if (npc && typeof npc === 'object') extractFromArchive((npc as Record<string, unknown>)['图片档案']);
    }
  }

  // Scene archive
  const system = tree['系统'] as Record<string, unknown> | undefined;
  const ext = system?.['扩展'] as Record<string, unknown> | undefined;
  const image = ext?.['image'] as Record<string, unknown> | undefined;
  const sceneArchive = image?.['sceneArchive'] as Record<string, unknown> | undefined;
  if (sceneArchive) {
    addIfValid(sceneArchive['当前壁纸图片ID']);
    addIfValid(sceneArchive['最近生图结果']);
    const sceneHistory = sceneArchive[TIANMING_IMAGE_ARCHIVE_KEYS.generationHistory];
    if (Array.isArray(sceneHistory)) {
      for (const entry of sceneHistory) {
        if (entry && typeof entry === 'object') addIfValid((entry as Record<string, unknown>).id);
      }
    }
  }

  // 参考重绘**实际用过**的参考图（多图参考重绘 epic，2026-08-29）。
  //
  // 此前从不采集：`providerMeta.reference` 只被写入、从没被备份遍历过，于是一张
  // 上传的参考图只有在用户勾了「包含参考素材」时才随素材库同行——默认关的情况下
  // 恢复备份就丢图，任务归档里的 sourceAssetIds 全变悬空引用。
  //
  // 这里**不受 includeReferenceAssets 门控**，与素材库区别对待：
  // - 素材库 = 用户囤着待用的素材，体量大且可能从没用过 → 保持 opt-in
  // - 这里 = 已经参与过生成的图，属于"这张图是怎么来的"记录的一部分 → 必须随档
  // 多数 id 与图库/头像重合，Set 去重后新增体积仅限"上传后未进图库"的参考图。
  const tasks = image?.['tasks'];
  if (Array.isArray(tasks)) {
    for (const task of tasks) {
      if (!task || typeof task !== 'object') continue;
      const meta = (task as Record<string, unknown>)['providerMeta'] as Record<string, unknown> | undefined;
      const ref = meta?.['reference'] as Record<string, unknown> | undefined;
      if (!ref) continue;
      const list = ref['sourceAssetIds'];
      // 新格式：有序数组，未持久化项以空串占位 → addIfValid 自动跳过
      if (Array.isArray(list)) for (const id of list) addIfValid(id);
      // 旧格式：单值（save-migration 会补齐数组，但备份可能读到未迁移的树）
      addIfValid(ref['sourceAssetId']);
    }
  }

  // Reference library assets (opt-in — large blobs, user chooses at export time)
  if (includeReferenceAssets) {
    const referenceLib = image?.['referenceLibrary'];
    if (Array.isArray(referenceLib)) {
      for (const entry of referenceLib) {
        if (entry && typeof entry === 'object') addIfValid((entry as Record<string, unknown>).assetId);
      }
    }
  }
}
