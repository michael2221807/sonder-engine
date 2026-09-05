<script setup lang="ts">
// App doc: docs/user-guide/pages/game-prompts.md §叙事契约 (tab layout · clauses · focal cast)
// Design: docs/design/narrative-contract-positioning.md §4.4 · docs/design/narrative-contract-v1-implementation-plan.md S2
/**
 * NarrativeContractTab — the player's "melody" for this save.
 *
 * A handful of one-sentence clauses (a character's true colours, the main line, what only
 * the player may change) plus the focal cast the engine derives from the relationship
 * panel (「重点」 type ∪ 「关注」 eye toggle). Everything shown here is exactly what the
 * next round's prompt will carry in BOTH split steps (see the Prompt Assembly panel).
 *
 * Nothing is explained in prose: the clause list IS the contract, the cast chips ARE the
 * list, and the empty state is one sentence.
 */
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useNarrativeContract, CONTRACT_CLAUSE_MAX_CHARS } from '@/ui/composables/useNarrativeContract';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

const { t } = useI18n();
const router = useRouter();
const { clauses, enabled, focalCast, setEnabled, addClause, updateClauseText, toggleClause, removeClause } = useNarrativeContract();

// ─── New clause draft ───
const draft = ref('');
const draftLength = computed(() => draft.value.trim().length);
const draftTooLong = computed(() => draftLength.value > CONTRACT_CLAUSE_MAX_CHARS);
const canAdd = computed(() => draftLength.value > 0 && !draftTooLong.value);

function submitDraft(): void {
  if (!canAdd.value) return;
  if (addClause(draft.value)) draft.value = '';
}

/** Enter adds; Shift+Enter keeps the newline (a clause is one sentence, but let people breathe). */
function onDraftKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitDraft();
  }
}

// ─── Inline edit of an existing clause (commit on blur / Enter) ───
function commitEdit(id: string, event: Event): void {
  const el = event.target as HTMLTextAreaElement;
  if (!updateClauseText(id, el.value)) {
    // Blank or over-long: restore the stored text rather than persisting garbage.
    el.value = clauses.value.find((c) => c.id === id)?.text ?? '';
  }
}

function onEditKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    (e.target as HTMLTextAreaElement).blur();
  }
}

function goRelationships(): void {
  void router.push({ name: 'Relationships' });
}
</script>

<template>
  <div class="contract-tab" data-testid="contract-tab">
    <!-- Header: master switch + one-line why -->
    <div class="contract-head">
      <Tooltip :text="t('prompt.contract.enabledHint')" interactive>
        <AgaToggle
          :model-value="enabled"
          :label="t('prompt.contract.enabled')"
          show-label
          data-testid="contract-enabled"
          @update:model-value="setEnabled"
        />
      </Tooltip>
      <p class="contract-lede">{{ t('prompt.contract.lede') }}</p>
    </div>

    <div :class="['contract-body', { 'contract-body--off': !enabled }]">
      <!-- Clauses -->
      <section class="contract-section">
        <h4 class="contract-section__title">{{ t('prompt.contract.clauses') }}</h4>

        <p v-if="clauses.length === 0" class="contract-empty">{{ t('prompt.contract.empty') }}</p>

        <ol v-else class="contract-list">
          <li
            v-for="(clause, i) in clauses"
            :key="clause.id"
            :class="['contract-clause', { 'contract-clause--off': !clause.enabled, 'contract-clause--proposed': clause.source === 'proposed' }]"
            data-testid="contract-clause-row"
          >
            <span class="contract-clause__index">{{ i + 1 }}</span>
            <textarea
              class="contract-clause__text"
              rows="2"
              :value="clause.text"
              :maxlength="CONTRACT_CLAUSE_MAX_CHARS"
              :aria-label="t('prompt.contract.clauseAria', { n: i + 1 })"
              @blur="commitEdit(clause.id, $event)"
              @keydown="onEditKeydown"
            />
            <div class="contract-clause__meta">
              <span :class="['contract-badge', `contract-badge--${clause.source}`]">{{ t(`prompt.contract.source.${clause.source}`) }}</span>
              <span class="contract-clause__round">{{ t('prompt.contract.round', { n: clause.createdRound }) }}</span>
            </div>
            <div class="contract-clause__actions">
              <AgaToggle
                :model-value="clause.enabled"
                :label="t('prompt.contract.clauseEnabled', { n: i + 1 })"
                @update:model-value="toggleClause(clause.id)"
              />
              <button class="contract-clause__delete" :aria-label="t('prompt.contract.remove')" @click="removeClause(clause.id)">✕</button>
            </div>
          </li>
        </ol>

        <!-- Draft: a new clause -->
        <div class="contract-draft">
          <textarea
            v-model="draft"
            class="contract-draft__input"
            rows="2"
            :placeholder="t('prompt.contract.placeholder')"
            :aria-label="t('prompt.contract.placeholder')"
            data-testid="contract-clause-input"
            @keydown="onDraftKeydown"
          />
          <div class="contract-draft__row">
            <span :class="['contract-draft__count', { 'contract-draft__count--over': draftTooLong }]">
              {{ draftLength }} / {{ CONTRACT_CLAUSE_MAX_CHARS }}
            </span>
            <AgaButton variant="primary" size="sm" :disabled="!canAdd" data-testid="contract-clause-add" @click="submitDraft">
              {{ t('prompt.contract.add') }}
            </AgaButton>
          </div>
        </div>
      </section>

      <!-- Focal cast (derived, read-only) -->
      <section class="contract-section">
        <div class="contract-section__head">
          <h4 class="contract-section__title">{{ t('prompt.contract.cast') }}</h4>
          <!-- `fixed`: this sits inside the scrolling `.contract-body` (CLAUDE.md §8.1). -->
          <Tooltip :text="t('prompt.contract.castHint')" interactive fixed>
            <button class="contract-link" @click="goRelationships">{{ t('prompt.contract.castEdit') }}</button>
          </Tooltip>
        </div>
        <p v-if="focalCast.length === 0" class="contract-empty">{{ t('prompt.contract.castEmpty') }}</p>
        <div v-else class="contract-cast">
          <span v-for="name in focalCast" :key="name" class="contract-cast__chip" data-testid="contract-cast-chip">{{ name }}</span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.contract-tab {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  min-height: 0;
}

