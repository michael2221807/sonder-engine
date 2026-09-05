<script setup lang="ts">
// App doc: docs/user-guide/pages/game-save.md §2.5
/**
 * CardExportFlow — Game Card export orchestrator (Story 5 P5; Story 7 target mode).
 *
 * Single scrolling flow inside a Modal: coverage gate → protagonist → metadata →
 * checklist → preview → download.
 *
 * Story 7 (save-to-card): pass `target` to export ANY persisted save instead of
 * the active session. Target mode loads the save read-only, computes coverage /
 * counts / names from that tree, SKIPS the pre-export flush (flushing the live
 * state over a non-active save would corrupt it — G2), restricts protagonist
 * modes to fixed/template (U13), and stamps selected edges core:true (D5).
 * The `pre-classify` slot receives the save's edges/entities/worldBrief and the
 * owner feeds the confirmed id set back via `edgeIdsOverride`.
 */
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useGameState } from '@/ui/composables/useGameState';
import Modal from '@/ui/components/common/Modal.vue';
import ProtagonistModeSelector from '@/ui/components/panels/ProtagonistModeSelector.vue';
import CardExportChecklist from '@/ui/components/panels/CardExportChecklist.vue';
import CardStripPreview from '@/ui/components/panels/CardStripPreview.vue';
import { eventBus } from '@/engine/core/event-bus';
import { inject } from 'vue';
import type { GameStateTree } from '@/engine/types';
import type { SaveManager } from '@/engine/persistence/save-manager';
import type { ProfileManager } from '@/engine/persistence/profile-manager';
import type { EngramEditor, CoverageStats } from '@/engine/memory/engram/engram-editor';
import type { GameCardExportService } from '@/engine/export/game-card-export-service';
import type { ImageAssetCache } from '@/engine/image/asset-cache';
import type { EngramEdge } from '@/engine/memory/engram/knowledge-edge';
import type { EngramEntity } from '@/engine/memory/engram/entity-builder';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import {
  CARD_FORMAT_VERSION,
  type ProtagonistMode,
  type ExportFlags,
  type ExportOptions,
} from '@/engine/export/game-card-bundle.types';

const props = defineProps<{
  modelValue: boolean;
  /** Story 7: convert THIS persisted save instead of the active session (read-only; skips flush). */
  target?: { profileId: string; slotId: string };
  /** Story 7: confirmed edge id set from the pre-classify slot owner; null/absent = all edges. */
  edgeIdsOverride?: Set<string> | null;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
}>();

defineSlots<{
  /** U7 contract: save data down; the confirmed id set returns via the edgeIdsOverride prop. */
  'pre-classify'(props: {
    edges: EngramEdge[];
    entities: EngramEntity[];
    worldBrief: string;
    loading: boolean;
  }): unknown;
}>();

const { t } = useI18n();
const router = useRouter();
const { activeProfileId, activeSlotId, activePackId, store } = useGameState();

const gameCardExportService = inject<GameCardExportService>('gameCardExportService');
const engramEditor = inject<EngramEditor>('engramEditor');
const saveManager = inject<SaveManager>('saveManager');
const profileManager = inject<ProfileManager>('profileManager');
const imageAssetCache = inject<ImageAssetCache | undefined>('imageAssetCache', undefined);

// ─── Form state ───────────────────────────────────────────────
const mode = ref<ProtagonistMode>('fixed');
const editableFields = ref<string[]>([]);
const title = ref('');
const description = ref('');
const author = ref('');
const tags = ref<string[]>([]);
const tagDraft = ref('');
const cover = ref('');            // base64
const coverError = ref('');
const coverFileName = ref('');
const flags = ref<ExportFlags>(defaultFlags());
const coverage = ref<CoverageStats | null>(null);
const exporting = ref(false);
/** D7: optional author hint that steers the AI-generated opening on import (fixed/template). */
const firstRoundSetup = ref('');

