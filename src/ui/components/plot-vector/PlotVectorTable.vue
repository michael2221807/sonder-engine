<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md · Plot-vector card table
/**
 * The plot-vector card table (rebuild plan phase 7; PO 2026-09-27 1A 2A 3A 4A, animation A, rarity A;
 * PO 2026-09-29 both board shapes; approved demo docs/demo/plot-vector-board.html). A miniature of the board sits
 * beside the input; it opens a table from the bottom, the story still in view. Cards move by hand, a placed card
 * walks the board at once, and the arrangement saves itself in the background. Numbers stay behind the "?".
 */
import { computed, inject, nextTick, onBeforeUnmount, onUnmounted, reactive, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { cloneDeep } from 'lodash-es';
import Tooltip from '../shared/Tooltip.vue';
import VectorBadge from './VectorBadge.vue';
import VectorTrack from './VectorTrack.vue';
import VectorCardFace from './VectorCardFace.vue';
import VectorCardDetail from './VectorCardDetail.vue';
import VectorHelpPanel from './VectorHelpPanel.vue';
import { prefersReducedMotion, useTripWalk } from './use-trip-walk';
import { useCardDrag, type DropTarget } from './use-card-drag';
import { useBackdropClose } from '@/ui/composables/useBackdropClose';
import { useGameState } from '@/ui/composables/useGameState';
import { eventBus } from '@/engine/core/event-bus';
import { DEFAULT_ENGINE_PATHS as P } from '@/engine/pipeline/types';
import { readPlotVectorControl, subscribePlotVectorControl } from '@/engine/plot-vector/feature-control';
import type { Layout, LocalizedLabel } from '@/engine/plot-vector/core/types';
import type { VectorBoardAccess, BoardView } from '@/features/plot-vector/board-access';
import { readVectorState, type PreparedVector } from '@/features/plot-vector/runtime';
import { readBoardShape, type BoardShape } from '@/features/plot-vector/vector-board';
import { SIX_CELL_RING_ID } from '@/features/plot-vector/default-board';
import { arrange, sweep, tableModel, tripWalk, type TableModel } from '@/features/plot-vector/table-model';
import { cardTripReceipt } from '@/features/plot-vector/card-trip-receipt';

const props = defineProps<{ generating: boolean }>();
const { t, locale } = useI18n();
const label = (value?: LocalizedLabel) => value ? (locale.value === 'en' ? value.en : value.zh) : '';
const access = inject<VectorBoardAccess | undefined>('plotVectorBoard', undefined);
const enabled = ref(readPlotVectorControl().enabled);

// ── Per-viewer conveniences (not game state): the two switches in "?", and which cards were already seen. ──
const PREFS_KEY = 'aga:plotVector:table';
function readPrefs(): { animate: boolean; exact: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
    return { animate: raw.animate !== false, exact: raw.exact === true };
  } catch { return { animate: true, exact: false }; }
}
const prefs = reactive(readPrefs());
watch(prefs, value => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(value)); } catch { /* storage unavailable */ } });
const seenKey = (slot: string) => `aga:plotVector:seen:${slot}`;
function readSeen(slot: string): Set<string> | null {
  try { const raw = localStorage.getItem(seenKey(slot)); return raw ? new Set(JSON.parse(raw) as string[]) : null; } catch { return null; }
}
function writeSeen(slot: string, ids: Iterable<string>): void {
  try { localStorage.setItem(seenKey(slot), JSON.stringify([...ids])); } catch { /* storage unavailable */ }
}

// ── The closed badge reads the saved board straight from the state (no copy of the tree). ──
const { useValue } = useGameState();
const stored = useValue<unknown>(P.plotVector);
const storedState = computed(() => (stored.value ? readVectorState(stored.value) : null));
const storedShape = computed<BoardShape>(() => readBoardShape(storedState.value?.shape));
const newCards = ref(0);
onUnmounted(eventBus.on<{ names?: string[] }>('plotVector:cards-gained', e => { newCards.value += e?.names?.length ?? 1; }));
const badgeLit = ref<string | null>(null);

