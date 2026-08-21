<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md
/**
 * MainGamePanel — The primary game conversation interface.
 *
 * This is the most important panel in the game view, where the player
 * reads AI-generated narrative and interacts with the game world.
 *
 * Layout (top to bottom):
 * ┌──────────────────────────────────────────┐
 * │  Round counter + status bar              │
 * ├──────────────────────────────────────────┤
 * │                                          │
 * │  Scrollable message history              │
 * │   - User messages (right-aligned)        │
 * │   - Assistant messages (left-aligned)    │
 * │   - Streaming indicator (typing dots)    │
 * │                                          │
 * ├──────────────────────────────────────────┤
 * │  Action options (clickable buttons)      │
 * ├──────────────────────────────────────────┤
 * │  Input area: textarea + send button      │
 * └──────────────────────────────────────────┘
 *
 * Data flow:
 * - Reads narrative history / round via `DEFAULT_ENGINE_PATHS`（`engine/pipeline/types.ts`）
 * - Sends user input by emitting 'pipeline:user-input' on the eventBus
 * - Listens for 'ai:stream-chunk' events to display streaming text
 * - Listens for 'engine:round-complete' to update action options
 * - Streaming can be cancelled via 'pipeline:cancel' event
 *
 * Key design decisions:
 * 1. Auto-scroll: The message area scrolls to bottom on new messages,
 *    but respects manual scroll-up (won't force scroll if user is reading history).
 * 2. Action options: Displayed as clickable buttons below the last AI message.
 *    Clicking an option sends it as the next user input.
 * 3. Streaming: During AI generation, partial text is accumulated and displayed
 *    in a "typing" bubble. The streaming indicator (animated dots) gives
 *    visual feedback that the AI is working.
 * 4. The textarea auto-grows up to 4 lines, then scrolls internally.
 *
 * Dependencies:
 *   - useGameState()  → reads narrative history, round number
 *   - inject('eventBus') → pipeline communication
 */
import {
  ref,
  computed,
  watch,
  nextTick,
  onMounted,
  onActivated,
  onBeforeUnmount,
  inject,
} from 'vue';
import { useI18n } from 'vue-i18n';
import { useGameState } from '@/ui/composables/useGameState';
import { useSessionMode } from '@/ui/composables/useSessionMode';
import { useRoundJump } from '@/ui/composables/useRoundJump';
import type { EventBus } from '@/engine/core/event-bus';
import { DEFAULT_ENGINE_PATHS, type BookmarkedRound } from '@/engine/pipeline/types';
import Modal from '@/ui/components/common/Modal.vue';
import FormattedText from '@/ui/components/common/FormattedText.vue';
import SettingTaggedText from '@/ui/components/common/SettingTaggedText.vue';
import RoundDivider from '@/ui/components/panels/RoundDivider.vue';
import GameComposer from '@/ui/components/panels/GameComposer.vue';
import ThinkingViewer from '@/ui/components/panels/ThinkingViewer.vue';
import CommandsViewer from '@/ui/components/panels/CommandsViewer.vue';
import RawResponseViewer from '@/ui/components/panels/RawResponseViewer.vue';
import EngramRoundViewer from '@/ui/components/panels/EngramRoundViewer.vue';
import WeatherBadge from '@/ui/components/panels/WeatherBadge.vue';
import EnvironmentChips from '@/ui/components/panels/EnvironmentChips.vue';
import FestivalChip from '@/ui/components/panels/FestivalChip.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import VoiceQuickSwitch from '@/ui/components/panels/VoiceQuickSwitch.vue';
import type { TtsService } from '@/engine/tts/tts-service';
import type { TtsStateEvent, TtsCacheEvent } from '@/engine/tts/types';
import {
  findFirstAssistantIdx,
  findLatestAssistantIdx,
  roundForAssistantAt as roundForAssistantAtHelper,
  deriveDisplayMetrics,
  countCjkChars,
  truncate,
  type RoundMetrics,
  type DisplayMetrics,
} from '@/ui/components/panels/round-divider-helpers';

// ─── Types ────────────────────────────────────────────────────

interface DeltaChange {
  path: string;
  action: string;
  oldValue?: unknown;
  newValue?: unknown;
}

/**
 * A single message in the chat display.
 * Mirrors the AIMessage shape from the engine but adds display metadata.
 * _delta: optional state changes from this round (display-only, not sent to AI)
 */
interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  _delta?: DeltaChange[];
  // Phase 1 metadata (2026-04-19); all optional for backward compat with
  // narrativeHistory entries saved before this sprint.
  _metrics?: RoundMetrics;
  _thinking?: string;
  _rawResponse?: string;
  _rawResponseStep2?: string;
  _commands?: unknown[];
  _shortTermPreview?: string;
  // Engram per-round visualization snapshots
  _engramWrite?: import('@/engine/memory/engram/engram-types').EngramWriteSnapshot;
  _engramRead?: import('@/engine/memory/engram/engram-types').EngramReadSnapshot;
  _npcRelevance?: import('@/engine/social/npc-relevance-scorer').NpcRelevanceMeta;
  // Phase 4 metadata (2026-04-19) — polish state for 优化/原文 toggle.
  _polish?: {
    applied: boolean;
    originalText: string;
    model: string;
    durationMs: number;
    manual: boolean;
    polishedAt: number;
  };
}

// ─── Dependencies ─────────────────────────────────────────────

const { t } = useI18n();
const { useValue, setValue } = useGameState();
// Story 9 — in worldBuilding mode the player isn't advancing turns, so the
// turn-advancement controls (composer, live streaming indicator) are hidden.
const { isWorldBuilding } = useSessionMode();
const eventBus = inject<EventBus>('eventBus');
const ttsService = inject<TtsService | undefined>('ttsService', undefined);

