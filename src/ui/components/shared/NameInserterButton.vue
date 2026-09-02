<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.16 (名字速插)
/**
 * NameInserterButton — the composer's「名字」key.
 *
 * Why it exists: every round the player retypes names the save already knows
 * (沈砚舟 / 北市·当铺). One click drops the exact string at the caret, so a
 * mistyped name can never desync the narrative from the state tree.
 *
 * Why it also swallowed the old「+词」key (AddLexiconTermButton, removed in the same
 * change): both surfaces are about proper nouns — this panel hands them out, the
 * footer takes new ones in. Merging them kept the composer at five keys while adding
 * a feature, and put the low-frequency dictionary behind the high-frequency list.
 *
 * The panel is TELEPORTED to <body> and positioned `fixed` (AgaSelect / Tooltip
 * `fixed` precedent). An in-flow absolute popover — what the old「+词」used — is
 * clipped by `.main-game-panel { overflow: hidden }`: the panel's tabs and search
 * row were cut off entirely. Position is re-measured on scroll/resize while open.
 *
 * Data + sort/filter/insert rules live in name-inserter-helpers.ts (pure, unit tested).
 */
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { eventBus } from '@/engine/core/event-bus';
import { useGameState } from '@/ui/composables/useGameState';
import { useAPIManagementStore } from '@/engine/stores/engine-api';
import { useSttLexicon } from '@/ui/composables/useSttLexicon';
import { isValidLexiconTerm } from '@/engine/stt/lexicon';
import { MAX_LEXICON_TERMS } from '@/engine/stt/types';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import {
  harvestNpcEntries,
  harvestLocationEntries,
  sortNpcEntries,
  sortLocEntries,
  matchesQuery,
  insertNameAt,
  NPC_SORT_MODES,
  LOC_SORT_MODES,
  type NpcSortMode,
  type LocSortMode,
} from './name-inserter-helpers';

const props = withDefaults(defineProps<{
  /** Bound to the composer textarea so the caret / selection can be read. */
  textarea: HTMLTextAreaElement | null;
  /**
   * Optional element the panel should open ABOVE, instead of the trigger key.
   *
   * On a phone the composer stacks (textarea on row 1, keys on row 2), so a panel
   * anchored to the key covers the very textarea the player is filling — they tap a
   * name and see nothing happen. Anchoring to the whole input area keeps the text in
   * view. Passed in rather than sniffed from the DOM so the component stays reusable.
   */
  anchor?: HTMLElement | null;
  disabled?: boolean;
}>(), { anchor: null, disabled: false });

const model = defineModel<string>({ required: true });

const { t } = useI18n();
const gs = useGameState();
const apiStore = useAPIManagementStore();
const lexicon = useSttLexicon();

// ─── Persisted UI preferences (device-local; `aga_` prefix travels in backups
// exactly like RelationshipPanel's `aga_rel_sort`, which is the behaviour to match) ───
const TAB_KEY = 'aga_name_inserter_tab';
const NPC_SORT_KEY = 'aga_name_inserter_npc_sort';
const NPC_DIR_KEY = 'aga_name_inserter_npc_dir';
const LOC_SORT_KEY = 'aga_name_inserter_loc_sort';
const LOC_DIR_KEY = 'aga_name_inserter_loc_dir';
/** Cleared once the player has inserted a name — the first-run whisper then stops. */
const SEEN_KEY = 'aga_name_inserter_used';

function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = localStorage.getItem(key);
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

const tab = ref<'npc' | 'loc'>(readEnum(TAB_KEY, ['npc', 'loc'] as const, 'npc'));
const npcSort = ref<NpcSortMode>(readEnum(NPC_SORT_KEY, NPC_SORT_MODES, 'present'));
const locSort = ref<LocSortMode>(readEnum(LOC_SORT_KEY, LOC_SORT_MODES, 'near'));
const npcAsc = ref(localStorage.getItem(NPC_DIR_KEY) !== 'desc');
const locAsc = ref(localStorage.getItem(LOC_DIR_KEY) !== 'desc');
const everUsed = ref(localStorage.getItem(SEEN_KEY) === '1');

