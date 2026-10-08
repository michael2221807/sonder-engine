import { sha256String } from '../core/codec';

/**
 * 全局设置包的**内容指纹**：剔除每次导出必变的时间戳字段（顶层 exportedAt 与
 * builtinPromptOverrides.exportedAt）后，对与设置语义相关的 sections 做 SHA-256。
 * engineSettings 按 key 排序，localStorage 枚举顺序波动不产生假变更。
 * 供 uploadGlobal 跳传比对与 Phase 3 迁移复用；导出为公共函数以便单测锁定
 * "时间戳不同、内容相同 ⇒ 指纹相同"这一关键性质。
 */
/**
 * 会话性易变键——每回合/每次输入都会变化、且对"设置是否变了"没有语义贡献的键。
 * 从内容指纹中剔除（仍随包携带，只是不触发重传）；不剔除的话 checksum-skip
 * 名存实亡（2026-07-23 真机验证：aga_pending_input 输入草稿每回合击穿跳传）。
 */
const VOLATILE_FINGERPRINT_KEYS: ReadonlySet<string> = new Set([
  'aga_pending_input', // 主输入框草稿——随玩家每次输入变化
]);

export async function computeGlobalContentChecksum(json: string): Promise<string> {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const bpo = parsed.builtinPromptOverrides as Record<string, unknown> | undefined;
  const engineSettings = parsed.engineSettings as Record<string, unknown> | undefined;
  const sortedSettings: Record<string, unknown> = {};
  for (const k of Object.keys(engineSettings ?? {}).sort()) {
    if (VOLATILE_FINGERPRINT_KEYS.has(k)) continue;
    sortedSettings[k] = (engineSettings as Record<string, unknown>)[k];
  }
  const fingerprint = {
    configs: parsed.configs,
    prompts: parsed.prompts,
    engineSettings: sortedSettings,
    customPresets: parsed.customPresets,
    builtinPromptOverrides: bpo
      ? { version: bpo.version, entries: bpo.entries, packId: bpo.packId }
      : undefined,
  };
  return sha256String(JSON.stringify(fingerprint));
}