// ─── Story 7 target mode state ────────────────────────────────
const sourceTree = ref<Record<string, unknown> | null>(null);
const loadingTree = ref(false);
const missingImageCount = ref(0);
// Monotonic open-generation guard: an in-flight loadGame whose generation no
// longer matches the latest open is stale and must not mutate state (HIGH #1).
let openGeneration = 0;

function defaultFlags(): ExportFlags {
  return {
    containsNsfw: false,
    includedGenerationHistory: false,
    includedReferenceGallery: false,
    includedSettings: false,
    includedApiTemplate: false,
    includedEngineConfig: false,
    includedWorldBooks: false,
    includedBuiltinOverrides: false,
    includedPromptSettings: false,
    includedHeroinePlan: false,
    includedPlotDirection: true, // OD1: plot direction default ON (reset, no spoiler)
    includedNarrativeContract: true, // R2 Q2: the author's melody travels with the card by default
  };
}

function resetForm(): void {
  mode.value = 'fixed';
  editableFields.value = [];
  title.value = '';
  description.value = '';
  author.value = '';
  tags.value = [];
  tagDraft.value = '';
  cover.value = '';
  coverError.value = '';
  coverFileName.value = '';
  flags.value = defaultFlags();
  firstRoundSetup.value = '';
}

// ─── Coverage gate ────────────────────────────────────────────
watch(
  () => props.modelValue,
  (open) => {
    openGeneration++;
    if (!open) return;
    resetForm();
    sourceTree.value = null;
    missingImageCount.value = 0;
    if (props.target) {
      void openForTarget(openGeneration);
    } else {
      coverage.value = engramEditor ? engramEditor.getCoverageStats() : null;
      void refreshMissingImages(asRecord(store.toSnapshot()));
    }
  },
  // immediate so the Story 7 path works when this component is mounted via
  // `v-if="modelValue && target"` (already-true on mount); the Story 5 always-mounted
  // case fires once with open=false and early-returns harmlessly.
  { immediate: true },
);

/** Target mode open: async read-only load of the persisted save (hardening F5).
 *  `gen` pins this call to one open; a close/reopen bumps openGeneration and any
 *  late-resolving prior load becomes a no-op (HIGH #1 race guard). */
async function openForTarget(gen: number): Promise<void> {
  if (!saveManager || !props.target) return;
  loadingTree.value = true;
  coverage.value = null;
  try {
    const tree = await saveManager.loadGame(props.target.profileId, props.target.slotId);
    if (gen !== openGeneration) return; // modal closed or reopened mid-flight → discard
    if (!tree) throw new Error(`save missing: ${props.target.profileId}/${props.target.slotId}`);
    sourceTree.value = tree as unknown as Record<string, unknown>;
    coverage.value = engramEditor ? engramEditor.getCoverageStatsForTree(sourceTree.value) : null;
    void refreshMissingImages(sourceTree.value);
  } catch (err) {
    if (gen !== openGeneration) return;
    console.warn('[CardExportFlow] failed to load target save:', err);
    eventBus.emit('ui:toast', { type: 'error', i18nKey: 'save.toCard.loadFailed', message: t('save.toCard.loadFailed') });
    close();
  } finally {
    if (gen === openGeneration) loadingTree.value = false;
  }
}

const gatePass = computed(
  () =>
    coverage.value !== null &&
    coverage.value.missingNpcNames.length === 0 &&
    coverage.value.missingLocationNames.length === 0,
);

/** EMPTY-1: a save with zero NPCs AND zero locations passes gatePass vacuously
 *  (the coverage check only asks "do existing entities have a node"). Treat it as a
 *  distinct state so the green "graph complete" pass is never shown for a content-less card. */
const isEmptyWorld = computed(
  () => coverage.value !== null && coverage.value.totalNpcs === 0 && coverage.value.totalLocations === 0,
);

/** Three-way gate state for the banner: pass / empty / incomplete. */
const gateState = computed<'pass' | 'empty' | 'incomplete'>(() => {
  if (isEmptyWorld.value) return 'empty';
  return gatePass.value ? 'pass' : 'incomplete';
});

