import { ref, type Ref } from 'vue';
import { SYSTEM_PATHS } from '@/engine/pipeline/system-paths';
import { useGameState } from './useGameState';

/**
 * The action-option style: the mode (action / story), the pace (fast / slow) and the player's extra request. One
 * per device, edited from both the settings page and 「提示词与世界书管理」, and copied into the game
 * (`系统.actionOptions.*`), where the round reads it; loading a game copies it in again (engine-state). Before
 * 2026-10-03 the prompt page kept its own mode and pace that nothing read (PO: the choices had no effect).
 */
export interface ActionOptionsStyle {
  mode: 'action' | 'story';
  pace: 'fast' | 'slow';
  customPrompt: string;
}

export const ACTION_OPTIONS_STYLE_KEY = 'aga_action_options_settings';
export const DEFAULT_ACTION_OPTIONS_STYLE: Readonly<ActionOptionsStyle> = { mode: 'action', pace: 'fast', customPrompt: '' };

/** A style from anywhere (storage, an imported settings file, a card): unknown values fall back to the defaults. */
export function normalizeActionOptionsStyle(raw: unknown): ActionOptionsStyle {
  const value = raw && typeof raw === 'object' ? (raw as Partial<Record<keyof ActionOptionsStyle, unknown>>) : {};
  return {
    mode: value.mode === 'story' ? 'story' : 'action',
    pace: value.pace === 'slow' ? 'slow' : 'fast',
    customPrompt: typeof value.customPrompt === 'string' ? value.customPrompt : '',
  };
}

/** What this device has saved, or the defaults. */
export function readActionOptionsStyle(): ActionOptionsStyle {
  try {
    return normalizeActionOptionsStyle(JSON.parse(localStorage.getItem(ACTION_OPTIONS_STYLE_KEY) ?? '{}'));
  } catch {
    return { ...DEFAULT_ACTION_OPTIONS_STYLE };
  }
}

/** One value for every page that shows it, so a change on one page is on the other at once. */
const style = ref<ActionOptionsStyle>(readActionOptionsStyle());

export interface UseActionOptionsStyle {
  style: Ref<ActionOptionsStyle>;
  /** Keep a change: on this device, and in the loaded game for the next round. */
  save(patch: Partial<ActionOptionsStyle>): void;
  /** Read the device's style again (a card import writes it directly); a page calls it when it shows. */
  refresh(): void;
}

export function useActionOptionsStyle(): UseActionOptionsStyle {
  const { isLoaded, setValue } = useGameState();
  function refresh(): void {
    const stored = readActionOptionsStyle();
    const now = style.value;
    if (stored.mode !== now.mode || stored.pace !== now.pace || stored.customPrompt !== now.customPrompt) style.value = stored;
  }
  function save(patch: Partial<ActionOptionsStyle>): void {
    // Onto what the device holds now, not onto a copy read earlier.
    style.value = normalizeActionOptionsStyle({ ...readActionOptionsStyle(), ...patch });
    try { localStorage.setItem(ACTION_OPTIONS_STYLE_KEY, JSON.stringify(style.value)); } catch { /* storage unavailable */ }
    if (!isLoaded.value) return;
    setValue(SYSTEM_PATHS.actionOptionsMode, style.value.mode);
    setValue(SYSTEM_PATHS.actionOptionsPace, style.value.pace);
    setValue(SYSTEM_PATHS.actionOptionsCustomPrompt, style.value.customPrompt);
  }
  refresh();
  return { style, save, refresh };
}