// ── The table ──
const open = ref(false);
const loading = ref(false);
const view = shallowRef<BoardView>();
const prepared = shallowRef<PreparedVector>();
const layout = ref<Layout>({ placements: {}, tray: [] });
const shape = ref<BoardShape>('line');
const note = ref<'cleared' | 'openFailed' | 'saveFailed' | 'reopened' | null>(null);
const selected = ref<string | null>(null);
const fresh = ref<ReadonlySet<string>>(new Set());
const helpOpen = ref(false);
const saved = ref(false);
const replaying = shallowRef<TableModel | null>(null);
const walk = useTripWalk();
/** With reduced motion the table simply appears and goes: no sliding classes at all. */
const motion = !prefersReducedMotion();

const model = computed(() => (view.value && prepared.value ? tableModel(view.value, prepared.value, layout.value, shape.value) : null));
const shown = computed(() => replaying.value ?? model.value);
const locked = computed(() => props.generating);
const hasPlaced = computed(() => !!model.value?.cells.some(c => c.role !== 'status' && c.card));
const placeable = computed(() => new Set(model.value ? [...model.value.hand, ...model.value.cells.filter(c => c.role !== 'status' && c.card).map(c => c.card!)] : []));
const canPlace = (card: string) => !locked.value && !replaying.value && placeable.value.has(card) && !model.value?.cards[card]?.resting;

const badgeCells = computed(() => {
  const s = storedState.value;
  const placements = s?.layout?.placements ?? {};
  const status = s?.last?.layout.placements['06'];
  return ['01', '02', '03', '04', '05', '06'].map(id => ({
    id, state: (id === '06' ? (status ? 'status' : 'empty') : placements[id] ? 'card' : 'empty') as 'empty' | 'card' | 'status',
  }));
});

onUnmounted(subscribePlotVectorControl(() => {
  enabled.value = readPlotVectorControl().enabled;
  if (!enabled.value) close();
}));

async function load(opts: { seen?: boolean } = { seen: true }): Promise<void> {
  if (!access) return;
  loading.value = true;
  try {
    const next = await access.open();
    view.value = next;
    prepared.value = next.prepared;
    layout.value = cloneDeep(next.prepared.layout);
    shape.value = readBoardShape(next.state.shape);
    note.value = next.cleared ? 'cleared' : null;
    // Only a table the player looks at marks its cards as seen.
    if (opts.seen) markFresh(next);
    walk.settle(tripWalk(next.prepared.result));
    // A saved arrangement that no longer computes was taken off: keep it that way for the next round.
    if (next.cleared) { dirty = true; scheduleSave(0); }
  } catch {
    view.value = undefined;
    note.value = 'openFailed';
  } finally { loading.value = false; }
}
function markFresh(next: BoardView): void {
  const slot = next.prepared.id.split('/').slice(0, 2).join('/');
  const ids = [...next.prepared.board.cards.map(c => c.id), ...next.backlog.map(b => b.id)];
  const seen = readSeen(slot);
  fresh.value = new Set(seen ? ids.filter(id => !seen.has(id)) : []);
  writeSeen(slot, ids);
}

// Focus moves into the table when it opens; it returns to the badge only for a keyboard user (a mouse user
// would otherwise see the badge's hint pop up again).
const sheet = ref<HTMLElement>();
let returnFocus: HTMLElement | null = null;
async function openTable(event?: MouseEvent): Promise<void> {
  if (!access || !enabled.value) return;
  returnFocus = event && event.detail === 0 && event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  open.value = true;
  newCards.value = 0;
  helpOpen.value = false;
  await nextTick();
  sheet.value?.focus({ preventScroll: true });
  if (!props.generating) await load();
}
function close(): void {
  if (!open.value) return;
  open.value = false;
  selected.value = null;
  detail.value = null;
  helpOpen.value = false;
  replaying.value = null;
  clearTimeout(hoverTimer);
  walk.stop();
  void flushSave();
  if (returnFocus) returnFocus.focus({ preventScroll: true });
  else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  returnFocus = null;
}
// A round ends: the board changed under the view (uses, new cards), so read it again. A move the player made
// just before the round began and that could not be saved in time is put back and saved now.
watch(() => props.generating, (now, before) => {
  if (now) { selected.value = null; detail.value = null; return; }
  if (!before) return;
  if (dirty) void restoreAfter();
  else if (open.value) void load();
});
async function restoreAfter(): Promise<void> {
  const keep = cloneDeep(layout.value), keepShape = shape.value;
  await load({ seen: open.value });
  if (!view.value) return;
  layout.value = keep;
  shape.value = keepShape;
  await changed();
  if (!open.value) void flushSave();
}

