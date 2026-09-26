<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md · Optional plot-vector board
import { computed, inject, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { cloneDeep } from 'lodash-es';
import Modal from '../common/Modal.vue';
import AgaButton from '../shared/AgaButton.vue';
import Tooltip from '../shared/Tooltip.vue';
import { eventBus } from '@/engine/core/event-bus';
import type { VectorBoardAccess, BoardView } from '@/features/plot-vector/board-access';
import type { PreparedVector } from '@/features/plot-vector/runtime';
import type { CardProgress } from '@/features/plot-vector/card-progress';
import type { Layout, LocalizedLabel } from '@/engine/plot-vector/core/types';
import { cardTripReceipt } from '@/features/plot-vector/card-trip-receipt';
import { readPlotVectorControl, subscribePlotVectorControl } from '@/engine/plot-vector/feature-control';
import { availableUses, stateOf } from '@/engine/plot-vector/core/card-state';

const props = defineProps<{ generating: boolean }>();
const { t, locale } = useI18n();
const access = inject<VectorBoardAccess | undefined>('plotVectorBoard', undefined);
const enabled = ref(readPlotVectorControl().enabled), open = ref(false), busy = ref(false);
const view = shallowRef<BoardView>(), shown = shallowRef<PreparedVector>();
const layout = ref<Layout>({ placements: {}, tray: [] });
const dirty = ref(false), error = ref(false), saved = ref(false), last = ref(false), cursor = ref(0);
let request = 0;
onUnmounted(subscribePlotVectorControl(() => {
  enabled.value = readPlotVectorControl().enabled;
  open.value = false;
}));
onUnmounted(() => { request++; });
// New cards since the board was last opened (I24): the entry shows how many; opening it clears the count.
const newCards = ref(0);
onUnmounted(eventBus.on<{ names?: string[] }>('plotVector:cards-gained', e => { newCards.value += e?.names?.length ?? 1; }));
watch(open, value => { if (!value) { request++; busy.value = false; } });
watch(() => props.generating, value => { if (value) open.value = false; });
const label = (value?: LocalizedLabel) => value ? (locale.value === 'en' ? value.en : value.zh) : '';
const board = computed(() => shown.value?.board ?? view.value?.prepared.board);
// The hand: automatic status/environment cards are never chosen by hand; a basic card with no uses left waits for its top-up.
const editableCards = computed(() => view.value?.prepared.board.cards.filter(c => c.origin !== 'effect' && c.origin !== 'environment'
  && (!c.usage || availableUses(c, stateOf(c, view.value?.state.session.cardStates)) > 0)) ?? []);
// Obtained entries whose ability is not usable yet: shown as text with a retry, never as a playable card.
const backlog = computed(() => view.value?.backlog ?? []);
const retrying = ref<string | null>(null);
const retryNote = ref<'bound' | 'failed' | 'error' | null>(null);
const starting = computed(() => last.value ? shown.value?.starting : view.value?.prepared.starting);
const weather = computed(() => (board.value?.cards ?? []).filter(c => c.origin === 'environment'));
const progress = computed(() => last.value ? shown.value?.progress : view.value?.prepared.progress);
const number = (value: number) => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 2 }).format(value);
const channelLabel = (target: string) => {
  const key = ({ 'S+': 'push', 'S-': 'resistance', Y: 'relations', J: 'chances', visits: 'steps' } as Record<string, string>)[target];
  return key ? t(`mainGame.vectorBoard.${key}`) : target;
};
const progressLabel = (row: CardProgress['rows'][number]) => t(({ uses: 'mainGame.vectorBoard.usesLeft', level: 'mainGame.vectorBoard.level', stored: 'mainGame.vectorBoard.stored' } as const)[row.key]);
const visits = computed(() => shown.value?.result.trace.filter(e => e.eventType === 'visitComplete') ?? []);
const current = computed(() => visits.value[Math.max(0, cursor.value - 1)]);
const triggered = computed(() => cursor.value ? shown.value?.result.trace.filter(e =>
  e.visitId === current.value?.visitId && e.owner?.kind === 'card' && e.status === 'applied' && (e.cardEffects?.length ?? 0) > 0)
  .map(e => label(board.value?.cards.find(c => c.id === e.owner?.id)?.label)) ?? [] : []);