const open = ref(false);
const query = ref('');
const lexOpen = ref(false);
const lexDraft = ref('');

const popRef = ref<HTMLElement | null>(null);
const btnRef = ref<HTMLButtonElement | null>(null);
const searchRef = ref<HTMLInputElement | null>(null);
const lexInputRef = ref<HTMLInputElement | null>(null);

// ─── Data ───
const npcRaw = gs.useValue<unknown>(DEFAULT_ENGINE_PATHS.relationships);
const locRaw = gs.useValue<unknown>(DEFAULT_ENGINE_PATHS.locations);
const exploredRaw = gs.useValue<unknown>(DEFAULT_ENGINE_PATHS.explorationRecord);
const playerLocation = gs.useValue<string>(DEFAULT_ENGINE_PATHS.playerLocation);

const npcAll = computed(() => harvestNpcEntries(npcRaw.value));
const locAll = computed(() =>
  harvestLocationEntries(locRaw.value, exploredRaw.value, playerLocation.value));


const npcRows = computed(() =>
  sortNpcEntries(npcAll.value, npcSort.value, npcAsc.value)
    .filter((n) => matchesQuery(query.value, n.name, n.location)));
const locRows = computed(() =>
  sortLocEntries(locAll.value, locSort.value, locAsc.value)
    .filter((l) => matchesQuery(query.value, l.name)));

/** One rendered chip. Unifying both tabs into this shape keeps a single v-for
 *  (and therefore one copy of the insert / copy wiring) instead of two branches. */
interface ChipRow {
  name: string;
  /** on = 在场 / 已探索, off = 不在场 / 未探索, here = 玩家当前所在地。 */
  dot: 'on' | 'off' | 'here';
  /** Only shown when the active sort makes it meaningful. */
  meta?: string;
}

const rows = computed<ChipRow[]>(() =>
  tab.value === 'npc'
    ? npcRows.value.map((n) => ({
        name: n.name,
        dot: n.present ? 'on' : 'off',
        meta: npcSort.value === 'affinity' && n.affinity !== undefined
          ? `${n.affinity > 0 ? '+' : ''}${n.affinity}`
          : undefined,
      }))
    : locRows.value.map((l) => ({
        name: l.name,
        dot: l.here ? 'here' : l.explored ? 'on' : 'off',
        meta: l.here ? t('mainGame.nameInserter.hereMark') : undefined,
      })));

const rowCount = computed(() => rows.value.length);
const tabIsEmpty = computed(() =>
  (tab.value === 'npc' ? npcAll.value.length : locAll.value.length) === 0);

/** One sort chip. The mode keeps its literal union type end-to-end — widening it to
 *  `string` here would force an unchecked `as` cast back in setSort(). */
interface SortChip {
  mode: NpcSortMode | LocSortMode;
  label: string;
  active: boolean;
  asc: boolean;
}

const sortChips = computed<SortChip[]>(() =>
  tab.value === 'npc'
    ? NPC_SORT_MODES.map((m) => ({ mode: m, label: t(`mainGame.nameInserter.sortNpc.${m}`), active: npcSort.value === m, asc: npcAsc.value }))
    : LOC_SORT_MODES.map((m) => ({ mode: m, label: t(`mainGame.nameInserter.sortLoc.${m}`), active: locSort.value === m, asc: locAsc.value })));

// ─── Lexicon footer (the whole of the retired AddLexiconTermButton) ───
const sttConfigured = computed(() =>
  apiStore.apiConfigs.some((c) => c.enabled && (c.apiCategory ?? 'llm') === 'stt'));
const lexAvailable = computed(() => sttConfigured.value && lexicon.hasSave.value);