// ─── TTS 配音 (2026-07-20) ────────────────────────────────────
// Play button per round + status-bar quick switcher. Playback state is a
// component ref driven by the engine's 'tts:state' broadcast; nothing persists.
const ttsState = ref<TtsStateEvent>({ status: 'idle', roundKey: null });
const ttsReady = ref(false);
// Which round's full narration is currently cached & downloadable (latest played
// round only; driven by the engine's 'tts:cache' broadcast). null = none.
const ttsCacheRoundKey = ref<string | null>(null);
const ttsDownloading = ref(false);
function refreshTtsReady(): void { ttsReady.value = ttsService?.isReady() ?? false; }
function ttsRoundKey(round: number): string { return `round-${round}`; }
function isRoundSpeaking(round: number): boolean {
  return ttsState.value.status !== 'idle' && ttsState.value.roundKey === ttsRoundKey(round);
}
/** Whether this round's audio is downloadable (it's the currently-cached round). */
function isRoundDownloadable(round: number): boolean {
  return ttsReady.value && ttsCacheRoundKey.value === ttsRoundKey(round);
}
/** ▶ 重播 / ❙❙ 停止 this round's narration (toggle, per-round). */
function playTtsForMessage(msg: ChatMessage, round: number): void {
  if (!ttsService) return;
  if (isRoundSpeaking(round)) { ttsService.stop(); return; }
  // Read the WYSIWYG text (respects the 优化/原文 toggle); engine strips markers.
  void ttsService.speak(displayTextForAssistant(msg), ttsRoundKey(round));
}
/** ↓ Download this round's full narration as one WAV (only when it's the cached round). */
async function downloadTtsForMessage(round: number): Promise<void> {
  if (!ttsService || ttsDownloading.value || !isRoundDownloadable(round)) return;
  ttsDownloading.value = true;
  try {
    const dl = await ttsService.buildRoundAudioDownload();
    if (!dl) { eventBus?.emit('ui:toast', { type: 'error', message: t('mainGame.voice.downloadErr'), duration: 3000 }); return; }
    const url = URL.createObjectURL(dl.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = dl.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    eventBus?.emit('ui:toast', { type: 'error', message: t('mainGame.voice.downloadErr'), duration: 3000 });
  } finally {
    ttsDownloading.value = false;
  }
}

// ─── Reactive state ───────────────────────────────────────────

/**
 * Narrative history from the state tree.
 * Each entry is an AIMessage with role + content.
 * The `useValue` reactive getter ensures this updates when the state tree changes.
 */
const narrativeHistory = useValue<ChatMessage[]>(DEFAULT_ENGINE_PATHS.narrativeHistory);

import type { NpcBrief } from '@/ui/components/common/FormattedText.vue';

const relationships = useValue<NpcBrief[]>(DEFAULT_ENGINE_PATHS.relationships);
const npcNameList = computed(() => {
  const list = relationships.value;
  if (!Array.isArray(list)) return [];
  return list.map((r) => r.名称).filter((n): n is string => !!n);
});
const npcDataList = computed<NpcBrief[]>(() => {
  const list = relationships.value;
  if (!Array.isArray(list)) return [];
  return list.filter((r) => !!r.名称);
});

/** Current round number */
const roundNumber = useValue<number>(DEFAULT_ENGINE_PATHS.roundNumber);

/**
 * Environment-tags state (P1 2026-04-19) — weather string, festival object,
 * environment tag array. Each is forcibly re-emitted every round by the AI
 * per the P2 prompt contract, so reactive reads here always reflect the
 * current round's declared state.
 */
const weather = useValue<unknown>(DEFAULT_ENGINE_PATHS.weather);
const festival = useValue<unknown>(DEFAULT_ENGINE_PATHS.festival);
const environmentTags = useValue<unknown>(DEFAULT_ENGINE_PATHS.environmentTags);

/** Persisted action options from state tree — survives page refresh */
const persistedActionOptions = useValue<string[]>('元数据.当前行动选项');

/** Whether the AI is currently generating a response (pipeline is running) */
const isGenerating = ref(false);

/** Accumulated streaming text from AI during generation */
const streamingText = ref('');

/**
 * Action options offered by the AI after its response.
 * Displayed as clickable buttons; clicking sends the option text as input.
 *
 * Stored in module-level variable to survive KeepAlive deactivation.
 * Vue 3's KeepAlive with lazy-loaded async components (router lazy import)
 * may not reliably preserve component-scoped refs.
 */
let _savedActionOptions: string[] = [];
let _pendingRollbackInput = '';
const _PENDING_INPUT_KEY = 'aga_pending_input';
let _lastSentInput = localStorage.getItem(_PENDING_INPUT_KEY) ?? '';
const actionOptions = ref<string[]>(_savedActionOptions);


// ─── Streaming timer ──────────────────────────────────────────

/** Timestamp when the current generation started (ms since epoch) */
const generationStartTime = ref<number | null>(null);

/** Elapsed time in milliseconds since generation started */
const generationElapsedMs = ref(0);

/** setInterval handle for the elapsed time ticker */
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

// ─── Rollback state ───────────────────────────────────────────

/** Reads the preRoundSnapshot from the state tree — null means no snapshot available */
const preRoundSnapshot = useValue<Record<string, unknown> | null>(
  DEFAULT_ENGINE_PATHS.preRoundSnapshot,
);

/** Whether rollback is possible: snapshot must exist and generation must be idle */
const canRollback = computed(() => !!preRoundSnapshot.value && !isGenerating.value);

/** Whether the rollback confirmation dialog is visible */
const showRollbackConfirm = ref(false);

// ─── Phase 3 viewers (2026-04-19) ──────────────────────────────
// CommandsViewer supersedes the old delta-only modal: it takes both
// `_commands` (AI-requested) and `_delta` (applied) and shows them as
// tabs. Both the Δ badge (in-bubble) and the ☰ button (on RoundDivider,
// current-round only) open CommandsViewer — they just pick different
// initial tabs.

interface ActiveCommandsPayload {
  commands: unknown[];
  delta: DeltaChange[];
  roundNumber: number;
  initialTab: 'commands' | 'delta';
}

const activeCommandsPayload = ref<ActiveCommandsPayload | null>(null);
const showCommandsViewer = ref(false);

const activeThinking = ref<{ text: string; roundNumber: number } | null>(null);
const showThinkingViewer = ref(false);

const activeRaw = ref<{ step1: string; step2: string; roundNumber: number } | null>(null);
const showRawViewer = ref(false);

function openThinkingViewer(msg: ChatMessage): void {
  const round = msg._metrics?.roundNumber ?? 0;
  activeThinking.value = { text: msg._thinking ?? '', roundNumber: round };
  showThinkingViewer.value = true;
}

function openCommandsViewer(msg: ChatMessage, initialTab: 'commands' | 'delta' = 'commands'): void {
  const round = msg._metrics?.roundNumber ?? 0;
  activeCommandsPayload.value = {
    commands: msg._commands ?? [],
    delta: msg._delta ?? [],
    roundNumber: round,
    initialTab,
  };
  showCommandsViewer.value = true;
}

function openRawViewer(msg: ChatMessage): void {
  const round = msg._metrics?.roundNumber ?? 0;
  activeRaw.value = {
    step1: msg._rawResponse ?? '',
    step2: msg._rawResponseStep2 ?? '',
    roundNumber: round,
  };
  showRawViewer.value = true;
}

// ─── Engram round viewer ──────────────────────────────────────
const activeEngramPayload = ref<{
  write?: ChatMessage['_engramWrite'];
  read?: ChatMessage['_engramRead'];
  npcRelevance?: ChatMessage['_npcRelevance'];
  roundNumber: number;
} | null>(null);
const showEngramViewer = ref(false);

function openEngramViewer(msg: ChatMessage): void {
  const round = msg._metrics?.roundNumber ?? 0;
  activeEngramPayload.value = {
    write: msg._engramWrite,
    read: msg._engramRead,
    npcRelevance: msg._npcRelevance,
    roundNumber: round,
  };
  showEngramViewer.value = true;
}

/**
 * Whether the user has manually scrolled up (away from the bottom).
 * When true, auto-scroll is suppressed to avoid jarring scroll jumps
 * while the user is reading older messages.
 */
const isUserScrolledUp = ref(false);

// ─── Template refs ────────────────────────────────────────────

const messagesContainer = ref<HTMLDivElement | null>(null);
const composerRef = ref<{ restoreInput: (text: string) => void } | null>(null);

// ─── Computed ─────────────────────────────────────────────────

/**
 * Messages to display in the chat area.
 * Filters out system messages (those are prompt-internal, not user-facing).
 */
const displayMessages = computed<ChatMessage[]>(() => {
  const history = narrativeHistory.value;
  if (!Array.isArray(history)) return [];
  return history.filter((msg) => msg.role !== 'system');
});

// ─── Round folding (performance: only render recent N rounds) ──
// Two modes:
//   'tail'   — show the latest N rounds (default, scrolled to bottom)
//   'pinned' — show ±2 rounds around a search target (5-round window)

const VISIBLE_ROUND_WINDOW = 5;
const VISIBLE_ROUND_HALF = 2;
const LOAD_MORE_INCREMENT = 5;

const windowMode = ref<'tail' | 'pinned'>('tail');
const tailVisibleRounds = ref(VISIBLE_ROUND_WINDOW);
const pinnedTargetIdx = ref(0);

const assistantPositions = computed<number[]>(() => {
  const msgs = displayMessages.value;
  const pos: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'assistant') pos.push(i);
  }
  return pos;
});

const visibleRange = computed<{ start: number; end: number }>(() => {
  const msgs = displayMessages.value;
  if (msgs.length === 0) return { start: 0, end: 0 };
  const aPos = assistantPositions.value;
  if (aPos.length === 0) return { start: 0, end: msgs.length };

  if (windowMode.value === 'tail') {
    const count = tailVisibleRounds.value;
    if (aPos.length <= count) return { start: 0, end: msgs.length };
    const startAssistantPos = aPos.length - count;
    const startMsgIdx = aPos[startAssistantPos];
    const start = startMsgIdx > 0 && msgs[startMsgIdx - 1].role === 'user'
      ? startMsgIdx - 1 : startMsgIdx;
    return { start, end: msgs.length };
  }

  // Pinned: show ±HALF rounds around target
  let centerPos = aPos.length - 1;
  for (let j = 0; j < aPos.length; j++) {
    if (aPos[j] >= pinnedTargetIdx.value) { centerPos = j; break; }
  }

  const wStart = Math.max(0, centerPos - VISIBLE_ROUND_HALF);
  const wEnd = Math.min(aPos.length - 1, centerPos + VISIBLE_ROUND_HALF);

  const startMsgIdx = aPos[wStart];
  const start = startMsgIdx > 0 && msgs[startMsgIdx - 1].role === 'user'
    ? startMsgIdx - 1 : startMsgIdx;

  const end = wEnd < aPos.length - 1
    ? aPos[wEnd] + 1
    : msgs.length;

  return { start, end };
});

const visibleStartIndex = computed(() => visibleRange.value.start);

const visibleMessages = computed<ChatMessage[]>(() => {
  const { start, end } = visibleRange.value;
  return displayMessages.value.slice(start, end);
});

const foldedBeforeCount = computed<number>(() => {
  const { start } = visibleRange.value;
  let count = 0;
  for (const pos of assistantPositions.value) {
    if (pos < start) count++; else break;
  }
  return count;
});

const hasFoldedBefore = computed(() => foldedBeforeCount.value > 0);
const isPinnedMode = computed(() => windowMode.value === 'pinned');

function loadMoreRounds(): void {
  if (windowMode.value !== 'tail') return;
  const container = messagesContainer.value;
  const prevScrollHeight = container?.scrollHeight ?? 0;
  tailVisibleRounds.value += LOAD_MORE_INCREMENT;
  nextTick(() => {
    if (!container) return;
    const delta = container.scrollHeight - prevScrollHeight;
    container.scrollTop += delta;
  });
}

function expandAllRounds(): void {
  windowMode.value = 'tail';
  tailVisibleRounds.value = Infinity;
}

function jumpToLatest(): void {
  windowMode.value = 'tail';
  tailVisibleRounds.value = VISIBLE_ROUND_WINDOW;
  nextTick(() => scrollToBottom(true, true));
}

// ─── Round search ────────────────────────────────────────────

function roundForMessageAt(msgs: ReadonlyArray<ChatMessage>, idx: number): number {
  const msg = msgs[idx];
  if (msg?._metrics?.roundNumber) return msg._metrics.roundNumber;
  for (let i = idx + 1; i < msgs.length; i++) {
    if (msgs[i]._metrics?.roundNumber) return msgs[i]._metrics!.roundNumber;
  }
  let count = 0;
  for (let i = 0; i <= idx; i++) {
    if (msgs[i].role === 'assistant') count++;
  }
  return count || 1;
}

interface SearchHit {
  roundNumber: number;
  role: ChatMessage['role'];
  snippet: string;
  globalIndex: number;
}

const showSearch = ref(false);
const searchFocused = ref(false);
const searchQuery = ref('');
const debouncedSearchQuery = ref('');
let _searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

watch(searchQuery, (val) => {
  if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => {
    debouncedSearchQuery.value = val;
  }, 200);
});

const searchResults = computed<SearchHit[]>(() => {
  const q = debouncedSearchQuery.value.trim();
  if (!q || q.length < 2) return [];
  const msgs = displayMessages.value;
  const results: SearchHit[] = [];
  const qLower = q.toLowerCase();
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    if (!msg.content) continue;
    const contentLower = msg.content.toLowerCase();
    const matchIdx = contentLower.indexOf(qLower);
    if (matchIdx === -1) continue;

    const round = roundForMessageAt(msgs, i);
    const start = Math.max(0, matchIdx - 30);
    const end = Math.min(msg.content.length, matchIdx + q.length + 30);
    const snippet =
      (start > 0 ? '…' : '') +
      msg.content.slice(start, end) +
      (end < msg.content.length ? '…' : '');

    results.push({ roundNumber: round, role: msg.role, snippet, globalIndex: i });
    if (results.length >= 50) break;
  }
  return results;
});