const displayedLayout = computed(() => last.value ? shown.value!.layout : layout.value);
const cardAt = (cell: string) => board.value?.cards.find(c => c.id === displayedLayout.value.placements[cell]);
const tripReceipts = computed(() => Object.fromEntries((board.value?.cards ?? []).map(card =>
  [card.id, shown.value ? cardTripReceipt(shown.value.result.trace, card.id) : null])));
const receiptNumber = (value: number) => value > 0 && value < 0.0000005 ? '<0.000001'
  : new Intl.NumberFormat(locale.value, { maximumFractionDigits: 6 }).format(value);
function receiptText(cardId: string): string {
  const receipt = tripReceipts.value[cardId];
  if (!receipt) return '';
  const prefix = t(last.value ? 'mainGame.vectorBoard.receiptAccepted' : 'mainGame.vectorBoard.receiptPreview');
  if (!receipt.activations) return `${prefix}：${t('mainGame.vectorBoard.receiptNotTriggered')}`;
  const parts = [t('mainGame.vectorBoard.receiptTriggers', { count: receipt.activations })];
  for (const [channel, change] of Object.entries(receipt.shuttleChanges)) {
    if (Math.abs(change) < 1e-9) continue;
    parts.push(`${channelLabel(channel)}${change > 0 ? '+' : '−'}${receiptNumber(Math.abs(change))}`);
  }
  if (receipt.stored > 1e-9) parts.push(t('mainGame.vectorBoard.receiptStored', { amount: receiptNumber(receipt.stored) }));
  if (receipt.released > 1e-9) parts.push(t('mainGame.vectorBoard.receiptReleased', { amount: receiptNumber(receipt.released) }));
  if (receipt.otherEffects.includes('route')) parts.push(t('mainGame.vectorBoard.receiptRoute'));
  if (parts.length === 1) parts.push(t('mainGame.vectorBoard.receiptNoChange'));
  return `${prefix}：${parts.join(' · ')}`;
}
const disabled = computed(() => busy.value || props.generating);
async function load() {
  if (!access || props.generating) return;
  const ticket = ++request;
  newCards.value = 0;
  open.value = true; busy.value = true; error.value = false; saved.value = false;
  view.value = undefined; shown.value = undefined; last.value = false; dirty.value = false;
  try {
    const result = await access.open();
    if (ticket !== request) return;
    view.value = result; layout.value = cloneDeep(result.prepared.layout);
    shown.value = result.prepared; cursor.value = 0;
    // The saved arrangement did not compute and is shown cleared: saving keeps it that way.
    dirty.value = result.cleared;
  } catch { if (ticket === request) error.value = true; }
  finally { if (ticket === request) busy.value = false; }
}
function place(cell: string, id: string | null) {
  if (id) for (const key of Object.keys(layout.value.placements)) {
    if (layout.value.placements[key] === id) layout.value.placements[key] = null;
  }
  layout.value.placements[cell] = id;
}
function arranged() {
  layout.value.tray = editableCards.value.filter(c => !Object.values(layout.value.placements).includes(c.id)).map(c => c.id);
  dirty.value = true; saved.value = false; shown.value = undefined; cursor.value = 0;
  // The existing local preview is pure; show the card's actual effect without an extra player click.
  void calculate(false);
}
function choose(cell: string, event: Event) {
  place(cell, (event.target as HTMLSelectElement).value || null);
  arranged();
}
/** Take every chosen card off the board (the automatic status cell is not the player's). */
function clearBoard() {
  for (const cell of Object.keys(layout.value.placements)) if (cell !== '06') place(cell, null);
  arranged();
}
const hasPlaced = computed(() => Object.entries(layout.value.placements).some(([cell, id]) => cell !== '06' && !!id));
async function calculate(save: boolean) {
  if (!view.value || disabled.value) return;
  const ticket = ++request;
  busy.value = true; error.value = false;
  try {
    if (save) {
      await view.value.save(cloneDeep(layout.value));
      if (ticket !== request) return;
      await load(); saved.value = true;
    } else {
      const result = await view.value.preview(cloneDeep(layout.value));
      if (ticket !== request) return;
      shown.value = result; cursor.value = 0;
    }
  } catch { if (ticket === request) error.value = true; }
  finally { if (ticket === request) busy.value = false; }
}
function showLast() {
  const accepted = view.value?.state.last;
  if (!accepted) return;
  last.value = true; shown.value = { ...accepted, prompt: '', growth: {} }; cursor.value = 0;
}
function showDraft() { last.value = false; shown.value = dirty.value ? undefined : view.value?.prepared; cursor.value = 0; }
async function retryAbility(entryId: string) {
  if (!access || disabled.value || retrying.value) return;
  retrying.value = entryId; retryNote.value = null;
  try { retryNote.value = (await access.regenerate(entryId)).bound ? 'bound' : 'failed'; }
  catch { retryNote.value = 'error'; }
  finally { retrying.value = null; }
  await load();
}
</script>