// ── Moving cards: every move walks the board and saves itself ──
let changeSeq = 0;
async function changed(opts: { walkDelay?: number } = {}): Promise<void> {
  const current = view.value;
  if (!current) return;
  const mine = ++changeSeq;
  note.value = null;
  try {
    const next = await current.preview(cloneDeep(layout.value), shape.value);
    if (mine !== changeSeq || current !== view.value) return;
    prepared.value = next;
  } catch (error) { if (mine === changeSeq) void recover(error); return; }
  dirty = true;
  scheduleSave();
  const trip = tripWalk(prepared.value!.result);
  if (!prefs.animate) { walk.settle(trip); return; }
  if (opts.walkDelay) await new Promise(resolve => setTimeout(resolve, opts.walkDelay));
  if (mine === changeSeq) void walk.play(trip);
}
function move(card: string, cell: string | null): void {
  if (locked.value || replaying.value) return;
  const next = arrange(layout.value, card, cell);
  if (next === layout.value) return;
  layout.value = next;
  if (fresh.value.has(card)) fresh.value = new Set([...fresh.value].filter(id => id !== card));
  void changed();
}
function sweepAll(): void {
  if (locked.value || !hasPlaced.value) return;
  layout.value = sweep(layout.value);
  void changed();
}
let switching = false;
function setShape(next: BoardShape): void {
  if (locked.value || replaying.value || switching || next === shape.value) return;
  shape.value = next;
  switching = true;
  setTimeout(() => { switching = false; }, 560);
  // Let the cells glide to their new places before the shuttle walks.
  void changed({ walkDelay: 560 });
}

// ── Saving in the background: debounced, one at a time, the latest arrangement wins ──
let dirty = false, saving = false, again = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let savedTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(ms = 600): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void flushSave(); }, ms);
}
async function flushSave(): Promise<void> {
  clearTimeout(saveTimer);
  const current = view.value;
  if (!current || !dirty) return;
  if (saving) { again = true; return; }
  saving = true;
  dirty = false;
  const layoutNow = cloneDeep(layout.value), shapeNow = shape.value;
  try {
    await current.save(layoutNow, shapeNow);
    saved.value = true;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { saved.value = false; }, 900);
  } catch (error) {
    dirty = true;
    await recover(error);
  } finally {
    saving = false;
    if (again) { again = false; void flushSave(); }
  }
}
/** The save changed under the view (or a round started): read it again and keep the player's arrangement. */
async function recover(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : '';
  // A round began: the move stays pending and is put back and saved when the round ends (restoreAfter).
  if (props.generating || access?.roundRunning()) return;
  if (message.includes('busy')) { scheduleSave(); return; }
  if (!message.includes('stale') || !access) { note.value = 'saveFailed'; return; }
  const keep = cloneDeep(layout.value), keepShape = shape.value;
  await load();
  if (!view.value) return;
  layout.value = keep;
  shape.value = keepShape;
  note.value = 'reopened';
  await changed();
}
onBeforeUnmount(() => { clearTimeout(savedTimer); void flushSave(); });

// ── Hands: drag, tap, long press ──
const drag = useCardDrag({
  canDrag: canPlace,
  onDrop: (card, from, to: DropTarget) => {
    // The pointer rests on the card it just dropped: no details until it leaves that card.
    quietCard = card;
    if (to === null) return;
    if (to === 'hand') { if (from !== 'hand') move(card, null); return; }
    move(card, to);
  },
  onTap: (card, from, el) => {
    if (from !== 'hand') { move(card, null); return; }
    if (!canPlace(card)) { showDetail(card, el); return; }
    selected.value = selected.value === card ? null : card;
  },
  onLongPress: (card, el) => showDetail(card, el),
});
function tapCell(cell: string): void {
  const target = shown.value?.cells.find(c => c.id === cell);
  if (!target || target.role === 'status') return;
  if (selected.value) { const card = selected.value; selected.value = null; move(card, cell); return; }
}
/** Keyboard: Enter on a cell puts the held card there, or picks up the card that is there. */
function keyCell(cell: string): void {
  const target = shown.value?.cells.find(c => c.id === cell);
  if (!target || target.role === 'status') return;
  if (selected.value) { tapCell(cell); return; }
  if (target.card && canPlace(target.card)) selected.value = target.card;
}
function keyHandCard(card: string, el: HTMLElement): void {
  if (!canPlace(card)) { showDetail(card, el); return; }
  selected.value = selected.value === card ? null : card;
}