function jumpToSearchResult(hit: SearchHit): void {
  windowMode.value = 'pinned';
  pinnedTargetIdx.value = hit.globalIndex;
  nextTick(() => {
    const container = messagesContainer.value;
    if (!container) return;
    const el = container.querySelector(`[data-global-idx="${hit.globalIndex}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('search-highlight-flash');
      setTimeout(() => el.classList.remove('search-highlight-flash'), 2000);
    }
  });
}

function toggleSearch(): void {
  showSearch.value = !showSearch.value;
  if (showSearch.value) showBookmarks.value = false; // only one dropdown open at a time
  if (!showSearch.value) {
    searchQuery.value = '';
    debouncedSearchQuery.value = '';
    if (windowMode.value === 'pinned') jumpToLatest();
  }
}

// ─── 收藏楼层 (Bookmarked rounds, 2026-07-18) ────────────────────
//
// Player-curated important rounds. Stored in the state tree at
// DEFAULT_ENGINE_PATHS.bookmarkedRounds (元数据.收藏楼层) as a self-contained
// content snapshot, so it rides along in save/backup/cloud-sync automatically
// and survives rollback (snapshot is independent of narrativeHistory).
//
// Selection semantics (PM decision): default nothing selected → nothing injected.
// Ticking a bookmark sets pending=true; the NEXT round injects the selected set
// once (context-assembly), then PostProcessStage resets pending to false.

const bookmarksRaw = useValue<BookmarkedRound[]>(DEFAULT_ENGINE_PATHS.bookmarkedRounds);
const bookmarks = computed<BookmarkedRound[]>(() =>
  Array.isArray(bookmarksRaw.value) ? bookmarksRaw.value : [],
);

const showBookmarks = ref(false);
const editingBookmarkId = ref<string | null>(null);

/** Set of round numbers currently bookmarked — drives the ★/☆ state per divider. */
const bookmarkedRoundSet = computed<Set<number>>(
  () => new Set(bookmarks.value.map((b) => b.round)),
);
function isRoundBookmarked(round: number): boolean {
  return bookmarkedRoundSet.value.has(round);
}

const selectedBookmarkCount = computed(() => bookmarks.value.filter((b) => b.pending).length);
const allBookmarksSelected = computed(
  () => bookmarks.value.length > 0 && selectedBookmarkCount.value === bookmarks.value.length,
);

/** Persist a new bookmarks array to the state tree (single write point). */
function writeBookmarks(next: BookmarkedRound[]): void {
  setValue(DEFAULT_ENGINE_PATHS.bookmarkedRounds, next);
}

/** Default name for a fresh bookmark: first ~10 non-space chars of the narrative. */
function defaultBookmarkName(content: string): string {
  const stripped = content.replace(/\s+/g, '');
  return stripped.length > 10 ? stripped.slice(0, 10) : (stripped || t('mainGame.bookmark.unnamed'));
}

/**
 * Toggle bookmark for the assistant message at global index `globalIdx`.
 * Captures a content snapshot + the preceding player input so the bookmark
 * is self-contained (stable against rollback / history folding).
 */
function toggleBookmarkForMessage(msg: ChatMessage, globalIdx: number): void {
  const round = roundForAssistantAt(globalIdx);
  const existing = bookmarks.value.findIndex((b) => b.round === round);
  if (existing >= 0) {
    const next = bookmarks.value.slice();
    next.splice(existing, 1);
    writeBookmarks(next);
    return;
  }
  // Snapshot exactly what the player is looking at (WYSIWYG): displayTextForAssistant
  // honours the per-round 优化/原文 toggle, so a bookmark keeps the on-screen version.
  const content = displayTextForAssistant(msg);
  const bm: BookmarkedRound = {
    id: `bm_${round}_${Date.now()}`,
    round,
    createdAt: Date.now(),
    name: defaultBookmarkName(content),
    content,
    pending: false,
  };
  // Keep the list sorted by round descending (newest floors first).
  const next = [...bookmarks.value, bm].sort((a, b) => b.round - a.round);
  writeBookmarks(next);
}

function toggleBookmarksPanel(): void {
  showBookmarks.value = !showBookmarks.value;
  if (showBookmarks.value) showSearch.value = false; // only one dropdown open at a time
  else editingBookmarkId.value = null;
}

function toggleBookmarkPending(id: string, checked: boolean): void {
  writeBookmarks(bookmarks.value.map((b) => (b.id === id ? { ...b, pending: checked } : b)));
}

function selectAllBookmarks(checked: boolean): void {
  writeBookmarks(bookmarks.value.map((b) => ({ ...b, pending: checked })));
}

function removeBookmark(id: string): void {
  writeBookmarks(bookmarks.value.filter((b) => b.id !== id));
  if (editingBookmarkId.value === id) editingBookmarkId.value = null;
}

function startRenameBookmark(id: string): void {
  editingBookmarkId.value = id;
  nextTick(() => {
    const el = document.querySelector<HTMLInputElement>(`[data-bm-edit="${id}"]`);
    if (el) { el.focus(); el.select(); }
  });
}

function commitRenameBookmark(id: string, value: string): void {
  const name = value.trim();
  if (name) {
    writeBookmarks(bookmarks.value.map((b) => (b.id === id ? { ...b, name } : b)));
  }
  editingBookmarkId.value = null;
}

/**
 * Locate the assistant message for a round and pin the view to it.
 * Shared by the in-panel bookmark list (jumpToBookmark) and cross-panel jumps
 * from MemoryPanel (via the 'ui:jump-to-round' eventBus event).
 */
function jumpToRound(round: number): void {
  const msgs = displayMessages.value;
  let targetIdx = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'assistant' && roundForMessageAt(msgs, i) === round) {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx === -1) return; // round no longer present (e.g. rolled back) — snapshot still viewable in list
  windowMode.value = 'pinned';
  pinnedTargetIdx.value = targetIdx;
  nextTick(() => {
    const container = messagesContainer.value;
    if (!container) return;
    const el = container.querySelector(`[data-global-idx="${targetIdx}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('search-highlight-flash');
      setTimeout(() => el.classList.remove('search-highlight-flash'), 2000);
    }
  });
}

/** Bookmark-list jump (in-panel). Closes the dropdown for an unobstructed view. */
function jumpToBookmark(round: number): void {
  showBookmarks.value = false;
  jumpToRound(round);
}

/**
 * Pending cross-panel jump target lives in a module-level singleton (survives this
 * view being unmounted / KeepAlive-evicted when the request is made from MemoryPanel).
 * onActivated — which also resets fold state to 'tail' — consumes it LAST so the
 * pin is not overridden. onActivated fires on first mount too, so this covers the
 * deep-link-to-/game/memory case with no event-timing race.
 */
const { consumeRoundJump } = useRoundJump();

/** Compact preview for a bookmark row snippet. */
function bookmarkSnippet(content: string, n = 48): string {
  const s = content.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ─── Round divider placement (Phase 2, 2026-04-19) ─────────────
// Logic delegated to round-divider-helpers.ts so it can be unit-tested
// without Vue test utils.

const firstAssistantIdx = computed<number>(() => findFirstAssistantIdx(displayMessages.value));
const latestAssistantIdx = computed<number>(() => findLatestAssistantIdx(displayMessages.value));
function roundForAssistantAt(idx: number): number {
  return roundForAssistantAtHelper(displayMessages.value, idx);
}
/**
 * Produce `DisplayMetrics` for the divider above an assistant at `idx`.
 * Modern entries use the persisted `_metrics`; legacy entries (saved before
 * Phase 1) get a synthetic pill with `outputTokens` estimated from content
 * and em-dash placeholders for the two un-recoverable fields.
 */
function displayMetricsForAssistantAt(idx: number): DisplayMetrics | undefined {
  const msg = displayMessages.value[idx];
  if (!msg) return undefined;
  return deriveDisplayMetrics(msg, roundForAssistantAt(idx));
}

// ─── Phase 4: 优化 / 原文 toggle state (2026-04-19) ────────────
//
// When a round was polished (`msg._polish.applied === true`), users can click
// the round badge to flip between the polished text (stored in `msg.content`)
// and the pre-polish original (`msg._polish.originalText`). State is stored
// per round-number so each round remembers its own toggle. Uses reactive
// Map so Vue picks up individual key changes.
const showingOriginalForRound = ref<Map<number, boolean>>(new Map());

function toggleOriginalForRound(msg: ChatMessage): void {
  if (!msg._polish?.applied) return;
  const round = msg._metrics?.roundNumber ?? 0;
  if (round <= 0) return;
  const prev = showingOriginalForRound.value.get(round) === true;
  // Create a new Map to trigger reactivity — direct .set() doesn't rerender.
  const next = new Map(showingOriginalForRound.value);
  next.set(round, !prev);
  showingOriginalForRound.value = next;
}

function isShowingOriginalForRound(roundNum: number): boolean {
  return showingOriginalForRound.value.get(roundNum) === true;
}

/**
 * Returns the text to render for an assistant message: polished text by
 * default (in `msg.content`), or the pre-polish original when the user has
 * toggled that round to "原文".
 */
function displayTextForAssistant(msg: ChatMessage): string {
  if (!msg._polish?.applied) return msg.content;
  const round = msg._metrics?.roundNumber;
  if (round == null) return msg.content;
  return isShowingOriginalForRound(round)
    ? (msg._polish.originalText || msg.content)
    : msg.content;
}

/** Display string for the round counter */
const roundDisplay = computed(() => {
  const r = roundNumber.value;
  return typeof r === 'number' && r > 0 ? t('mainGame.status.roundDisplay', { n: r }) : t('mainGame.status.gameStart');
});

// ─── Scroll management ───────────────────────────────────────

/**
 * Scroll the message container to the bottom.
 * Only scrolls if the user hasn't manually scrolled up (unless force=true).
 *
 * 2026-04-14：`instant` 参数用于跳过 CSS `scroll-behavior: smooth` 的动画，
 * 适合 mount/onActivated 首次定位到底部的场景（动画会晃眼）。
 * 流式追加内容的场景（新 chunk 到来）则保持默认的平滑滚动。
 */
function scrollToBottom(force = false, instant = false): void {
  if (!messagesContainer.value) return;
  if (!force && isUserScrolledUp.value) return;

  nextTick(() => {
    const el = messagesContainer.value;
    if (!el) return;
    if (instant) {
      const prev = el.style.scrollBehavior;
      el.style.scrollBehavior = 'auto';
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        if (el) el.style.scrollBehavior = prev;
      });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  });
}

/**
 * Track manual scroll position to determine if the user has scrolled up.
 * A small threshold (30px) prevents floating-point rounding issues
 * from breaking the "at bottom" detection.
 */
function onScroll(): void {
  const el = messagesContainer.value;
  if (!el) return;

  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  isUserScrolledUp.value = distanceFromBottom > 30;
}

// ─── Input handling ───────────────────────────────────────────

/**
 * Send the current user input to the game pipeline.
 * Emits 'pipeline:user-input' on the event bus with the message text.
 */
function handleComposerSend(text: string): void {
  const trimmed = text.trim();
  if (!trimmed || isGenerating.value) return;

  _lastSentInput = trimmed;
  localStorage.setItem(_PENDING_INPUT_KEY, trimmed);

  if (eventBus) {
    eventBus.emit('pipeline:user-input', { text: trimmed });
  }
}

/**
 * Fill an action option into the input textarea.
 * The user can review and edit the text before sending.
 * This preserves player agency (Polanyi design principle).
 */
async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    eventBus?.emit('ui:toast', { type: 'success', message: t('mainGame.toast.copiedToClipboard') });
  } catch {
    eventBus?.emit('ui:toast', { type: 'error', message: t('mainGame.toast.copyFailed') });
  }
}