.contract-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}
.contract-lede {
  margin: 0;
  font-size: 0.82rem;
  color: var(--color-text-muted);
  line-height: 1.5;
}

.contract-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
  overflow-y: auto;
  min-height: 0;
  transition: opacity 0.25s ease;
}
.contract-body--off { opacity: 0.45; }
.contract-body::-webkit-scrollbar { width: 4px; }
.contract-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

.contract-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.contract-section__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.contract-section__title {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--color-text-secondary);
  text-transform: uppercase;
}

.contract-empty {
  margin: 0;
  font-size: 0.82rem;
  color: var(--color-text-muted);
  padding: 12px 0;
}

/* ─── Clauses ─── */
.contract-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.contract-clause {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-areas:
    'index text actions'
    'index meta actions';
  column-gap: 10px;
  row-gap: 4px;
  align-items: start;
  padding: 10px 12px;
  border-left: 3px solid var(--color-sage-400);
  border-radius: 8px;
  background: color-mix(in oklch, var(--color-sage-400) 5%, transparent);
  transition: opacity 0.2s ease, background 0.15s ease;
}
.contract-clause:hover { background: color-mix(in oklch, var(--color-sage-400) 9%, transparent); }
.contract-clause--off { opacity: 0.5; }
.contract-clause--proposed { border-left-color: var(--color-amber-400); }

.contract-clause__index {
  grid-area: index;
  font-size: 0.8rem;
  color: var(--color-text-muted);
  padding-top: 6px;
  min-width: 1.2em;
  text-align: right;
}
.contract-clause__text {
  grid-area: text;
  width: 100%;
  resize: vertical;
  background: transparent;
  border: none;
  border-bottom: 1px dashed color-mix(in oklch, var(--color-sage-400) 35%, transparent);
  color: inherit;
  font: inherit;
  font-size: 0.9rem;
  line-height: 1.55;
  padding: 4px 0;
  outline: none;
}
.contract-clause__text:focus { border-bottom-color: var(--color-sage-400); }

.contract-clause__meta {
  grid-area: meta;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.72rem;
  color: var(--color-text-muted);
}
.contract-badge {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 0.68rem;
  letter-spacing: 0.03em;
  backdrop-filter: blur(6px);
  background: color-mix(in oklch, var(--color-sage-400) 14%, transparent);
  color: var(--color-sage-300);
}
.contract-badge--proposed {
  background: color-mix(in oklch, var(--color-amber-400) 16%, transparent);
  color: var(--color-amber-400);
}
.contract-badge--accepted {
  background: color-mix(in oklch, var(--color-sage-400) 22%, transparent);
}

.contract-clause__actions {
  grid-area: actions;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 4px;
}
.contract-clause__delete {
  background: none;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 0.8rem;
  padding: 2px 4px;
  border-radius: 4px;
  transition: color 0.15s, background 0.15s;
}
.contract-clause__delete:hover {
  color: var(--color-amber-400);
  background: color-mix(in oklch, var(--color-amber-400) 12%, transparent);
}

/* ─── Draft ─── */
.contract-draft {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px dashed color-mix(in oklch, var(--color-sage-400) 30%, transparent);
}
.contract-draft__input {
  width: 100%;
  resize: vertical;
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  font-size: 0.9rem;
  line-height: 1.55;
  outline: none;
}
.contract-draft__input::placeholder { color: var(--color-text-muted); opacity: 0.8; }
.contract-draft__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.contract-draft__count { font-size: 0.72rem; color: var(--color-text-muted); }
.contract-draft__count--over { color: var(--color-amber-400); }

/* ─── Cast ─── */
.contract-link {
  background: none;
  border: none;
  padding: 0;
  font-size: 0.75rem;
  color: var(--color-sage-300);
  cursor: pointer;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}
.contract-link:hover { color: var(--color-sage-400); }
.contract-cast {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.contract-cast__chip {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 0.8rem;
  backdrop-filter: blur(6px);
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
  color: var(--color-text-secondary);
}

@media (prefers-reduced-motion: reduce) {
  .contract-body, .contract-clause { transition: none; }
}
</style>
