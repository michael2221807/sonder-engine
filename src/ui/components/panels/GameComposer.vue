<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.7 (输入区) · §3.16 (工具抽屉 + 名字速插)
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import MicInputButton from '@/ui/components/shared/MicInputButton.vue';
import SettingTagButton from '@/ui/components/shared/SettingTagButton.vue';
import NameInserterButton from '@/ui/components/shared/NameInserterButton.vue';
import { eventBus } from '@/engine/core/event-bus';
import { scanSettingTags, SETTING_QUALITY_WARN_CHARS } from '@/engine/prompt/setting-tag-scanner';

const ACTION_OPTIONS_COLLAPSED_KEY = 'aga_action_options_collapsed';
const TOOLS_OPEN_KEY = 'aga_composer_tools_open';

const props = withDefaults(defineProps<{
  actionOptions?: string[];
  isGenerating: boolean;
  canRollback: boolean;
}>(), {
  actionOptions: () => [],
});

const emit = defineEmits<{
  (e: 'send', text: string): void;
  (e: 'copy-option', text: string): void;
  (e: 'cancel-generation'): void;
  (e: 'request-rollback'): void;
}>();

const userInput = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
/** Passed to NameInserterButton so its panel opens above the WHOLE input area
    (on a phone the keys sit on a second row below the textarea). */
const inputAreaRef = ref<HTMLElement | null>(null);
// 语音录音/听写期间置 textarea 为 readonly，防止并发键入被识别文本覆盖（MicInputButton
// 的插入锚点在录音开始时快照）；readonly 不改变外观、保留焦点，程序化 v-model 更新照常。
const micRecording = ref(false);
const actionOptionsCollapsed = ref<boolean>(
  localStorage.getItem(ACTION_OPTIONS_COLLAPSED_KEY) === '1',
);

/**
 * Tool drawer (rollback / names / setting-tag).
 *
 * Defaults to OPEN so a first-time player SEES the three keys and learns they can be
 * tucked away — a drawer that starts closed hides its own contents, which is exactly
 * the discoverability hole a「⋯」key normally digs. The choice is remembered per device.
 */
const toolsOpen = ref<boolean>(localStorage.getItem(TOOLS_OPEN_KEY) !== '0');
const nameInserterRef = ref<InstanceType<typeof NameInserterButton> | null>(null);

function toggleTools(): void {
  toolsOpen.value = !toolsOpen.value;
  localStorage.setItem(TOOLS_OPEN_KEY, toolsOpen.value ? '1' : '0');
  // Collapsing with the name panel open would leave it floating with no anchor.
  if (!toolsOpen.value) nameInserterRef.value?.close();
}

const canSend = computed(() => userInput.value.trim().length > 0 && !props.isGenerating);

function toggleActionOptionsCollapsed(): void {
  actionOptionsCollapsed.value = !actionOptionsCollapsed.value;
  localStorage.setItem(ACTION_OPTIONS_COLLAPSED_KEY, actionOptionsCollapsed.value ? '1' : '0');
}

function autoResizeTextarea(): void {
  const el = textareaRef.value;
  if (!el) return;

  el.style.height = 'auto';
  const maxHeight = 120;
  el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
}

function resetTextareaHeight(): void {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = 'auto';
}

function sendMessage(): void {
  const text = userInput.value.trim();
  if (!text || props.isGenerating) return;

  // Soft advisory only — NEVER a gate (PM decision 2026-08-25). A very long marked
  // setting still generates normally; the model just has more facts to decompose while
  // also writing the narrative, so quality may dip. The player can rollback and retry.
  try {
    const tagChars = scanSettingTags(text).segments
      .reduce((n, seg) => n + seg.rawText.length, 0);
    if (tagChars > SETTING_QUALITY_WARN_CHARS) {
      eventBus.emit('ui:toast', {
        type: 'info',
        i18nKey: 'mainGame.settingTag.longWarn',
        duration: 6000,
      });
    }
  } catch { /* advisory only — a scanner hiccup must never block sending */ }

  userInput.value = '';
  resetTextareaHeight();
  emit('send', text);
}