/** Cancel the current AI generation */
function cancelGeneration(): void {
  if (eventBus) {
    eventBus.emit('pipeline:cancel', undefined);
  }
}

/** Stop the elapsed-time ticker and reset timer refs */
function stopTimer(): void {
  if (elapsedTimer !== null) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  generationStartTime.value = null;
}

/** Send a rollback request to the engine */
function handleRollback(): void {
  showRollbackConfirm.value = false;
  if (!eventBus) return;

  // Capture the last user input before rollback reverts the state tree.
  // After rollback, narrativeHistory loses the last round's entries,
  // so we grab it now and restore it to the input box on rollback-complete.
  const history = narrativeHistory.value;
  let lastUserInput = '';
  if (Array.isArray(history)) {
    for (let i = history.length - 1; i >= 0; i--) {
      if ((history[i] as { role: string }).role === 'user') {
        lastUserInput = (history[i] as { content: string }).content;
        break;
      }
    }
  }
  _pendingRollbackInput = lastUserInput;

  eventBus.emit('engine:rollback-requested', undefined);
}

// ─── Event bus subscriptions ──────────────────────────────────

/** Cleanup functions for event bus subscriptions */
const unsubscribers: Array<() => void> = [];

// KeepAlive: when user returns from another panel
onActivated(() => {
  // Reset fold state — returning to this tab should show latest 5 rounds
  windowMode.value = 'tail';
  tailVisibleRounds.value = VISIBLE_ROUND_WINDOW;
  refreshTtsReady(); // config may have changed in the Settings/API panel

  const el = messagesContainer.value;
  if (el) {
    const prev = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      if (el) el.style.scrollBehavior = prev;
    });
  }
  isUserScrolledUp.value = false;

  // Restore action options from module-level cache
  if (_savedActionOptions.length > 0 && actionOptions.value.length === 0) {
    actionOptions.value = [..._savedActionOptions];
  }

  // Process a pending cross-panel jump (收藏楼层 jump from MemoryPanel).
  // Runs LAST so the tail-reset above doesn't override the pin.
  const jumpRound = consumeRoundJump();
  if (jumpRound != null) {
    nextTick(() => jumpToRound(jumpRound));
  }
});

onMounted(() => {
  refreshTtsReady();
  if (!eventBus) return;

  // TTS playback state broadcast (TtsService → play button + quick switcher).
  unsubscribers.push(
    eventBus.on<TtsStateEvent>('tts:state', (payload) => {
      if (payload) ttsState.value = payload;
      refreshTtsReady();
    }),
  );
  // TTS round-audio cache availability (TtsService → per-round download button).
  unsubscribers.push(
    eventBus.on<TtsCacheEvent>('tts:cache', (payload) => {
      ttsCacheRoundKey.value = payload?.available ? payload.roundKey : null;
    }),
  );

  /*
   * Pipeline lifecycle events:
   * - round-start: clear streaming state, mark generating
   * - stream-chunk: accumulate partial AI text
   * - round-complete: finalize, update action options
   * - ai:error: stop generating on errors
   */
  unsubscribers.push(
    eventBus.on('engine:round-start', () => {
      if (windowMode.value === 'pinned') jumpToLatest();
      isGenerating.value = true;
      streamingText.value = '';
      actionOptions.value = [];
      generationStartTime.value = Date.now();
      generationElapsedMs.value = 0;
      elapsedTimer = setInterval(() => {
        if (generationStartTime.value !== null) {
          generationElapsedMs.value = Date.now() - generationStartTime.value;
        }
      }, 100);
    }),
  );

  unsubscribers.push(
    eventBus.on<{ chunk: string }>('ai:stream-chunk', (payload) => {
      if (payload && typeof payload === 'object' && 'chunk' in payload) {
        streamingText.value += (payload as { chunk: string }).chunk;
        scrollToBottom();
      }
    }),
  );

  unsubscribers.push(
    eventBus.on<{ text: string }>('ai:polish-chunk', (payload) => {
      if (payload && typeof payload === 'object' && 'text' in payload) {
        streamingText.value = (payload as { text: string }).text;
        scrollToBottom();
      }
    }),
  );

  unsubscribers.push(
    eventBus.on<{ actionOptions?: string[] }>('engine:round-complete', (payload) => {
      stopTimer();
      isGenerating.value = false;
      streamingText.value = '';
      _lastSentInput = '';
      localStorage.removeItem(_PENDING_INPUT_KEY);

      if (
        payload &&
        typeof payload === 'object' &&
        'actionOptions' in payload &&
        Array.isArray((payload as { actionOptions: string[] }).actionOptions)
      ) {
        actionOptions.value = (payload as { actionOptions: string[] }).actionOptions;
      }

      scrollToBottom(true);
    }),
  );

  unsubscribers.push(
    eventBus.on('ai:error', (payload) => {
      stopTimer();
      isGenerating.value = false;
      streamingText.value = '';
      // 恢复用户刚才发送的输入，防止报错后丢失
      if (_lastSentInput) {
        composerRef.value?.restoreInput(_lastSentInput);
        _lastSentInput = '';
      }
      const errMsg = (payload as { error?: Error })?.error?.message ?? t('mainGame.toast.aiErrorUnknown');
      eventBus.emit('ui:toast', {
        type: 'error',
        message: t('mainGame.toast.aiError', { error: errMsg }),
        duration: 5000,
      });
    }),
  );

  unsubscribers.push(
    eventBus.on<{ attempt: number; maxRetries: number }>('ai:retrying', (payload) => {
      isGenerating.value = true;
      const { attempt, maxRetries } = payload ?? { attempt: 0, maxRetries: 0 };
      eventBus.emit('ui:toast', {
        type: 'warning',
        message: t('mainGame.toast.retrying', { attempt, maxRetries }),
        duration: 3000,
      });
    }),
  );

  unsubscribers.push(
    eventBus.on('engine:sub-pipelines-done', () => {
      isGenerating.value = false;
    }),
  );

  unsubscribers.push(
    eventBus.on('engine:rollback-complete', () => {
      actionOptions.value = [];
      // Restore the rolled-back round's user input so the player can re-submit or edit
      if (_pendingRollbackInput) {
        composerRef.value?.restoreInput(_pendingRollbackInput);
        _pendingRollbackInput = '';
      }
    }),
  );

  // Restore pending input that survived a page refresh
  if (_lastSentInput) {
    composerRef.value?.restoreInput(_lastSentInput);
  }

  /* Initial scroll to bottom when the panel mounts —— instant 避免首屏动画 */
  scrollToBottom(true, true);

  // Restore action options from state tree (survives page refresh)
  if (actionOptions.value.length === 0 && Array.isArray(persistedActionOptions.value) && persistedActionOptions.value.length > 0) {
    actionOptions.value = [...persistedActionOptions.value];
    _savedActionOptions = [...persistedActionOptions.value];
  }
});

onBeforeUnmount(() => {
  stopTimer();
  if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer);
  ttsService?.stop(); // don't let narration keep playing after leaving the game
  for (const unsub of unsubscribers) {
    unsub();
  }
  unsubscribers.length = 0;
});

// ─── Watchers ─────────────────────────────────────────────────

/* Sync action options to module-level cache for KeepAlive survival */
watch(actionOptions, (v) => { _savedActionOptions = [...v]; }, { deep: true });

/* Auto-scroll when new messages are added — only in tail mode */
watch(
  () => narrativeHistory.value?.length,
  () => {
    if (windowMode.value === 'tail') scrollToBottom();
  },
);
</script>

