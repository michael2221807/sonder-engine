<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.15
/**
 * SettingTagButton — the composer's「设定」key.
 *
 * Canon Capture is deliberately an EXPLICIT lane: the engine never guesses which part of
 * a free-form sentence was meant as a lasting setting. This button is the whole entry
 * point — it wraps the player's selection (or drops an empty pair at the caret) in
 * `<设定>…</设定>`, which the pipeline treats as authoritative for this turn and every
 * turn after.
 *
 * Why a button rather than teaching a syntax: the tag has to be discoverable without a
 * tutorial. A key beside Send is something the player finds by looking, and the inserted
 * markers then teach the syntax by example.
 *
 * Self-gating, mirroring MicInputButton / AddLexiconTermButton: when world books are off
 * the key is disabled with a tooltip saying WHY, rather than silently accepting input
 * that would never be recorded.
 */
import { computed, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { useEngineStateStore } from '@/engine/stores/engine-state';
import { DEFAULT_PROMPT_SETTINGS, type PromptSettings } from '@/engine/prompt/world-book';
import { DEFAULT_SETTING_TAG_NAMES } from '@/engine/prompt/setting-tag-scanner';

const props = defineProps<{
  /** Bound to the composer textarea so the caret / selection can be read. */
  textarea: HTMLTextAreaElement | null;
  disabled?: boolean;
}>();

const model = defineModel<string>({ required: true });

const { t } = useI18n();
const engineState = useEngineStateStore();

const TAG = DEFAULT_SETTING_TAG_NAMES[0];
const OPEN = `<${TAG}>`;
const CLOSE = `</${TAG}>`;

/** Prompt settings live in the state tree; read them live so a toggle takes effect at once. */
const settings = computed<PromptSettings>(() => ({
  ...DEFAULT_PROMPT_SETTINGS,
  ...((engineState.get('系统.设置.prompt') as Partial<PromptSettings> | undefined) ?? {}),
}));

const captureEnabled = computed(() =>
  settings.value.enableWorldBook !== false && settings.value.enableSettingCapture !== false);

const tooltip = computed(() =>
  captureEnabled.value ? t('mainGame.settingTag.tooltip') : t('mainGame.settingTag.tooltipDisabled'));

/**
 * Wrap the selection, or insert an empty pair and park the caret between the markers.
 *
 * Reads the live selection from the DOM rather than tracking it in state: the textarea
 * is the source of truth for where the player is looking, and mirroring it would drift.
 */
function insertTag(): void {
  const el = props.textarea;

  if (!el) {
    model.value = `${model.value ?? ''}${OPEN}${CLOSE}`;
    return;
  }

  // Read the string from the TEXTAREA, not from `model.value`. The caret offsets come
  // from the DOM, and the two can briefly disagree: dictation writes into the bound ref
  // and Vue flushes it to the DOM on the next tick, so a click landing inside that window
  // would slice a newer string with older offsets and drop the markers in the wrong place.
  // `el.value` and `el.selectionStart` are always consistent with each other.
  const value = el.value ?? '';
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? start;
  const selected = value.slice(start, end);

  model.value = `${value.slice(0, start)}${OPEN}${selected}${CLOSE}${value.slice(end)}`;

  // Caret goes after the wrapped text, or between the markers when nothing was selected —
  // either way the player can keep typing without repositioning by hand.
  const caret = start + OPEN.length + selected.length;
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(caret, caret);
  });
}
</script>

<template>
  <Tooltip :text="tooltip" interactive>
    <button
      type="button"
      class="setting-tag-btn"
      :disabled="props.disabled || !captureEnabled"
      :aria-label="$t('mainGame.settingTag.buttonAria')"
      @click="insertTag"
    >
      <!-- A bookmark: something you deliberately place to come back to later. -->
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
    </button>
  </Tooltip>
</template>

<style scoped>
.setting-tag-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              background var(--duration-fast) var(--ease-out);
}

.setting-tag-btn:hover:not(:disabled) {
  color: var(--color-amber-400);
  background: color-mix(in oklch, var(--color-amber-400) 10%, transparent);
}

.setting-tag-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.setting-tag-btn:focus-visible {
  outline: 2px solid var(--color-sage-400);
  outline-offset: 2px;
}
</style>