/**
 * Gated like MicInputButton: a key that can only ever open an empty panel is a dead
 * control, so it appears the moment the save knows any name at all.
 *
 * `lexAvailable` is part of the condition because the retired「+词」key was gated ONLY on
 * (STT configured + save loaded). Hiding this key on a save with no NPCs and no locations
 * yet would take the voice dictionary away with it — a feature disappearing behind an
 * unrelated precondition (review finding, 2026-09-02).
 */
const visible = computed(() =>
  gs.isLoaded.value && ((npcAll.value.length + locAll.value.length) > 0 || lexAvailable.value));

// ─── Floating position (measured from the trigger, clamped to the viewport) ───
const PANEL_W = 360;
const GAP = 10;
const EDGE = 12;
const MIN_ABOVE = 220;
const rect = ref({ left: 0, right: 0, top: 0, bottom: 0 });

function measure(): void {
  const r = btnRef.value?.getBoundingClientRect();
  if (!r) return;
  // Horizontally the panel tracks the key (it belongs to that key); vertically it
  // clears the whole anchor when one is given.
  const a = props.anchor?.getBoundingClientRect();
  rect.value = {
    left: r.left,
    right: r.right,
    top: a ? Math.min(r.top, a.top) : r.top,
    bottom: a ? Math.max(r.bottom, a.bottom) : r.bottom,
  };
}

const popStyle = computed(() => {
  const vw = typeof window === 'undefined' ? PANEL_W + EDGE * 2 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight;
  const width = Math.min(PANEL_W, vw - EDGE * 2);
  const roomAbove = rect.value.top - GAP - EDGE;
  const flipDown = roomAbove < MIN_ABOVE;
  // Right-aligned to the trigger, then clamped so a narrow phone never pushes the
  // panel off-screen (the horizontal-overflow trap from the 2026-08-21 mobile fix).
  const left = Math.min(Math.max(EDGE, rect.value.right - width), vw - width - EDGE);
  const maxHeight = Math.max(200, (flipDown ? vh - rect.value.bottom - GAP - EDGE : roomAbove));
  return flipDown
    ? { left: `${left}px`, top: `${rect.value.bottom + GAP}px`, width: `${width}px`, maxHeight: `${maxHeight}px` }
    : { left: `${left}px`, bottom: `${vh - rect.value.top + GAP}px`, width: `${width}px`, maxHeight: `${maxHeight}px` };
});

watch(open, (isOpen) => {
  if (isOpen) {
    measure();
    window.addEventListener('scroll', measure, { capture: true, passive: true });
    window.addEventListener('resize', measure);
    // Desktop only: on touch, focusing a field yanks the keyboard up over the list.
    if (window.matchMedia?.('(hover: hover)').matches) void nextTick(() => searchRef.value?.focus());
  } else {
    window.removeEventListener('scroll', measure, { capture: true });
    window.removeEventListener('resize', measure);
    query.value = '';
    lexOpen.value = false;
    lexDraft.value = '';
  }
});

function toggle(): void {
  if (props.disabled) return;
  open.value = !open.value;
}

// Generation started while the panel was open: the textarea is disabled, so further
// inserts would write into a field the player cannot see changing. Close instead of
// gating each action — same posture as the other composer keys (review finding).
watch(() => props.disabled, (isDisabled) => { if (isDisabled) close(); });

function close(returnFocus = false): void {
  if (!open.value) return;
  open.value = false;
  if (returnFocus) void nextTick(() => btnRef.value?.focus());
}

function onClickOutside(e: MouseEvent): void {
  const target = e.target as Node;
  if (!popRef.value?.contains(target) && !btnRef.value?.contains(target)) close();
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open.value) {
    e.preventDefault();
    close(true);
  }
}
onMounted(() => {
  document.addEventListener('click', onClickOutside, true);
  document.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onClickOutside, true);
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('scroll', measure, { capture: true });
  window.removeEventListener('resize', measure);
});

// ─── Actions ───
function setTab(next: 'npc' | 'loc'): void {
  tab.value = next;
  localStorage.setItem(TAB_KEY, next);
}

