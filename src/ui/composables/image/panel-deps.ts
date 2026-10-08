/**
 * Shared dependency shapes for the composables that were split out of
 * ImagePanel (R7). They are deliberately the narrowest signatures the moved
 * code needs, so the panel can hand over its own `t` / `get` / `setValue`.
 */
import type { UseGameStateReturn } from '@/ui/composables/useGameState';

/** `useI18n().t` as the moved code calls it: a key plus optional named values. */
export type PanelTranslate = (key: string, named?: Record<string, unknown>) => string;

/** `useGameState().get` — imperative path read. */
export type GetState = UseGameStateReturn['get'];

/** `useGameState().setValue` — path write from the UI layer. */
export type SetState = UseGameStateReturn['setValue'];