<template>
  <div class="main-game-panel">
    <!-- Status bar: left cluster [round counter][weather][env chips] / right cluster [festival][generating] -->
    <div class="status-bar">
      <div class="status-bar__left">
        <span class="round-counter">{{ roundDisplay }}</span>
        <WeatherBadge :weather="weather" />
        <EnvironmentChips :tags="environmentTags" />
      </div>
      <div class="status-bar__right">
        <Tooltip :text="$t('mainGame.search.toggleTitle')" interactive>
          <button
            class="search-toggle-btn"
            :class="{ 'search-toggle-btn--active': showSearch }"
            :aria-label="$t('mainGame.search.toggleTitle')"
            @click="toggleSearch"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" width="15" height="15" aria-hidden="true">
              <path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd" />
            </svg>
          </button>
        </Tooltip>
        <!-- 收藏楼层 展开按钮 — 紧邻搜索按钮 (2026-07-18) -->
        <Tooltip :text="$t('mainGame.bookmark.toggleTitle')" interactive>
          <button
            class="search-toggle-btn bookmark-toggle-btn"
            :class="{ 'bookmark-toggle-btn--active': showBookmarks }"
            data-testid="bookmark-toggle"
            :aria-label="$t('mainGame.bookmark.toggleTitle')"
            @click="toggleBookmarksPanel"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true">
              <path d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z" />
            </svg>
            <span v-if="bookmarks.length > 0" class="bookmark-count">{{ bookmarks.length }}</span>
          </button>
        </Tooltip>
        <!-- 配音快速切换 (2026-07-20) — chip → popover: 切音色/方言 + 自动配音开关 -->
        <VoiceQuickSwitch v-if="ttsReady" :speaking="ttsState.status !== 'idle'" />
        <FestivalChip :festival="festival" />
        <span v-if="isGenerating" class="status-generating">
          {{ $t('mainGame.status.aiThinking') }}
        </span>
      </div>
    </div>

    <!-- Messages area —— wrapper 提供 position:relative 以承载浮动按钮 -->
    <div class="messages-area">

      <!-- Search panel — slides down from top when toggled.
           focusin/focusout bubble from input + result buttons to control
           whether the results dropdown is expanded or collapsed. -->
      <Transition name="slide-down">
        <div
          v-if="showSearch"
          class="search-panel"
          @focusin="searchFocused = true"
          @focusout="searchFocused = false"
        >
          <div class="search-input-row">
            <svg class="search-input-icon" viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
              <path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd" />
            </svg>
            <input
              v-model="searchQuery"
              class="search-input"
              type="text"
              :placeholder="$t('mainGame.search.placeholder')"
              @keydown.escape="toggleSearch"
            />
            <span v-if="!searchFocused && searchResults.length > 0" class="search-result-count">{{ searchResults.length }}</span>
            <Tooltip :text="$t('mainGame.search.close')" interactive>
              <button class="search-close-btn" :aria-label="$t('mainGame.search.close')" @click="toggleSearch">
                <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
              </button>
            </Tooltip>
          </div>
          <template v-if="searchFocused">
            <div v-if="searchResults.length > 0" class="search-results">
              <button
                v-for="(hit, si) in searchResults"
                :key="si"
                class="search-result-item"
                @mousedown.prevent
                @click="jumpToSearchResult(hit)"
              >
                <span class="search-result-round">{{ $t('mainGame.search.roundLabel', { n: hit.roundNumber }) }}</span>
                <span class="search-result-snippet">{{ hit.snippet }}</span>
              </button>
            </div>
            <div v-else-if="searchQuery.length >= 2" class="search-empty">
              {{ $t('mainGame.search.noResults') }}
            </div>
          </template>
        </div>
      </Transition>

      <!-- Bookmark panel (收藏楼层) — slides down, mirrors the search panel.
           Lists player-bookmarked rounds: select (→ inject next round once),
           rename, jump, delete. (2026-07-18) -->
      <Transition name="slide-down">
        <div v-if="showBookmarks" class="bookmark-panel" data-testid="bookmark-panel">
          <div class="bookmark-head">
            <span class="bookmark-title">{{ $t('mainGame.bookmark.panelTitle') }}</span>
            <Tooltip :text="$t('mainGame.bookmark.close')" interactive>
              <button class="search-close-btn" :aria-label="$t('mainGame.bookmark.close')" @click="toggleBookmarksPanel">
                <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
              </button>
            </Tooltip>
          </div>

          <template v-if="bookmarks.length > 0">
            <div class="bookmark-toolbar">
              <label class="bookmark-selectall">
                <input
                  type="checkbox"
                  :checked="allBookmarksSelected"
                  @change="selectAllBookmarks(($event.target as HTMLInputElement).checked)"
                />
                {{ $t('mainGame.bookmark.selectAll') }}
              </label>
              <span class="bookmark-selcount">{{ $t('mainGame.bookmark.selectedHint', { n: selectedBookmarkCount }) }}</span>
            </div>

            <div class="bookmark-list">
              <div
                v-for="bm in bookmarks"
                :key="bm.id"
                class="bookmark-row"
                :class="{ 'bookmark-row--pending': bm.pending }"
                data-testid="bookmark-row"
              >
                <Tooltip :text="$t('mainGame.bookmark.selectHint')" interactive>
                  <input
                    type="checkbox"
                    class="bookmark-check"
                    :checked="bm.pending"
                    :aria-label="$t('mainGame.bookmark.selectHint')"
                    @change="toggleBookmarkPending(bm.id, ($event.target as HTMLInputElement).checked)"
                  />
                </Tooltip>
                <div class="bookmark-body">
                  <div class="bookmark-namerow">
                    <span class="bookmark-badge">{{ $t('mainGame.bookmark.roundLabel', { n: bm.round }) }}</span>
                    <input
                      v-if="editingBookmarkId === bm.id"
                      :data-bm-edit="bm.id"
                      class="bookmark-name-input"
                      :value="bm.name"
                      @blur="commitRenameBookmark(bm.id, ($event.target as HTMLInputElement).value)"
                      @keydown.enter="($event.target as HTMLInputElement).blur()"
                      @keydown.escape="editingBookmarkId = null"
                    />
                    <Tooltip v-else :text="$t('mainGame.bookmark.renameHint')" interactive>
                      <button class="bookmark-name" @click="startRenameBookmark(bm.id)">{{ bm.name }}</button>
                    </Tooltip>
                  </div>
                  <p class="bookmark-snippet" @click="jumpToBookmark(bm.round)">{{ bookmarkSnippet(bm.content) }}</p>
                </div>
                <div class="bookmark-actions">
                  <Tooltip :text="$t('mainGame.bookmark.jump')" interactive>
                    <button class="bookmark-tiny-btn" :aria-label="$t('mainGame.bookmark.jump')" @click="jumpToBookmark(bm.round)">
                      <svg viewBox="0 0 20 20" fill="currentColor" width="13" height="13"><path fill-rule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
                    </button>
                  </Tooltip>
                  <Tooltip :text="$t('mainGame.bookmark.delete')" interactive>
                    <button class="bookmark-tiny-btn bookmark-tiny-btn--del" :aria-label="$t('mainGame.bookmark.delete')" @click="removeBookmark(bm.id)">
                      <svg viewBox="0 0 20 20" fill="currentColor" width="13" height="13"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" /></svg>
                    </button>
                  </Tooltip>
                </div>
              </div>
            </div>
          </template>

          <div v-else class="bookmark-empty">
            {{ $t('mainGame.bookmark.emptyHint') }}
          </div>
        </div>
      </Transition>

      <!-- Scrollable message history -->
      <div
        ref="messagesContainer"
        class="messages-container"
        @scroll="onScroll"
      >

      <!-- Top bar: mode-dependent -->
      <div v-if="isPinnedMode" class="load-more-bar">
        <button class="load-more-btn" @click="jumpToLatest">
          {{ $t('mainGame.fold.jumpToLatest') }}
        </button>
      </div>
      <div v-else-if="hasFoldedBefore" class="load-more-bar">
        <button class="load-more-btn" @click="loadMoreRounds">
          {{ $t('mainGame.fold.loadMore', { n: foldedBeforeCount }) }}
        </button>
        <button v-if="foldedBeforeCount > LOAD_MORE_INCREMENT" class="load-all-btn" @click="expandAllRounds">
          {{ $t('mainGame.fold.loadAll') }}
        </button>
      </div>

      <!-- Empty state when no messages exist yet (Story 9: writing-mode copy must not
           tell the user to "type an action" — the composer is hidden in that mode). -->
      <div v-if="displayMessages.length === 0 && !isGenerating" class="empty-chat">
        <p class="empty-text">{{ isWorldBuilding ? $t('mainGame.empty.worldBuilding') : $t('mainGame.empty.text') }}</p>
      </div>

      <!-- Message bubbles (each assistant preceded by a RoundDivider, except the opening one) -->
      <template v-for="(msg, localIdx) in visibleMessages" :key="visibleStartIndex + localIdx">
        <RoundDivider
          v-if="msg.role === 'assistant' && (visibleStartIndex + localIdx) !== firstAssistantIdx"
          :round-number="roundForAssistantAt(visibleStartIndex + localIdx)"
          :metrics="displayMetricsForAssistantAt(visibleStartIndex + localIdx)"
          :is-current="(visibleStartIndex + localIdx) === latestAssistantIdx"
          :has-thinking="!!msg._thinking && msg._thinking.length > 0"
          :has-commands="(msg._commands?.length ?? 0) > 0 || (msg._delta?.length ?? 0) > 0"
          :has-raw="!!msg._rawResponse && msg._rawResponse.length > 0"
          :has-engram="!!msg._engramWrite || !!msg._engramRead"
          :polish="msg._polish"
          :showing-original="isShowingOriginalForRound(msg._metrics?.roundNumber ?? 0)"
          :is-bookmarked="isRoundBookmarked(roundForAssistantAt(visibleStartIndex + localIdx))"
          @view-thinking="openThinkingViewer(msg)"
          @view-commands="openCommandsViewer(msg, 'commands')"
          @view-raw="openRawViewer(msg)"
          @view-engram="openEngramViewer(msg)"
          @toggle-original="toggleOriginalForRound(msg)"
          @toggle-bookmark="toggleBookmarkForMessage(msg, visibleStartIndex + localIdx)"
        />
      <div
        class="message"
        :class="[`message--${msg.role}`]"
        :data-global-idx="visibleStartIndex + localIdx"
      >
        <div class="message-bubble">
          <div
            v-if="msg.role === 'user'"
            class="message-text message-text--plain"
          ><SettingTaggedText :text="msg.content" /></div>
          <div v-else class="message-text"><FormattedText :text="displayTextForAssistant(msg)" :npc-names="npcNameList" :npc-data="npcDataList" /></div>

          <Tooltip
            v-if="msg.role === 'assistant' && msg._delta && msg._delta.length > 0"
            :text="$t('mainGame.delta.ariaLabel', { n: msg._delta.length })"
            interactive
          >
            <button
              class="delta-badge"
              :aria-label="$t('mainGame.delta.ariaLabel', { n: msg._delta.length })"
              @click="openCommandsViewer(msg, 'delta')"
            >
              Δ {{ msg._delta.length }}
            </button>
          </Tooltip>
        </div>
        <div
          v-if="msg.role === 'assistant' && (ttsReady || countCjkChars(msg.content) > 0 || msg._shortTermPreview)"
          class="message-meta-bottom"
          :class="{ 'message-meta-bottom--tts-on': isRoundSpeaking(roundForAssistantAt(visibleStartIndex + localIdx)) }"
        >
          <span v-if="countCjkChars(msg.content) > 0" class="message-meta-bottom__chars">{{ $t('mainGame.meta.charCount', { n: countCjkChars(msg.content) }) }}</span>
          <Tooltip
            v-if="msg._shortTermPreview"
            :text="msg._shortTermPreview"
            position="top"
          >
            <span
              class="message-meta-bottom__preview"
            >{{ $t('mainGame.meta.memoryPreview', { text: truncate(msg._shortTermPreview, 40) }) }}</span>
          </Tooltip>
          <!-- 配音 per-round 控件 (2026-07-23): 重播 + 下载, 放在底部 meta 行 -->
          <span v-if="ttsReady" class="message-meta-bottom__tts">
            <button
              type="button"
              class="meta-tts-btn"
              :class="{ 'meta-tts-btn--active': isRoundSpeaking(roundForAssistantAt(visibleStartIndex + localIdx)) }"
              data-testid="round-replay-btn"
              :aria-pressed="isRoundSpeaking(roundForAssistantAt(visibleStartIndex + localIdx))"
              @click="playTtsForMessage(msg, roundForAssistantAt(visibleStartIndex + localIdx))"
            >
              <svg v-if="isRoundSpeaking(roundForAssistantAt(visibleStartIndex + localIdx))" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="12" height="12" aria-hidden="true">
                <rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
              <svg v-else xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="12" height="12" aria-hidden="true">
                <path d="M8 5.14v13.72c0 .78.85 1.26 1.52.86l10.94-6.86a1 1 0 0 0 0-1.72L9.52 4.28A1 1 0 0 0 8 5.14Z" />
              </svg>
              <span>{{ isRoundSpeaking(roundForAssistantAt(visibleStartIndex + localIdx)) ? $t('mainGame.voice.replayStop') : $t('mainGame.voice.replay') }}</span>
            </button>
            <button
              v-if="isRoundDownloadable(roundForAssistantAt(visibleStartIndex + localIdx))"
              type="button"
              class="meta-tts-btn"
              data-testid="round-download-btn"
              :disabled="ttsDownloading"
              @click="downloadTtsForMessage(roundForAssistantAt(visibleStartIndex + localIdx))"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16" />
              </svg>
              <span>{{ ttsDownloading ? $t('mainGame.voice.downloading') : $t('mainGame.voice.download') }}</span>
            </button>
          </span>
        </div>
      </div>
      </template>

      <!--
        Streaming indicator: shown during AI generation.
        Displays accumulated text + elapsed timer + animated typing dots.
        Story 9: suppressed in worldBuilding mode. Safe because the composer (the
        only turn-submission entry) is hidden there, so a round cannot start.
      -->
      <div v-if="isGenerating && !isWorldBuilding" class="message message--assistant message--streaming">
        <div class="message-bubble">
          <div v-if="streamingText" class="message-text"><FormattedText :text="streamingText" :npc-names="npcNameList" :npc-data="npcDataList" /></div>
          <div class="streaming-meta">
            <span class="elapsed-time">{{ (generationElapsedMs / 1000).toFixed(1) }}s</span>
            <span v-if="streamingText.length > 0" class="char-count">· {{ streamingText.length }}字</span>
          </div>
          <div class="typing-indicator" :aria-label="$t('mainGame.typing.ariaLabel')">
            <span class="typing-dot" />
            <span class="typing-dot" />
            <span class="typing-dot" />
          </div>
        </div>
      </div>
      </div>

      <!--
        Scroll-to-bottom floating button —— 聊天类应用常见的"跳到最新"按钮。
        只在用户往上滚超过 30px 阈值后出现；点击瞬时跳到底部（不走 smooth 动画）。
        放在 messages-area 内部、messages-container 外部，position: absolute
        贴在 messages-container 可视区域的右下角。
      -->
      <Transition name="fade-scale">
        <Tooltip
          v-if="isUserScrolledUp || isPinnedMode || tailVisibleRounds > VISIBLE_ROUND_WINDOW"
          class="scroll-to-bottom-tip"
          :text="(isPinnedMode || tailVisibleRounds > VISIBLE_ROUND_WINDOW) ? $t('mainGame.fold.jumpToLatest') : $t('mainGame.scroll.title')"
          position="left"
          interactive
        >
          <button
            class="scroll-to-bottom-btn"
            :aria-label="$t('mainGame.scroll.ariaLabel')"
            @click="(isPinnedMode || tailVisibleRounds > VISIBLE_ROUND_WINDOW) ? jumpToLatest() : scrollToBottom(true)"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18" aria-hidden="true">
              <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v10.586l3.293-3.293a1 1 0 111.414 1.414l-5 5a1 1 0 01-1.414 0l-5-5a1 1 0 011.414-1.414L9 14.586V4a1 1 0 011-1z" clip-rule="evenodd" />
            </svg>
          </button>
        </Tooltip>
      </Transition>
    </div>

    <!-- Story 9: hidden in worldBuilding mode (no turn advancement while building the world). -->
    <GameComposer
      v-if="!isWorldBuilding"
      ref="composerRef"
      :action-options="actionOptions"
      :is-generating="isGenerating"
      :can-rollback="canRollback"
      @send="handleComposerSend"
      @copy-option="copyText"
      @cancel-generation="cancelGeneration"
      @request-rollback="showRollbackConfirm = true"
    />
    <!-- Story 9 (JOURNEY-2 fix): writing-mode replacement for the hidden composer.
         Explains why the input is gone and offers a one-click path to the guide, so a user
         who resumes / navigates back to the main panel in worldBuilding mode is not stranded. -->
    <div v-else class="wb-composer-notice">
      <p class="wb-composer-notice__text">{{ $t('mainGame.worldBuilding.composerHint') }}</p>
      <router-link to="/game/card-guide" class="wb-composer-notice__btn">{{ $t('mainGame.worldBuilding.openGuide') }}</router-link>
    </div>

    <!-- ── Rollback confirmation modal ── -->
    <Modal v-model="showRollbackConfirm" :title="$t('mainGame.rollback.modalTitle')">
      <p class="modal-body-text">{{ $t('mainGame.rollback.modalBody') }}</p>
      <div class="modal-actions">
        <button class="modal-btn modal-btn--cancel" @click="showRollbackConfirm = false">{{ $t('mainGame.composer.cancelLabel') }}</button>
        <button class="modal-btn modal-btn--confirm" @click="handleRollback">{{ $t('mainGame.rollback.confirm') }}</button>
      </div>
    </Modal>

    <!-- ── Phase 3 per-round viewers (2026-04-19) ── -->
    <ThinkingViewer
      v-model="showThinkingViewer"
      :text="activeThinking?.text ?? ''"
      :round-number="activeThinking?.roundNumber ?? 0"
    />
    <CommandsViewer
      v-model="showCommandsViewer"
      :commands="(activeCommandsPayload?.commands ?? []) as any"
      :delta="activeCommandsPayload?.delta ?? []"
      :round-number="activeCommandsPayload?.roundNumber ?? 0"
      :initial-tab="activeCommandsPayload?.initialTab ?? 'commands'"
    />
    <RawResponseViewer
      v-model="showRawViewer"
      :step1="activeRaw?.step1 ?? ''"
      :step2="activeRaw?.step2 ?? ''"
      :round-number="activeRaw?.roundNumber ?? 0"
    />
    <EngramRoundViewer
      v-model="showEngramViewer"
      :write="activeEngramPayload?.write ?? null"
      :read="activeEngramPayload?.read ?? null"
      :npc-relevance="activeEngramPayload?.npcRelevance ?? null"
      :round-number="activeEngramPayload?.roundNumber ?? 0"
    />
  </div>