/** Clicking the ACTIVE chip flips the direction; any other chip switches mode and
 *  resets to that mode's natural order — RelationshipPanel's exact gesture. */
function setSort(mode: NpcSortMode | LocSortMode): void {
  if (tab.value === 'npc') {
    if (npcSort.value === mode) npcAsc.value = !npcAsc.value;
    else if (isNpcSort(mode)) { npcSort.value = mode; npcAsc.value = true; }
    localStorage.setItem(NPC_SORT_KEY, npcSort.value);
    localStorage.setItem(NPC_DIR_KEY, npcAsc.value ? 'asc' : 'desc');
  } else {
    if (locSort.value === mode) locAsc.value = !locAsc.value;
    else if (isLocSort(mode)) { locSort.value = mode; locAsc.value = true; }
    localStorage.setItem(LOC_SORT_KEY, locSort.value);
    localStorage.setItem(LOC_DIR_KEY, locAsc.value ? 'asc' : 'desc');
  }
}

function isNpcSort(mode: NpcSortMode | LocSortMode): mode is NpcSortMode {
  return (NPC_SORT_MODES as readonly string[]).includes(mode);
}
function isLocSort(mode: NpcSortMode | LocSortMode): mode is LocSortMode {
  return (LOC_SORT_MODES as readonly string[]).includes(mode);
}

/**
 * Insert at the caret and keep the panel open so names can be chained.
 *
 * Reads the string from the TEXTAREA rather than `model.value` for the same reason
 * SettingTagButton does: dictation writes into the bound ref and Vue flushes to the
 * DOM a tick later, so slicing the model with DOM offsets could land the name in the
 * wrong place.
 */
function insert(name: string): void {
  const el = props.textarea;
  if (!el) {
    model.value = `${model.value ?? ''}${name}`;
  } else {
    const value = el.value ?? '';
    const { text, caret } = insertNameAt(value, el.selectionStart ?? value.length, el.selectionEnd ?? value.length, name);
    model.value = text;
    void nextTick(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }
  if (!everUsed.value) {
    everUsed.value = true;
    localStorage.setItem(SEEN_KEY, '1');
  }
}

/** Clipboard write with the project's usual execCommand fallback (MainGamePanel parity). */
async function copy(name: string, e: Event): Promise<void> {
  e.stopPropagation();
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(name);
    } else {
      const ta = document.createElement('textarea');
      ta.value = name;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      try { ta.select(); document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    }
    toast('success', 'mainGame.toast.copiedToClipboard');
  } catch {
    toast('warning', 'mainGame.toast.copyFailed');
  }
}

/**
 * `i18nParams` must travel with the key: Toast RE-translates from `i18nKey` and would
 * otherwise render the raw placeholder («已加入词典：{word}» → «已加入词典：»). The retired
 * AddLexiconTermButton passed params only into `message` and lost the word every time.
 */
function toast(type: 'success' | 'warning', key: string, params?: Record<string, unknown>): void {
  eventBus.emit('ui:toast', {
    type,
    i18nKey: key,
    i18nParams: params,
    message: t(key, params ?? {}),
    duration: 2200,
  });
}

function toggleLex(): void {
  lexOpen.value = !lexOpen.value;
  if (lexOpen.value) void nextTick(() => lexInputRef.value?.focus());
}

/** Verbatim from the retired AddLexiconTermButton — three distinct refusal reasons. */
function submitLex(): void {
  const word = lexDraft.value.trim();
  if (!word) return;
  if (!isValidLexiconTerm(word)) { toast('warning', 'stt.lexicon.invalid'); return; }
  if (lexicon.customTerms.value.includes(word)) { toast('warning', 'stt.lexicon.duplicate'); lexDraft.value = ''; return; }
  if (lexicon.customTerms.value.length >= MAX_LEXICON_TERMS) { toast('warning', 'stt.lexicon.full', { max: MAX_LEXICON_TERMS }); return; }
  lexicon.addTerm(word);
  toast('success', 'stt.lexicon.added', { word });
  lexDraft.value = '';
  lexOpen.value = false;
}