function selectAction(option: string): void {
  if (props.isGenerating) return;
  userInput.value = option;
  nextTick(() => {
    textareaRef.value?.focus();
    autoResizeTextarea();
  });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

function restoreInput(text: string): void {
  userInput.value = text;
  nextTick(() => autoResizeTextarea());
}

onBeforeUnmount(() => {
  resetTextareaHeight();
});

defineExpose({
  restoreInput,
});
</script>

<template>
  <div
    v-if="props.actionOptions.length > 0 && !props.isGenerating"
    :class="['action-options', { 'action-options--collapsed': actionOptionsCollapsed }]"
  >
    <button
      class="action-options__toggle"
      :aria-expanded="!actionOptionsCollapsed"
      :aria-label="actionOptionsCollapsed ? $t('mainGame.composer.expandActions') : $t('mainGame.composer.collapseActions')"
      @click="toggleActionOptionsCollapsed"
    >
      <span class="action-options__hint">
        {{ actionOptionsCollapsed ? $t('mainGame.composer.actionCountHint', { n: props.actionOptions.length }) : $t('mainGame.composer.actionLabel') }}
      </span>
      <svg
        class="action-options__chevron"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
    <!-- Viewport = collapse animator (clips); inner list = scroll container.
         Splitting the two so a long option set scrolls instead of clipping. -->
    <div class="action-options__viewport">
      <div class="action-options__list">
        <div
          v-for="(option, idx) in props.actionOptions"
          :key="idx"
          class="action-option-row"
        >
          <Tooltip :text="$t('mainGame.composer.copyText')" interactive>
            <button
              class="action-copy"
              :aria-label="$t('mainGame.composer.copyText')"
              @click.stop="emit('copy-option', option)"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg>
            </button>
          </Tooltip>
          <button
            :class="['action-btn', { 'action-btn--selected': userInput === option }]"
            @click="selectAction(option)"
          >
            {{ option }}
          </button>
        </div>
      </div>
    </div>
  </div>

  <div ref="inputAreaRef" class="input-area">
    <button
      v-if="props.isGenerating"
      class="cancel-btn"
      @click="emit('cancel-generation')"
      :aria-label="$t('mainGame.composer.cancelAriaLabel')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
      </svg>
      {{ $t('mainGame.composer.cancelLabel') }}
    </button>

    <div :class="['input-row', { 'input-row--recording': micRecording }]">
      <textarea
        ref="textareaRef"
        v-model="userInput"
        class="message-input"
        :placeholder="$t('mainGame.composer.inputPlaceholder')"
        rows="1"
        :disabled="props.isGenerating"
        :readonly="micRecording"
        @keydown="onKeydown"
        @input="autoResizeTextarea"
      />
      <!-- Grouped so mobile can move all trailing controls onto their own row
           below the textarea; desktop flattens the wrapper via display:contents. -->
      <div class="composer-actions">
        <!-- Tool drawer — `inert` (not just visually collapsed) so the hidden keys
             leave the tab order and the a11y tree while rolled up. -->
        <div
          id="composer-tools"
          class="tools-drawer"
          :class="{ 'tools-drawer--open': toolsOpen }"
          :inert="!toolsOpen"
        >
          <Tooltip
            class="rollback-slot"
            :text="props.canRollback ? $t('mainGame.composer.rollbackTitle') : $t('mainGame.composer.rollbackUnavailable')"
            interactive
          >
            <button
              class="rollback-btn"
              :disabled="!props.canRollback"
              :aria-label="$t('mainGame.composer.rollbackAriaLabel')"
              @click="emit('request-rollback')"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          </Tooltip>

          <NameInserterButton
            ref="nameInserterRef"
            class="name-slot"
            v-model="userInput"
            :textarea="textareaRef"
            :anchor="inputAreaRef"
            :disabled="props.isGenerating"
            @update:model-value="nextTick(autoResizeTextarea)"
          />

          <SettingTagButton
            class="setting-tag-slot"
            v-model="userInput"
            :textarea="textareaRef"
            :disabled="props.isGenerating"
          />
        </div>

        <Tooltip
          class="tools-slot"
          :text="toolsOpen ? $t('mainGame.composer.toolsCollapseTooltip') : $t('mainGame.composer.toolsExpandTooltip')"
          interactive
        >
          <button
            class="tools-btn"
            :class="{ 'tools-btn--open': toolsOpen }"
            :aria-expanded="toolsOpen"
            aria-controls="composer-tools"
            :aria-label="toolsOpen ? $t('mainGame.composer.toolsCollapseAria') : $t('mainGame.composer.toolsExpandAria')"
            @click="toggleTools"
          >
            <!-- Closed: three dots (there is more here). Open: a chevron pointing back
                 at the edge (put them away). The icon IS the instruction. -->
            <svg v-if="!toolsOpen" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </Tooltip>

        <MicInputButton
          v-model="userInput"
          :textarea="textareaRef"
          :disabled="props.isGenerating"
          @recording-change="micRecording = $event"
          @update:model-value="nextTick(autoResizeTextarea)"
        />
        <Tooltip :text="$t('mainGame.composer.sendAriaLabel')" interactive>
          <button
            class="send-btn"
            :disabled="!canSend"
            @click="sendMessage"
            :aria-label="$t('mainGame.composer.sendAriaLabel')"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </Tooltip>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Desktop/shared base: extracted intact from MainGamePanel so typing only
   updates this composer subtree, not the full narrative history. */
.action-options {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--color-border-subtle);
  background: var(--color-surface);
  flex-shrink: 0;
}

