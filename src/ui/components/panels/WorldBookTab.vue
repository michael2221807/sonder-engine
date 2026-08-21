<script setup lang="ts">
// App doc: docs/user-guide/pages/game-prompts.md §4
import { ref, computed, inject, onUnmounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { eventBus } from '@/engine/core/event-bus';
import { useEngineStateStore } from '@/engine/stores/engine-state';
import type { WorldBookStorage } from '@/engine/prompt/world-book-storage';
import type { WorldBook, WorldBookEntry, WorldBookEntryType, WorldBookScope, WorldBookEntryShape, WorldBookExportData } from '@/engine/prompt/world-book';
import { isSTLorebook, convertSTLorebook } from '@/engine/prompt/st-lorebook-converter';
import { useRoute, useRouter } from 'vue-router';
import { isCapturedBook } from '@/engine/prompt/world-book';
import { useCapturedSettings } from '@/ui/composables/useCapturedSettings';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import AgaSelect from '@/ui/components/shared/AgaSelect.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

const { t } = useI18n();
const engineState = useEngineStateStore();
const worldBookStorage = inject<WorldBookStorage>('worldBookStorage');

const SCOPE_OPTIONS: Array<{ value: WorldBookScope; labelKey: string }> = [
  { value: 'main', labelKey: 'prompt.scope.main' },
  { value: 'opening', labelKey: 'prompt.scope.opening' },
  { value: 'all', labelKey: 'prompt.scope.all' },
  { value: 'world_evolution', labelKey: 'prompt.scope.worldEvolution' },
  { value: 'variable_calibration', labelKey: 'prompt.scope.variableCalibration' },
  { value: 'story_plan', labelKey: 'prompt.scope.storyPlan' },
  { value: 'heroine_plan', labelKey: 'prompt.scope.heroinePlan' },
  { value: 'recall', labelKey: 'prompt.scope.recall' },
];

// Type badge accents draw from the design-token palette (sage/amber/info/success)
// instead of legacy hardcoded hexes, so badges stay theme-consistent.
const TYPE_OPTIONS: Array<{ value: WorldBookEntryType; labelKey: string; color: string }> = [
  { value: 'world_lore', labelKey: 'prompt.type.worldLore', color: 'var(--color-info)' },
  { value: 'system_rule', labelKey: 'prompt.type.systemRule', color: 'var(--color-sage-400)' },
  { value: 'command_rule', labelKey: 'prompt.type.commandRule', color: 'var(--color-amber-400)' },
  { value: 'output_rule', labelKey: 'prompt.type.outputRule', color: 'var(--color-success)' },
];

const SHAPE_OPTIONS: Array<{ value: WorldBookEntryShape; labelKey: string }> = [
  { value: 'normal', labelKey: 'prompt.worldbook.shapeNormal' },
  { value: 'timeline_outline', labelKey: 'prompt.worldbook.shapeTimeline' },
  { value: 'time_injection', labelKey: 'prompt.worldbook.shapeTimeInjection' },
];

// ─── State ─────────────────────────────────────────────────

const books = ref<WorldBook[]>([]);
const selectedBookId = ref<string>('');
const selectedEntryId = ref<string>('');
const newEntryShape = ref<WorldBookEntryShape>('normal');

// ── Canon Capture: the slot-owned auto-settings book ──
//
// Two homes, one panel. Profile books live in IndexedDB and are shared by every save of
// this profile; the captured book lives INSIDE the save's state tree so it rolls back
// with the round and travels with backups. They are shown together because to the player
// they are all "world book", but every write has to take the right road — which is what
// `isCaptured()` below decides.
const captured = useCapturedSettings();
const route = useRoute();
const router = useRouter();

/** Profile books first, then this save's captured book (when it exists). */
const allBooks = computed<WorldBook[]>(() => [...books.value, ...captured.slotBooks.value]);

function isCaptured(book: WorldBook | null | undefined): boolean {
  return !!book && isCapturedBook(book);
}

const selectedBook = computed(() => allBooks.value.find((b) => b.id === selectedBookId.value) ?? null);
const selectedEntry = computed(() => selectedBook.value?.entries.find((e) => e.id === selectedEntryId.value) ?? null);
const selectedIsCaptured = computed(() => isCaptured(selectedBook.value));

/** Provenance of the selected entry, when it is an auto-captured one. */
const selectedCapture = computed(() => selectedEntry.value?.capturedSetting ?? null);

/** Report a coordinator failure honestly instead of leaving the UI looking successful. */
function reportMutation(result: { ok: boolean; reason?: string; engramDegraded?: boolean }): void {
  if (result.ok) {
    if (result.engramDegraded) {
      eventBus.emit('ui:toast', {
        type: 'warning',
        i18nKey: 'prompt.settingCapture.engramDegraded',
        message: t('prompt.settingCapture.engramDegraded'),
      });
    }
    return;
  }
  const key = result.reason === 'capacity'
    ? 'prompt.settingCapture.restoreFailedCapacity'
    : 'prompt.settingCapture.mutationFailed';
  eventBus.emit('ui:toast', { type: 'error', i18nKey: key, message: t(key) });
}

// ── Captured-entry operations — ALWAYS through the coordinator ──
//
// Never `scheduleSave` for these: that writes profile IndexedDB, which is the wrong
// store, would not sync the Engram projection, and would not roll back with the round.

async function retractCaptured(entryId: string): Promise<void> {
  reportMutation(await captured.coordinator.retract(entryId));
}

async function restoreCaptured(entryId: string): Promise<void> {
  reportMutation(await captured.coordinator.restore(entryId));
}

async function toggleCapturedEnabled(entry: WorldBookEntry): Promise<void> {
  reportMutation(await captured.coordinator.setEnabled(entry.id, entry.enabled === false));
}

async function pinCaptured(entry: WorldBookEntry, pinned: boolean): Promise<void> {
  reportMutation(await captured.coordinator.pin(entry.id, pinned));
}

async function editCaptured(
  entry: WorldBookEntry,
  patch: { content?: string; title?: string; keywords?: string[] },
): Promise<void> {
  reportMutation(await captured.coordinator.edit(entry.id, patch));
}

// ── Manual add (the post-failure fallback, design §6.4) ──
//
// The toast deep-links here with `?capturedDraft=…` holding the text the player wrote
// but the pipeline could not record. Refusing to remember it because the model produced
// malformed JSON would be the feature failing at its one job.
const manualDraft = ref('');
const manualDraftOpen = ref(false);

/**
 * Last round's world-book selection outcome, for the "not sent this turn" notice.
 *
 * Emitted by ContextAssembly rather than recomputed here: the panel must show what the
 * PROMPT BUILDER actually decided, not a second guess at it — a second implementation
 * would be the thing that drifts.
 */
const lastSkipped = ref<Array<{ entryId: string; reason: string }>>([]);

/** Engram projection status of a captured entry (design §10.2). */
function engramStatusOf(entry: WorldBookEntry): string {
  return captured.engramStatus(entry);
}

function skipReasonFor(entryId: string): string | null {
  const hit = lastSkipped.value.find((x) => x.entryId === entryId);
  if (!hit) return null;
  const key = `prompt.settingCapture.skipReason.${hit.reason}`;
  const label = t(key);
  return label === key ? hit.reason : label;
}

const unsubscribeSelection = eventBus.on<{ skipped?: Array<{ entryId: string; reason: string }> }>(
  'worldbook:selection',
  (payload) => { lastSkipped.value = payload?.skipped ?? []; },
);

function applyDraftFromQuery(): void {
  const raw = route.query['capturedDraft'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return;
  manualDraft.value = String(value);
  manualDraftOpen.value = true;
  selectedBookId.value = captured.capturedBook.value?.id ?? selectedBookId.value;
  // Consume the query so a refresh does not resurrect the draft.
  void router.replace({ path: route.path, query: { ...route.query, capturedDraft: undefined } })
    .catch(() => { /* duplicate / guarded navigation — nothing to recover */ });
}

async function submitManualDraft(): Promise<void> {
  const content = manualDraft.value.trim();
  if (!content) return;
  const result = await captured.coordinator.addManual({ content });
  reportMutation(result);
  if (result.ok) {
    manualDraft.value = '';
    manualDraftOpen.value = false;
    selectedBookId.value = captured.capturedBook.value?.id ?? selectedBookId.value;
    selectedEntryId.value = result.entry?.id ?? '';
  }
}

// ─── Load ──────────────────────────────────────────────────

async function loadBooks() {
  if (!worldBookStorage) return;
  const pid = engineState.activeProfileId;
  if (!pid) return;
  books.value = await worldBookStorage.loadWorldBooks(pid);
  if (!selectedBookId.value) {
    const first = allBooks.value[0];
    if (first) {
      selectedBookId.value = first.id;
      selectedEntryId.value = first.entries[0]?.id ?? '';
    }
  }
}
void loadBooks();
applyDraftFromQuery();
watch(() => route.query['capturedDraft'], () => applyDraftFromQuery());
watch(() => engineState.activeProfileId, () => {
  selectedBookId.value = '';
  selectedEntryId.value = '';
  void loadBooks();
});

// ─── Save (debounced) ──────────────────────────────────────

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSave(book: WorldBook) {
  const existing = saveTimers.get(book.id);
  if (existing) clearTimeout(existing);
  saveTimers.set(book.id, setTimeout(() => {
    saveTimers.delete(book.id);
    void persistBook(book);
  }, 300));
}

async function persistBook(book: WorldBook) {
  if (!worldBookStorage) return;
  const pid = engineState.activeProfileId;
  if (!pid) return;
  book.updatedAt = Date.now();
  await worldBookStorage.saveWorldBook(pid, book);
  notifyEngine();
}

function notifyEngine() {
  eventBus.emit('worldbook:updated', books.value.filter((b) => b.enabled !== false));
}

onUnmounted(() => {
  unsubscribeSelection();
  for (const [bookId, timer] of saveTimers) {
    clearTimeout(timer);
    const book = books.value.find((b) => b.id === bookId);
    if (book) void persistBook(book);
  }
  saveTimers.clear();
});

// ─── Book CRUD ─────────────────────────────────────────────

function createBook() {
  const id = `wb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const book: WorldBook = {
    id,
    title: t('prompt.worldbook.newBookTitle'),
    entries: [],
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  books.value = [book, ...books.value];
  selectedBookId.value = id;
  selectedEntryId.value = '';
  void persistBook(book);
}

async function deleteBook(bookId: string) {
  // The captured book is system-owned: deleting it wholesale would silently drop every
  // setting the player ever marked. Individual entries are still fully retractable.
  if (isCaptured(allBooks.value.find((b) => b.id === bookId))) {
    eventBus.emit('ui:toast', {
      type: 'info',
      i18nKey: 'prompt.worldbook.cannotDeleteCapturedBook',
      message: t('prompt.worldbook.cannotDeleteCapturedBook'),
    });
    return;
  }
  if (!window.confirm(t('prompt.worldbook.confirmDeleteBook'))) return;
  if (!worldBookStorage) return;
  const pid = engineState.activeProfileId;
  if (!pid) return;
  await worldBookStorage.deleteWorldBook(pid, bookId);
  books.value = books.value.filter((b) => b.id !== bookId);
  if (selectedBookId.value === bookId) {
    selectedBookId.value = books.value[0]?.id ?? '';
    selectedEntryId.value = books.value[0]?.entries[0]?.id ?? '';
  }
  notifyEngine();
}

function toggleBookEnabled(book: WorldBook) {
  book.enabled = !(book.enabled !== false);
  scheduleSave(book);
}

function updateBookTitle(book: WorldBook, title: string) {
  book.title = title;
  scheduleSave(book);
}

// ─── Entry CRUD ────────────────────────────────────────────

function createEntry() {
  const book = selectedBook.value;
  if (!book) return;
  const shape = newEntryShape.value;
  const id = `we_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const entry: WorldBookEntry = {
    id,
    title: t('prompt.worldbook.newEntryTitle'),
    content: '',
    type: 'world_lore',
    scope: shape === 'normal' ? ['main'] : ['all'],
    injectionMode: 'always',
    shape,
    enabled: true,
    priority: shape === 'timeline_outline' ? 120 : shape === 'time_injection' ? 90 : 50,
    keywords: [],
    timelineStart: '',
    timelineEnd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  book.entries = [entry, ...book.entries];
  selectedEntryId.value = id;
  scheduleSave(book);
}

function deleteEntry(entryId: string) {
  if (!window.confirm(t('prompt.worldbook.confirmDeleteEntry'))) return;
  const book = selectedBook.value;
  if (!book) return;
  book.entries = book.entries.filter((e) => e.id !== entryId);
  if (selectedEntryId.value === entryId) {
    selectedEntryId.value = book.entries[0]?.id ?? '';
  }
  scheduleSave(book);
}

function toggleEntryEnabled(entry: WorldBookEntry) {
  entry.enabled = !(entry.enabled !== false);
  const book = selectedBook.value;
  if (book) scheduleSave(book);
}

function updateEntry<K extends keyof WorldBookEntry>(entry: WorldBookEntry, key: K, value: WorldBookEntry[K]) {
  entry[key] = value;
  entry.updatedAt = Date.now();
  const book = selectedBook.value;
  if (book) scheduleSave(book);
}

function toggleScope(entry: WorldBookEntry, scope: WorldBookScope) {
  const scopes = [...(entry.scope ?? ['main'])];
  const idx = scopes.indexOf(scope);
  if (idx >= 0) scopes.splice(idx, 1);
  else scopes.push(scope);
  updateEntry(entry, 'scope', scopes);
}

function setKeywordsFromText(entry: WorldBookEntry, text: string) {
  updateEntry(entry, 'keywords', text.split(',').map((s) => s.trim()).filter(Boolean));
}

// ─── Import / Export ───────────────────────────────────────

async function exportBooks() {
  if (!worldBookStorage) return;
  const pid = engineState.activeProfileId;
  if (!pid) return;
  const data = await worldBookStorage.exportWorldBooks(pid);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `worldbooks-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importBooks() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file || !worldBookStorage) return;
    const pid = engineState.activeProfileId;
    if (!pid) return;
    try {
      const raw = JSON.parse(await file.text()) as unknown;

      if (isSTLorebook(raw)) {
        const bookTitle = file.name.replace(/\.json$/i, '');
        const book = convertSTLorebook(raw, bookTitle);
        if (!book || book.entries.length === 0) {
          eventBus.emit('ui:toast', { type: 'error', i18nKey: 'prompt.worldbook.importInvalidFormat' });
          return;
        }
        if (book.entries.length > 200) {
          eventBus.emit('ui:toast', { type: 'error', i18nKey: 'prompt.worldbook.importTooMany' });
          return;
        }
        await worldBookStorage.saveWorldBook(pid, book);
        await loadBooks();
        selectedBookId.value = book.id;
        selectedEntryId.value = book.entries[0]?.id ?? '';
        eventBus.emit('ui:toast', {
          type: 'success',
          message: t('prompt.worldbook.importSTSuccess', { count: book.entries.length, title: book.title }),
        });
        notifyEngine();
        return;
      }

      const agaData = raw as Record<string, unknown>;
      if (!agaData.books || !Array.isArray(agaData.books)) {
        eventBus.emit('ui:toast', { type: 'error', i18nKey: 'prompt.worldbook.importInvalidFormat' });
        return;
      }
      const totalEntries = (agaData.books as WorldBook[]).reduce((sum: number, b) => sum + (b.entries?.length ?? 0), 0);
      if (totalEntries > 200) {
        eventBus.emit('ui:toast', { type: 'error', i18nKey: 'prompt.worldbook.importTooMany' });
        return;
      }
      const count = await worldBookStorage.importWorldBooks(pid, agaData as unknown as WorldBookExportData);
      await loadBooks();
      eventBus.emit('ui:toast', { type: 'success', message: t('prompt.worldbook.importSuccess', { count }) });
    } catch (e) {
      console.error('[WorldBook] import failed:', e);
      eventBus.emit('ui:toast', { type: 'error', i18nKey: 'prompt.worldbook.importError' });
    }
  };
  input.click();
}

// ─── Helpers ───────────────────────────────────────────────

function typeColor(type: WorldBookEntryType): string {
  return TYPE_OPTIONS.find((o) => o.value === type)?.color ?? 'var(--color-text-muted)';
}

// ─── AgaSelect option arrays ───────────────────────────────
const shapeSelectOptions = computed(() =>
  SHAPE_OPTIONS.map((s) => ({ value: s.value, label: t(s.labelKey) })),
);
const typeSelectOptions = computed(() =>
  TYPE_OPTIONS.map((tp) => ({ value: tp.value, label: t(tp.labelKey) })),
);
const injectionModeOptions = computed(() => [
  { value: 'always', label: t('prompt.modal.injectionAlways') },
  { value: 'match_any', label: t('prompt.modal.injectionKeyword') },
]);
</script>

<template>
  <div class="wb-tab">
    <!-- Toolbar -->
    <div class="wb-toolbar">
      <AgaButton variant="primary" size="sm" @click="createBook">{{ $t('prompt.worldbook.createBook') }}</AgaButton>
      <AgaButton variant="ghost" size="sm" @click="importBooks">{{ $t('prompt.worldbook.import') }}</AgaButton>
      <AgaButton variant="ghost" size="sm" @click="exportBooks">{{ $t('prompt.worldbook.export') }}</AgaButton>
    </div>

    <!-- Manual-add draft — arrives pre-filled from the capture-failed toast so the
         player's words are never lost just because extraction stumbled. -->
    <div v-if="manualDraftOpen" class="wb-manual-draft">
      <label class="wb-manual-draft__label" for="wb-manual-draft">
        {{ $t('mainGame.settingCapture.addManually') }}
      </label>
      <textarea
        id="wb-manual-draft"
        v-model="manualDraft"
        class="wb-manual-draft__input"
        rows="3"
      />
      <div class="wb-manual-draft__actions">
        <AgaButton variant="primary" size="sm" @click="submitManualDraft">
          {{ $t('prompt.modal.save') }}
        </AgaButton>
        <AgaButton variant="ghost" size="sm" @click="manualDraftOpen = false; manualDraft = ''">
          {{ $t('prompt.modal.cancel') }}
        </AgaButton>
      </div>
    </div>

    <div v-if="allBooks.length === 0" class="wb-empty">
      {{ $t('prompt.worldbook.noBooks') }}
    </div>

    <div v-else class="wb-layout">
      <!-- Left: Book list + Entry list -->
      <div class="wb-sidebar">
        <!-- Book cards. Profile books and this save's captured book are shown in one
             list (to the player they are all "world book") but grouped, because their
             lifetimes differ: profile books follow the character, the captured book
             belongs to this save alone and rolls back with the round. -->
        <template v-for="(book, i) in allBooks" :key="book.id">
          <h4
            v-if="i === 0 && !isCaptured(book)"
            class="wb-group-title"
          >{{ $t('prompt.worldbook.groupProfile') }}</h4>
          <h4
            v-if="isCaptured(book) && !isCaptured(allBooks[i - 1])"
            class="wb-group-title"
          >{{ $t('prompt.worldbook.groupSlot') }}</h4>

          <div
            :class="['wb-book-card', {
              'wb-book-card--selected': selectedBookId === book.id,
              'wb-book-card--disabled': book.enabled === false,
              'wb-book-card--captured': isCaptured(book),
            }]"
            @click="selectedBookId = book.id; selectedEntryId = book.entries[0]?.id ?? ''"
          >
            <div class="wb-book-header">
              <input
                class="wb-book-title-input"
                :value="book.title"
                :readonly="isCaptured(book)"
                @input="!isCaptured(book) && updateBookTitle(book, ($event.target as HTMLInputElement).value)"
                @click.stop
              />
              <span v-if="isCaptured(book)" class="wb-auto-badge">
                {{ $t('prompt.worldbook.capturedBadge') }}
              </span>
              <AgaToggle
                v-if="!isCaptured(book)"
                :modelValue="book.enabled !== false"
                @update:modelValue="() => toggleBookEnabled(book)"
                :label="$t('prompt.worldbook.toggleBookEnabled')"
                @click.stop
              />
              <Tooltip
                v-if="!isCaptured(book)"
                :text="$t('prompt.worldbook.deleteBook')"
                interactive
              >
                <button class="wb-delete-btn" @click.stop="deleteBook(book.id)">✕</button>
              </Tooltip>
            </div>
            <span class="wb-book-count">{{ book.entries.length }} {{ $t('prompt.worldbook.entries') }}</span>
            <p v-if="isCaptured(book)" class="wb-book-hint">
              {{ $t('prompt.worldbook.capturedBookHint') }}
            </p>
          </div>
        </template>

        <!-- Entries of selected book -->
        <template v-if="selectedBook">
          <div v-if="!selectedIsCaptured" class="wb-entry-list-header">
            <AgaSelect
              class="wb-shape-select"
              :modelValue="newEntryShape"
              :options="shapeSelectOptions"
              @update:modelValue="v => newEntryShape = v as WorldBookEntryShape"
            />
            <AgaButton variant="ghost" size="sm" @click="createEntry">{{ $t('prompt.worldbook.createEntry') }}</AgaButton>
          </div>
          <div v-else class="wb-entry-list-header">
            <AgaButton variant="ghost" size="sm" @click="manualDraftOpen = true">
              {{ $t('mainGame.settingCapture.addManually') }}
            </AgaButton>
          </div>

          <div
            v-for="entry in selectedBook.entries"
            :key="entry.id"
            :class="['wb-entry-item', { 'wb-entry-item--selected': selectedEntryId === entry.id, 'wb-entry-item--disabled': entry.enabled === false }]"
            @click="selectedEntryId = entry.id"
          >
            <span class="wb-entry-title">{{ entry.title || $t('prompt.worldbook.untitled') }}</span>
            <span
              v-if="entry.capturedSetting?.status === 'retracted'"
              class="wb-retracted-badge"
            >{{ $t('prompt.settingCapture.retracted') }}</span>
            <span class="wb-type-badge" :style="{ background: `color-mix(in oklch, ${typeColor(entry.type)} 18%, transparent)`, color: typeColor(entry.type) }">
              {{ $t(TYPE_OPTIONS.find(o => o.value === entry.type)?.labelKey ?? 'prompt.type.worldLore') }}
            </span>
          </div>

          <div v-if="selectedBook.entries.length === 0" class="wb-empty-entries">
            {{ $t('prompt.worldbook.noEntries') }}
          </div>
        </template>
      </div>

      <!-- Right: Entry editor -->
      <div v-if="selectedEntry" class="wb-editor">
        <div class="wb-editor-header">
          <input
            class="wb-editor-title"
            :value="selectedEntry.title"
            @input="selectedIsCaptured
              ? editCaptured(selectedEntry!, { title: ($event.target as HTMLInputElement).value })
              : updateEntry(selectedEntry!, 'title', ($event.target as HTMLInputElement).value)"
            :placeholder="$t('prompt.worldbook.entryTitle')"
          />
          <AgaToggle
            :modelValue="selectedEntry.enabled !== false"
            @update:modelValue="() => selectedIsCaptured
              ? toggleCapturedEnabled(selectedEntry!)
              : toggleEntryEnabled(selectedEntry!)"
            :label="$t('prompt.worldbook.toggleEntryEnabled')"
          />
          <!-- Captured entries are never hard-deleted: undo keeps the row so the player
               can restore it, and so the Engram bridge can find the edge to invalidate. -->
          <template v-if="selectedIsCaptured">
            <AgaButton
              v-if="selectedCapture?.status === 'retracted'"
              variant="ghost" size="sm"
              @click="restoreCaptured(selectedEntry!.id)"
            >{{ $t('prompt.settingCapture.restore') }}</AgaButton>
            <AgaButton
              v-else
              variant="danger" size="sm"
              @click="retractCaptured(selectedEntry!.id)"
            >{{ $t('prompt.settingCapture.retract') }}</AgaButton>
          </template>
          <AgaButton
            v-else
            variant="danger" size="sm"
            @click="deleteEntry(selectedEntry!.id)"
          >{{ $t('prompt.worldbook.deleteEntry') }}</AgaButton>
        </div>

        <!-- Provenance panel — only for auto-captured entries.
             Evidence sits next to the statement on purpose: the engine can prove the
             quote came from inside a <设定> tag, but it cannot prove the statement means
             the same thing. Showing both lets the player check that in one glance. -->
        <div v-if="selectedCapture" class="wb-capture-meta">
          <div class="wb-capture-row">
            <span class="wb-capture-label">{{ $t('prompt.settingCapture.evidence') }}</span>
            <q class="wb-capture-evidence">{{ selectedCapture.evidence }}</q>
          </div>
          <div class="wb-capture-row wb-capture-row--stats">
            <span class="wb-capture-chip">
              {{ $t('prompt.settingCapture.capturedAt', { round: selectedCapture.capturedRound }) }}
            </span>
            <span class="wb-capture-chip">
              {{ selectedCapture.injectedCount > 0
                ? $t('prompt.settingCapture.usage', { count: selectedCapture.injectedCount })
                : $t('prompt.settingCapture.usageNever') }}
            </span>
            <span v-if="selectedCapture.lastInjectedRound !== undefined" class="wb-capture-chip">
              {{ $t('prompt.settingCapture.lastUsed', { round: selectedCapture.lastInjectedRound }) }}
            </span>
            <span v-if="selectedCapture.source === 'user-edited'" class="wb-capture-chip">
              {{ $t('prompt.settingCapture.edited') }}
            </span>
            <!-- Engram status. "not projected" is the NORMAL outcome for a one-entity
                 setting, so it reads as information, not as a fault. -->
            <Tooltip :text="$t(`prompt.settingCapture.engram.${engramStatusOf(selectedEntry!)}Hint`)" interactive>
              <span :class="['wb-capture-chip', `wb-capture-chip--engram-${engramStatusOf(selectedEntry!)}`]">
                {{ $t(`prompt.settingCapture.engram.${engramStatusOf(selectedEntry!)}`) }}
              </span>
            </Tooltip>
          </div>
          <div
            v-if="selectedCapture.originalContent && selectedCapture.originalContent !== selectedEntry.content"
            class="wb-capture-row"
          >
            <span class="wb-capture-label">{{ $t('prompt.settingCapture.originalContent') }}</span>
            <span class="wb-capture-original">{{ selectedCapture.originalContent }}</span>
          </div>
          <label class="wb-capture-pin">
            <input
              type="checkbox"
              :checked="selectedEntry.injectionMode === 'always'"
              @change="pinCaptured(selectedEntry!, ($event.target as HTMLInputElement).checked)"
            />
            <span>{{ $t('prompt.settingCapture.pin') }}</span>
            <Tooltip :text="$t('prompt.settingCapture.pinHint')" interactive>
              <span class="wb-capture-pin-hint" aria-hidden="true">?</span>
            </Tooltip>
          </label>
        </div>

        <!-- Meta fields.
             HIDDEN for captured entries: their type / scope / injection mode / priority
             are decided deterministically by the capture pipeline (design §4.2), and the
             panel is explicitly not allowed to change priority (§10.2). Beyond the design
             rule there is a correctness reason — these controls call `updateEntry` +
             `scheduleSave`, which persist into the PROFILE IndexedDB store. Doing that to
             a slot-owned book would write a second, drifting copy of the captured book
             into the wrong store. Injection mode has a sanctioned control: the "include
             every turn" checkbox above, which routes through the coordinator. -->
        <div v-if="!selectedIsCaptured" class="wb-meta-grid">
          <div class="wb-meta-field">
            <label class="wb-meta-label">{{ $t('prompt.worldbook.entryShape') }}</label>
            <AgaSelect
              :modelValue="selectedEntry.shape ?? 'normal'"
              :options="shapeSelectOptions"
              @update:modelValue="v => updateEntry(selectedEntry!, 'shape', v as WorldBookEntryShape)"
            />
          </div>

          <div class="wb-meta-field">
            <label class="wb-meta-label">{{ $t('prompt.worldbook.entryType') }}</label>
            <AgaSelect
              :modelValue="selectedEntry.type"
              :options="typeSelectOptions"
              @update:modelValue="v => updateEntry(selectedEntry!, 'type', v as WorldBookEntryType)"
            />
          </div>

          <div class="wb-meta-field">
            <label class="wb-meta-label">{{ $t('prompt.worldbook.injectionMode') }}</label>
            <AgaSelect
              :modelValue="selectedEntry.injectionMode"
              :options="injectionModeOptions"
              @update:modelValue="v => updateEntry(selectedEntry!, 'injectionMode', v as 'always' | 'match_any')"
            />
          </div>

          <div class="wb-meta-field">
            <label class="wb-meta-label">{{ $t('prompt.worldbook.priority') }}</label>
            <input
              type="number"
              class="wb-meta-input"
              min="0"
              max="999"
              :value="selectedEntry.priority ?? 50"
              @change="updateEntry(selectedEntry!, 'priority', Number(($event.target as HTMLInputElement).value))"
            />
          </div>
        </div>

        <!-- Scope checkboxes — same reasoning as the meta grid above. -->
        <div v-if="!selectedIsCaptured" class="wb-meta-field">
          <label class="wb-meta-label">{{ $t('prompt.worldbook.scope') }}</label>
          <div class="wb-scope-group">
            <label v-for="s in SCOPE_OPTIONS" :key="s.value" class="wb-scope-check">
              <input type="checkbox" :checked="(selectedEntry.scope ?? []).includes(s.value)" @change="toggleScope(selectedEntry!, s.value)" />
              {{ $t(s.labelKey) }}
            </label>
          </div>
        </div>

        <!-- Keywords (only for match_any) -->
        <div v-if="selectedEntry.injectionMode === 'match_any'" class="wb-meta-field">
          <label class="wb-meta-label">{{ $t('prompt.worldbook.keywords') }}</label>
          <input
            class="wb-meta-input wb-meta-input--wide"
            :value="(selectedEntry.keywords ?? []).join(', ')"
            @input="selectedIsCaptured
              ? editCaptured(selectedEntry!, { keywords: ($event.target as HTMLInputElement).value.split(',') })
              : setKeywordsFromText(selectedEntry!, ($event.target as HTMLInputElement).value)"
            :placeholder="$t('prompt.modal.keywordsPlaceholder')"
          />
        </div>

        <!-- Timeline fields (only for time_injection; never for captured entries). -->
        <div v-if="!selectedIsCaptured && selectedEntry.shape === 'time_injection'" class="wb-meta-grid">
          <div class="wb-meta-field">
            <label class="wb-meta-label">{{ $t('prompt.worldbook.timeStart') }}</label>
            <input
              class="wb-meta-input"
              :value="selectedEntry.timelineStart ?? ''"
              @input="updateEntry(selectedEntry!, 'timelineStart', ($event.target as HTMLInputElement).value)"
              placeholder="YYYY:MM:DD:HH:MM"
            />
          </div>
          <div class="wb-meta-field">
            <label class="wb-meta-label">{{ $t('prompt.worldbook.timeEnd') }}</label>
            <input
              class="wb-meta-input"
              :value="selectedEntry.timelineEnd ?? ''"
              @input="updateEntry(selectedEntry!, 'timelineEnd', ($event.target as HTMLInputElement).value)"
              placeholder="YYYY:MM:DD:HH:MM"
            />
          </div>
        </div>

        <!-- Why this entry did not reach the model last turn.
             An entry that silently loses to the budget is indistinguishable from a
             broken one, so the reason is shown in the panel, not just in debug. -->
        <div v-if="skipReasonFor(selectedEntry!.id)" class="wb-skip-notice">
          <span class="wb-skip-notice__label">{{ $t('prompt.settingCapture.notInjected') }}</span>
          <span class="wb-skip-notice__reason">{{ skipReasonFor(selectedEntry!.id) }}</span>
        </div>

        <!-- Content editor -->
        <div class="wb-content-area">
          <label class="wb-meta-label">{{ $t('prompt.worldbook.content') }}</label>
          <textarea
            class="wb-content-editor"
            :value="selectedEntry.content"
            @input="selectedIsCaptured
              ? editCaptured(selectedEntry!, { content: ($event.target as HTMLTextAreaElement).value })
              : updateEntry(selectedEntry!, 'content', ($event.target as HTMLTextAreaElement).value)"
            rows="14"
            spellcheck="false"
          />
        </div>
      </div>

      <div v-else class="wb-editor wb-editor--empty">
        {{ $t('prompt.worldbook.selectEntry') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.wb-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
}

.wb-toolbar {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.wb-empty, .wb-empty-entries {
  font-size: 0.82rem;
  color: var(--color-text-muted);
  text-align: center;
  padding: 24px 0;
}

.wb-layout {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 12px;
  min-height: 0;
  flex: 1;
}

/* ─── Sidebar ─── */
.wb-sidebar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  padding-right: 4px;
}
.wb-sidebar::-webkit-scrollbar { width: 4px; }
.wb-sidebar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

/* ─── Book cards ─── */
.wb-book-card {
  padding: 8px 10px;
  border-left: 3px solid var(--color-sage-400);
  border-radius: 8px;
  background: color-mix(in oklch, var(--color-sage-400) 5%, transparent);
  cursor: pointer;
  transition: all 0.15s;
}
.wb-book-card:hover { background: color-mix(in oklch, var(--color-sage-400) 9%, transparent); }
.wb-book-card--selected {
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
}
.wb-book-card--disabled { opacity: 0.45; }

.wb-book-header {
  display: flex;
  align-items: center;
  gap: 6px;
}
.wb-book-title-input {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--color-text);
  font-size: 0.82rem;
  font-weight: 600;
  outline: none;
  padding: 0;
  min-width: 0;
}
.wb-book-title-input:focus {
  border-bottom: 1px solid var(--color-sage-400);
}
.wb-book-count {
  font-size: 0.7rem;
  color: var(--color-text-muted);
}

/* ─── Delete ─── */
.wb-delete-btn {
  background: none;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 0.75rem;
  padding: 2px;
  flex-shrink: 0;
}
.wb-delete-btn:hover { color: var(--color-danger); }

/* ─── Entry list ─── */
.wb-entry-list-header {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 8px 0 4px;
  border-top: 1px solid var(--color-border-subtle);
  margin-top: 4px;
}
.wb-shape-select {
  flex: 1;
  min-width: 0;
}

.wb-entry-item {
  padding: 6px 8px;
  border-left: 3px solid var(--color-sage-400);
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: background 0.12s;
}
.wb-entry-item:hover { background: rgba(255,255,255,0.04); }
.wb-entry-item--selected { background: color-mix(in oklch, var(--color-sage-400) 10%, transparent); }
.wb-entry-item--disabled { opacity: 0.4; }

.wb-entry-title {
  font-size: 0.78rem;
  color: var(--color-text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-type-badge {
  font-size: 0.6rem;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 4px;
  flex-shrink: 0;
}

/* ─── Editor ─── */
.wb-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  padding: 12px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  background: rgba(255,255,255,0.01);
}
.wb-editor::-webkit-scrollbar { width: 4px; }
.wb-editor::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

.wb-editor--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  font-size: 0.82rem;
}

.wb-editor-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wb-editor-title {
  flex: 1;
  padding: 6px 10px;
  font-size: 0.88rem;
  font-weight: 600;
  background: var(--color-surface-input);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  outline: none;
}
.wb-editor-title:focus { border-color: var(--color-sage-400); }

/* ─── Meta grid ─── */
.wb-meta-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.wb-meta-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.wb-meta-label {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.wb-meta-input {
  padding: 5px 8px;
  font-size: 0.78rem;
  background: var(--color-surface-input);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  outline: none;
}
.wb-meta-input:focus { border-color: var(--color-sage-400); }
.wb-meta-input--wide { width: 100%; }

/* ─── Scope checkboxes ─── */
.wb-scope-group {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.wb-scope-check {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.72rem;
  color: var(--color-text-secondary);
  cursor: pointer;
}
/* Native checkbox accent + focus ring themed globally by forms.css. */

/* ─── Content editor ─── */
.wb-content-area { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.wb-content-editor {
  width: 100%;
  min-height: 300px;
  padding: 10px;
  font-size: 0.8rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text);
  background: var(--color-surface-input);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  outline: none;
  resize: vertical;
  line-height: 1.6;
  box-sizing: border-box;
}
.wb-content-editor:focus { border-color: var(--color-sage-400); }

@media (max-width: 767px) {
  .wb-layout { grid-template-columns: 1fr; }
  .wb-sidebar { max-height: 200px; }
}

/* ── Canon Capture additions ── */

.wb-group-title {
  margin: 12px 0 4px;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.wb-group-title:first-child { margin-top: 0; }

.wb-book-card--captured {
  border-left: none;
}

.wb-auto-badge {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 0.68rem;
  letter-spacing: 0.04em;
  background: color-mix(in oklch, var(--color-amber-400) 16%, transparent);
  color: var(--color-amber-400);
}

.wb-book-hint {
  margin: 6px 0 0;
  font-size: 0.72rem;
  line-height: 1.5;
  color: var(--color-text-muted);
}

.wb-retracted-badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 0.66rem;
  background: color-mix(in oklch, var(--color-text) 8%, transparent);
  color: var(--color-text-muted);
}

/* ── Provenance panel ── */
.wb-capture-meta {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  margin-bottom: 14px;
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--color-amber-400) 5%, transparent);
}

.wb-capture-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}

.wb-capture-label {
  flex-shrink: 0;
  font-size: 0.72rem;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

.wb-capture-evidence {
  font-size: 0.84rem;
  line-height: 1.6;
  color: var(--color-text);
  font-style: italic;
}

.wb-capture-original {
  font-size: 0.8rem;
  line-height: 1.6;
  color: var(--color-text-muted);
}

.wb-capture-row--stats { gap: 6px; }

.wb-capture-chip {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
  background: color-mix(in oklch, var(--color-text) 6%, transparent);
  color: var(--color-text-muted);
}

.wb-capture-pin {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8rem;
  color: var(--color-text);
  cursor: pointer;
}

.wb-capture-pin-hint {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  font-size: 0.66rem;
  background: color-mix(in oklch, var(--color-text) 9%, transparent);
  color: var(--color-text-muted);
  cursor: help;
}

/* ── "not sent this turn" notice ── */
.wb-skip-notice {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 8px 12px;
  margin-bottom: 12px;
  border-radius: var(--radius-sm);
  background: color-mix(in oklch, var(--color-amber-400) 8%, transparent);
  font-size: 0.78rem;
}
.wb-skip-notice__label {
  flex-shrink: 0;
  color: var(--color-amber-400);
}
.wb-skip-notice__reason { color: var(--color-text-muted); }

/* ── Manual add draft ── */
.wb-manual-draft {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  margin-bottom: 12px;
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--color-sage-400) 6%, transparent);
}

.wb-manual-draft__label {
  font-size: 0.78rem;
  color: var(--color-text-muted);
}

.wb-manual-draft__input {
  width: 100%;
  resize: vertical;
  font-family: inherit;
  font-size: 0.85rem;
  line-height: 1.6;
}

.wb-manual-draft__actions {
  display: flex;
  gap: 8px;
}

/* Engram status chip — informational, never alarming: "not graphed" is the correct
   outcome for a one-entity setting, not a fault. */
.wb-capture-chip--engram-linked {
  background: color-mix(in oklch, var(--color-success) 14%, transparent);
  color: var(--color-success);
}
.wb-capture-chip--engram-pending {
  background: color-mix(in oklch, var(--color-amber-400) 12%, transparent);
  color: var(--color-amber-400);
}
</style>