/**
 * JOURNEY-1 (PM decision A): whether the export form unlocks.
 * - Active session (Story 5 导出): HARD gate — D18 coverage + non-empty world.
 * - Target save (Story 7 转卡): the coverage gate is a NON-BLOCKING warning. The
 *   solidify tool only reaches the active session, so blocking a non-active save would be
 *   an unsatisfiable dead-end, contradicting Story 7's "any save → card" success criterion.
 *   Once the read-only load resolves (coverage !== null) the form is available.
 */
const canProceed = computed(() =>
  props.target ? coverage.value !== null : gatePass.value && !isEmptyWorld.value,
);

// ─── Target save metadata (Story 7) ───────────────────────────
const targetSlotMeta = computed(() =>
  props.target ? profileManager?.getSlotMeta(props.target.profileId, props.target.slotId) : undefined,
);

const targetCharacterName = computed(() => {
  if (!props.target) return '';
  const fromMeta = targetSlotMeta.value?.characterName;
  if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta;
  // Fallback when slot meta lacks the name: read it from the loaded tree. This UI-layer
  // path mirrors the protagonist name field (角色.基础信息.姓名); if the pack renames it,
  // slotMeta.characterName above remains the primary, schema-stable source.
  const v = rec(rec((sourceTree.value ?? {})['角色'])?.['基础信息'])?.['姓名'];
  return typeof v === 'string' ? v : '';
});

const fixedNameMissing = computed(() =>
  mode.value === 'fixed' &&
  !(props.target ? targetCharacterName.value.trim() : String(store.characterName ?? '').trim()),
);

const canExport = computed(
  () =>
    canProceed.value && title.value.trim() !== '' && !fixedNameMissing.value && !exporting.value &&
    !loadingTree.value && (!props.target || sourceTree.value !== null),
);

// ─── Preview source: target tree (Story 7) or the live snapshot (Story 5) ──
const previewSnap = computed<Record<string, unknown>>(() =>
  props.target ? (sourceTree.value ?? {}) : asRecord(store.toSnapshot()),
);

const counts = computed(() => {
  const snap = previewSnap.value;
  return {
    npc: coverage.value?.totalNpcs ?? 0,
    loc: coverage.value?.totalLocations ?? 0,
    edge: props.edgeIdsOverride ? props.edgeIdsOverride.size : edgeIdsFrom(snap).size,
    img: countSelectedImages(snap),
  };
});

// ─── pre-classify slot data (Story 7, U7) ─────────────────────
const sourceEdges = computed<EngramEdge[]>(() => {
  const engram = rec(rec(rec(previewSnap.value['系统'])?.['扩展'])?.['engramMemory']);
  const v2 = engram?.['v2Edges'];
  return Array.isArray(v2) ? (v2 as EngramEdge[]) : [];
});

const sourceEntities = computed<EngramEntity[]>(() => {
  const engram = rec(rec(rec(previewSnap.value['系统'])?.['扩展'])?.['engramMemory']);
  const ents = engram?.['entities'];
  return Array.isArray(ents) ? (ents as EngramEntity[]) : [];
});

const worldBrief = computed<string>(() => {
  let cur: unknown = previewSnap.value;
  for (const seg of DEFAULT_ENGINE_PATHS.worldDescription.split('.')) {
    cur = rec(cur)?.[seg];
  }
  return typeof cur === 'string' ? cur : '';
});

// ─── Missing-image warning (U16) ──────────────────────────────
async function refreshMissingImages(snap: Record<string, unknown>): Promise<void> {
  if (!imageAssetCache) { missingImageCount.value = 0; return; }
  try {
    const ids = collectSelectedImageIds(snap);
    if (ids.size === 0) { missingImageCount.value = 0; return; }
    const cached = new Set((await imageAssetCache.listAll()).map((a) => a.id));
    missingImageCount.value = [...ids].filter((id) => !cached.has(id)).length;
  } catch {
    missingImageCount.value = 0; // warning is best-effort, never blocks the flow
  }
}