<template>
  <Tooltip v-if="enabled && access" :text="t('mainGame.vectorBoard.openHint')" interactive>
    <AgaButton size="sm" variant="secondary" :disabled="generating" data-testid="vector-board-open" @click="load">
      {{ t('mainGame.vectorBoard.open') }}<span v-if="newCards" class="new-cards" data-testid="vector-new-cards" :aria-label="t('mainGame.vectorBoard.newCards', { count: newCards })">{{ newCards }}</span>
    </AgaButton>
  </Tooltip>
  <Modal v-model="open" :title="t('mainGame.vectorBoard.title')" width="960px" :closable="!busy">
    <section data-testid="vector-board" class="vector-board" :aria-busy="busy">
      <p class="intro">{{ t('mainGame.vectorBoard.help') }}</p>
      <p v-if="busy" role="status">{{ t('mainGame.vectorBoard.loading') }}</p>
      <p v-if="error" role="alert">{{ t('mainGame.vectorBoard.error') }} <AgaButton size="sm" :disabled="busy" @click="load">{{ t('mainGame.vectorBoard.reload') }}</AgaButton></p>
      <p v-if="saved" role="status">{{ t('mainGame.vectorBoard.saved') }}</p>
      <p v-if="view?.cleared && dirty" role="status" data-testid="vector-board-cleared">{{ t('mainGame.vectorBoard.layoutCleared') }}</p>
      <template v-if="view && board">
        <section v-if="backlog.length || retryNote" class="backlog" data-testid="vector-ability-backlog">
          <details v-if="backlog.length" :open="backlog.length <= 3">
            <summary>{{ t('mainGame.vectorBoard.backlogSummary', { count: backlog.length }) }}</summary>
            <p class="intro">{{ t('mainGame.vectorBoard.backlogHelp') }}</p>
            <div v-for="entry in backlog" :key="entry.id" class="backlog-row">
              <strong>{{ entry.name }}</strong>
              <span class="backlog-state">{{ t(`mainGame.vectorBoard.backlogState.${entry.state}`) }}</span>
              <AgaButton size="sm" variant="secondary" :disabled="disabled || retrying !== null" data-testid="vector-ability-retry" @click="retryAbility(entry.id)">
                {{ retrying === entry.id ? t('mainGame.vectorBoard.retryingAbility') : t('mainGame.vectorBoard.retryAbility') }}
              </AgaButton>
            </div>
          </details>
          <p v-if="retryNote" role="status" data-testid="vector-ability-retry-result">{{ t(`mainGame.vectorBoard.retryResult.${retryNote}`) }}</p>
        </section>
        <details><summary>{{ t('mainGame.vectorBoard.boardRule') }}</summary><p>{{ t('mainGame.vectorBoard.demoRule') }}</p></details>
        <div class="actions">
          <AgaButton size="sm" :variant="!last ? 'primary' : 'ghost'" :disabled="disabled" @click="showDraft">{{ t('mainGame.vectorBoard.next') }}</AgaButton>
          <AgaButton size="sm" :variant="last ? 'primary' : 'ghost'" :disabled="disabled || !view.state.last" @click="showLast">{{ t('mainGame.vectorBoard.last') }}</AgaButton>
        </div>
        <details v-if="starting" data-testid="vector-native">
          <summary>{{ t('mainGame.vectorBoard.native', { steps: starting.visitBudget, push: number(starting.payload['S+'] ?? 0), relations: number(starting.payload.Y ?? 0), chances: number(starting.payload.J ?? 0) }) }}</summary>
          <p>{{ t('mainGame.vectorBoard.nativeHelp') }}</p>
          <p v-for="(row, index) in starting.contributions" :key="index">{{ label(row.label) }} · {{ row.value === null ? t('mainGame.vectorBoard.missingAttribute') : number(row.value) }} → {{ channelLabel(row.target) }} +{{ number(row.amount) }}</p>
        </details>
        <p v-if="weather.length" class="intro" data-testid="vector-weather">{{ t('mainGame.vectorBoard.weather', { cards: weather.map(c => `${label(c.label)}（${label(c.summary ?? c.originalText)}）`).join('；') }) }}</p>
        <p v-if="!editableCards.length && !last" class="intro">{{ t('mainGame.vectorBoard.empty') }}</p>
        <ol class="track">
          <li v-for="cell in board.cells" :key="cell.id" :class="{ active: cursor > 0 && current?.cellId === cell.id }" :data-cell="cell.id">
            <header><span>{{ cell.id }}</span><strong>{{ cell.id === '06' ? t('mainGame.vectorBoard.statusCell') : label(cell.label) }}</strong><span v-if="cursor > 0 && current?.cellId === cell.id" :aria-label="t('mainGame.vectorBoard.shuttle')">◆</span></header>
            <label v-if="cell.id !== '06' && !last">
              <span class="sr-only">{{ t('mainGame.vectorBoard.choose', { cell: cell.id }) }}</span>
              <select :value="layout.placements[cell.id] ?? ''" :disabled="disabled" @change="choose(cell.id, $event)">
                <option value="">{{ t('mainGame.vectorBoard.leaveEmpty') }}</option>
                <option v-for="card in editableCards" :key="card.id" :value="card.id">{{ label(card.label) }}{{ card.origin === 'supply' ? ` · ${t('mainGame.vectorBoard.basicSupply')}` : '' }}</option>
              </select>
            </label>
            <p v-else>{{ label(cardAt(cell.id)?.label) || t('mainGame.vectorBoard.leaveEmpty') }}</p>
            <p v-if="cardAt(cell.id)?.summary" class="trip-receipt">{{ label(cardAt(cell.id)?.summary) }}</p>
            <p v-if="cardAt(cell.id)" class="description">{{ label(cardAt(cell.id)?.originalText) }}</p>
            <p v-if="cardAt(cell.id) && receiptText(cardAt(cell.id)!.id)" class="trip-receipt">{{ receiptText(cardAt(cell.id)!.id) }}</p>
            <p v-for="row in progress?.find(p => p.cardId === cardAt(cell.id)?.id)?.rows ?? []" :key="row.key" class="progress">
              {{ progressLabel(row) }} {{ number(row.value) }}<span v-if="row.max !== undefined"> / {{ number(row.max) }}</span><span v-if="row.delta"> ({{ row.delta > 0 ? '+' : '' }}{{ number(row.delta) }})</span>
            </p>
            <small v-if="cell.id === '06'">{{ t('mainGame.vectorBoard.status') }}</small>
            <details v-if="cell.effects.length"><summary>{{ t('mainGame.vectorBoard.cellRule') }}</summary><p v-for="effect in cell.effects" :key="effect.id">{{ label(effect.label) }}</p></details>
          </li>
        </ol>
        <details v-if="progress?.length" data-testid="vector-progress">
          <summary>{{ t(last ? 'mainGame.vectorBoard.acceptedProgress' : 'mainGame.vectorBoard.savedProgress') }}</summary>
          <p v-if="!last">{{ t('mainGame.vectorBoard.progressHelp') }}</p>
          <div v-for="card in progress" :key="card.cardId" class="progress-row">
            <strong>{{ card.name }}</strong>
            <span v-for="row in card.rows" :key="row.key">{{ progressLabel(row) }} {{ number(row.value) }}<span v-if="row.max !== undefined"> / {{ number(row.max) }}</span><span v-if="row.delta"> ({{ row.delta > 0 ? '+' : '' }}{{ number(row.delta) }})</span></span>
          </div>
        </details>
        <div v-if="!last" class="actions">
          <AgaButton size="sm" variant="secondary" :disabled="disabled" data-testid="vector-preview" @click="calculate(false)">{{ t('mainGame.vectorBoard.preview') }}</AgaButton>
          <AgaButton size="sm" :disabled="disabled || !dirty" data-testid="vector-save" @click="calculate(true)">{{ t('mainGame.vectorBoard.save') }}</AgaButton>
          <AgaButton size="sm" variant="ghost" :disabled="disabled || !hasPlaced" data-testid="vector-clear" @click="clearBoard">{{ t('mainGame.vectorBoard.clear') }}</AgaButton>
          <span v-if="dirty">{{ t('mainGame.vectorBoard.unsaved') }}</span>
        </div>
        <template v-if="shown">
          <p>{{ t(last ? 'mainGame.vectorBoard.accepted' : 'mainGame.vectorBoard.prediction', { count: shown.result.visits }) }}</p>
          <label class="replay">{{ t('mainGame.vectorBoard.step', { step: cursor, count: visits.length }) }}
            <input v-model.number="cursor" type="range" min="0" :max="visits.length" step="1" :aria-label="t('mainGame.vectorBoard.replay')">
          </label>
          <p class="path">{{ visits.slice(0, cursor).map(e => e.cellId).join(' → ') || t('mainGame.vectorBoard.start') }}</p>
          <p v-if="triggered.length">{{ t('mainGame.vectorBoard.triggered', { cards: triggered.join(' · ') }) }}</p>
          <dl class="dimensions"><div v-for="dimension in board.dimensions" :key="dimension.id"><dt>{{ label(dimension.label) }}</dt><dd>{{ (shown.result.vectorPacket.dimensions[dimension.id] ?? 0).toFixed(2) }}</dd></div></dl>
          <p class="intro">{{ t('mainGame.vectorBoard.meaning') }}</p>
        </template>
      </template>
    </section>
  </Modal>