.action-options__toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 6px var(--sidebar-right-reserve, 40px) 6px var(--sidebar-left-reserve, 40px);
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-family: var(--font-sans);
  font-size: 0.7rem;
  letter-spacing: 0.06em;
  cursor: pointer;
  opacity: 0.7;
  transition: padding-left var(--duration-open) var(--ease-droplet),
              padding-right var(--duration-open) var(--ease-droplet),
              opacity var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out);
}
.action-options__toggle:hover {
  opacity: 1;
  color: var(--color-sage-300);
}
.action-options--collapsed .action-options__toggle {
  padding-top: 10px;
  padding-bottom: 10px;
  opacity: 0.9;
}
.action-options__hint {
  font-variant-numeric: tabular-nums;
}
.action-options__chevron {
  flex-shrink: 0;
  transition: transform var(--duration-normal) var(--ease-out);
}
.action-options--collapsed .action-options__chevron {
  transform: rotate(-180deg);
}

/* Viewport — the collapse animator. overflow:hidden makes the max-height
   transition read as a smooth roll-up/down. It does NOT scroll; the inner
   list does. Keeping the animated height and the scroll height on separate
   elements is what prevents a scrollbar flicker mid-animation.
   NOTE: its expanded max-height must stay >= the list's max-height below. */
.action-options__viewport {
  max-height: 60vh;
  opacity: 1;
  overflow: hidden;
  visibility: visible;
  /* visibility flips on immediately when expanding (0s, no delay) so the
     options re-enter the tab order / a11y tree as the roll-down starts. */
  transition: max-height var(--duration-normal) var(--ease-out),
              opacity var(--duration-fast) var(--ease-out),
              visibility 0s;
}
.action-options--collapsed .action-options__viewport {
  max-height: 0;
  opacity: 0;
  /* visibility:hidden (deferred until the roll-up finishes) takes the
     collapsed options out of the tab order + a11y tree, so keyboard users
     can't Tab into hidden buttons and the browser won't auto-scroll to a
     focused-but-clipped element. The delay keeps the fade visible meanwhile. */
  visibility: hidden;
  pointer-events: none;
  transition: max-height var(--duration-normal) var(--ease-out),
              opacity var(--duration-fast) var(--ease-out),
              visibility 0s var(--duration-normal);
}