// ─── Helpers ──────────────────────────────────────────────────
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function edgeIdsFrom(snap: Record<string, unknown>): Set<string> {
  const engram = rec(rec(rec(snap['系统'])?.['扩展'])?.['engramMemory']);
  const v2 = engram?.['v2Edges'];
  const ids = new Set<string>();
  if (Array.isArray(v2)) {
    for (const e of v2) {
      const id = rec(e)?.['id'];
      if (typeof id === 'string') ids.add(id);
    }
  }
  return ids;
}
function countSelectedImages(snap: Record<string, unknown>): number {
  let n = 0;
  const sel = ['已选头像图片ID', '已选立绘图片ID', '已选背景图片ID'];
  const player = rec(rec(snap['角色'])?.['图片档案']);
  for (const f of sel) if (typeof player?.[f] === 'string' && player[f]) n++;
  const rels = rec(snap['社交'])?.['关系'];
  if (Array.isArray(rels)) {
    for (const npc of rels) {
      const arc = rec(rec(npc)?.['图片档案']);
      for (const f of sel) if (typeof arc?.[f] === 'string' && arc[f]) n++;
    }
  }
  const scene = rec(rec(rec(rec(snap['系统'])?.['扩展'])?.['image'])?.['sceneArchive']);
  if (typeof scene?.['当前壁纸图片ID'] === 'string' && scene['当前壁纸图片ID']) n++;
  return n;
}

/** Same field walk as countSelectedImages, but collecting unique ids (missing-image check, U16). */
function collectSelectedImageIds(snap: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const sel = ['已选头像图片ID', '已选立绘图片ID', '已选背景图片ID'];
  const player = rec(rec(snap['角色'])?.['图片档案']);
  for (const f of sel) if (typeof player?.[f] === 'string' && player[f]) ids.add(player[f] as string);
  const rels = rec(snap['社交'])?.['关系'];
  if (Array.isArray(rels)) {
    for (const npc of rels) {
      const arc = rec(rec(npc)?.['图片档案']);
      for (const f of sel) if (typeof arc?.[f] === 'string' && arc[f]) ids.add(arc[f] as string);
    }
  }
  const scene = rec(rec(rec(rec(snap['系统'])?.['扩展'])?.['image'])?.['sceneArchive']);
  if (typeof scene?.['当前壁纸图片ID'] === 'string' && scene['当前壁纸图片ID']) ids.add(scene['当前壁纸图片ID'] as string);
  return ids;
}

// ─── Tags + cover ─────────────────────────────────────────────
function addTag(): void {
  const v = tagDraft.value.trim();
  if (v && !tags.value.includes(v)) tags.value = [...tags.value, v];
  tagDraft.value = '';
}
function removeTag(tag: string): void {
  tags.value = tags.value.filter((x) => x !== tag);
}
function onCover(e: Event): void {
  coverError.value = '';
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  // Reset the native input so re-picking the same file still fires change.
  input.value = '';
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    coverError.value = t('save.export.meta.coverTooLarge');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const result = String(reader.result ?? '');
    // accept="image/*" is only a browser hint — enforce an image data-URL before embedding it in the card.
    if (!result.startsWith('data:image/')) {
      coverError.value = t('save.export.meta.coverInvalidType');
      return;
    }
    cover.value = result;
    coverFileName.value = file.name;
  };
  reader.onerror = () => { coverError.value = t('save.export.meta.coverInvalidType'); };
  reader.readAsDataURL(file);
}

function clearCover(): void {
  cover.value = '';
  coverFileName.value = '';
  coverError.value = '';
}

// ─── Gate navigation ──────────────────────────────────────────
function goSolidify(): void {
  emit('update:modelValue', false);
  void router.push('/game/relationship-graph');
}

/** EMPTY-1: empty world has nothing to solidify — send the author to build it first. */
function goBuildWorld(): void {
  emit('update:modelValue', false);
  void router.push('/game/card-guide');
}

// ─── Export ───────────────────────────────────────────────────
function close(): void { emit('update:modelValue', false); }