</template>

<style scoped>
/*
 * MainGamePanel — sanctuary migration (2026-04-21)
 *
 * Template + script untouched. Only `<style scoped>` rewritten to match
 * .impeccable.md direction: narrative becomes the light source (serif
 * letter, no bubble chrome), sage + amber beacons only, warm-rust for
 * cancel, full-border judgement cards in FormattedText (no 3px stripe).
 *
 * Preserved: sidebar-reserve dynamic-padding pattern on every full-width
 * bar (see memory project_sidebar_reserve_pattern).
 */
.main-game-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg);
  overflow: hidden;
}

/* ── Messages area wrapper ──────────────────────────────────────
 * Wrapper around messages-container so we can anchor the floating
 * scroll-to-bottom button at its bottom-right without putting the button
 * inside the scroll container (would make the button scroll with content). */
.messages-area {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}

/* ── Scroll-to-bottom floating button ──────────────────────────
 * Frosted cabin-glass pill. Right anchor follows the sidebar-reserve
 * so the button clears the right-side droplet when it expands. */
/* Float anchor lives on the Tooltip wrapper so the button can stay static
   inside it; the wrapper follows the sidebar-reserve droplet on the right. */
.scroll-to-bottom-tip {
  position: absolute;
  right: calc(var(--sidebar-right-reserve, 40px) + 8px);
  bottom: 1rem;
  z-index: 20;
  transition: right var(--duration-open) var(--ease-droplet);
}

.scroll-to-bottom-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  padding: 0;
  border-radius: 50%;
  background: color-mix(in oklch, var(--color-surface-elevated) 80%, transparent);
  backdrop-filter: blur(14px) saturate(1.2);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
  color: var(--color-text-secondary);
  /* §8: no hard 1px border on glass — a gradient ::before edge keeps the
     translucent illusion (light-refraction rim instead of a solid line). */
  border: none;
  box-shadow: var(--shadow-md), var(--lumi-inset-highlight);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              transform var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out);
}

.scroll-to-bottom-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  padding: 1px;
  background: var(--glass-edge-gradient,
    linear-gradient(135deg,
      color-mix(in oklch, var(--color-border) 80%, transparent),
      transparent 60%));
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  mask-composite: exclude;
  pointer-events: none;
  transition: background var(--duration-fast) var(--ease-out);
}

.scroll-to-bottom-btn:hover {
  color: var(--color-sage-300);
  transform: translateY(-1px);
  box-shadow: var(--shadow-md),
              0 0 14px color-mix(in oklch, var(--color-sage-400) 22%, transparent);
}

.scroll-to-bottom-btn:hover::before {
  background: linear-gradient(135deg,
    color-mix(in oklch, var(--color-sage-400) 40%, transparent),
    transparent 60%);
}

.scroll-to-bottom-btn:focus-visible {
  outline: 2px solid var(--color-sage-400);
  outline-offset: 2px;
}

/* 进入/离开动画：淡入 + 轻微缩放 —— 保留现有行为，只在 opacity 上生效，
   不再触发平移动画（保持 sanctuary 的安静感）。*/
.fade-scale-enter-active,
.fade-scale-leave-active {
  transition: opacity var(--duration-normal) var(--ease-out),
              transform var(--duration-normal) var(--ease-out);
}
.fade-scale-enter-from,
.fade-scale-leave-to {
  opacity: 0;
  transform: scale(0.9);
}

/* ── Status bar ─────────────────────────────────────────────── */