/* List — flex-wrap layout AND the real vertical scroll container. When the
   AI returns more options than fit in 60vh, this scrolls internally instead
   of clipping the trailing options off the bottom (the bug this fixes — they
   were unreachable on both mobile and desktop). overscroll-behavior:contain
   stops scroll-chaining to the page; -webkit-overflow-scrolling gives iOS
   momentum. The global sanctuary scrollbar (tokens.css) styles the bar. */
.action-options__list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.25rem var(--sidebar-right-reserve, 40px) 0.65rem var(--sidebar-left-reserve, 40px);
  max-height: 60vh;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  transition: padding-left var(--duration-open) var(--ease-droplet),
              padding-right var(--duration-open) var(--ease-droplet);
}

.action-option-row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
}
.action-copy {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  margin-top: 3px;
  flex-shrink: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  cursor: pointer;
  opacity: 0.4;
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              background-color var(--duration-fast) var(--ease-out),
              opacity var(--duration-fast) var(--ease-out);
}
.action-option-row:hover .action-copy { opacity: 0.85; }
.action-copy:hover {
  opacity: 1;
  color: var(--color-sage-300);
  border-color: color-mix(in oklch, var(--color-sage-400) 25%, transparent);
  background: var(--color-sage-muted);
}

.action-btn {
  padding: 0.42rem 0.85rem;
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-family: var(--font-serif-cjk);
  font-size: 0.82rem;
  line-height: 1.5;
  color: var(--color-text);
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out),
              background-color var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out),
              transform var(--duration-fast) var(--ease-out);
  white-space: normal;
  word-break: break-word;
  text-align: left;
  max-width: 100%;
  letter-spacing: 0.02em;
}

.action-btn:hover {
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  background: linear-gradient(180deg,
    color-mix(in oklch, var(--color-sage-400) 10%, var(--color-surface-elevated)),
    color-mix(in oklch, var(--color-sage-400) 5%, var(--color-surface-elevated)));
  color: var(--color-sage-100);
  box-shadow: 0 0 14px color-mix(in oklch, var(--color-sage-400) 18%, transparent);
  transform: translateY(-1px);
}
.action-btn--selected {
  border-color: color-mix(in oklch, var(--color-sage-400) 55%, transparent);
  background: color-mix(in oklch, var(--color-sage-400) 14%, var(--color-surface-elevated));
  color: var(--color-sage-100);
  font-weight: 500;
}

.input-area {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.625rem var(--sidebar-right-reserve, 40px) 0.75rem var(--sidebar-left-reserve, 40px);
  transition: padding-left var(--duration-open) var(--ease-droplet),
              padding-right var(--duration-open) var(--ease-droplet);
  border-top: 1px solid var(--color-border-subtle);
  background: var(--color-surface);
  flex-shrink: 0;
}

.cancel-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  align-self: center;
  padding: 0.3rem 0.85rem;
  background: color-mix(in oklch, var(--color-danger) 10%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-danger) 40%, transparent);
  border-radius: var(--radius-md);
  font-family: var(--font-sans);
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  color: color-mix(in oklch, var(--color-danger) 95%, var(--color-text));
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out);
}

.cancel-btn:hover {
  background: color-mix(in oklch, var(--color-danger) 18%, transparent);
  border-color: color-mix(in oklch, var(--color-danger) 60%, transparent);
  box-shadow: inset 0 0 12px color-mix(in oklch, var(--color-danger) 12%, transparent);
}

.input-row {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
}

/* Desktop: the wrapper dissolves so the flex row lays out exactly as before.
   Mobile (below) turns it into the second-row control cluster. */
.composer-actions {
  display: contents;
}