async function doExport(): Promise<void> {
  if (!canExport.value || !gameCardExportService || !saveManager) return;
  const pid = props.target?.profileId ?? activeProfileId.value;
  const slot = props.target?.slotId ?? activeSlotId.value;
  if (!pid || !slot) return;

  exporting.value = true;
  try {
    let packId: string;
    let packVersion: string | undefined;
    let selectedEdgeIds: Set<string>;

    if (props.target) {
      // Story 7: the target save is already persisted — NO flush (flushing the live
      // session over a non-active save would corrupt it, G2). Pack identity comes
      // from the target slot meta only — never fall back to the active pack (U14/G7).
      const slotMeta = targetSlotMeta.value;
      if (!slotMeta?.packId) {
        eventBus.emit('ui:toast', { type: 'error', i18nKey: 'save.toCard.packIdMissing', message: t('save.toCard.packIdMissing') });
        return;
      }
      packId = slotMeta.packId;
      packVersion = slotMeta.packVersion;
      // Confirmed set from the classification panel (U7); fall back to all edges.
      selectedEdgeIds = props.edgeIdsOverride ?? edgeIdsFrom(sourceTree.value ?? {});
    } else {
      // Story 5: flush the live state so exportCard reads a consistent persisted snapshot.
      packId = activePackId.value ?? '';
      const snapshot = store.toSnapshot() as GameStateTree;
      const slotMeta = profileManager?.getProfile(pid)?.slots[slot];
      await saveManager.saveGame(pid, slot, snapshot, {
        slotId: slot,
        slotName: slotMeta?.slotName ?? slot,
        lastSavedAt: new Date().toISOString(),
        packId: slotMeta?.packId ?? packId,
        packVersion: slotMeta?.packVersion ?? '',
        characterName: store.characterName,
        currentLocation: store.currentLocation,
        gameTime: store.gameTime,
        saveType: 'manual',
      });
      packVersion = slotMeta?.packVersion;
      // Story 5: include ALL edge ids (creative-card edges = world setup).
      selectedEdgeIds = edgeIdsFrom(asRecord(snapshot));
    }

    const now = new Date().toISOString();
    const options: ExportOptions = {
      protagonist: {
        mode: mode.value,
        editableFields: mode.value === 'template' ? editableFields.value : undefined,
      },
      cardMeta: {
        formatVersion: CARD_FORMAT_VERSION,
        cardId: crypto.randomUUID(),
        title: title.value.trim(),
        description: description.value.trim(),
        author: author.value.trim(),
        tags: tags.value,
        coverImage: cover.value || undefined,
        createdAt: now,
        updatedAt: now,
        packId,
        packVersion, // Story 6 import uses this for cross-version drift warnings
      },
      selectedEdgeIds,
      // D5: every edge the author confirmed into the card is a world setting → core:true (copy only).
      markSelectedEdgesCore: props.target ? true : undefined,
      // D7: optional author hint to steer the import-time opening (fixed/template only).
      firstRoundSetup: mode.value !== 'blank' ? (firstRoundSetup.value.trim() || undefined) : undefined,
      checklist: flags.value,
    };

    const { blob } = await gameCardExportService.exportCard(pid, slot, options);
    downloadBlob(blob, fileName());
    eventBus.emit('ui:toast', { type: 'success', message: t('save.export.success'), duration: 2200 });
    close();
  } catch (err) {
    eventBus.emit('ui:toast', { type: 'error', message: t('save.export.failed') });
    console.warn('[CardExportFlow] export failed:', err);
  } finally {
    exporting.value = false;
  }
}

function fileName(): string {
  const safe = title.value.trim().replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'card';
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `card-${safe}-${date}.aga-card`;
}
function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }
}
</script>

