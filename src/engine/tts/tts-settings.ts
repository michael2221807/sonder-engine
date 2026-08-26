/**
 * TTS 全局配音设置持久化 — localStorage `aga_tts_settings`。
 *
 * 用 read-merge 写入避免覆盖未知字段(前向兼容),与 APIPanel 的
 * aga_ai_settings 写法一致。此 key 会被 collectLocalStorageSettings()
 * (backup-service.ts)自动采集进 engineSettings → 随备份/云同步。
 *
 * 引擎侧只读写此 key;UI 侧(设置区)save 后调 ttsService.setSettings()。
 */
import {
  DEFAULT_TTS_SETTINGS, TTS_RATE_MIN, TTS_RATE_MAX,
  PREWARM_SECONDS_MIN, PREWARM_SECONDS_MAX,
} from './types';
import type { TtsSettings, TtsVoiceFavorite, TtsBackendType } from './types';
import { providerCatalog } from '../providers';
import {
  SEGMENT_TARGET_CHARS_MIN, SEGMENT_TARGET_CHARS_MAX,
  SEGMENT_MAX_SENTENCES_MIN, SEGMENT_MAX_SENTENCES_MAX,
} from './sentence-splitter';

export const TTS_SETTINGS_STORAGE_KEY = 'aga_tts_settings';

function clampRate(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_TTS_SETTINGS.rate;
  return Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, n));
}

function clampVolume(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_TTS_SETTINGS.volume;
  return Math.min(1, Math.max(0, n));
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeFavorites(v: unknown): TtsVoiceFavorite[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((f): TtsVoiceFavorite | null => {
      if (!f || typeof f !== 'object') return null;
      const obj = f as { speaker?: unknown; instruct?: unknown };
      const speaker = typeof obj.speaker === 'string' ? obj.speaker : '';
      if (!speaker) return null;
      return { speaker, instruct: typeof obj.instruct === 'string' ? obj.instruct : '' };
    })
    .filter((f): f is TtsVoiceFavorite => f !== null);
}

/** 把任意来源的对象归一化为完整、合法的 TtsSettings(缺字段回落默认)。 */
export function normalizeTtsSettings(raw: unknown): TtsSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<TtsSettings>;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_TTS_SETTINGS.enabled,
    // epic P2 / D2: 当前配音服务商;合法值由目录派生(不手抄名单——review 2026-08-26),
    // 未知值(含旧存档缺省)回落默认 cosyvoice
    backend: providerCatalog.has('tts', String(o.backend ?? ''))
      ? (o.backend as TtsBackendType) : DEFAULT_TTS_SETTINGS.backend,
    autoNarrateOnRound: typeof o.autoNarrateOnRound === 'boolean'
      ? o.autoNarrateOnRound : DEFAULT_TTS_SETTINGS.autoNarrateOnRound,
    // 'full'/'pseudo' 保留;其它(含旧值 'segment')迁移到真流式 'stream'
    transmissionMode: o.transmissionMode === 'full' ? 'full'
      : o.transmissionMode === 'pseudo' ? 'pseudo' : 'stream',
    prewarmSeconds: clampNum(
      o.prewarmSeconds, PREWARM_SECONDS_MIN, PREWARM_SECONDS_MAX, DEFAULT_TTS_SETTINGS.prewarmSeconds),
    // 旧存档无这两键 → clampInt 回落默认(120/6),前向兼容。
    segmentTargetChars: clampInt(
      o.segmentTargetChars, SEGMENT_TARGET_CHARS_MIN, SEGMENT_TARGET_CHARS_MAX, DEFAULT_TTS_SETTINGS.segmentTargetChars),
    segmentMaxSentences: clampInt(
      o.segmentMaxSentences, SEGMENT_MAX_SENTENCES_MIN, SEGMENT_MAX_SENTENCES_MAX, DEFAULT_TTS_SETTINGS.segmentMaxSentences),
    defaultSpeaker: typeof o.defaultSpeaker === 'string' ? o.defaultSpeaker : DEFAULT_TTS_SETTINGS.defaultSpeaker,
    defaultInstruct: typeof o.defaultInstruct === 'string' ? o.defaultInstruct : DEFAULT_TTS_SETTINGS.defaultInstruct,
    rate: clampRate(o.rate),
    volume: clampVolume(o.volume),
    favorites: sanitizeFavorites(o.favorites),
  };
}

/** 从 localStorage 载入配音设置(冷启动 / 导入存档后调用)。 */
export function loadTtsSettings(): TtsSettings {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(TTS_SETTINGS_STORAGE_KEY) : null;
    if (!saved) return { ...DEFAULT_TTS_SETTINGS };
    return normalizeTtsSettings(JSON.parse(saved));
  } catch {
    return { ...DEFAULT_TTS_SETTINGS };
  }
}

/** 保存配音设置(read-merge:保留 localStorage 里的未知字段)。 */
export function saveTtsSettings(settings: TtsSettings): void {
  try {
    if (typeof localStorage === 'undefined') return;
    let existing: Record<string, unknown> = {};
    const prev = localStorage.getItem(TTS_SETTINGS_STORAGE_KEY);
    if (prev) {
      try {
        const parsed = JSON.parse(prev);
        if (parsed && typeof parsed === 'object') existing = parsed;
      } catch { /* ignore malformed prev */ }
    }
    const merged = { ...existing, ...normalizeTtsSettings(settings) };
    localStorage.setItem(TTS_SETTINGS_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}