defineExpose({ close });
</script>

<template>
  <div v-if="visible" class="name-ins">
    <Tooltip :text="$t('mainGame.nameInserter.buttonTooltip')" interactive>
      <button
        ref="btnRef"
        type="button"
        class="name-ins__btn"
        :class="{ 'name-ins__btn--open': open }"
        :disabled="props.disabled"
        :aria-label="$t('mainGame.nameInserter.buttonAria')"
        :aria-expanded="open"
        aria-haspopup="dialog"
        @click="toggle"
      >
        <!-- A person with a plus: someone you are adding INTO the sentence. -->
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M19 8v6M22 11h-6" />
        </svg>
      </button>
    </Tooltip>

    <Teleport to="body">
      <Transition name="np-pop">
        <div
          v-if="open"
          ref="popRef"
          class="np"
          :style="popStyle"
          role="dialog"
          :aria-label="$t('mainGame.nameInserter.title')"
        >
          <div class="np__head">
            <Tooltip class="np__tabSlot" :text="$t('mainGame.nameInserter.tabNpcTooltip')" fixed interactive>
              <button
                type="button"
                class="np__tab"
                :class="{ 'np__tab--on': tab === 'npc' }"
                :aria-pressed="tab === 'npc'"
                @click="setTab('npc')"
              >
                {{ $t('mainGame.nameInserter.tabNpc') }}<b>{{ npcAll.length }}</b>
              </button>
            </Tooltip>
            <Tooltip class="np__tabSlot" :text="$t('mainGame.nameInserter.tabLocTooltip')" fixed interactive>
              <button
                type="button"
                class="np__tab"
                :class="{ 'np__tab--on': tab === 'loc' }"
                :aria-pressed="tab === 'loc'"
                @click="setTab('loc')"
              >
                {{ $t('mainGame.nameInserter.tabLoc') }}<b>{{ locAll.length }}</b>
              </button>
            </Tooltip>
            <Tooltip :text="$t('mainGame.nameInserter.closeTooltip')" fixed interactive>
              <button
                type="button"
                class="np__close"
                :aria-label="$t('mainGame.nameInserter.closeTooltip')"
                @click="close(true)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                  <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
                </svg>
              </button>
            </Tooltip>
          </div>

          <div class="np__search">
            <svg class="np__searchIcon" width="13" height="13" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref="searchRef"
              v-model="query"
              type="text"
              :placeholder="$t('mainGame.nameInserter.searchPlaceholder')"
              :aria-label="$t('mainGame.nameInserter.searchPlaceholder')"
              @keydown.esc.prevent="close(true)"
            />
          </div>

          <div class="np__sorts" role="group" :aria-label="$t('mainGame.nameInserter.sortAria')">
            <Tooltip
              v-for="chip in sortChips"
              :key="chip.mode"
              :text="chip.active ? $t('mainGame.nameInserter.sortFlipTooltip') : $t('mainGame.nameInserter.sortTooltip', { mode: chip.label })"
              fixed
              interactive
            >
              <button
                type="button"
                class="sort-chip"
                :class="{ 'sort-chip--active': chip.active }"
                :aria-pressed="chip.active"
                @click="setSort(chip.mode)"
              >{{ chip.label }}<span v-if="chip.active" class="sort-arrow">{{ chip.asc ? '↑' : '↓' }}</span></button>
            </Tooltip>
          </div>

          <div class="np__list">
            <p v-if="rowCount === 0" class="np__empty">
              {{ tabIsEmpty
                ? (tab === 'npc' ? $t('mainGame.nameInserter.emptyNpc') : $t('mainGame.nameInserter.emptyLoc'))
                : $t('mainGame.nameInserter.emptyFiltered') }}
            </p>

            <div
              v-for="row in rows"
              :key="row.name"
              class="name-chip"
              :class="{ 'name-chip--here': row.dot === 'here' }"
            >
              <button
                type="button"
                class="name-chip__main"
                :aria-label="$t('mainGame.nameInserter.insertAria', { name: row.name })"
                @click="insert(row.name)"
              >
                <span class="name-chip__dot" :class="`name-chip__dot--${row.dot}`" aria-hidden="true" />
                <span class="name-chip__name">{{ row.name }}</span>
                <span v-if="row.meta" class="name-chip__meta">{{ row.meta }}</span>
              </button>
              <Tooltip :text="$t('mainGame.nameInserter.copyTooltip')" fixed interactive>
                <button
                  type="button"
                  class="name-chip__copy"
                  :aria-label="$t('mainGame.nameInserter.copyAria', { name: row.name })"
                  @click="copy(row.name, $event)"
                >
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg>
                </button>
              </Tooltip>
            </div>
          </div>

          <!-- First-run whisper: shown until the first successful insert, then never again.
               Teaches the two gestures without a tutorial or a permanent label. -->
          <p v-if="!everUsed && rowCount > 0" class="np__whisper">
            {{ $t('mainGame.nameInserter.firstRunHint') }}
          </p>

          <div v-if="lexAvailable" class="np__foot">
            <Tooltip :text="$t('stt.lexicon.addTooltip')" fixed interactive>
              <button
                type="button"
                class="np__footToggle"
                :class="{ 'np__footToggle--on': lexOpen }"
                :aria-expanded="lexOpen"
                @click="toggleLex"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" aria-hidden="true">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span>{{ $t('mainGame.nameInserter.lexToggle') }}</span>
              </button>
            </Tooltip>
            <div v-if="lexOpen" class="np__lex">
              <input
                ref="lexInputRef"
                v-model="lexDraft"
                type="text"
                :placeholder="$t('stt.lexicon.addPlaceholder')"
                :aria-label="$t('stt.lexicon.addTooltip')"
                maxlength="10"
                @keydown.enter.prevent="submitLex"
                @keydown.esc.prevent="lexOpen = false"
              />
              <button
                type="button"
                class="np__lexAdd"
                :disabled="!lexDraft.trim()"
                @click="submitLex"
              >{{ $t('stt.lexicon.addConfirm') }}</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* Trigger — sized and bordered to sit flush with its composer-row siblings. */