<template>
  <Modal
    :model-value="modelValue"
    :title="t(props.target ? 'save.toCard.modalTitle' : 'save.export.modalTitle')"
    width="640px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="cef">
      <!-- Story 7: async target-save loading state -->
      <p v-if="loadingTree" class="cef-loading">{{ t('save.toCard.loading') }}</p>

      <!-- ① Coverage gate — pass / empty-world / incomplete.
           Target mode (Story 7 转卡): incomplete + empty are NON-BLOCKING warnings (PM decision A);
           active mode (Story 5 导出): they hard-block with an actionable CTA. -->
      <div
        v-if="coverage"
        class="cef-gate"
        :class="{
          'cef-gate--pass': gateState === 'pass',
          'cef-gate--warn': props.target && gateState !== 'pass',
          'cef-gate--fail': !props.target && gateState !== 'pass',
        }"
      >
        <!-- pass -->
        <template v-if="gateState === 'pass'">
          <span class="cef-gate__icon">✓</span>
          <div>
            <p class="cef-gate__title">{{ t('save.export.gate.pass') }}</p>
            <p class="cef-gate__detail">{{ t('save.export.gate.passDetail', { npc: coverage.totalNpcs, loc: coverage.totalLocations }) }}</p>
          </div>
        </template>

        <!-- empty world (no NPCs / no locations) -->
        <template v-else-if="gateState === 'empty'">
          <span class="cef-gate__icon">!</span>
          <div class="cef-gate__body">
            <p class="cef-gate__title">{{ props.target ? t('save.toCard.gateWarnEmptyTitle') : t('save.export.gate.emptyTitle') }}</p>
            <p class="cef-gate__detail">{{ props.target ? t('save.toCard.gateWarnHint') : t('save.export.gate.emptyDetail') }}</p>
            <button v-if="!props.target" type="button" class="cef-gate__btn" @click="goBuildWorld">{{ t('save.export.gate.goBuildWorld') }}</button>
          </div>
        </template>

        <!-- incomplete coverage -->
        <template v-else>
          <span class="cef-gate__icon">!</span>
          <div class="cef-gate__body">
            <p class="cef-gate__title">{{ props.target ? t('save.toCard.gateWarnTitle') : t('save.export.gate.fail') }}</p>
            <p v-if="coverage.missingNpcNames.length" class="cef-gate__detail">
              {{ t('save.export.gate.failNpc', { names: coverage.missingNpcNames.join('、') }) }}
            </p>
            <p v-if="coverage.missingLocationNames.length" class="cef-gate__detail">
              {{ t('save.export.gate.failLoc', { names: coverage.missingLocationNames.join('、') }) }}
            </p>
            <p v-if="props.target" class="cef-gate__detail cef-gate__hint">{{ t('save.toCard.gateWarnHint') }}</p>
            <button v-else type="button" class="cef-gate__btn" @click="goSolidify">{{ t('save.export.gate.goSolidify') }}</button>
          </div>
        </template>
      </div>

      <!-- Story 7 injects its edge-classification panel here (U7 slot contract:
           edges/entities/worldBrief down, confirmed Set back via edgeIdsOverride prop) -->
      <slot
        name="pre-classify"
        :edges="sourceEdges"
        :entities="sourceEntities"
        :world-brief="worldBrief"
        :loading="loadingTree"
      />

      <template v-if="canProceed">
        <!-- ② Protagonist -->
        <section class="cef-sec">
          <h3 class="cef-sec__title">{{ t('save.export.protagonist.sectionTitle') }}</h3>
          <ProtagonistModeSelector
            v-model:mode="mode"
            v-model:editable-fields="editableFields"
            :allowed-modes="props.target ? (['fixed', 'template'] as ProtagonistMode[]) : undefined"
          />
          <p v-if="fixedNameMissing" class="cef-warn">{{ t('save.export.protagonist.fixedEmptyName') }}</p>
        </section>

        <!-- ③ Metadata -->
        <section class="cef-sec">
          <h3 class="cef-sec__title">{{ t('save.export.meta.sectionTitle') }}</h3>
          <label class="cef-field">
            <span class="cef-field__label">{{ t('save.export.meta.titleLabel') }} *</span>
            <input v-model="title" class="cef-input" type="text" data-testid="card-export-title" :placeholder="t('save.export.meta.titlePlaceholder')" />
          </label>
          <label class="cef-field">
            <span class="cef-field__label">{{ t('save.export.meta.descLabel') }}</span>
            <textarea v-model="description" class="cef-input cef-input--area" rows="2" :placeholder="t('save.export.meta.descPlaceholder')" />
          </label>
          <label class="cef-field">
            <span class="cef-field__label">{{ t('save.export.meta.authorLabel') }}</span>
            <input v-model="author" class="cef-input" type="text" :placeholder="t('save.export.meta.authorPlaceholder')" />
          </label>
          <!-- D7: optional author hint to steer the AI-generated opening on import (fixed/template). -->
          <label v-if="mode !== 'blank'" class="cef-field">
            <span class="cef-field__label">{{ t('save.export.meta.openingHintLabel') }}</span>
            <textarea v-model="firstRoundSetup" class="cef-input cef-input--area" rows="2" :placeholder="t('save.export.meta.openingHintPlaceholder')" />
            <span class="cef-field__help">{{ t('save.export.meta.openingHintHelp') }}</span>
          </label>
          <label class="cef-field">
            <span class="cef-field__label">{{ t('save.export.meta.tagsLabel') }}</span>
            <div class="cef-tags">
              <span v-for="tag in tags" :key="tag" class="cef-tag" @click="removeTag(tag)">{{ tag }} ✕</span>
              <input v-model="tagDraft" class="cef-input cef-input--tag" type="text" :placeholder="t('save.export.meta.tagsPlaceholder')" @keydown.enter.prevent="addTag" />
            </div>
          </label>
          <div class="cef-field">
            <span class="cef-field__label">{{ t('save.export.meta.coverLabel') }}</span>
            <div class="cef-cover">
              <img v-if="cover" :src="cover" class="cef-cover__thumb" alt="" />
              <label class="cef-filebtn">
                <input type="file" accept="image/*" @change="onCover" />
                <span>{{ t('save.export.meta.coverPick') }}</span>
              </label>
              <span class="cef-filename" :title="coverFileName">{{ coverFileName || t('save.export.meta.coverNone') }}</span>
              <button v-if="cover" type="button" class="cef-cover__clear" @click="clearCover">{{ t('save.export.meta.coverClear') }}</button>
            </div>
            <p v-if="coverError" class="cef-warn">{{ coverError }}</p>
          </div>
        </section>

        <!-- ④ Checklist -->
        <section class="cef-sec">
          <h3 class="cef-sec__title">{{ t('save.export.content.sectionTitle') }}</h3>
          <CardExportChecklist v-model="flags" />
        </section>

        <!-- ⑤ Strip preview (U12: kept / cleared / reset, shared by both modes) -->
        <section class="cef-sec">
          <h3 class="cef-sec__title">{{ t('save.export.preview.sectionTitle') }}</h3>
          <CardStripPreview
            :counts="{ npc: counts.npc, loc: counts.loc, img: counts.img }"
            :edge-count="counts.edge"
            :flags="flags"
            :missing-image-count="missingImageCount"
            :target-mode="Boolean(props.target)"
          />
        </section>
      </template>
    </div>

    <template #footer>
      <button type="button" class="btn-modal btn-modal--secondary" @click="close">{{ t('save.export.cancel') }}</button>
      <button type="button" class="btn-modal btn-modal--primary" data-testid="card-export-submit" :disabled="!canExport" @click="doExport">
        {{ exporting ? t('save.export.exporting') : t('save.export.exportBtn') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.cef { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
/* Prevent any control from overflowing the modal body (no horizontal scrollbar). */
.cef :where(input, textarea, select) { box-sizing: border-box; max-width: 100%; }
.cef :where(p, h3, span) { overflow-wrap: anywhere; }

.cef-gate {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-md);
}
.cef-gate--pass { background: color-mix(in oklch, var(--color-sage-400) 12%, transparent); }
.cef-gate--fail { background: color-mix(in oklch, var(--color-amber-400) 12%, transparent); }
.cef-gate__icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  font-weight: 700;
  border-radius: var(--radius-full);
  color: var(--color-bg);
}
.cef-gate--pass .cef-gate__icon { background: var(--color-sage-400); }
.cef-gate--fail .cef-gate__icon { background: var(--color-amber-400); }
/* Target-mode (Story 7) non-blocking warning — softer amber than the active-mode hard block. */
.cef-gate--warn { background: color-mix(in oklch, var(--color-amber-400) 8%, transparent); }
.cef-gate--warn .cef-gate__icon { background: var(--color-amber-400); }
.cef-gate__title { margin: 0; font-size: 0.9rem; font-weight: 600; color: var(--color-text); }
.cef-gate__detail { margin: 4px 0 0; font-size: 0.8rem; color: var(--color-text-secondary); }
.cef-gate__hint { font-style: italic; opacity: 0.85; }
.cef-gate__btn {
  margin-top: 8px;
  padding: 6px 12px;
  font-size: 0.82rem;
  color: var(--color-bg);
  background: var(--color-amber-400);
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.cef-sec__title {
  margin: 0 0 10px;
  font-family: var(--font-serif-cjk);
  font-size: 0.98rem;
  font-weight: 500;
  color: var(--color-text);
}

.cef-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; }
.cef-field__label { font-size: 0.82rem; color: var(--color-text-secondary); }
.cef-field__help { font-size: 0.74rem; color: var(--color-text-secondary); opacity: 0.75; }
.cef-input {
  width: 100%;
  padding: 8px 10px;
  font-size: 0.9rem;
  color: var(--color-text);
  background: color-mix(in oklch, var(--color-bg) 55%, transparent);
  border: none;
  border-radius: var(--radius-sm);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-text) 10%, transparent);
  transition: box-shadow 0.16s var(--ease-out);
}
.cef-input::placeholder { color: color-mix(in oklch, var(--color-text-secondary) 70%, transparent); }
.cef-input:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1.5px color-mix(in oklch, var(--color-sage-400) 55%, transparent);
}
.cef-input--area { resize: vertical; min-height: 44px; font-family: inherit; }