// ── Details: hover 0.8 s, long press, or a tap on a card that cannot be placed ──
const detail = ref<{ card: string; anchor: DOMRect } | null>(null);
let hoverTimer: ReturnType<typeof setTimeout> | undefined, overDetail = false;
let quietCard: string | null = null;
function detailEnter(): void { overDetail = true; }
function detailLeave(): void { overDetail = false; detail.value = null; }
function showDetail(card: string, el: HTMLElement): void {
  clearTimeout(hoverTimer);
  retryNote.value = null;
  detail.value = { card, anchor: el.getBoundingClientRect() };
}
function cardEnter(card: string, el: HTMLElement): void {
  clearTimeout(hoverTimer);
  if (drag.drag.value || card === quietCard) return;
  hoverTimer = setTimeout(() => { if (!drag.drag.value) showDetail(card, el); }, 800);
}
function cardLeave(card?: string): void {
  clearTimeout(hoverTimer);
  if (card === quietCard) quietCard = null;
  setTimeout(() => { if (!overDetail) detail.value = null; }, 120);
}
const detailCard = computed(() => (detail.value && shown.value ? shown.value.cards[detail.value.card] : undefined));
const detailForming = computed(() => (detail.value && shown.value ? shown.value.forming.find(f => f.id === detail.value!.card) : undefined));
const detailReceipt = computed(() => (detail.value && prepared.value && detailCard.value ? cardTripReceipt(prepared.value.result.trace, detail.value.card) : null));
onBeforeUnmount(() => clearTimeout(hoverTimer));

// ── The player's retry for an entry whose ability is still forming (4A) ──
const retrying = ref(false);
const retryNote = ref<'bound' | 'failed' | 'error' | null>(null);
async function retry(): Promise<void> {
  const target = detail.value?.card;
  if (!access || !target || retrying.value) return;
  retrying.value = true;
  retryNote.value = null;
  try { retryNote.value = (await access.regenerate(target)).bound ? 'bound' : 'failed'; }
  catch { retryNote.value = 'error'; }
  finally { retrying.value = false; }
  if (retryNote.value === 'bound') { detail.value = null; await load(); }
}

// ── Replaying the last round: its own arrangement and shape, then back to the player's ──
const lastRound = computed(() => view.value?.state.last);
function replayLast(): void {
  const last = lastRound.value, current = view.value;
  if (!last || !current || locked.value || replaying.value) return;
  const lastShape: BoardShape = last.board.id === SIX_CELL_RING_ID ? 'ring' : 'line';
  const pseudo = { ...last, prompt: '', growth: {} } as PreparedVector;
  replaying.value = tableModel(current, pseudo, last.layout, lastShape);
  selected.value = null;
  const shownReplay = replaying.value;
  void walk.play(tripWalk(last.result)).then(() => {
    if (replaying.value !== shownReplay) return;
    replaying.value = null;
    if (prepared.value) walk.settle(tripWalk(prepared.value.result));
  });
}
// After a round, the badge walks the trip once (animation A).
const lastId = computed(() => storedState.value?.last?.id);
watch(lastId, (id, before) => {
  if (!id || !before || id === before || !prefs.animate || open.value) return;
  const last = storedState.value?.last;
  if (!last) return;
  const steps = tripWalk(last.result).steps.map(s => s.cell);
  let i = 0;
  const tick = () => {
    badgeLit.value = i < steps.length ? steps[i++] : null;
    if (badgeLit.value) setTimeout(tick, 150);
  };
  setTimeout(tick, 400);
});