.name-ins { display: inline-flex; }
.name-ins__btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 38px; height: 42px; flex-shrink: 0; padding: 0;
  background: transparent; border: 1px solid var(--color-border);
  border-radius: var(--radius-lg); color: var(--color-text-secondary); cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              background-color var(--duration-fast) var(--ease-out);
}
.name-ins__btn:hover:not(:disabled),
.name-ins__btn--open {
  color: var(--color-sage-100);
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  background: var(--color-sage-muted);
}
.name-ins__btn:disabled { opacity: 0.4; cursor: not-allowed; }
.name-ins__btn:focus-visible { outline: 2px solid var(--color-sage-400); outline-offset: 2px; }
</style>

<style>
/* Unscoped: the panel is teleported to <body>, so scoped attribute selectors
   would not reach it. Class names are namespaced (`np__*`) to stay collision-free. */
.np {
  position: fixed;
  z-index: var(--z-floating, 9100);
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* Panel-grade glass: no hard 1px border — the edge is the ::before gradient
     (CLAUDE.md §8). The old「+词」popover used a hard border and a 12px blur. */
  background: color-mix(in oklch, var(--color-surface-elevated) 82%, transparent);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border-radius: var(--radius-lg);
  box-shadow: var(--glass-shadow);
  overflow: hidden;
}
.np::before {
  content: '';
  position: absolute; inset: 0; padding: 1px;
  border-radius: inherit;
  background: var(--glass-edge-gradient);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}