.cef-tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.cef-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 0.78rem;
  color: var(--color-text);
  background: color-mix(in oklch, var(--color-sage-400) 16%, transparent);
  border-radius: var(--radius-full);
  cursor: pointer;
}
.cef-input--tag { flex: 1; min-width: 120px; }

.cef-cover { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.cef-cover__thumb { width: 56px; height: 56px; object-fit: cover; border-radius: var(--radius-sm); flex-shrink: 0; }
/* Custom file picker — native input visually hidden, label acts as the button. */
.cef-filebtn {
  display: inline-flex;
  align-items: center;
  padding: 6px 14px;
  font-size: 0.82rem;
  color: var(--color-text);
  background: color-mix(in oklch, var(--color-bg) 55%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-text) 14%, transparent);
  border-radius: var(--radius-sm);
  cursor: pointer;
  flex-shrink: 0;
  transition: box-shadow 0.16s var(--ease-out), background 0.16s var(--ease-out);
}
.cef-filebtn:hover { box-shadow: inset 0 0 0 1.5px color-mix(in oklch, var(--color-sage-400) 50%, transparent); }
.cef-filebtn input[type="file"] {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0);
  white-space: nowrap; border: 0;
}
.cef-filename {
  flex: 1;
  min-width: 0;
  font-size: 0.8rem;
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cef-cover__clear {
  padding: 4px 10px;
  font-size: 0.8rem;
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-text) 14%, transparent);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.cef-warn { margin: 6px 0 0; font-size: 0.8rem; color: var(--color-amber-400); }

.cef-loading { margin: 0; font-size: 0.86rem; color: var(--color-text-secondary); }

.btn-modal {
  padding: 8px 18px;
  font-size: 0.88rem;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.16s var(--ease-out), box-shadow 0.16s var(--ease-out);
}
.btn-modal--secondary {
  color: var(--color-text-secondary);
  background: transparent;
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-text) 14%, transparent);
}
.btn-modal--primary { color: var(--color-bg); background: var(--color-sage-400); }
.btn-modal--primary:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
