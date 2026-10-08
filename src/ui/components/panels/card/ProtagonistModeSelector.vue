<script setup lang="ts">
// App doc: docs/user-guide/pages/game-save.md §2.5.1
/**
 * ProtagonistModeSelector — fixed / template / blank picker for Game Card export (Story 5, P5).
 * Reusable by Story 7. Card-style tacit choice (Polanyi principle 1) + template editable-field list.
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ProtagonistMode } from '@/engine/export/game-card-bundle.types';

const props = defineProps<{
  mode: ProtagonistMode;
  /** Editable field dot-paths (relative to 角色), template mode only. */
  editableFields: string[];
  /** Story 7 (U13): restrict pickable modes (save-to-card passes ['fixed','template'] — blank is rejected by import). */
  allowedModes?: ProtagonistMode[];
}>();

const emit = defineEmits<{
  (e: 'update:mode', v: ProtagonistMode): void;
  (e: 'update:editableFields', v: string[]): void;
}>();

const { t } = useI18n();

const MODES: { value: ProtagonistMode; icon: string }[] = [
  { value: 'fixed', icon: '🔒' },
  { value: 'template', icon: '📝' },
  { value: 'blank', icon: '✨' },
];

const visibleModes = computed(() => {
  const allowed = props.allowedModes;
  return allowed ? MODES.filter((m) => allowed.includes(m.value)) : MODES;
});

/** Whitelist-only editable options (mirrors buildDefaultProtagonistPolicy.editableWhitelist). */
const EDITABLE_OPTIONS: { path: string; labelKey: string }[] = [
  { path: '基础信息.姓名', labelKey: 'save.export.protagonist.field.name' },
  { path: '基础信息.年龄', labelKey: 'save.export.protagonist.field.age' },
  { path: '基础信息.性别', labelKey: 'save.export.protagonist.field.sex' },
  { path: '基础信息.特质', labelKey: 'save.export.protagonist.field.traits' },
  { path: '基础信息.外貌', labelKey: 'save.export.protagonist.field.appearance' },
  { path: '背包', labelKey: 'save.export.protagonist.field.inventory' },
];

const selected = computed(() => new Set(props.editableFields));

function pick(m: ProtagonistMode): void {
  emit('update:mode', m);
}

function toggleField(path: string): void {
  const next = new Set(props.editableFields);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  emit('update:editableFields', [...next]);
}
</script>

<template>
  <div class="pms">
    <div class="pms-cards" role="radiogroup" :aria-label="t('save.export.protagonist.sectionTitle')">
      <button
        v-for="m in visibleModes"
        :key="m.value"
        type="button"
        class="pms-card"
        :class="{ 'pms-card--active': mode === m.value }"
        role="radio"
        :aria-checked="mode === m.value"
        @click="pick(m.value)"
      >
        <span class="pms-card__icon" aria-hidden="true">{{ m.icon }}</span>
        <span class="pms-card__label">{{ t(`save.export.protagonist.${m.value}.label`) }}</span>
        <span class="pms-card__desc">{{ t(`save.export.protagonist.${m.value}.desc`) }}</span>
      </button>
    </div>

    <div v-if="mode === 'template'" class="pms-fields">
      <p class="pms-fields__title">{{ t('save.export.protagonist.editableTitle') }}</p>
      <div class="pms-fields__grid">
        <label v-for="opt in EDITABLE_OPTIONS" :key="opt.path" class="pms-check">
          <input
            type="checkbox"
            :checked="selected.has(opt.path)"
            @change="toggleField(opt.path)"
          />
          <span>{{ t(opt.labelKey) }}</span>
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pms-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
@media (max-width: 520px) {
  .pms-cards { grid-template-columns: 1fr; }
}

.pms-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 12px 14px;
  text-align: left;
  background: color-mix(in oklch, var(--color-bg) 60%, transparent);
  border: none;
  border-radius: var(--radius-md);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-text) 8%, transparent);
  cursor: pointer;
  transition: transform 0.16s var(--ease-out), box-shadow 0.16s var(--ease-out),
    background 0.16s var(--ease-out);
}
@media (hover: hover) {
  .pms-card:hover { transform: translateY(-2px); }
}
.pms-card--active {
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  box-shadow: inset 0 0 0 1.5px color-mix(in oklch, var(--color-sage-400) 55%, transparent),
    var(--shadow-glow);
}
.pms-card__icon { font-size: 18px; }
.pms-card__label {
  font-family: var(--font-serif-cjk);
  font-size: 0.95rem;
  font-weight: 500;
  color: var(--color-text);
}
.pms-card__desc {
  font-size: 0.78rem;
  line-height: 1.4;
  color: var(--color-text-secondary);
}
.pms-card:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 35%, transparent);
}

.pms-fields { margin-top: 12px; }
.pms-fields__title {
  margin: 0 0 8px;
  font-size: 0.82rem;
  color: var(--color-text-secondary);
}
.pms-fields__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 6px 12px;
}
.pms-check {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 0.86rem;
  color: var(--color-text);
  cursor: pointer;
}
</style>
