<script setup lang="ts">
// App doc: docs/user-guide/pages/game-relationships.md §人物向量 (per-NPC vector card)
// Design: docs/design/character-vector-v1-implementation-plan.md S3
/**
 * CharacterVectorCard — one NPC's "potential vector", shown under the inner-thought line
 * of the relationship card. Four short lines (toward / never / direction / hidden), a
 * source badge (world-written entries are amber and editable like any other — never
 * "accepted"), an inject toggle and delete. Edits commit on blur / Enter.
 */
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  useCharacterVectors,
  CHARACTER_VECTOR_LINE_MAX_CHARS,
  CHARACTER_VECTOR_HIDDEN_MAX_CHARS,
  type CharacterVectorFields,
} from '@/ui/composables/useCharacterVectors';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

const props = defineProps<{ name: string }>();
const { t } = useI18n();
const { entryFor, upsertEntry, toggleEntry, removeEntry } = useCharacterVectors();

const entry = computed(() => entryFor(props.name));
const editing = ref(false);
const draft = ref<CharacterVectorFields>({ toward: '', never: '', direction: '', hidden: '' });

type Line = keyof CharacterVectorFields;
const LINES: readonly Line[] = ['toward', 'never', 'direction', 'hidden'];
const maxFor = (line: Line): number => (line === 'hidden' ? CHARACTER_VECTOR_HIDDEN_MAX_CHARS : CHARACTER_VECTOR_LINE_MAX_CHARS);

function loadDraft(): void {
  const e = entry.value;
  draft.value = { toward: e?.toward ?? '', never: e?.never ?? '', direction: e?.direction ?? '', hidden: e?.hidden ?? '' };
}
watch(entry, loadDraft, { immediate: true });

function startEdit(): void {
  loadDraft();
  editing.value = true;
}

/** Commit the draft; an all-empty draft on a new entry writes nothing. */
function commit(): void {
  const any = LINES.some((l) => draft.value[l].trim());
  if (any || entry.value) upsertEntry(props.name, draft.value);
  editing.value = false;
}

function cancel(): void {
  loadDraft();
  editing.value = false;
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') cancel();
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    commit();
  }
}
</script>

