import type { InjectionKey, Ref } from 'vue';

/**
 * What the story composer offers to something that floats above it (the plot-vector card table, PO 2026-09-30 A):
 * the input row to stand above, and a way to put the caret into the input.
 */
export interface ComposerAnchor {
  row: Readonly<Ref<HTMLElement | null>>;
  input: Readonly<Ref<HTMLTextAreaElement | null>>;
  focusInput(): void;
}

export const COMPOSER_ANCHOR: InjectionKey<ComposerAnchor> = Symbol('composer-anchor');