</template>

<style scoped>
.vector-board { display: grid; gap: 1rem; min-width: 0; }
p { margin: 0; line-height: 1.65; overflow-wrap: anywhere; }
.intro, small, .description { color: var(--color-text-secondary); font-size: .85rem; }
.trip-receipt { color: var(--color-text-primary); font-size: .85rem; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; }
.track { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; }
.track li { min-width: 0; padding: 1rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); display: flex; flex-direction: column; gap: .6rem; }
.track li.active { border-color: var(--color-primary); background: var(--color-surface-elevated); }
header { display: flex; gap: .5rem; align-items: center; }
header > span:first-child { font-family: var(--font-mono); color: var(--color-text-secondary); }
select { width: 100%; min-height: 44px; padding: .4rem; color: var(--color-text); background: var(--color-surface-input); border: 1px solid var(--color-border); border-radius: var(--radius-sm); }
summary { cursor: pointer; font-size: .8rem; }
details p { margin-top: .5rem; font-size: .8rem; }
.replay { display: grid; gap: .5rem; }
.replay input { width: 100%; min-height: 30px; accent-color: var(--color-primary); }
.path { font-family: var(--font-mono); font-size: .8rem; }
.progress { color: var(--color-primary); font-size: .85rem; }
.progress-row { display: flex; flex-wrap: wrap; gap: .5rem 1rem; padding-top: .6rem; font-size: .85rem; }
.backlog { display: grid; gap: .5rem; }
.backlog-row { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; font-size: .85rem; }
.backlog-state { color: var(--color-text-secondary); }
.backlog details { display: grid; gap: .5rem; }
.backlog-row + .backlog-row, .backlog .intro { margin-top: .5rem; }
.new-cards { margin-left: .35rem; font-family: var(--font-mono); font-size: .62rem; font-weight: 700; line-height: 1; color: var(--color-amber-300); }
.dimensions { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: 0; }
.dimensions dd { margin: .2rem 0 0; font-family: var(--font-mono); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
@media (max-width: 600px) { .track { grid-template-columns: 1fr; } }
</style>