<template>
  <div :class="['vector-card', { 'vector-card--off': entry && !entry.enabled, 'vector-card--proposed': entry?.source === 'proposed' }]" data-testid="vector-card">
    <!-- Read view -->
    <template v-if="!editing">
      <button v-if="!entry" class="vector-card__empty" data-testid="vector-add" @click="startEdit">
        {{ t('relationship.vector.empty') }}
      </button>
      <template v-else>
        <div class="vector-card__head">
          <span :class="['vector-badge', `vector-badge--${entry.source}`]">{{ t(`relationship.vector.source.${entry.source}`) }}</span>
          <span class="vector-card__round">{{ t('relationship.vector.round', { n: entry.updatedRound }) }}</span>
          <span class="vector-card__spacer" />
          <AgaToggle :model-value="entry.enabled" :label="t('relationship.vector.enabled')" @update:model-value="toggleEntry(name)" />
          <button class="vector-card__icon" :aria-label="t('relationship.vector.edit')" data-testid="vector-edit" @click="startEdit">✎</button>
          <button class="vector-card__icon" :aria-label="t('relationship.vector.remove')" data-testid="vector-remove" @click="removeEntry(name)">✕</button>
        </div>
        <dl class="vector-lines">
          <template v-for="line in LINES" :key="line">
            <template v-if="entry[line]">
              <dt :class="['vector-lines__label', { 'vector-lines__label--hidden': line === 'hidden' }]">
                <Tooltip v-if="line === 'hidden'" :text="t('relationship.vector.hiddenHint')" fixed>
                  <span>◐ {{ t(`relationship.vector.${line}`) }}</span>
                </Tooltip>
                <span v-else>{{ t(`relationship.vector.${line}`) }}</span>
              </dt>
              <dd class="vector-lines__text" :data-testid="`vector-line-${line}`">{{ entry[line] }}</dd>
            </template>
          </template>
        </dl>
      </template>
    </template>

    <!-- Edit view -->
    <div v-else class="vector-edit" data-testid="vector-edit-form">
      <label v-for="line in LINES" :key="line" class="vector-edit__row">
        <span :class="['vector-lines__label', { 'vector-lines__label--hidden': line === 'hidden' }]">{{ t(`relationship.vector.${line}`) }}</span>
        <input
          v-model="draft[line]"
          class="vector-edit__input"
          type="text"
          :maxlength="maxFor(line)"
          :placeholder="t(`relationship.vector.placeholder.${line}`)"
          :data-testid="`vector-input-${line}`"
          @keydown="onKeydown"
        >
        <span class="vector-edit__count">{{ draft[line].length }}/{{ maxFor(line) }}</span>
      </label>
      <div class="vector-edit__actions">
        <button class="vector-card__icon" :aria-label="t('relationship.vector.cancel')" @click="cancel">✕</button>
        <button class="vector-edit__save" data-testid="vector-save" @click="commit">{{ t('relationship.vector.save') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vector-card {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  border-left: 3px solid var(--color-sage-400);
  background: color-mix(in oklch, var(--color-sage-400) 5%, transparent);
  transition: opacity 0.2s ease, background 0.15s ease;
}
.vector-card:hover { background: color-mix(in oklch, var(--color-sage-400) 9%, transparent); }
.vector-card--off { opacity: 0.5; }
.vector-card--proposed { border-left-color: var(--color-amber-400); }

.vector-card__empty {
  width: 100%;
  background: none;
  border: 1px dashed color-mix(in oklch, var(--color-sage-400) 30%, transparent);
  border-radius: 6px;
  padding: 6px 8px;
  color: var(--color-text-muted);
  font: inherit;
  font-size: 0.78rem;
  text-align: left;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.vector-card__empty:hover { color: var(--color-sage-300); border-color: var(--color-sage-400); }

.vector-card__head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.7rem;
  color: var(--color-text-muted);
}
.vector-card__spacer { flex: 1; }
.vector-card__round { white-space: nowrap; }
.vector-badge {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 0.66rem;
  letter-spacing: 0.03em;
  backdrop-filter: blur(6px);
  background: color-mix(in oklch, var(--color-sage-400) 14%, transparent);
  color: var(--color-sage-300);
}
.vector-badge--proposed {
  background: color-mix(in oklch, var(--color-amber-400) 16%, transparent);
  color: var(--color-amber-400);
}
.vector-badge--accepted { background: color-mix(in oklch, var(--color-sage-400) 22%, transparent); }

.vector-card__icon {
  background: none;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 0.8rem;
  padding: 2px 4px;
  border-radius: 4px;
  transition: color 0.15s, background 0.15s;
}
.vector-card__icon:hover {
  color: var(--color-amber-400);
  background: color-mix(in oklch, var(--color-amber-400) 12%, transparent);
}

.vector-lines {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  column-gap: 8px;
  row-gap: 3px;
  margin: 6px 0 0;
  font-size: 0.8rem;
  line-height: 1.5;
}
.vector-lines__label {
  color: var(--color-text-muted);
  white-space: nowrap;
  font-size: 0.72rem;
  padding-top: 1px;
}
.vector-lines__label--hidden { color: var(--color-amber-400); }
.vector-lines__text { margin: 0; color: var(--color-text-secondary); overflow-wrap: anywhere; }

.vector-edit { display: flex; flex-direction: column; gap: 6px; }
.vector-edit__row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 8px;
}
.vector-edit__input {
  width: 100%;
  background: transparent;
  border: none;
  border-bottom: 1px dashed color-mix(in oklch, var(--color-sage-400) 35%, transparent);
  color: inherit;
  font: inherit;
  font-size: 0.82rem;
  padding: 3px 0;
  outline: none;
}
.vector-edit__input:focus { border-bottom-color: var(--color-sage-400); }
.vector-edit__input::placeholder { color: var(--color-text-muted); opacity: 0.7; }
.vector-edit__count { font-size: 0.66rem; color: var(--color-text-muted); }
.vector-edit__actions { display: flex; justify-content: flex-end; align-items: center; gap: 6px; }
.vector-edit__save {
  background: color-mix(in oklch, var(--color-sage-400) 18%, transparent);
  border: none;
  border-radius: 6px;
  color: var(--color-sage-300);
  font: inherit;
  font-size: 0.76rem;
  padding: 3px 10px;
  cursor: pointer;
  transition: background 0.15s;
}
.vector-edit__save:hover { background: color-mix(in oklch, var(--color-sage-400) 28%, transparent); }

@media (prefers-reduced-motion: reduce) {
  .vector-card, .vector-card__empty, .vector-card__icon, .vector-edit__save { transition: none; }
}
</style>