.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* Dynamic horizontal padding — sidebar-reserve pattern (shipped 2026-04-20). */
  padding: 0.4rem var(--sidebar-right-reserve, 40px) 0.4rem var(--sidebar-left-reserve, 40px);
  transition: padding-left var(--duration-open) var(--ease-droplet),
              padding-right var(--duration-open) var(--ease-droplet);
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-surface);
  flex-shrink: 0;
  min-height: 36px;
  gap: 0.75rem;
}

.status-bar__left,
.status-bar__right {
  display: inline-flex;
  align-items: center;
  gap: 0.625rem;
  min-width: 0;
}

.status-bar__right {
  flex-shrink: 0;
}

.round-counter {
  font-family: var(--font-serif-cjk);
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--color-text);
  letter-spacing: 0.08em;
  flex-shrink: 0;
}

.status-generating {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.72rem;
  color: var(--color-sage-300);
  letter-spacing: 0.04em;
}
.status-generating::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-sage-400);
  animation: sage-pulse var(--duration-breath) var(--ease-out) infinite;
}
@keyframes sage-pulse {
  0%, 100% { opacity: 0.55; transform: scale(1); }
  50%      { opacity: 1;    transform: scale(1.15); }
}

/* ── Messages container — the reading column ─────────────────── */

.messages-container {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  /* Dynamic horizontal padding — sidebar-reserve pattern. Vertical 1rem
     preserved so prose breathes above/below chrome bars. */
  padding: 1rem var(--sidebar-right-reserve, 40px) 1rem var(--sidebar-left-reserve, 40px);
  transition: padding-left var(--duration-open) var(--ease-droplet),
              padding-right var(--duration-open) var(--ease-droplet);
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
  min-height: 0;
  scroll-behavior: smooth;
}
/* No `::-webkit-scrollbar` overrides here — the global sanctuary scrollbar
   in tokens.css handles every scrollable surface consistently. */

/* ── Empty chat state ────────────────────────────────────────── */

.empty-chat {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.625rem;
  padding: 3.5rem 1.25rem;
}

.empty-text {
  font-family: var(--font-serif-cjk);
  font-size: 0.95rem;
  color: var(--color-text-umber);
  letter-spacing: 0.08em;
  text-align: center;
}

/* Story 9: writing-mode replacement for the hidden GameComposer. */
.wb-composer-notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.625rem 0.875rem;
  padding: 0.75rem 1.25rem;
  text-align: center;
}
.wb-composer-notice__text {
  font-family: var(--font-serif-cjk);
  font-size: 0.875rem;
  color: var(--color-text-umber);
  letter-spacing: 0.04em;
  margin: 0;
}
.wb-composer-notice__btn {
  flex-shrink: 0;
  padding: 0.4rem 0.9rem;
  border-radius: 999px;
  font-size: 0.8rem;
  letter-spacing: 0.04em;
  color: var(--color-sage-400);
  background: var(--color-sage-tint, rgba(140, 170, 140, 0.12));
  text-decoration: none;
  transition: background 0.2s ease, color 0.2s ease;
}
.wb-composer-notice__btn:hover {
  background: var(--color-sage-tint-strong, rgba(140, 170, 140, 0.22));
}

/* ── Message bubbles ──────────────────────────────────────────
 * User  = a tucked-in note on the right (warm surface, sage hint)
 * AI    = pure letter, no bubble chrome (narrative is light source,
 *         per Polanyi principle + .impeccable.md "narrative is the
 *         light source")
 * Streaming = same letter form, plus a soft sage top glyph that
 *             breathes while the AI is generating. No colored
 *             side-stripe (absolute ban). */
.message {
  display: flex;
  flex-direction: column;
  max-width: 100%;
}

.message--user {
  align-self: flex-end;
  max-width: 68%;
}

.message--assistant {
  align-self: stretch;
  max-width: 100%;
}

.message-bubble {
  font-size: 0.88rem;
  line-height: 1.7;
  word-break: break-word;
}

.message--user .message-bubble {
  padding: 0.6rem 0.9rem;
  border-radius: 14px 14px 4px 14px;
  background: color-mix(in oklch, var(--color-sage-400) 10%, var(--color-surface-elevated));
  backdrop-filter: blur(8px) saturate(1.2);
  -webkit-backdrop-filter: blur(8px) saturate(1.2);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 22%, var(--color-border));
  box-shadow: var(--lumi-inset-highlight);
  color: var(--color-text);
  font-family: var(--font-sans);
  font-size: 0.85rem;
}

.message--assistant .message-bubble {
  padding: 0.25rem 0 0.125rem;
  border-radius: 0;
  background: transparent;
  border: none;
  color: var(--color-text);
  font-family: var(--font-serif-cjk);
  font-size: 0.98rem;
  line-height: var(--narrative-line-height);
  letter-spacing: var(--narrative-letter-spacing);
}

/* Streaming state — a soft sage top-left glyph breathing while the
   AI generates. Replaces the old `border-left: dashed primary` which
   both read as indigo + violated the "no colored side-stripes" rule. */
.message--streaming .message-bubble {
  position: relative;
}
.message--streaming .message-bubble::before {
  content: '';
  position: absolute;
  left: 0;
  top: -2px;
  width: 22px;
  height: 2px;
  background: linear-gradient(90deg,
    color-mix(in oklch, var(--color-sage-400) 70%, transparent),
    transparent);
  border-radius: var(--radius-full);
  animation: sage-pulse var(--duration-breath) var(--ease-out) infinite;
}
.message--streaming .message-bubble::after {
  content: '';
  position: absolute;
  inset: -8px -12px;
  background: var(--diffuse-sage);
  filter: var(--diffuse-blur);
  opacity: 0.6;
  border-radius: 16px;
  animation: lumi-pulse var(--diffuse-breathe) ease-in-out infinite;
  pointer-events: none;
  z-index: -1;
}

/* Per-turn meta row (Phase 3): hover-reveal footer below assistant
   bubbles. Kept at opacity 0 so the narrative stays the focal point;
   parent `.message--assistant` hover fades it in. */
.message-meta-bottom {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--space-md);
  margin-top: var(--space-xs);
  padding: 0 var(--space-xs);
  opacity: 0;
  transition: opacity var(--duration-slow) var(--ease-out);
  font-size: 10.5px;
  color: var(--color-text-muted);
  pointer-events: none;
}

.message--assistant:hover .message-meta-bottom,
.message-meta-bottom--tts-on {
  opacity: 0.85;
  pointer-events: auto;
}

.message-meta-bottom__chars {
  flex-shrink: 0;
  font-family: var(--font-mono);
  letter-spacing: 0.08em;
}

.message-meta-bottom__preview {
  flex: 1;
  min-width: 0;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-style: italic;
}

/* 配音 per-round 控件 (重播 / 下载) — 底部 meta 行右侧,低调 chip 级 */
.message-meta-bottom__tts {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  margin-left: auto;
}
.meta-tts-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-umber);
  font-family: inherit;
  font-size: 10.5px;
  line-height: 1.4;
  cursor: pointer;
  transition:
    color var(--duration-normal) var(--ease-out),
    border-color var(--duration-normal) var(--ease-out),
    background var(--duration-normal) var(--ease-out);
}
.meta-tts-btn:hover:not(:disabled) {
  color: var(--color-sage-300);
  border-color: color-mix(in oklch, var(--color-sage-400) 35%, var(--color-border));
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
}
.meta-tts-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 25%, transparent);
}
.meta-tts-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.meta-tts-btn--active {
  color: var(--color-sage-300);
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, var(--color-border));
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
}

.message-text {
  font-size: inherit;
  white-space: pre-wrap;
}

/* User plain-text path (2026-04-11 fix kept intact) — just the
   word-break override; font-family comes from the parent user bubble. */
.message-text--plain {
  word-break: break-word;
}

/* ── Typing indicator — three sage dots breathing ──────────────
   Bounce was replaced with vertical breath + opacity, slowed to the
   sanctuary --duration-breath tempo. Each dot has a faint sage halo
   so they glow like instrument LEDs, not Tailwind primaries. */
.typing-indicator {
  display: inline-flex;
  gap: 4px;
  padding-top: 0.375rem;
  align-items: center;
}

.typing-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-sage-400);
  animation: typing-breath var(--duration-breath) var(--ease-out) infinite;
  box-shadow: 0 0 6px color-mix(in oklch, var(--color-sage-400) 40%, transparent);
}

.typing-dot:nth-child(2) { animation-delay: 220ms; }
.typing-dot:nth-child(3) { animation-delay: 440ms; }

@keyframes typing-breath {
  0%, 100% { opacity: 0.35; transform: translateY(0); }
  50%      { opacity: 1;    transform: translateY(-3px); }
}

/* ── Streaming meta (elapsed time + char count) ────────────── */

.streaming-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 6px;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--color-text-muted);
}

.elapsed-time {
  font-variant-numeric: tabular-nums;
}

/* Prose char count — no extra font-family override; inherits --font-mono
   from .streaming-meta. */

/* ── Delta badge — sage pill, no indigo ─────────────────────── */

.delta-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-top: 8px;
  padding: 2px 10px;
  background: var(--color-sage-muted);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 28%, transparent);
  border-radius: var(--radius-full);
  font-family: var(--font-sans);
  font-size: 0.7rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--color-sage-300);
  cursor: pointer;
  line-height: 1.4;
  transition: color var(--duration-fast) var(--ease-out),
              background-color var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out);
}

.delta-badge:hover {
  color: var(--color-sage-100);
  background: color-mix(in oklch, var(--color-sage-400) 22%, transparent);
  box-shadow: 0 0 14px color-mix(in oklch, var(--color-sage-400) 25%, transparent);
}

/* ── Modal content (rollback confirm) ───────────────────────── */

.modal-body-text {
  font-family: var(--font-serif-cjk);
  font-size: 0.92rem;
  color: var(--color-text);
  line-height: 1.85;
  margin-bottom: 1.25rem;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.modal-btn {
  padding: 0.44rem 1rem;
  border-radius: var(--radius-md);
  font-family: var(--font-sans);
  font-size: 0.78rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out);
}

.modal-btn--cancel {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
}

.modal-btn--cancel:hover {
  background: color-mix(in oklch, var(--color-text) 4%, transparent);
  color: var(--color-text);
}

.modal-btn--confirm {
  background: color-mix(in oklch, var(--color-danger) 14%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-danger) 45%, transparent);
  color: color-mix(in oklch, var(--color-danger) 95%, var(--color-text));
}