/* ── Tool drawer ──────────────────────────────────────────────
 * Rolls up horizontally into the「⋯」key. `max-width` (not `width`) animates
 * cleanly without measuring, and the negative margin swallows the parent row's
 * 0.5rem gap so a collapsed drawer leaves NO phantom space beside the textarea.
 * `visibility` flips after the roll-up finishes, matching the action-options
 * pattern above; `inert` in the template does the real focus/a11y removal. */
.tools-drawer {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  max-width: 0;
  margin-right: -0.5rem;
  opacity: 0;
  overflow: hidden;
  visibility: hidden;
  transition: max-width var(--duration-normal) var(--ease-out),
              opacity var(--duration-fast) var(--ease-out),
              margin-right var(--duration-normal) var(--ease-out),
              visibility 0s var(--duration-normal);
}
.tools-drawer--open {
  max-width: 240px;
  margin-right: 0;
  opacity: 1;
  visibility: visible;
  transition: max-width var(--duration-normal) var(--ease-out),
              opacity var(--duration-fast) var(--ease-out),
              margin-right var(--duration-normal) var(--ease-out),
              visibility 0s;
}

.tools-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 42px;
  flex-shrink: 0;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              background-color var(--duration-fast) var(--ease-out);
}
.tools-btn:hover {
  color: var(--color-sage-100);
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  background: var(--color-sage-muted);
}
/* Open is NOT a highlight state: the chevron already says "put these away", and a
   filled key here would compete with Send for the eye (UI must recede — Principle 2). */
.tools-btn--open {
  color: var(--color-text-muted);
  border-color: var(--color-border-subtle);
}
.tools-btn:focus-visible {
  outline: 2px solid var(--color-sage-400);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .tools-drawer,
  .tools-drawer--open {
    transition: none;
  }
}

.message-input {
  flex: 1;
  box-sizing: border-box;
  padding: 0.55rem 0.85rem;
  background: var(--color-surface-input);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  color: var(--color-text);
  font-family: var(--font-serif-cjk);
  font-size: 0.92rem;
  line-height: 1.6;
  letter-spacing: 0.01em;
  resize: none;
  outline: none;
  min-height: 42px;
  max-height: 120px;
  overflow-y: auto;
  transition: border-color var(--duration-fast) var(--ease-out),
              background-color var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out);
}

.message-input::placeholder {
  color: var(--color-text-muted);
  opacity: 0.7;
  font-style: italic;
}

.message-input:focus {
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  background: color-mix(in oklch, var(--color-sage-400) 3%, var(--color-surface-input));
  box-shadow:
    0 0 0 3px color-mix(in oklch, var(--color-sage-400) 12%, transparent),
    0 0 16px color-mix(in oklch, var(--color-sage-400) 8%, transparent),
    inset 0 0 12px color-mix(in oklch, var(--color-sage-400) 4%, transparent);
}

.message-input:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.send-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  background: transparent;
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  border-radius: var(--radius-lg);
  color: var(--color-sage-300);
  cursor: pointer;
  flex-shrink: 0;
  transition: color var(--duration-fast) var(--ease-out),
              background-color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out),
              opacity var(--duration-fast) var(--ease-out);
}

.send-btn:hover:not(:disabled) {
  color: var(--color-sage-100);
  background: linear-gradient(135deg,
    color-mix(in oklch, var(--color-sage-400) 18%, transparent),
    color-mix(in oklch, var(--color-sage-400) 10%, transparent));
  border-color: var(--color-sage-400);
  box-shadow:
    0 0 16px color-mix(in oklch, var(--color-sage-400) 30%, transparent),
    0 0 6px color-mix(in oklch, var(--color-sage-400) 15%, transparent),
    var(--lumi-inset-highlight);
}

.send-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.rollback-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 42px;
  flex-shrink: 0;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              background-color var(--duration-fast) var(--ease-out);
}