// ── Closing: the handle (tap or pull down), Esc, or a press on the dimmed story ──
const backdrop = useBackdropClose(close);
let pull: { y: number; id: number } | null = null;
const onHandleDown = (e: PointerEvent) => { pull = { y: e.clientY, id: e.pointerId }; };
const onHandleUp = (e: PointerEvent) => { if (pull && pull.id === e.pointerId) close(); pull = null; };
function onKey(e: KeyboardEvent): void {
  if (!open.value || e.key !== 'Escape') return;
  if (selected.value) selected.value = null;
  else if (detail.value) detail.value = null;
  else if (helpOpen.value) helpOpen.value = false;
  else close();
}
watch(open, value => {
  if (value) window.addEventListener('keydown', onKey);
  else window.removeEventListener('keydown', onKey);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

const weatherLine = (id: string) => label(shown.value?.cards[id]?.line);
</script>

<template>
  <VectorBadge
    v-if="enabled && access"
    :cells="badgeCells"
    :shape="storedShape"
    :count="newCards"
    :lit="badgeLit"
    @open="openTable"
  />
  <Teleport to="body">
    <Transition name="vtable-veil" :css="motion">
      <div
        v-if="open"
        class="vtable-veil"
        @pointerdown="backdrop.onPointerdown"
        @pointerup="backdrop.onPointerup"
      />
    </Transition>
    <Transition name="vtable" :css="motion">
      <section
        v-if="open"
        ref="sheet"
        tabindex="-1"
        class="vtable"
        role="dialog"
        :aria-label="t('mainGame.vectorTable.title')"
        :aria-busy="loading"
        data-testid="vector-board"
        @scroll.passive="detail = null"
      >
        <button
          type="button"
          class="vtable__handle"
          :class="{ 'vtable__handle--saved': saved }"
          :aria-label="t('mainGame.vectorTable.close')"
          data-testid="vector-board-close"
          @pointerdown="onHandleDown"
          @pointerup="onHandleUp"
          @keydown.enter.prevent="close"
        />
        <header class="vtable__head">
          <div class="vtable__weather" data-testid="vector-weather">
            <Tooltip v-for="id in shown?.weather ?? []" :key="id" :text="weatherLine(id)" fixed>
              <span class="vtable__chip" :class="{ 'vtable__chip--acting': walk.acting.value.has(id) }">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.2 9.1 4.5 4.5 0 0 0 7 18Z" /></svg>
                {{ label(shown?.cards[id]?.name) }}
              </span>
            </Tooltip>
          </div>
          <div class="vtable__actions">
            <div class="vtable__shape" :class="{ 'vtable__shape--ring': shape === 'ring' }" role="group" :aria-label="t('mainGame.vectorTable.shape.label')">
              <span class="vtable__knob" aria-hidden="true" />
              <Tooltip :text="t('mainGame.vectorTable.shape.line')" interactive fixed>
                <button type="button" :aria-pressed="shape === 'line'" :aria-label="t('mainGame.vectorTable.shape.line')" :disabled="locked || !view" data-testid="vector-shape-line" @click="setShape('line')">
                  <svg width="18" height="12" viewBox="0 0 18 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 6h14" /><circle cx="2.5" cy="6" r="1.6" fill="currentColor" stroke="none" /><circle cx="15.5" cy="6" r="1.6" fill="currentColor" stroke="none" /></svg>
                </button>
              </Tooltip>
              <Tooltip :text="t('mainGame.vectorTable.shape.ring')" interactive fixed>
                <button type="button" :aria-pressed="shape === 'ring'" :aria-label="t('mainGame.vectorTable.shape.ring')" :disabled="locked || !view" data-testid="vector-shape-ring" @click="setShape('ring')">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="2.5" r="1.6" fill="currentColor" stroke="none" /></svg>
                </button>
              </Tooltip>
            </div>
            <Tooltip :text="lastRound ? t('mainGame.vectorTable.replay') : t('mainGame.vectorTable.replayNone')" interactive fixed>
              <button type="button" class="vtable__icon" :disabled="!lastRound || locked || !!replaying" :aria-label="t('mainGame.vectorTable.replay')" data-testid="vector-replay" @click="replayLast">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
              </button>
            </Tooltip>
            <Tooltip :text="t('mainGame.vectorTable.sweep')" interactive fixed>
              <button type="button" class="vtable__icon" :disabled="!hasPlaced || locked" :aria-label="t('mainGame.vectorTable.sweep')" data-testid="vector-clear" @click="sweepAll">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12" /></svg>
              </button>
            </Tooltip>
            <button type="button" class="vtable__icon" :aria-expanded="helpOpen" :aria-label="t('mainGame.vectorTable.help')" data-testid="vector-help-toggle" @click="helpOpen = !helpOpen">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14" /><circle cx="12" cy="17" r=".6" fill="currentColor" /></svg>
            </button>
          </div>
        </header>

        <div class="vtable__board">
          <VectorTrack
            v-if="shown"
            :cells="shown.cells"
            :cards="shown.cards"
            :shape="shown.shape"
            :at="walk.at.value"
            :back="walk.back.value"
            :passing="walk.passing.value"
            :acting="walk.acting.value"
            :floats="walk.floats.value"
            :tendency="walk.tendency.value"
            :selected="selected"
            :dragging="!!drag.drag.value"
            :over="drag.drag.value?.over ?? null"
            :fresh="fresh"
            @cell-tap="tapCell"
            @cell-key="keyCell"
            @card-down="(e, card, cell) => drag.start(e, card, cell)"
            @card-enter="cardEnter"
            @card-leave="cardLeave"
          />
          <div v-else class="vtable__shimmer" aria-hidden="true" />
          <p class="vtable__note" role="status" data-testid="vector-board-note">
            <template v-if="note">
              {{ t(`mainGame.vectorTable.note.${note}`) }}
              <button v-if="note === 'openFailed'" type="button" class="vtable__retry" @click="load()">{{ t('mainGame.vectorTable.note.retry') }}</button>
            </template>
          </p>
        </div>

        <div class="vtable__hand-wrap">
          <div class="vtable__hand-label">{{ t('mainGame.vectorTable.hand') }}</div>
          <div
            class="vtable__hand"
            :class="{ 'vtable__hand--over': drag.drag.value?.over === 'hand' }"
            data-drop-hand
            data-testid="vector-hand"
            @scroll.passive="detail = null"
          >
            <VectorCardFace
              v-for="id in shown?.hand ?? []"
              :key="id"
              class="vtable__card"
              :card="shown!.cards[id]"
              :selected="selected === id"
              :fresh="fresh.has(id)"
              :data-card="id"
              role="button"
              tabindex="0"
              :aria-label="label(shown!.cards[id]?.name)"
              @pointerdown="drag.start($event, id, 'hand')"
              @pointerenter="cardEnter(id, $event.currentTarget as HTMLElement)"
              @pointerleave="cardLeave(id)"
              @focus="cardEnter(id, $event.currentTarget as HTMLElement)"
              @blur="cardLeave(id)"
              @keydown.enter.prevent="keyHandCard(id, $event.currentTarget as HTMLElement)"
              @keydown.space.prevent="keyHandCard(id, $event.currentTarget as HTMLElement)"
            />
            <VectorCardFace
              v-for="f in shown?.forming ?? []"
              :key="f.id"
              class="vtable__card"
              :forming="f"
              :fresh="fresh.has(f.id)"
              :data-card="f.id"
              role="button"
              tabindex="0"
              :aria-label="f.name"
              data-testid="vector-forming"
              @click="showDetail(f.id, $event.currentTarget as HTMLElement)"
              @pointerenter="cardEnter(f.id, $event.currentTarget as HTMLElement)"
              @pointerleave="cardLeave(f.id)"
              @focus="cardEnter(f.id, $event.currentTarget as HTMLElement)"
              @blur="cardLeave(f.id)"
              @keydown.enter.prevent="showDetail(f.id, $event.currentTarget as HTMLElement)"
            />
            <div v-if="shown && !shown.hand.length && !shown.forming.length" class="vtable__empty">{{ t('mainGame.vectorTable.handEmpty') }}</div>
          </div>
        </div>

        <div v-if="helpOpen" class="vtable__help">
          <VectorHelpPanel
            :starting="prepared?.starting"
            :shape="shape"
            :exact="prefs.exact"
            :animate="prefs.animate"
            @update:exact="prefs.exact = $event"
            @update:animate="prefs.animate = $event"
          />
        </div>
        <div v-if="locked" class="vtable__lock" data-testid="vector-board-locked"><span>{{ t('mainGame.vectorTable.lock') }}</span></div>
      </section>
    </Transition>
    <VectorCardDetail
      v-if="open && detail && (detailCard || detailForming)"
      :key="detail.card"
      :card="detailCard"
      :forming="detailForming"
      :anchor="detail.anchor"
      :exact="prefs.exact"
      :receipt="detailReceipt"
      :retrying="retrying"
      :retry-note="retryNote"
      @enter="detailEnter"
      @leave="detailLeave"
      @retry="retry"
    />
    <div
      v-if="drag.drag.value && shown?.cards[drag.drag.value.card]"
      class="vtable__ghost"
      :style="{ left: `${drag.drag.value.x - 66}px`, top: `${drag.drag.value.y - 50}px` }"
      aria-hidden="true"
    >
      <VectorCardFace :card="shown.cards[drag.drag.value.card]" ghost />
    </div>
  </Teleport>
</template>

<style scoped>
.vtable-veil {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  background: color-mix(in srgb, var(--glass-overlay-bg) 60%, transparent);
}
.vtable {
  position: fixed;
  left: 50%;
  bottom: 0;
  z-index: var(--z-modal);
  display: grid;
  grid-template-rows: auto auto auto auto;
  width: min(100vw, 980px);
  max-height: 86vh;
  max-height: 86dvh;
  padding: 8px 22px calc(18px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  border-radius: 20px 20px 0 0;
  background: linear-gradient(var(--glass-bg), var(--glass-bg)), color-mix(in oklch, var(--color-bg) 74%, transparent);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: var(--glass-shadow);
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: oklch(0.3 0.006 95) transparent;
}
.vtable:focus { outline: none; }
.vtable::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: var(--glass-edge-gradient);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}
.vtable__handle {
  justify-self: center;
  width: 44px;
  height: 5px;
  margin: 4px 0 8px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: oklch(0.32 0.006 95);
  cursor: pointer;
  touch-action: none;
  transition: background var(--duration-normal) var(--ease-out), box-shadow var(--duration-normal) var(--ease-out);
}
.vtable__handle::after { content: ''; position: absolute; inset: -12px -20px; }
.vtable__handle { position: relative; }
.vtable__handle--saved { background: var(--color-sage-400); box-shadow: 0 0 10px var(--color-sage-400); }
.vtable__handle:focus-visible { outline: 2px solid var(--color-sage-400); outline-offset: 4px; }
.vtable__head { display: flex; align-items: center; gap: 8px; min-height: 36px; }
.vtable__weather { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; min-width: 0; }
.vtable__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--color-text-secondary);
  background: rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  transition: box-shadow var(--duration-normal) var(--ease-out), color var(--duration-normal) var(--ease-out);
}
.vtable__chip svg { color: var(--color-amber-300); }
.vtable__chip--acting { color: var(--color-text); box-shadow: 0 0 0 1px var(--color-amber-600), 0 0 16px color-mix(in oklch, var(--color-amber-400) 30%, transparent); }
.vtable__actions { display: flex; align-items: center; gap: 2px; }
.vtable__icon {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--color-sage-700);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.vtable__icon:hover:not(:disabled) { background: color-mix(in oklch, var(--color-sage-400) 10%, transparent); color: var(--color-sage-400); }
.vtable__icon:disabled { opacity: 0.35; cursor: default; }
.vtable__icon:focus-visible, .vtable__shape button:focus-visible { outline: 2px solid var(--color-sage-400); outline-offset: 2px; }
.vtable__shape { position: relative; display: inline-flex; padding: 3px; margin-right: 6px; border-radius: 999px; background: rgba(255, 255, 255, 0.04); }
.vtable__shape button {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 30px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color var(--duration-normal) var(--ease-out);
}
.vtable__shape button[aria-pressed='true'] { color: var(--color-sage-300); }
.vtable__shape button:hover:not(:disabled) { color: var(--color-text-secondary); }
.vtable__shape button:disabled { cursor: default; }
.vtable__knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 30px;
  height: 26px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--color-sage-400) 16%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-sage-400) 30%, transparent);
  transition: transform var(--duration-slow) var(--ease-out);
}
.vtable__shape--ring .vtable__knob { transform: translateX(30px); }
.vtable__board { position: relative; padding: 6px 0 4px; min-width: 0; }
.vtable__shimmer {
  height: 190px;
  margin-top: 24px;
  border-radius: 14px;
  background: linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, 0.04) 50%, transparent 70%) 0 0 / 200% 100%, color-mix(in oklch, var(--color-surface) 60%, transparent);
  animation: vtable-shimmer 1.4s linear infinite;
}
@keyframes vtable-shimmer { to { background-position: -200% 0, 0 0; } }
.vtable__note { min-height: 18px; margin: 4px 0 0; font-size: 12px; text-align: center; color: var(--color-amber-300); }
.vtable__retry { margin-left: 8px; padding: 2px 10px; border: 0; border-radius: 999px; background: color-mix(in oklch, var(--color-sage-400) 16%, transparent); color: var(--color-sage-300); font: inherit; cursor: pointer; }
.vtable__hand-wrap { display: grid; min-width: 0; }
.vtable__hand-label { padding: 6px 2px; font-size: 11px; letter-spacing: 0.1em; color: var(--color-text-muted); }
.vtable__hand {
  display: flex;
  gap: 12px;
  min-height: 118px;
  padding: 8px 2px 10px;
  overflow-x: auto;
  scroll-snap-type: x proximity;
  border-radius: 12px;
  transition: background var(--duration-normal) var(--ease-out);
  scrollbar-width: thin;
  scrollbar-color: oklch(0.3 0.006 95) transparent;
}
.vtable__hand--over { background: color-mix(in oklch, var(--color-sage-400) 7%, transparent); }
.vtable__card { flex: none; width: 132px; height: 100px; scroll-snap-align: start; cursor: grab; touch-action: pan-x; }
.vtable__card:hover { transform: translateY(-2px); }
.vtable__card:focus-visible { outline: 2px solid var(--color-sage-400); outline-offset: 2px; }
.vtable__empty {
  display: grid;
  place-items: center;
  flex: none;
  width: 132px;
  height: 100px;
  border: 1px dashed oklch(0.28 0.006 95);
  border-radius: 11px;
  font-size: 12px;
  color: var(--color-text-muted);
}
.vtable__help { position: absolute; top: 50px; right: 22px; bottom: 12px; z-index: 5; display: flex; align-items: flex-start; pointer-events: none; }
.vtable__help > * { pointer-events: auto; }
.vtable__lock {
  position: absolute;
  inset: 24px 0 0;
  z-index: 6;
  display: grid;
  place-items: center;
  font-family: var(--font-serif-cjk);
  font-size: 15px;
  color: var(--color-text-secondary);
  background: color-mix(in oklch, var(--color-bg) 55%, transparent);
}
.vtable__lock span::after { content: ''; display: inline-block; width: 1.2em; text-align: left; animation: vtable-dots 1.4s steps(4) infinite; }
@keyframes vtable-dots { 0% { content: ''; } 25% { content: '·'; } 50% { content: '··'; } 75% { content: '···'; } }
.vtable__ghost { position: fixed; z-index: var(--z-floating); width: 132px; height: 100px; pointer-events: none; }

.vtable-enter-active, .vtable-leave-active { transition: transform var(--duration-open) var(--ease-out); }
.vtable-enter-from, .vtable-leave-to { transform: translate(-50%, 104%); }
.vtable-veil-enter-active, .vtable-veil-leave-active { transition: opacity var(--duration-open) var(--ease-out); }
.vtable-veil-enter-from, .vtable-veil-leave-to { opacity: 0; }

@media (max-width: 767px) {
  .vtable { max-height: 90dvh; padding: 8px 14px calc(14px + env(safe-area-inset-bottom, 0px)); }
  .vtable__help { right: 14px; left: 14px; justify-content: center; }
}
@media (prefers-reduced-motion: reduce) {
  .vtable-enter-active, .vtable-leave-active, .vtable-veil-enter-active, .vtable-veil-leave-active { transition: none; }
  .vtable__shimmer, .vtable__lock span::after { animation: none; }
}
</style>
