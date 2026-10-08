<template>
  <!--
    Debounced search input with a search icon prefix and clear button.

    Polanyi principle: the search input acts as a transparent tool —
    the user's attention stays on the results (focal awareness),
    not the input widget itself (subsidiary awareness).
  -->
  <div class="search-input-wrapper">
    <!-- Search icon -->
    <span class="search-input__icon" aria-hidden="true">
      <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
        <path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd" />
      </svg>
    </span>

    <input
      ref="inputRef"
      type="text"
      class="search-input__field"
      :value="localValue"
      :placeholder="effectivePlaceholder"
      :aria-label="$t('common.search.ariaInput')"
      @input="handleInput"
      @keydown.escape="handleClear"
    />

    <!-- Clear button — only visible when the input has content -->
    <Transition name="clear-fade">
      <Tooltip
        v-if="localValue"
        class="search-input__clear-tip"
        :text="$t('common.search.ariaClear')"
        interactive
        position="top"
      >
        <button
          class="search-input__clear"
          :aria-label="$t('common.search.ariaClear')"
          @click="handleClear"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
            <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
          </svg>
        </button>
      </Tooltip>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

const { t } = useI18n();

interface SearchInputProps {
  modelValue: string;
  placeholder?: string;
  debounceMs?: number;
}

const props = withDefaults(defineProps<SearchInputProps>(), {
  placeholder: '',
  debounceMs: 300,
});

const effectivePlaceholder = computed(() => props.placeholder || t('common.search.placeholder'));

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const inputRef = ref<HTMLInputElement | null>(null);

/**
 * Local value mirrors the input's visual state instantly,
 * while the debounced emit only fires after the user stops typing.
 */
const localValue = ref(props.modelValue);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Sync external v-model changes into local state */
watch(() => props.modelValue, (newVal) => {
  if (newVal !== localValue.value) {
    localValue.value = newVal;
  }
});

function handleInput(e: Event): void {
  const target = e.target as HTMLInputElement;
  localValue.value = target.value;

  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    emit('update:modelValue', localValue.value);
    debounceTimer = null;
  }, props.debounceMs);
}

function handleClear(): void {
  localValue.value = '';
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  emit('update:modelValue', '');
  inputRef.value?.focus();
}

onUnmounted(() => {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
});
</script>

<style scoped>
/* Sanctuary migration 2026-04-21:
   - Hardcoded `#8888a0` / `#e0e0e6` / `#0f0f14` / `#2a2a3a` fallbacks
     retired — tokens are now reliably loaded (see index.html + main.ts)
   - Focus: `rgba(99, 102, 241, 0.12)` indigo ring → sage 3px ring with
     tokenized color-mix so it blends correctly on OKLCH surfaces
   - Placeholder: add italic to match MainGamePanel textarea language
   - Clear-btn hover bg: `rgba(255,255,255,0.08)` → sage-muted */

.search-input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}

/* ── Search icon (left) ── */
.search-input__icon {
  position: absolute;
  left: 12px;
  display: flex;
  align-items: center;
  color: var(--color-text-muted);
  pointer-events: none;
  transition: color var(--duration-fast) var(--ease-out);
}

.search-input-wrapper:focus-within .search-input__icon {
  color: var(--color-sage-300);
  filter: drop-shadow(0 0 4px color-mix(in oklch, var(--color-sage-400) 35%, transparent));
}

/* ── Input field ── */
.search-input__field {
  width: 100%;
  height: 38px;
  padding: 0 36px;
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--color-text);
  background: var(--color-surface-input);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out),
              background-color var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out);
}

.search-input__field::placeholder {
  color: var(--color-text-muted);
  opacity: 0.7;
  font-style: italic;
}

.search-input__field:focus {
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  background: color-mix(in oklch, var(--color-sage-400) 3%, var(--color-surface-input));
  box-shadow:
    0 0 0 3px color-mix(in oklch, var(--color-sage-400) 12%, transparent),
    0 0 16px color-mix(in oklch, var(--color-sage-400) 8%, transparent),
    inset 0 0 12px color-mix(in oklch, var(--color-sage-400) 4%, transparent);
}

/* ── Clear button (right) ── */
/* The Tooltip wrapper owns the absolute right-anchor; the button inside fills it. */
.search-input__clear-tip {
  position: absolute;
  right: 8px;
}
.search-input__clear {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              background var(--duration-fast) var(--ease-out);
}
.search-input__clear:hover {
  color: var(--color-sage-300);
  background: var(--color-sage-muted);
}
.search-input__clear:focus-visible {
  outline: 2px solid var(--color-sage-400);
  outline-offset: -1px;
}

/* ── Clear button fade transition ── */
.clear-fade-enter-active,
.clear-fade-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out);
}
.clear-fade-enter-from,
.clear-fade-leave-to {
  opacity: 0;
}
</style>