.np__head { display: flex; align-items: center; gap: 4px; padding: 8px 8px 0; flex-shrink: 0; }
.np__tab {
  padding: 7px 12px; background: transparent; border: none; border-radius: var(--radius-md);
  color: var(--color-text-muted); cursor: pointer;
  font-family: var(--font-sans); font-size: 0.78rem; letter-spacing: 0.04em;
  transition: color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
}
/* The Tooltip wrapper is the real flex item — it must stretch, not the button inside it. */
.np__tabSlot { flex: 1; min-width: 0; }
.np__tabSlot .np__tab { width: 100%; }
.np__tab:hover { color: var(--color-text); }
.np__tab--on { color: var(--color-sage-100); background: color-mix(in oklch, var(--color-sage-400) 12%, transparent); }
.np__tab b { font-weight: 500; font-size: 0.7rem; opacity: 0.6; margin-left: 5px; font-variant-numeric: tabular-nums; }
.np__close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; flex-shrink: 0;
  background: transparent; border: none; border-radius: var(--radius-sm);
  color: var(--color-text-muted); cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
}
.np__close:hover { color: var(--color-text); background: color-mix(in oklch, var(--color-text) 8%, transparent); }

.np__search { position: relative; padding: 8px 10px 6px; flex-shrink: 0; }
.np__searchIcon {
  position: absolute; left: 20px; top: 50%; transform: translateY(-40%);
  color: var(--color-text-muted); pointer-events: none; opacity: 0.75;
}
.np__search input {
  width: 100%; box-sizing: border-box; padding: 6px 10px 6px 30px;
  background: var(--color-surface-input); border: 1px solid var(--color-border);
  border-radius: var(--radius-md); color: var(--color-text);
  font-family: var(--font-sans); font-size: 0.8rem; outline: none;
  transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}
.np__search input:focus {
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  box-shadow: 0 0 0 3px var(--color-primary-muted);
}

/* Sort chips — same recipe as RelationshipPanel's sort bar so the gesture transfers. */
.np__sorts { display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 10px 8px; flex-shrink: 0; }
.np .sort-chip {
  padding: 2px 8px; white-space: nowrap; cursor: pointer;
  font-family: var(--font-sans); font-size: 0.68rem; font-weight: 500;
  color: var(--color-text-secondary); background: transparent;
  border: 1px solid var(--color-border); border-radius: var(--radius-full);
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              background-color var(--duration-fast) var(--ease-out);
}
.np .sort-chip:hover { color: var(--color-text-bone); border-color: color-mix(in oklch, var(--color-sage-400) 40%, transparent); }
.np .sort-chip--active {
  color: var(--color-sage-300);
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  border-color: color-mix(in oklch, var(--color-sage-400) 35%, transparent);
}
.np .sort-arrow { margin-left: 2px; font-size: 0.6rem; }

.np__list {
  display: flex; flex-wrap: wrap; align-content: flex-start; gap: 5px;
  padding: 2px 10px 10px; min-height: 0;
  overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
}
.np__empty {
  width: 100%; margin: 6px 0 10px; padding: 0 4px;
  color: var(--color-text-muted); font-size: 0.76rem; line-height: 1.6; text-align: center;
}

/* The chip is a CONTAINER holding two real buttons (insert + copy). A span with
   role="button" nested inside a <button> would be the usual popover shortcut, but it
   is unreachable by keyboard and invalid as an a11y tree; two siblings styled as one
   chip give the same single-object feel with correct semantics. */
