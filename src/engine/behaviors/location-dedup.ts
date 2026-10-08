/**
 * 地点去重与合并 — 处理 AI 生成的结构性重复地点
 *
 * 问题场景：
 * AI 先生成 "S市 → S市·云顶区 → S市·云顶区·天际一号"，
 * 后来又生成 "中国 → 中国·S市 → 中国·S市·云顶区 → 中国·S市·云顶区·天际一号"。
 * 这是同一地方的两种路径表达，地图上会出现两棵重复的树。
 *
 * 合并策略（后缀匹配）：
 * 1. 检测末段相同的条目（`·` 分割后最后一段）
 * 2. 若短路径名是长路径名的后缀（"S市" 是 "中国·S市" 的后缀），识别为重复
 * 3. 保留长路径（更具体），将短路径重命名为长路径
 * 4. 短路径的所有子孙也做前缀替换：`"S市·X"` → `"中国·S市·X"`
 * 5. 合并 NPC 列表（并集）和描述（取更长的）
 * 6. 更新探索记录中的地点名
 *
 * 在 PostProcessStage 每回合末调用。
 */
import type { StateManager } from '../core/state-manager';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';

/** Separator between the levels of a hierarchical location name. */
const SEP = DEFAULT_ENGINE_PATHS.locationPathSeparator;

interface LocEntry {
  名称: string;
  描述?: string;
  上级?: string;
  NPC?: string[];
  [key: string]: unknown;
}

/**
 * 对状态树中的地点数组执行去重合并。
 *
 * @param stateManager 状态管理器
 * @param locationsPath 地点数组路径（如 `世界.地点信息`）
 * @param explorationPath 探索记录路径（如 `系统.探索记录`）
 * @param playerLocationPath 玩家当前位置路径
 * @returns 本次合并的重命名数量（0 = 无变更）
 */
export function deduplicateLocations(
  stateManager: StateManager,
  locationsPath: string,
  explorationPath: string,
  playerLocationPath: string,
): number {
  const locs = stateManager.get<LocEntry[]>(locationsPath);
  if (!Array.isArray(locs) || locs.length < 2) return 0;

  // Step 1: 按末段分组
  const byLastSeg = new Map<string, LocEntry[]>();
  for (const loc of locs) {
    if (!loc?.名称) continue;
    const segs = loc.名称.split(SEP);
    const last = segs[segs.length - 1];
    const group = byLastSeg.get(last);
    if (group) group.push(loc);
    else byLastSeg.set(last, [loc]);
  }

  // Step 2: 在每组中检测后缀重复对
  // rename map: oldName → newName
  const renames = new Map<string, string>();

  for (const group of byLastSeg.values()) {
    if (group.length < 2) continue;

    // 按名称长度排序（短在前）
    group.sort((a, b) => a.名称.length - b.名称.length);

    for (let i = 0; i < group.length; i++) {
      const short = group[i];
      if (renames.has(short.名称)) continue; // 已被合并

      for (let j = i + 1; j < group.length; j++) {
        const long = group[j];
        if (renames.has(long.名称)) continue;

        // 检查短名是否是长名的后缀
        // "S市" 是 "中国·S市" 的后缀 → long.名称.endsWith(SEP + short.名称)
        if (long.名称.endsWith(SEP + short.名称) || long.名称 === short.名称) {
          renames.set(short.名称, long.名称);
          break; // 一个短名只匹配第一个长名
        }
      }
    }
  }

  if (renames.size === 0) return 0;

  // Step 3: 扩展重命名到子孙
  // 如果 "S市" → "中国·S市"，则 "S市·云顶区" → "中国·S市·云顶区"
  const fullRenames = new Map<string, string>();
  for (const [oldPrefix, newPrefix] of renames) {
    for (const loc of locs) {
      if (!loc?.名称) continue;
      if (loc.名称 === oldPrefix) {
        fullRenames.set(oldPrefix, newPrefix);
      } else if (loc.名称.startsWith(oldPrefix + SEP)) {
        const suffix = loc.名称.slice(oldPrefix.length);
        fullRenames.set(loc.名称, newPrefix + suffix);
      }
    }
  }

  // Step 4: 执行合并
  const merged: LocEntry[] = [];
  const seen = new Set<string>();

  for (const loc of locs) {
    if (!loc?.名称) continue;

    let finalName = loc.名称;
    let finalParent = loc.上级;

    // 重命名
    if (fullRenames.has(loc.名称)) {
      finalName = fullRenames.get(loc.名称)!;
    }
    if (finalParent && fullRenames.has(finalParent)) {
      finalParent = fullRenames.get(finalParent);
    }

    // 去重
    if (seen.has(finalName)) {
      const existing = merged.find((m) => m.名称 === finalName);
      if (existing) {
        // NPC 并集
        if (Array.isArray(loc.NPC) && loc.NPC.length > 0) {
          const existingNpc = Array.isArray(existing.NPC) ? existing.NPC : [];
          existing.NPC = [...new Set([...existingNpc, ...loc.NPC])];
        }
        // 描述取更长
        const ld = typeof loc.描述 === 'string' ? loc.描述.trim() : '';
        const ed = typeof existing.描述 === 'string' ? existing.描述.trim() : '';
        if (ld && (!ed || ld.length > ed.length)) {
          existing.描述 = loc.描述;
        }
        // 上级：已有条目无上级但重复条目有 → 采纳
        // 这修复"S市"(无上级) 被重命名为"中国·S市"后，真正的"中国·S市"(上级:"中国")的上级丢失
        if (!existing.上级 && finalParent) {
          existing.上级 = finalParent;
        }
      }
      continue;
    }

    seen.add(finalName);
    merged.push({
      ...loc,
      名称: finalName,
      上级: finalParent,
    });
  }

  // Step 5: 修复缺失的上级——从名称推断
  // 重命名后 "S市"→"中国·S市"，名称含 `·` 但上级仍为空。
  // 正确的上级应该是名称去掉最后一段：`"中国·S市".split('·').slice(0,-1).join('·')` = `"中国"`
  const mergedNames = new Set(merged.map((m) => m.名称));
  for (const loc of merged) {
    if (loc.上级) continue; // 已有上级
    const segs = loc.名称.split(SEP);
    if (segs.length < 2) continue; // 真正的 root（如 "中国"），不需要上级
    const inferredParent = segs.slice(0, -1).join(SEP);
    if (mergedNames.has(inferredParent)) {
      loc.上级 = inferredParent;
    }
  }

  // Step 6: 写回状态树
  stateManager.set(locationsPath, merged, 'system');

  // Step 6: 更新探索记录中的旧地点名
  const exploration = stateManager.get<string[]>(explorationPath);
  if (Array.isArray(exploration) && fullRenames.size > 0) {
    let changed = false;
    const updated = exploration.map((name) => {
      if (fullRenames.has(name)) {
        changed = true;
        return fullRenames.get(name)!;
      }
      return name;
    });
    if (changed) {
      stateManager.set(explorationPath, [...new Set(updated)], 'system');
    }
  }

  // Step 7: 更新玩家当前位置
  const playerLoc = stateManager.get<string>(playerLocationPath);
  if (playerLoc && fullRenames.has(playerLoc)) {
    stateManager.set(playerLocationPath, fullRenames.get(playerLoc), 'system');
  }

  return fullRenames.size;
}