.rollback-btn:hover:not(:disabled) {
  color: var(--color-amber-400);
  border-color: color-mix(in oklch, var(--color-amber-400) 45%, transparent);
  background: linear-gradient(135deg,
    color-mix(in oklch, var(--color-amber-400) 10%, transparent),
    color-mix(in oklch, var(--color-amber-400) 5%, transparent));
  box-shadow: 0 0 12px color-mix(in oklch, var(--color-amber-400) 18%, transparent);
}

.rollback-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* Mobile baseline: touch targets and safe-area spacing. */
@media (max-width: 767px) {
  .action-options__toggle {
    padding-left: var(--space-md);
    padding-right: var(--space-md);
  }
  .action-options__list {
    padding-left: var(--space-md);
    padding-right: var(--space-md);
  }
  .input-area {
    padding-left: var(--space-sm);
    padding-right: var(--space-sm);
    padding-bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
  }

  /* Two-row composer: the textarea takes the full first row, all controls drop
     to a second row (rollback far left, tools + send far right). Five 34-42px
     controls beside the textarea left it ~110px wide on a 390px phone. */
  .input-row {
    flex-wrap: wrap;
  }
  .message-input {
    /* order pulls the textarea ahead of the rollback button (which precedes it
       in the DOM) so the full-width field forms row 1 and every control wraps
       onto row 2 together. Trade-off: mobile tab order (rollback → textarea →
       tools) no longer matches the visual rows; DOM order stays aligned with
       the desktop layout, where keyboard traversal actually happens. */
    order: -1;
    flex-basis: 100%;
    /* 16px floor: below that iOS Safari auto-zooms the page on focus. */
    font-size: 1rem;
    min-height: 46px;
  }
  .composer-actions {
    display: flex;
    align-items: center;
    /* An OPEN drawer puts six keys on this row (3 drawer + ⋯ + mic + send ≈ 304px
       of 44px targets). Wrapping to a third row is the honest failure mode on a
       375px phone — letting it overflow would bring back the horizontal-pan bug. */
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-left: auto;
    min-width: 0;
  }
  /* Uniform 44px touch targets. */
  .rollback-btn,
  .send-btn {
    width: 44px;
    height: 44px;
  }
  .composer-actions :deep(.mic-btn),
  .composer-actions :deep(.setting-tag-btn),
  .composer-actions :deep(.name-ins__btn),
  .tools-btn {
    width: 44px;
    height: 44px;
  }
  .tools-drawer--open {
    max-width: 100%;
  }
  /* Send is the primary action on this row — give it a filled resting state so
     the eye lands on it (desktop keeps the quiet outline; hover isn't a cue on touch). */
  .send-btn:not(:disabled) {
    background: color-mix(in oklch, var(--color-sage-400) 14%, var(--color-surface-input));
  }

  /* Recording: the compact rec-control (cancel/level/timer/stop) needs the whole
     row — hide the idle-only helpers and let the meter breathe. */
  /* Hide the whole drawer + its key at their outermost wrappers so no empty flex
     item lingers to double the row gap. */
  .input-row--recording .tools-drawer,
  .input-row--recording .tools-slot {
    display: none;
  }
  .input-row--recording .composer-actions {
    flex: 1;
    margin-left: 0;
  }
  .input-row--recording .composer-actions :deep(.mic-input),
  .input-row--recording .composer-actions :deep(.rec-control) {
    flex: 1;
    min-width: 0;
  }
  .input-row--recording .composer-actions :deep(.wave),
  .input-row--recording .composer-actions :deep(.shimmer) {
    flex: 1;
    width: auto;
    min-width: 24px;
  }

  .action-btn {
    min-height: 44px;
  }
}

/* Small phone refinements: tighter side padding, same controls. */
@media (max-width: 640px) {
  .input-area {
    padding: 0.5rem 0.75rem;
    padding-bottom: calc(0.5rem + env(safe-area-inset-bottom, 0px));
  }
  .action-options__toggle,
  .action-options__list {
    padding-left: 0.75rem;
    padding-right: 0.75rem;
  }
}
</style>
