/**
 * localStorage -> game state tree settings sync (moved verbatim out of the engine-state store, R6 step 6).
 *
 * The store passes its own `get` / `setValue`, so reads and writes still go through the
 * linked StateManager (source 'user') exactly as before. Called from loadGame / markLoaded.
 */
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { SYSTEM_PATHS } from '../pipeline/system-paths';
import type { StatePath } from '../types';

export type SettingsGetter = <T = unknown>(path: StatePath) => T | undefined;
export type SettingsSetter = (path: StatePath, value: unknown) => void;

const P = DEFAULT_ENGINE_PATHS;

/**
 * 从 localStorage 同步 NSFW 设置到状态树。
 *
 * 之前此逻辑仅在 SettingsPanel 的 onMounted / watch(isLoaded) 中执行，
 * 导致面板未挂载时（如创角后直接进入游戏）状态树中的 nsfwMode 停留在
 * schema 默认值 false，即使用户已在设置中开启。
 *
 * 现在在 loadGame / markLoaded 时统一同步，确保游戏可用时 nsfwMode 总是
 * 反映用户的最新偏好。
 */
export function syncNsfwFromLocalStorage(setValue: SettingsSetter): void {
  try {
    const raw = localStorage.getItem('aga_nsfw_settings');
    if (!raw) return;
    const parsed = JSON.parse(raw) as { nsfwMode?: boolean; nsfwGenderFilter?: string };
    if (typeof parsed.nsfwMode === 'boolean') {
      setValue(SYSTEM_PATHS.nsfwMode, parsed.nsfwMode);
    }
    const validFilters = ['all', 'male', 'female'];
    if (typeof parsed.nsfwGenderFilter === 'string' && validFilters.includes(parsed.nsfwGenderFilter)) {
      setValue(SYSTEM_PATHS.nsfwGenderFilter, parsed.nsfwGenderFilter);
    }
  } catch { /* no-op */ }
}

/**
 * 从 localStorage 恢复所有引擎设置到状态树。
 *
 * 问题：heartbeat/actionOptions 等设置存在 localStorage 但游戏重启后
 * 状态树从 schema 默认值重建，覆盖了用户的偏好。NSFW 有专门的 sync，
 * 但其他设置没有。此函数统一处理。
 *
 * 调用时机：loadGame / markLoaded（和 syncNsfwFromLocalStorage 同步）。
 */
export function syncAllSettingsFromLocalStorage(get: SettingsGetter, setValue: SettingsSetter): void {
  // Heartbeat
  try {
    const raw = localStorage.getItem('aga_heartbeat_settings');
    if (raw) {
      const parsed = JSON.parse(raw) as { enabled?: boolean; period?: number };
      if (typeof parsed.enabled === 'boolean') setValue(P.heartbeatEnabled, parsed.enabled);
      if (typeof parsed.period === 'number' && parsed.period > 0) setValue(P.heartbeatPeriod, parsed.period);
    }
  } catch { /* no-op */ }

  // Action Options
  try {
    const raw = localStorage.getItem('aga_action_options_settings');
    if (raw) {
      const parsed = JSON.parse(raw) as { mode?: string; pace?: string; customPrompt?: string };
      if (parsed.mode === 'action' || parsed.mode === 'story') setValue(SYSTEM_PATHS.actionOptionsMode, parsed.mode);
      if (parsed.pace === 'fast' || parsed.pace === 'slow') setValue(SYSTEM_PATHS.actionOptionsPace, parsed.pace);
      if (typeof parsed.customPrompt === 'string') setValue(SYSTEM_PATHS.actionOptionsCustomPrompt, parsed.customPrompt);
    }
  } catch { /* no-op */ }

  // CoT settings
  try {
    const raw = localStorage.getItem('aga_cot_settings');
    if (raw) {
      const parsed = JSON.parse(raw) as { enabled?: boolean; judgeEnabled?: boolean; injectStep2?: boolean; ringSize?: number };
      if (typeof parsed.enabled === 'boolean') setValue(SYSTEM_PATHS.cotEnabled, parsed.enabled);
      if (typeof parsed.judgeEnabled === 'boolean') setValue(SYSTEM_PATHS.cotJudgeEnabled, parsed.judgeEnabled);
      if (typeof parsed.injectStep2 === 'boolean') setValue(SYSTEM_PATHS.cotInjectStep2, parsed.injectStep2);
      if (typeof parsed.ringSize === 'number' && parsed.ringSize >= 1) setValue(SYSTEM_PATHS.cotReasoningRingSize, parsed.ringSize);
    }
  } catch { /* no-op */ }

  // Body polish
  try {
    const raw = localStorage.getItem('aga_body_polish_settings');
    if (raw) {
      const parsed = JSON.parse(raw) as { enabled?: boolean };
      if (typeof parsed.enabled === 'boolean') setValue(SYSTEM_PATHS.bodyPolish, parsed.enabled);
    }
  } catch { /* no-op */ }

  // Presence partition
  try {
    const raw = localStorage.getItem('aga_presence_settings');
    if (raw) {
      const parsed = JSON.parse(raw) as { presenceEnabled?: boolean };
      if (typeof parsed.presenceEnabled === 'boolean') setValue(SYSTEM_PATHS.presenceEnabled, parsed.presenceEnabled);
    }
  } catch { /* no-op */ }

  // Image generation
  try {
    const raw = localStorage.getItem('aga_image_gen_settings');
    if (raw) {
      const parsed = JSON.parse(raw) as { enabled?: boolean };
      if (typeof parsed.enabled === 'boolean') setValue(SYSTEM_PATHS.image.enabled, parsed.enabled);
    }
  } catch { /* no-op */ }

  // Prompt settings — ensure defaults exist in state tree
  // (PromptPanel reads/writes to 系统.设置.prompt; SystemPromptBuilder reads it)
  if (!get(SYSTEM_PATHS.promptSettings)) {
    setValue(SYSTEM_PATHS.promptSettings, {
      perspective: '第二人称',
      wordCountRequirement: 650,
      storyStyle: 'general',
      enableNoControl: true,
      enableActionOptions: true,
      actionOptionsMode: 'action',
      actionPace: 'fast',
      customSystemPrompt: '',
    });
  }

  // Heroine plan — ensure default structure exists
  if (!get(P.heroinePlan)) {
    setValue(P.heroinePlan, {
      stageProgression: [],
      heroineEntries: [],
      interactionEvents: [],
      scenePlans: [],
    });
  }
}
