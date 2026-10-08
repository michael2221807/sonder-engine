<script setup lang="ts">
// App doc: docs/user-guide/pages/game-assistant.md §10.3
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps<{
  modelValue: string;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const isOpen = ref(false);
const focusedIndex = ref(-1);
const containerRef = ref<HTMLDivElement | null>(null);

const selectedLabel = computed(() => {
  const opt = props.options.find(o => o.value === props.modelValue);
  return opt?.label ?? props.placeholder ?? '';
});

function toggle() {
  if (props.disabled) return;
  isOpen.value = !isOpen.value;
  if (isOpen.value) {
    focusedIndex.value = props.options.findIndex(o => o.value === props.modelValue);
  }
}

function select(value: string) {
  emit('update:modelValue', value);
  isOpen.value = false;
}

function onKeydown(e: KeyboardEvent) {
  if (props.disabled) return;
  if (!isOpen.value) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      isOpen.value = true;
      focusedIndex.value = Math.max(0, props.options.findIndex(o => o.value === props.modelValue));
    }
    return;
  }
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      focusedIndex.value = Math.min(focusedIndex.value + 1, props.options.length - 1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      focusedIndex.value = Math.max(focusedIndex.value - 1, 0);
      break;
    case 'Enter':
    case ' ':
      e.preventDefault();
      if (focusedIndex.value >= 0 && focusedIndex.value < props.options.length) {
        select(props.options[focusedIndex.value].value);
      }
      break;
    case 'Escape':
      e.preventDefault();
      isOpen.value = false;
      break;
  }
}

function onClickOutside(e: MouseEvent) {
  if (containerRef.value && !containerRef.value.contains(e.target as Node)) {
    isOpen.value = false;
  }
}

onMounted(() => document.addEventListener('click', onClickOutside));
onBeforeUnmount(() => document.removeEventListener('click', onClickOutside));
</script>

<template>
  <div ref="containerRef" class="custom-select" :class="{ open: isOpen, disabled }">
    <button
      type="button"
      class="cs-trigger"
      role="combobox"
      :aria-expanded="isOpen"
      aria-haspopup="listbox"
      :disabled="disabled"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span class="cs-label">{{ selectedLabel }}</span>
      <span class="cs-arrow">
        <svg width="12" height="8" viewBox="0 0 12 8"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>
      </span>
    </button>
    <Transition name="cs-drop">
      <div v-if="isOpen" class="cs-dropdown" role="listbox">
        <button
          v-for="(opt, idx) in options"
          :key="opt.value"
          type="button"
          class="cs-option"
          role="option"
          :class="{ selected: opt.value === modelValue, focused: idx === focusedIndex }"
          :aria-selected="opt.value === modelValue"
          @click="select(opt.value)"
        >{{ opt.label }}</button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.custom-select {
  position: relative;
  width: 100%;
  max-width: 360px;
}
.cs-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 8px 12px;
  background: var(--color-surface);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 0.84rem;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.cs-trigger:hover {
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
}
.cs-trigger:focus {
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}
.custom-select.disabled .cs-trigger {
  opacity: 0.45;
  cursor: not-allowed;
}
.cs-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cs-arrow {
  flex-shrink: 0;
  margin-left: 8px;
  color: var(--color-text-muted);
  transition: transform 0.2s, color 0.15s;
}
.custom-select.open .cs-arrow {
  transform: rotate(180deg);
  color: var(--color-sage-300);
}

.cs-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 240px;
  overflow-y: auto;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: none;
  border-radius: 6px;
  box-shadow: var(--glass-shadow);
  z-index: var(--z-dropdown);
  padding: 4px;
}
.cs-option {
  display: block;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  color: var(--color-text);
  border: none;
  border-radius: 4px;
  font-size: 0.82rem;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}
.cs-option:hover, .cs-option.focused {
  background: var(--color-sage-muted);
  color: var(--color-sage-100);
}
.cs-option.selected {
  color: var(--color-sage-300);
  font-weight: 500;
}
.cs-option.selected::before {
  content: '✓';
  margin-right: 6px;
  color: var(--color-sage-400);
}

.cs-drop-enter-active { transition: opacity 0.15s, transform 0.15s; }
.cs-drop-leave-active { transition: opacity 0.1s, transform 0.1s; }
.cs-drop-enter-from, .cs-drop-leave-to { opacity: 0; transform: translateY(-4px); }

.cs-dropdown::-webkit-scrollbar { width: 6px; }
.cs-dropdown::-webkit-scrollbar-track { background: transparent; }
.cs-dropdown::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.12);
  border-radius: 3px;
}
</style>
