// App doc: docs/user-guide/pages/game-main.md §3.14 (语音输入 · STT)
/**
 * 语音输入(STT)设置持久化 — localStorage `aga_stt_settings`。
 *
 * 与 aga_tts_settings 对称:read-merge 写入保留未知字段(前向兼容);此 key 以
 * `aga_` 开头,会被 collectLocalStorageSettings()(backup-service.ts)自动采集进
 * engineSettings → 随备份/云同步。无密钥,故也进卡片导出白名单
 * (settings-export-whitelist.ts)。
 *
 * 引擎侧只读写此 key;UI 侧(设置区)save 后即时用于组件行为(下次录音生效)。
 *
 * 设计文档:docs/design/stt-streaming-handoff.md §5
 */
import { DEFAULT_STT_SETTINGS } from './types';
import { providerCatalog } from '../providers';
import type { SttSettings, SttBackendType, SttInputMode, SttLatencyProfile, SttHotwordStrength, SttPauseTolerance } from './types';

export const STT_SETTINGS_STORAGE_KEY = 'aga_stt_settings';

const MODES: readonly SttInputMode[] = ['auto', 'stream', 'record'];
const LATENCIES: readonly SttLatencyProfile[] = ['fast', 'balanced', 'stable'];
const STRENGTHS: readonly SttHotwordStrength[] = ['weak', 'medium', 'strong'];
const PAUSE_TOLERANCES: readonly SttPauseTolerance[] = ['short', 'medium', 'long'];

/** 把任意来源对象归一化为完整、合法的 SttSettings(缺字段回落默认)。 */
export function normalizeSttSettings(raw: unknown): SttSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<SttSettings>;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_STT_SETTINGS.enabled,
    // epic P3 / D2: 当前听写服务商;合法值由目录派生(不手抄名单——review 2026-08-26),
    // 未知值(含旧存档缺省)回落默认 cosyvoice
    backend: providerCatalog.has('stt', String(o.backend ?? ''))
      ? (o.backend as SttBackendType) : DEFAULT_STT_SETTINGS.backend,
    mode: MODES.includes(o.mode as SttInputMode) ? (o.mode as SttInputMode) : DEFAULT_STT_SETTINGS.mode,
    latency: LATENCIES.includes(o.latency as SttLatencyProfile)
      ? (o.latency as SttLatencyProfile)
      : DEFAULT_STT_SETTINGS.latency,
    firstUseHint: typeof o.firstUseHint === 'boolean' ? o.firstUseHint : DEFAULT_STT_SETTINGS.firstUseHint,
    hotwordEnabled: typeof o.hotwordEnabled === 'boolean' ? o.hotwordEnabled : DEFAULT_STT_SETTINGS.hotwordEnabled,
    hotwordStrength: STRENGTHS.includes(o.hotwordStrength as SttHotwordStrength)
      ? (o.hotwordStrength as SttHotwordStrength)
      : DEFAULT_STT_SETTINGS.hotwordStrength,
    pauseTolerance: PAUSE_TOLERANCES.includes(o.pauseTolerance as SttPauseTolerance)
      ? (o.pauseTolerance as SttPauseTolerance)
      : DEFAULT_STT_SETTINGS.pauseTolerance,
  };
}

/** 从 localStorage 载入语音输入设置(冷启动 / 导入存档后调用)。 */
export function loadSttSettings(): SttSettings {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STT_SETTINGS_STORAGE_KEY) : null;
    if (!saved) return { ...DEFAULT_STT_SETTINGS };
    return normalizeSttSettings(JSON.parse(saved));
  } catch {
    return { ...DEFAULT_STT_SETTINGS };
  }
}

/** 保存语音输入设置(read-merge:保留 localStorage 里的未知字段)。 */
export function saveSttSettings(settings: SttSettings): void {
  try {
    if (typeof localStorage === 'undefined') return;
    let existing: Record<string, unknown> = {};
    const prev = localStorage.getItem(STT_SETTINGS_STORAGE_KEY);
    if (prev) {
      try {
        const parsed = JSON.parse(prev);
        if (parsed && typeof parsed === 'object') existing = parsed;
      } catch {
        /* ignore malformed prev */
      }
    }
    const merged = { ...existing, ...normalizeSttSettings(settings) };
    localStorage.setItem(STT_SETTINGS_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}