.modal-btn--confirm:hover {
  background: color-mix(in oklch, var(--color-danger) 22%, transparent);
  border-color: color-mix(in oklch, var(--color-danger) 60%, transparent);
}

/* ── Search toggle button (status bar) ────────────────────────── */

.search-toggle-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              background-color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out);
}

.search-toggle-btn:hover {
  color: var(--color-sage-300);
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
}

.search-toggle-btn--active {
  color: var(--color-sage-300);
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  border-color: color-mix(in oklch, var(--color-sage-400) 25%, transparent);
}

/* ── Bookmark toggle button (收藏楼层, 2026-07-18) ──────────────── */
/* Reuses .search-toggle-btn base; auto width to fit the count badge, amber
   beacon on hover/active (amber = deliberately-kept, per sanctuary brief). */
.bookmark-toggle-btn {
  position: relative;
  width: auto;
  min-width: 28px;
  gap: 3px;
  padding: 0 6px;
}
.bookmark-toggle-btn:hover {
  color: var(--color-amber-300);
  background: color-mix(in oklch, var(--color-amber-400) 8%, transparent);
}
.bookmark-toggle-btn--active {
  color: var(--color-amber-300);
  background: color-mix(in oklch, var(--color-amber-400) 12%, transparent);
  border-color: color-mix(in oklch, var(--color-amber-400) 25%, transparent);
}
.bookmark-count {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  font-weight: 700;
  color: var(--color-amber-300);
  line-height: 1;
}

/* ── Search panel ─────────────────────────────────────────────── */

.search-panel {
  flex-shrink: 0;
  border-bottom: none;
  box-shadow: 0 4px 12px -4px color-mix(in oklch, var(--color-sage-400) 15%, transparent);
  background: color-mix(in oklch, var(--color-surface) 92%, transparent);
  backdrop-filter: blur(12px) saturate(1.1);
  -webkit-backdrop-filter: blur(12px) saturate(1.1);
  padding: 0.5rem var(--sidebar-right-reserve, 40px) 0.5rem var(--sidebar-left-reserve, 40px);
  transition: padding-left var(--duration-open) var(--ease-droplet),
              padding-right var(--duration-open) var(--ease-droplet);
}

.search-input-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: color-mix(in oklch, var(--color-surface-elevated) 60%, transparent);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.35rem 0.6rem;
}

.search-input-icon {
  flex-shrink: 0;
  color: var(--color-text-muted);
}

.search-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  font-family: var(--font-sans);
  font-size: 0.82rem;
  color: var(--color-text);
}

.search-input::placeholder {
  color: var(--color-text-muted);
}

.search-result-count {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  font-weight: 500;
  color: var(--color-sage-300);
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  padding: 1px 6px;
  border-radius: var(--radius-full);
  letter-spacing: 0.04em;
}

.search-close-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              background-color var(--duration-fast) var(--ease-out);
}

.search-close-btn:hover {
  color: var(--color-text);
  background: color-mix(in oklch, var(--color-text) 8%, transparent);
}

.search-results {
  max-height: 200px;
  overflow-y: auto;
  margin-top: 0.4rem;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.search-result-item {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  padding: 0.35rem 0.5rem;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  text-align: left;
  width: 100%;
  transition: background-color var(--duration-fast) var(--ease-out);
}

.search-result-item:hover {
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}

.search-result-round {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  font-weight: 500;
  color: var(--color-sage-300);
  letter-spacing: 0.04em;
}

.search-result-snippet {
  flex: 1;
  min-width: 0;
  font-family: var(--font-serif-cjk);
  font-size: 0.78rem;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-empty {
  padding: 0.5rem;
  font-family: var(--font-sans);
  font-size: 0.78rem;
  color: var(--color-text-muted);
  text-align: center;
}

/* ── Bookmark panel (收藏楼层, 2026-07-18) ─────────────────────── */
/* Mirrors the search-panel slide-down shell; warm-glass surface. */
.bookmark-panel {
  flex-shrink: 0;
  box-shadow: 0 4px 12px -4px color-mix(in oklch, var(--color-amber-400) 15%, transparent);
  background: color-mix(in oklch, var(--color-surface) 92%, transparent);
  backdrop-filter: blur(12px) saturate(1.1);
  -webkit-backdrop-filter: blur(12px) saturate(1.1);
  padding: 0.5rem var(--sidebar-right-reserve, 40px) 0.6rem var(--sidebar-left-reserve, 40px);
  transition: padding-left var(--duration-open) var(--ease-droplet),
              padding-right var(--duration-open) var(--ease-droplet);
}

.bookmark-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.15rem 0.2rem 0.4rem;
}
.bookmark-title {
  font-size: 0.74rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--color-text-secondary);
}

.bookmark-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.35rem 0.2rem;
  border-bottom: 1px solid var(--color-border-subtle);
}
.bookmark-selectall {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.7rem;
  color: var(--color-text-muted);
  cursor: pointer;
  user-select: none;
}
.bookmark-selectall input,
.bookmark-check {
  accent-color: var(--color-amber-400);
  cursor: pointer;
}
.bookmark-selcount {
  font-size: 0.68rem;
  color: var(--color-amber-300);
}

.bookmark-list {
  max-height: 260px;
  overflow-y: auto;
  margin-top: 0.3rem;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.bookmark-row {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.5rem 0.5rem;
  border-radius: var(--radius-sm);
  transition: background-color var(--duration-fast) var(--ease-out);
}
.bookmark-row:hover {
  background: color-mix(in oklch, var(--color-text) 4%, transparent);
}
.bookmark-row--pending {
  background: color-mix(in oklch, var(--color-amber-400) 8%, transparent);
}
.bookmark-check {
  margin-top: 3px;
  flex-shrink: 0;
  width: 15px;
  height: 15px;
}
.bookmark-body {
  flex: 1;
  min-width: 0;
}
.bookmark-namerow {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bookmark-badge {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 0.62rem;
  font-weight: 600;
  color: var(--color-sage-300);
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
  padding: 1px 7px;
  border-radius: var(--radius-full);
}
.bookmark-name {
  font-family: var(--font-serif-cjk);
  font-size: 0.82rem;
  color: var(--color-text);
  background: transparent;
  border: none;
  border-radius: 3px;
  padding: 1px 4px;
  cursor: text;
  text-align: left;
  transition: background-color var(--duration-fast) var(--ease-out);
}
.bookmark-name:hover {
  background: color-mix(in oklch, var(--color-text) 6%, transparent);
  outline: 1px dashed color-mix(in oklch, var(--color-sage-400) 40%, transparent);
}
.bookmark-name-input {
  font-family: var(--font-serif-cjk);
  font-size: 0.82rem;
  color: var(--color-text);
  background: color-mix(in oklch, var(--color-surface-input) 80%, transparent);
  border: 1px solid var(--color-sage-400);
  border-radius: 3px;
  padding: 1px 4px;
  outline: none;
  min-width: 0;
  flex: 1;
}
.bookmark-snippet {
  margin: 3px 0 0;
  font-family: var(--font-serif-cjk);
  font-size: 0.74rem;
  line-height: 1.4;
  color: var(--color-text-umber);
  cursor: pointer;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.bookmark-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.bookmark-tiny-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out);
}
.bookmark-tiny-btn:hover {
  color: var(--color-sage-300);
  border-color: color-mix(in oklch, var(--color-sage-400) 30%, var(--color-border));
}
.bookmark-tiny-btn--del:hover {
  color: var(--color-danger);
  border-color: color-mix(in oklch, var(--color-danger) 30%, var(--color-border));
}
.bookmark-empty {
  padding: 0.9rem 0.5rem;
  font-family: var(--font-sans);
  font-size: 0.76rem;
  color: var(--color-text-muted);
  text-align: center;
  font-style: italic;
}

.slide-down-enter-active,
.slide-down-leave-active {
  transition: opacity var(--duration-normal) var(--ease-out),
              max-height var(--duration-normal) var(--ease-out);
  overflow: hidden;
}
.slide-down-enter-from,
.slide-down-leave-to {
  opacity: 0;
  max-height: 0;
}
.slide-down-enter-to,
.slide-down-leave-from {
  max-height: 300px;
}

/* ── Load-more bar (folded rounds) ───────────────────────────── */

.load-more-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 0.5rem 0 0.25rem;
}

.load-more-btn,
.load-all-btn {
  font-family: var(--font-sans);
  font-size: 0.72rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  padding: 0.3rem 0.8rem;
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              background-color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out);
}

.load-more-btn {
  color: var(--color-sage-300);
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 22%, transparent);
}

.load-more-btn:hover {
  color: var(--color-sage-100);
  background: linear-gradient(135deg,
    color-mix(in oklch, var(--color-sage-400) 18%, transparent),
    color-mix(in oklch, var(--color-sage-400) 10%, transparent));
  border-color: color-mix(in oklch, var(--color-sage-400) 35%, transparent);
  box-shadow: 0 0 10px color-mix(in oklch, var(--color-sage-400) 15%, transparent);
}

.load-all-btn {
  color: var(--color-text-muted);
  background: transparent;
  border: 1px solid var(--color-border);
}

.load-all-btn:hover {
  color: var(--color-text-secondary);
  background: color-mix(in oklch, var(--color-text) 4%, transparent);
  border-color: var(--color-border);
}

/* ── Responsive — wider breakpoint first, narrower overrides after ── */

/* Mobile baseline: replace 0px sidebar-reserve with minimum padding */
@media (max-width: 767px) {
  .status-bar {
    padding-left: var(--space-md);
    padding-right: var(--space-md);
  }
  .messages-container {
    padding-left: var(--space-sm);
    padding-right: var(--space-sm);
  }
  .search-panel {
    padding-left: var(--space-md);
    padding-right: var(--space-md);
  }
}

/* Small phone refinements — overrides 767px block above */
@media (max-width: 640px) {
  .messages-container {
    padding: 0.75rem;
  }
  .message--user {
    max-width: 82%;
  }
  .search-panel {
    padding-left: 0.75rem;
    padding-right: 0.75rem;
  }
}
</style>

<!-- Unscoped: classList.add('search-highlight-flash') won't match scoped selectors -->
<style>
.search-highlight-flash {
  animation: search-flash 2s ease-out;
}
@keyframes search-flash {
  0%   { background: color-mix(in oklch, var(--color-sage-400) 18%, transparent); }
  100% { background: transparent; }
}
</style>