.name-chip {
  display: inline-flex; align-items: stretch; max-width: 100%;
  background: var(--color-surface-elevated); border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  transition: border-color var(--duration-fast) var(--ease-out),
              background-color var(--duration-fast) var(--ease-out),
              transform var(--duration-fast) var(--ease-out);
}
.name-chip:hover {
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  background: color-mix(in oklch, var(--color-sage-400) 10%, var(--color-surface-elevated));
  transform: translateY(-1px);
}
.name-chip--here { border-color: color-mix(in oklch, var(--color-amber-400) 32%, transparent); }
.name-chip__main {
  display: inline-flex; align-items: center; gap: 5px; min-width: 0;
  padding: 4px 4px 4px 8px; background: transparent; border: none; cursor: pointer;
  font-family: var(--font-serif-cjk); font-size: 0.82rem; color: var(--color-text);
  transition: color var(--duration-fast) var(--ease-out);
}
.name-chip:hover .name-chip__main { color: var(--color-sage-100); }
.name-chip__main:focus-visible, .name-chip__copy:focus-visible {
  outline: 2px solid var(--color-sage-400); outline-offset: 1px; border-radius: var(--radius-sm);
}
.name-chip__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name-chip__dot {
  width: 5px; height: 5px; flex-shrink: 0; border-radius: 50%;
  background: var(--color-sage-400); opacity: 0.9;
}
.name-chip__dot--off { background: var(--color-text-muted); opacity: 0.3; }
.name-chip__dot--here { background: var(--color-amber-400); opacity: 1; }
.name-chip__meta {
  font-family: var(--font-sans); font-size: 0.64rem; color: var(--color-text-muted);
  font-variant-numeric: tabular-nums; flex-shrink: 0;
}
.name-chip__copy {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; flex-shrink: 0; padding: 0 5px 0 0;
  background: transparent; border: none; cursor: pointer;
  color: var(--color-text-muted); opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.name-chip:hover .name-chip__copy, .name-chip__copy:focus-visible { opacity: 0.6; }
.name-chip__copy:hover { opacity: 1; color: var(--color-sage-300); }
/* Touch has no hover: without this the copy affordance would never appear. */
@media (hover: none) {
  .name-chip__copy { opacity: 0.45; }
}

.np__whisper {
  margin: 0; padding: 0 12px 9px; flex-shrink: 0;
  color: var(--color-text-muted); font-size: 0.66rem; letter-spacing: 0.04em;
  text-align: center; opacity: 0.75;
}

.np__foot { border-top: 1px solid var(--color-border-subtle); padding: 7px 10px 9px; flex-shrink: 0; }
.np__footToggle {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 3px 2px;
  background: transparent; border: none; cursor: pointer;
  color: var(--color-text-muted); font-family: var(--font-sans); font-size: 0.72rem; letter-spacing: 0.03em;
  transition: color var(--duration-fast) var(--ease-out);
}
.np__footToggle:hover, .np__footToggle--on { color: var(--color-sage-300); }
.np__lex { display: flex; align-items: center; gap: 6px; padding-top: 8px; }
/* The fix for the old「+词」row: the field FLEXES (min-width:0 + border-box) instead of
   a hardcoded 150px content-box width, so the confirm key can no longer be pushed
   through the popover's padding on a narrow viewport. */
.np__lex input {
  flex: 1; min-width: 0; box-sizing: border-box; height: 32px; padding: 6px 9px;
  background: var(--color-surface-input); border: 1px solid var(--color-border);
  border-radius: var(--radius-md); color: var(--color-text);
  font-family: var(--font-serif-cjk); font-size: 0.82rem; outline: none;
  transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}
.np__lex input:focus {
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  box-shadow: 0 0 0 3px var(--color-primary-muted);
}
/* Ghost outline, not a solid fill: matches every other key in the composer. */
.np__lexAdd {
  flex-shrink: 0; height: 32px; box-sizing: border-box; padding: 0 12px;
  background: transparent;
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  border-radius: var(--radius-md); color: var(--color-sage-300);
  font-family: var(--font-sans); font-size: 0.76rem; letter-spacing: 0.04em; cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              background-color var(--duration-fast) var(--ease-out);
}
.np__lexAdd:hover:not(:disabled) {
  color: var(--color-sage-100); border-color: var(--color-sage-400); background: var(--color-sage-muted);
}
.np__lexAdd:disabled { opacity: 0.35; cursor: not-allowed; }

.np-pop-enter-active, .np-pop-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.np-pop-enter-from, .np-pop-leave-to { opacity: 0; transform: translateY(6px); }
@media (prefers-reduced-motion: reduce) {
  .np-pop-enter-active, .np-pop-leave-active { transition: none; }
  .name-chip:hover { transform: none; }
}
</style>
