<script setup lang="ts">
// App doc: docs/user-guide/pages/game-save.md §2.6
/**
 * CardImportFlow — Game Card import orchestrator (Story 6, P6).
 *
 * Single scrolling state-machine inside a Modal — the structural inverse of CardExportFlow:
 *   upload → decode → preview → (nsfw gate) → protagonist(fixed|template|blankReject) →
 *   global opt-in → progress → success.  (handover §6 is the authoritative UI spec.)
 *
 * The engine returns CODES only; this component resolves them to i18n. Decode/preview use the
 * pure `decodeAndValidateCard`; the actual write goes through `GameCardImportService.importCard`.
 */
import { ref, computed, watch, nextTick, inject } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { get as _get } from 'lodash-es';
import Modal from '@/ui/components/common/Modal.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { getBootstrapGamePack } from '@/engine/bootstrap-pack';
import { decodeAndValidateCard, type ValidatedCard } from '@/engine/export/game-card-import-service';
import { readImportedCardLedger } from '@/engine/export/card-import-payloads';
import type { GameCardImportService } from '@/engine/export/game-card-import-service';
import type { GameCardBundle, ProtagonistMode } from '@/engine/export/game-card-bundle.types';
import type { GlobalOptInFlag, ImportErrorCode, PackVersionDrift } from '@/engine/export/game-card-import.types';
import { validateEditableFields } from '@/engine/export/protagonist-template';
import { buildDefaultProtagonistPolicy } from '@/engine/export/card-export-paths';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  /** Emitted after a successful import so HomeView re-lists profiles (SC-UI-A). */
  (e: 'imported'): void;
}>();

const { t } = useI18n();
const router = useRouter();
const importService = inject<GameCardImportService>('gameCardImportService');

type Stage =
  | 'upload' | 'decode' | 'preview' | 'nsfw'
  | 'protagonist' | 'blankRejected' | 'global' | 'progress' | 'success' | 'error';

const MAX_CARD_BYTES = 64 * 1024 * 1024;
const ALLOWED_COVER_MIME = /^data:image\/(png|jpeg|webp);/i; // security M-3: no svg → no XSS

// ─── State ────────────────────────────────────────────────────
const stage = ref<Stage>('upload');
const blob = ref<Blob | null>(null);
const dragOver = ref(false);
const reading = ref(false);
const uploadError = ref('');
const errorCode = ref<ImportErrorCode | null>(null);

const bundle = ref<GameCardBundle | null>(null);
// The schema-default base deep-merged with the card's stateTree (returned by decode). The
// character data lives here (角色.*), NOT in protagonist.data which real exported cards never set.
const mergedTree = ref<Record<string, unknown> | null>(null);
const drift = ref<PackVersionDrift | null>(null);
const alreadyImported = ref(false);

// protagonist (template) edits, keyed by editable path relative to 角色
const edits = ref<Record<string, unknown>>({});
const enableNsfw = ref(false);
const optIns = ref<Set<GlobalOptInFlag>>(new Set());

// progress + result
const importing = ref(false);
const openingPhase = ref('');
const result = ref<{ profileId: string; slotId: string; retrievalDegraded: boolean; openingDegraded: boolean; globalChangesApplied: boolean } | null>(null);
const undone = ref(false);   // global-changes undone on the success screen
const undoing = ref(false);
const undoFailed = ref(false);
const importAbort = ref<AbortController | null>(null); // lets ⑦ skip the (slow) opening generation

const fileInput = ref<HTMLInputElement | null>(null);
const bodyEl = ref<HTMLElement | null>(null);

function reset(): void {
  stage.value = 'upload';
  blob.value = null;
  dragOver.value = false;
  reading.value = false;
  uploadError.value = '';
  errorCode.value = null;
  bundle.value = null;
  mergedTree.value = null;
  drift.value = null;
  alreadyImported.value = false;
  edits.value = {};
  enableNsfw.value = false;
  optIns.value = new Set();
  importing.value = false;
  openingPhase.value = '';
  result.value = null;
  undone.value = false;
  undoing.value = false;
  undoFailed.value = false;
  importAbort.value = null;
}

watch(() => props.modelValue, (open) => { if (open) reset(); });

// Move focus to the stage heading on each transition (a11y §6.10).
watch(stage, async () => {
  await nextTick();
  bodyEl.value?.querySelector<HTMLElement>('[data-stage-focus]')?.focus();
});

// ─── ① Upload ─────────────────────────────────────────────────
function pickFile(): void {
  if (fileInput.value) fileInput.value.value = ''; // allow re-selecting the same file (else no change event)
  fileInput.value?.click();
}

function onFileInput(e: Event): void {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void acceptFile(f);
}
function onDrop(e: DragEvent): void {
  dragOver.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (f) void acceptFile(f);
}

async function acceptFile(file: File): Promise<void> {
  uploadError.value = '';
  if (!file.name.toLowerCase().endsWith('.aga-card')) {
    uploadError.value = t('save.import.card.upload.wrongExt');
    return;
  }
  if (file.size > MAX_CARD_BYTES) {
    uploadError.value = t('save.import.card.upload.tooLarge');
    return;
  }
  reading.value = true;
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // gzip magic 0x1f 0x8b — second cheap guard before handing to the engine.
    if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
      uploadError.value = t('save.import.card.upload.notGzip');
      return;
    }
    blob.value = new Blob([buf]);
    await decode();
  } catch {
    uploadError.value = t('save.import.card.upload.readFailed');
  } finally {
    reading.value = false;
  }
}

// ─── ② Decode + validate ──────────────────────────────────────
async function decode(): Promise<void> {
  if (!blob.value) return;
  stage.value = 'decode';
  const outcome = await decodeAndValidateCard(blob.value, getBootstrapGamePack());
  if (!outcome.ok) {
    if (outcome.code === 'blank-unsupported') { stage.value = 'blankRejected'; return; }
    errorCode.value = outcome.code;
    stage.value = 'error';
    return;
  }
  const v: ValidatedCard = outcome;
  bundle.value = v.bundle;
  mergedTree.value = v.mergedTree;
  drift.value = v.packVersionDrift ?? null;
  alreadyImported.value = readImportedCardLedger().includes(v.bundle.cardMeta.cardId);
  stage.value = 'preview';
}

// ─── ③ Preview data ───────────────────────────────────────────
const cardMeta = computed(() => bundle.value?.cardMeta ?? null);
const coverOk = computed(() => {
  const c = cardMeta.value?.coverImage;
  return typeof c === 'string' && ALLOWED_COVER_MIME.test(c);
});
const coverInitial = computed(() => (cardMeta.value?.title ?? '?').trim().charAt(0) || '?');

const counts = computed(() => {
  const b = bundle.value;
  if (!b) return { loc: 0, npc: 0, edge: 0, mem: 0, img: 0 };
  const tree = b.stateTree as Record<string, unknown>;
  const locations = _get(tree, '世界.地点信息');
  const rels = _get(tree, '社交.关系');
  return {
    loc: locations && typeof locations === 'object' ? Object.keys(locations as object).length : 0,
    npc: Array.isArray(rels) ? rels.length : 0,
    edge: b.engram?.knowledgeEdges?.length ?? 0,
    mem: b.engram?.entities?.length ?? 0,
    img: b.imageAssets?.length ?? 0,
  };
});

/** Export-flag chips (only TRUE flags surface), each with a plain-language Tooltip. */
const flagChips = computed(() => {
  const f = bundle.value?.exportFlags;
  if (!f) return [] as { key: string; label: string; hint: string }[];
  const out: { key: string; label: string; hint: string }[] = [];
  const add = (cond: boolean | undefined, key: string) => {
    if (cond) out.push({ key, label: t(`save.import.card.flag.${key}`), hint: t(`save.import.card.flag.${key}Hint`) });
  };
  add(f.includedWorldBooks, 'worldBooks');
  add(f.includedPromptSettings, 'promptSettings');
  add(f.includedHeroinePlan, 'heroinePlan');
  add(f.includedPlotDirection, 'plotDirection');
  add(f.includedNarrativeContract, 'narrativeContract');
  add(f.includedEngineConfig, 'engineConfig');
  add(f.includedBuiltinOverrides, 'builtinOverrides');
  add(f.includedSettings, 'settings');
  add(f.includedApiTemplate, 'apiTemplate');
  if (counts.value.img > 0) out.push({ key: 'images', label: t('save.import.card.flag.images', { n: counts.value.img }), hint: t('save.import.card.flag.imagesHint') });
  return out;
});

// ─── Protagonist ──────────────────────────────────────────────
const protagMode = computed<ProtagonistMode>(() => bundle.value?.protagonist.mode ?? 'fixed');
const policy = buildDefaultProtagonistPolicy();
const charRoot = policy.characterRoot;

/** Schema-driven editable field descriptors (handover §2.5 P0-1). */
interface FieldDesc { path: string; label: string; control: 'text' | 'textarea' | 'number'; }
const LONG_TEXT_LEAVES = new Set(['外貌', '特质', '简介', '描述', '背景']);

function schemaTypeAt(relPath: string): string | undefined {
  const pack = getBootstrapGamePack();
  if (!pack) return undefined;
  let node: unknown = pack.stateSchema;
  for (const seg of `${charRoot}.${relPath}`.split('.')) {
    const props = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
    node = props?.[seg];
    if (!node) return undefined;
  }
  return (node as { type?: string } | undefined)?.type;
}

const editableDescs = computed<FieldDesc[]>(() => {
  const b = bundle.value;
  if (!b || b.protagonist.mode !== 'template') return [];
  const candidate = b.protagonist.editableFields ?? [];
  const { allowed } = validateEditableFields(candidate, policy);
  return allowed.map((raw) => {
    const rel = raw.startsWith(charRoot + '.') ? raw.slice(charRoot.length + 1) : raw;
    const leaf = rel.split('.').pop() ?? rel;
    const type = schemaTypeAt(rel);
    const control: FieldDesc['control'] = type === 'number' ? 'number' : LONG_TEXT_LEAVES.has(leaf) ? 'textarea' : 'text';
    return { path: rel, label: t(`save.import.card.field.${leaf}`, leaf), control };
  });
});

/** Gray (downgraded) read-only fields — derivation warning, no input (handover §6.5b). */
const grayDescs = computed<string[]>(() => {
  const b = bundle.value;
  if (!b || b.protagonist.mode !== 'template') return [];
  const { downgraded } = validateEditableFields(b.protagonist.editableFields ?? [], policy);
  return downgraded;
});

/** The card's character value at a path relative to 角色, read from the MERGED tree (not the
 *  empty protagonist.data). Falls back to {} before decode completes. */
function cardData(rel: string): unknown {
  return _get(mergedTree.value ?? {}, `${charRoot}.${rel}`);
}
function fieldValue(rel: string): unknown {
  if (rel in edits.value) return edits.value[rel];
  return cardData(rel);
}
function setField(rel: string, v: unknown): void { edits.value = { ...edits.value, [rel]: v }; }

function cardFieldString(rel: string): string {
  const v = cardData(rel);
  return v == null ? '' : String(v);
}

const fixedName = computed(() => cardFieldString(policy.playerNameRelPath));
const templateName = computed(() => String(fieldValue(policy.playerNameRelPath) ?? ''));
// Only block on an empty name when 姓名 is actually an editable field the player can fill — a
// template card that does NOT expose 姓名 already carries the author's name in the merged tree
// (the engine reads it from there / falls back to the card title), so it must not be blocked.
const templateNameMissing = computed(
  () =>
    protagMode.value === 'template' &&
    editableDescs.value.some((d) => d.path === policy.playerNameRelPath) &&
    !templateName.value.trim(),
);

// ─── ⑥ Global opt-in rows ─────────────────────────────────────
const autoRows = computed(() => {
  const b = bundle.value;
  const rows: { key: string; label: string }[] = [];
  if (b?.customPresets) rows.push({ key: 'customPresets', label: t('save.import.card.global.customPresets') });
  if (counts.value.img > 0) rows.push({ key: 'imageAssets', label: t('save.import.card.global.imageAssets', { n: counts.value.img }) });
  if (b?.worldBooks) rows.push({ key: 'worldBooks', label: t('save.import.card.global.worldBooks') });
  return rows;
});
const optInRows = computed(() => {
  const b = bundle.value;
  const rows: { flag: GlobalOptInFlag; label: string; hint: string }[] = [];
  const add = (present: unknown, flag: GlobalOptInFlag) => {
    if (present) rows.push({ flag, label: t(`save.import.card.global.${flag}`), hint: t(`save.import.card.global.${flag}Hint`) });
  };
  add(b?.configOverlays?.length, 'configOverlays');
  add(b?.settings, 'settings');
  add(b?.promptOverrides?.length, 'promptOverrides');
  add(b?.builtinPromptOverrides, 'builtinPromptOverrides');
  // authorGameplaySettings draws from the same settings payload — offer it whenever settings exist.
  add(b?.settings, 'authorGameplaySettings');
  return rows;
});
const hasApiTemplate = computed(() => !!bundle.value?.apiTemplate);
const noExtras = computed(() => autoRows.value.length === 0 && optInRows.value.length === 0 && !hasApiTemplate.value);

function toggleOptIn(flag: GlobalOptInFlag, on: boolean): void {
  const next = new Set(optIns.value);
  if (on) next.add(flag); else next.delete(flag);
  optIns.value = next;
}

// ─── NSFW gate condition ──────────────────────────────────────
function nsfwGloballyOn(): boolean {
  try {
    const raw = localStorage.getItem('aga_nsfw_settings');
    return raw ? JSON.parse(raw).nsfwMode === true : false;
  } catch { return false; }
}
const needsNsfwGate = computed(() => bundle.value?.exportFlags?.containsNsfw === true && !nsfwGloballyOn());

// ─── Navigation ───────────────────────────────────────────────
function fromPreview(): void {
  if (needsNsfwGate.value) { stage.value = 'nsfw'; return; }
  goProtagonist();
}
function goProtagonist(): void {
  stage.value = protagMode.value === 'blank' ? 'blankRejected' : 'protagonist';
}
function acceptNsfw(): void { enableNsfw.value = true; goProtagonist(); }
function backTo(s: Stage): void { stage.value = s; }

// ─── ⑦ Import ─────────────────────────────────────────────────
async function doImport(): Promise<void> {
  if (!blob.value) return;
  if (!importService) { errorCode.value = 'write-failed'; stage.value = 'error'; return; } // surface, never silently no-op
  stage.value = 'progress';
  importing.value = true;
  openingPhase.value = '';
  importAbort.value = new AbortController();
  try {
    const res = await importService.importCard(blob.value, {
      protagonistEdits: protagMode.value === 'template' ? { ...edits.value } : undefined,
      optInGlobals: optIns.value,
      enableNsfw: enableNsfw.value,
      onOpeningProgress: (phase) => { openingPhase.value = phase; },
      abortSignal: importAbort.value.signal,
    });
    if (res.ok) {
      result.value = {
        profileId: res.profileId,
        slotId: res.slotId,
        retrievalDegraded: res.retrievalDegraded,
        openingDegraded: res.openingDegraded,
        globalChangesApplied: res.globalChangesApplied,
      };
      stage.value = 'success';
    } else {
      errorCode.value = res.code;
      stage.value = 'error';
    }
  } catch {
    // importCard is contractually total, but never strand the user on the non-cancelable ⑦.
    errorCode.value = 'write-failed';
    stage.value = 'error';
  } finally {
    importing.value = false;
  }
}

// ─── ⑧ Success / close ────────────────────────────────────────
function enterGame(): void {
  // plan §2.5 P1-e (supersedes handover §6.8): the slot was already activated during ⑦
  // (engineState.loadGame + vectorizePending) — DO NOT re-activate; just navigate.
  emit('imported');
  emit('update:modelValue', false);
  void router.push('/game');
}
function stayHome(): void {
  emit('imported'); // HomeView re-lists so the new save appears (SC-UI-A)
  emit('update:modelValue', false);
}
/** Revert the global settings this import overwrote, back to their pre-import state. */
async function undoGlobal(): Promise<void> {
  if (!importService || undoing.value) return;
  undoing.value = true;
  undoFailed.value = false;
  const ok = await importService.undoGlobalChanges();
  undoing.value = false;
  if (ok) undone.value = true;
  else undoFailed.value = true; // restore threw — surface a retry (the backup handle is retained)
}
function close(): void {
  // Closing the success screen via X/Esc/backdrop must still re-list (the save exists) — SC-UI-A.
  if (stage.value === 'success' && result.value) emit('imported');
  emit('update:modelValue', false);
}
/** Skip the (slow, AI-driven) opening generation; abort is non-fatal so the save still persists. */
function cancelOpening(): void { importAbort.value?.abort(); }
function restart(): void { reset(); }

// ─── Rail (§6.1) + closable (§6.0) ────────────────────────────
const RAIL: { id: Stage; key: string }[] = [
  { id: 'preview', key: 'preview' },
  { id: 'protagonist', key: 'protagonist' },
  { id: 'global', key: 'global' },
  { id: 'progress', key: 'import' },
];
const railOrder = ['preview', 'protagonist', 'global', 'progress'];
function railState(id: Stage): 'done' | 'current' | 'pending' {
  const cur = railOrder.indexOf(stage.value === 'nsfw' ? 'protagonist' : stage.value);
  const me = railOrder.indexOf(id);
  if (cur < 0 || me < 0) return 'pending';
  return me < cur ? 'done' : me === cur ? 'current' : 'pending';
}
const showRail = computed(() => ['preview', 'nsfw', 'protagonist', 'global'].includes(stage.value));
const closable = computed(() => stage.value !== 'progress'); // ⑦ non-cancelable (SC-4)

const errorText = computed(() => (errorCode.value ? t(`save.import.card.error.${errorCode.value}`) : ''));
</script>

<template>
  <Modal
    :model-value="modelValue"
    :title="t('save.import.card.modalTitle')"
    width="640px"
    :closable="closable"
    @update:model-value="close"
  >
    <div ref="bodyEl" class="cif">
      <!-- Where-am-i rail (§6.1) -->
      <nav v-if="showRail" class="cif-rail" :aria-label="t('save.import.card.rail.label')">
        <span
          v-for="node in RAIL"
          :key="node.id"
          class="cif-rail__node"
          :class="`cif-rail__node--${railState(node.id)}`"
        >
          {{ t(`save.import.card.rail.${node.key}`) }}
        </span>
      </nav>

      <!-- aria-live region for stage announcements -->
      <p class="cif-sr" aria-live="polite">{{ t(`save.import.card.rail.${stage}`, '') }}</p>

      <!-- ① UPLOAD -->
      <section v-if="stage === 'upload'" class="cif-stage">
        <h3 class="cif-h" data-stage-focus tabindex="-1">{{ t('save.import.card.upload.title') }}</h3>
        <!-- Drop target is a mouse-convenience click area; the inner "choose file" button is the
             keyboard-accessible control (avoids a nested interactive role="button"). -->
        <div
          class="cif-drop"
          :class="{ 'cif-drop--over': dragOver }"
          @click="pickFile"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="onDrop"
        >
          <svg class="cif-drop__glyph" viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" />
          </svg>
          <p class="cif-drop__main">{{ t('save.import.card.upload.dropHere') }}</p>
          <button type="button" class="cif-drop__btn" @click.stop="pickFile">{{ t('save.import.card.upload.pick') }}</button>
          <p class="cif-drop__hint">{{ t('save.import.card.upload.accept') }}</p>
          <input ref="fileInput" type="file" accept=".aga-card" class="cif-file" data-testid="card-import-file" @change="onFileInput" />
        </div>
        <p class="cif-note">{{ t('save.import.card.upload.note') }}</p>
        <p v-if="reading" class="cif-reading">{{ t('save.import.card.upload.reading') }}</p>
        <p v-if="uploadError" class="cif-warn" role="alert">{{ uploadError }}</p>
      </section>

      <!-- ② DECODE -->
      <section v-else-if="stage === 'decode'" class="cif-stage">
        <h3 class="cif-h" data-stage-focus tabindex="-1">{{ t('save.import.card.decode.title') }}</h3>
        <ul class="cif-steps">
          <li class="cif-steps__item cif-steps__item--done">{{ t('save.import.card.decode.unzip') }}</li>
          <li class="cif-steps__item cif-steps__item--done">{{ t('save.import.card.decode.checksum') }}</li>
          <li class="cif-steps__item cif-steps__item--active">{{ t('save.import.card.decode.pack') }}</li>
          <li class="cif-steps__item">{{ t('save.import.card.decode.read') }}</li>
        </ul>
        <div class="cif-track"><span class="cif-track__fill" style="width: 60%" /></div>
      </section>

      <!-- ③ PREVIEW -->
      <section v-else-if="stage === 'preview'" class="cif-stage">
        <h3 class="cif-h" data-stage-focus tabindex="-1">{{ t('save.import.card.preview.title') }}</h3>
        <div class="cif-prev-head">
          <img v-if="coverOk" :src="cardMeta!.coverImage" class="cif-cover" alt="" />
          <div v-else class="cif-cover cif-cover--ph">{{ coverInitial }}</div>
          <div class="cif-prev-meta">
            <p class="cif-prev-title">{{ cardMeta?.title }}</p>
            <p class="cif-prev-author">{{ t('save.import.card.preview.author', { author: cardMeta?.author || '—' }) }}</p>
            <p v-if="cardMeta?.description" class="cif-prev-desc">{{ cardMeta.description }}</p>
            <div v-if="cardMeta?.tags?.length" class="cif-tags">
              <span v-for="tag in cardMeta.tags" :key="tag" class="cif-tag">#{{ tag }}</span>
            </div>
          </div>
        </div>

        <p class="cif-sub">{{ t('save.import.card.preview.contains') }}</p>
        <p class="cif-counts">
          {{ t('save.import.card.preview.counts', { loc: counts.loc, npc: counts.npc, edge: counts.edge, mem: counts.mem }) }}
        </p>
        <div v-if="flagChips.length" class="cif-chips">
          <span class="cif-chips__lead">{{ t('save.import.card.preview.bundled') }}</span>
          <Tooltip v-for="chip in flagChips" :key="chip.key" :text="chip.hint">
            <span class="cif-chip">{{ chip.label }}</span>
          </Tooltip>
        </div>

        <div v-if="drift && drift.comparison === 1" class="cif-banner cif-banner--amber" role="note">
          {{ t('save.import.card.preview.driftNewer', { card: drift.cardVersion, installed: drift.installedVersion }) }}
        </div>
        <div v-if="alreadyImported" class="cif-banner cif-banner--info" role="note">
          {{ t('save.import.card.preview.alreadyImported') }}
        </div>
      </section>

      <!-- ④ NSFW gate -->
      <section v-else-if="stage === 'nsfw'" class="cif-stage">
        <h3 class="cif-h cif-h--amber" data-stage-focus tabindex="-1">🕯 {{ t('save.import.card.nsfw.title') }}</h3>
        <p class="cif-body">{{ t('save.import.card.nsfw.line1') }}</p>
        <p class="cif-body">{{ t('save.import.card.nsfw.line2') }}</p>
        <p class="cif-body cif-body--dim">{{ t('save.import.card.nsfw.line3') }}</p>
      </section>

      <!-- ⑤ Protagonist -->
      <section v-else-if="stage === 'protagonist'" class="cif-stage">
        <!-- fixed -->
        <template v-if="protagMode === 'fixed'">
          <h3 class="cif-h" data-stage-focus tabindex="-1">🔒 {{ t('save.import.card.protagonist.fixedTitle') }}</h3>
          <div class="cif-fixed">
            <p class="cif-fixed__name">{{ fixedName || t('save.import.card.protagonist.unnamed') }}</p>
            <p v-if="cardFieldString('基础信息.外貌')" class="cif-fixed__line">{{ cardFieldString('基础信息.外貌') }}</p>
          </div>
          <p v-if="!fixedName" class="cif-warn">{{ t('save.import.card.protagonist.fixedNoName') }}</p>
          <p class="cif-note">{{ t('save.import.card.protagonist.fixedNote') }}</p>
        </template>
        <!-- template -->
        <template v-else>
          <h3 class="cif-h" data-stage-focus tabindex="-1">📝 {{ t('save.import.card.protagonist.templateTitle') }}</h3>
          <label v-for="d in editableDescs" :key="d.path" class="cif-field">
            <span class="cif-field__label">{{ d.label }}</span>
            <textarea
              v-if="d.control === 'textarea'"
              class="cif-input cif-input--area" rows="2"
              :value="String(fieldValue(d.path) ?? '')"
              @input="setField(d.path, ($event.target as HTMLTextAreaElement).value)"
            />
            <input
              v-else
              class="cif-input"
              :type="d.control === 'number' ? 'number' : 'text'"
              :value="fieldValue(d.path) as string | number"
              @input="setField(d.path, d.control === 'number' ? Number(($event.target as HTMLInputElement).value) : ($event.target as HTMLInputElement).value)"
            />
          </label>
          <div v-if="grayDescs.length" class="cif-gray">
            <p class="cif-gray__warn">{{ t('save.import.card.protagonist.grayWarn') }}</p>
            <p v-for="g in grayDescs" :key="g" class="cif-gray__item">{{ g }}</p>
          </div>
          <p v-if="templateNameMissing" class="cif-warn">{{ t('save.import.card.protagonist.nameRequired') }}</p>
        </template>
      </section>

      <!-- ⑤c BLANK reject -->
      <section v-else-if="stage === 'blankRejected'" class="cif-stage">
        <h3 class="cif-h" data-stage-focus tabindex="-1">⛺ {{ t('save.import.card.protagonist.blankTitle') }}</h3>
        <p class="cif-body">{{ t('save.import.card.protagonist.blankLine1') }}</p>
        <p class="cif-body cif-body--dim">{{ t('save.import.card.protagonist.blankLine2') }}</p>
      </section>

      <!-- ⑥ Global opt-in -->
      <section v-else-if="stage === 'global'" class="cif-stage">
        <h3 class="cif-h" data-stage-focus tabindex="-1">{{ t('save.import.card.global.title') }}</h3>
        <p v-if="noExtras" class="cif-note">{{ t('save.import.card.global.none') }}</p>
        <template v-else>
          <fieldset v-if="autoRows.length" class="cif-group">
            <legend class="cif-group__legend">{{ t('save.import.card.global.autoLegend') }}</legend>
            <p v-for="r in autoRows" :key="r.key" class="cif-group__auto">✓ {{ r.label }}</p>
          </fieldset>
          <fieldset v-if="optInRows.length" class="cif-group">
            <legend class="cif-group__legend">{{ t('save.import.card.global.optInLegend') }}</legend>
            <label v-for="r in optInRows" :key="r.flag" class="cif-check">
              <input type="checkbox" :checked="optIns.has(r.flag)" @change="toggleOptIn(r.flag, ($event.target as HTMLInputElement).checked)" />
              <span>{{ r.label }}</span>
              <Tooltip :text="r.hint"><span class="cif-help" aria-hidden="true">?</span></Tooltip>
            </label>
          </fieldset>
          <fieldset v-if="hasApiTemplate" class="cif-group">
            <legend class="cif-group__legend">{{ t('save.import.card.global.apiLegend') }}</legend>
            <p class="cif-group__info">ℹ {{ t('save.import.card.global.apiInfo') }}</p>
          </fieldset>
        </template>
      </section>

      <!-- ⑦ Progress -->
      <section v-else-if="stage === 'progress'" class="cif-stage">
        <h3 class="cif-h" data-stage-focus tabindex="-1">{{ t('save.import.card.progress.title', { title: cardMeta?.title }) }}</h3>
        <ul class="cif-steps">
          <li class="cif-steps__item cif-steps__item--active">{{ t('save.import.card.progress.building') }}</li>
          <li class="cif-steps__item" :class="{ 'cif-steps__item--active': openingPhase }">{{ t('save.import.card.progress.opening') }}</li>
          <li class="cif-steps__item">{{ t('save.import.card.progress.saving') }}</li>
        </ul>
        <div class="cif-track cif-track--indeterminate"><span class="cif-track__fill" /></div>
        <p class="cif-note">{{ t('save.import.card.progress.wait') }}</p>
        <!-- Escape hatch: skip the slow AI opening (non-fatal → save still created; first round fills it). -->
        <button v-if="openingPhase" type="button" class="cif-undo" @click="cancelOpening">{{ t('save.import.card.progress.skipOpening') }}</button>
      </section>

      <!-- ⑧ Success -->
      <section v-else-if="stage === 'success'" class="cif-stage cif-stage--center">
        <div class="cif-ok">✓</div>
        <h3 class="cif-h" data-stage-focus tabindex="-1">{{ t('save.import.card.success.title') }}</h3>
        <p class="cif-body">{{ t('save.import.card.success.line', { title: cardMeta?.title }) }}</p>
        <p v-if="result?.retrievalDegraded" class="cif-banner cif-banner--amber" role="note">{{ t('save.import.card.success.degraded') }}</p>
        <p v-if="result?.openingDegraded" class="cif-banner cif-banner--amber" role="note">{{ t('save.import.card.success.openingDegraded') }}</p>
        <!-- Reversible global overwrite (user request): one-click undo of any global settings this import changed. -->
        <div v-if="result?.globalChangesApplied" class="cif-undo-wrap">
          <template v-if="!undone">
            <p class="cif-note">{{ t('save.import.card.success.globalChanged') }}</p>
            <button type="button" class="cif-undo" :disabled="undoing" @click="undoGlobal">
              {{ undoing ? t('save.import.card.success.undoing') : t('save.import.card.success.undoGlobal') }}
            </button>
            <p v-if="undoFailed" class="cif-warn" role="alert">{{ t('save.import.card.success.undoFailed') }}</p>
          </template>
          <p v-else class="cif-note" role="status">{{ t('save.import.card.success.undoneGlobal') }}</p>
        </div>
      </section>

      <!-- ✕ Error -->
      <section v-else-if="stage === 'error'" class="cif-stage">
        <h3 class="cif-h cif-h--amber" data-stage-focus tabindex="-1" role="alert">{{ t('save.import.card.error.title') }}</h3>
        <p class="cif-body">{{ errorText }}</p>
      </section>
    </div>

    <template #footer>
      <!-- ① upload / ② decode -->
      <template v-if="stage === 'upload' || stage === 'decode'">
        <button type="button" class="btn-modal btn-modal--secondary" @click="close">{{ t('save.import.card.actions.cancel') }}</button>
      </template>
      <!-- ③ preview -->
      <template v-else-if="stage === 'preview'">
        <button type="button" class="btn-modal btn-modal--secondary" @click="close">{{ t('save.import.card.actions.cancel') }}</button>
        <button type="button" class="btn-modal btn-modal--primary" data-testid="card-import-next" @click="fromPreview">{{ t('save.import.card.actions.continue') }}</button>
      </template>
      <!-- ④ nsfw -->
      <template v-else-if="stage === 'nsfw'">
        <button type="button" class="btn-modal btn-modal--secondary" @click="backTo('preview')">{{ t('save.import.card.actions.back') }}</button>
        <button type="button" class="btn-modal btn-modal--amber" @click="acceptNsfw">{{ t('save.import.card.actions.enableNsfw') }}</button>
      </template>
      <!-- ⑤ protagonist -->
      <template v-else-if="stage === 'protagonist'">
        <button type="button" class="btn-modal btn-modal--secondary" @click="backTo('preview')">{{ t('save.import.card.actions.back') }}</button>
        <button type="button" class="btn-modal btn-modal--primary" data-testid="card-import-next" :disabled="templateNameMissing" @click="stage = 'global'">{{ t('save.import.card.actions.continue') }}</button>
      </template>
      <!-- ⑤c blank reject -->
      <template v-else-if="stage === 'blankRejected'">
        <button type="button" class="btn-modal btn-modal--secondary" @click="close">{{ t('save.import.card.actions.close') }}</button>
      </template>
      <!-- ⑥ global -->
      <template v-else-if="stage === 'global'">
        <button type="button" class="btn-modal btn-modal--secondary" @click="backTo('protagonist')">{{ t('save.import.card.actions.back') }}</button>
        <button type="button" class="btn-modal btn-modal--primary" data-testid="card-import-submit" @click="doImport">{{ t('save.import.card.actions.import') }}</button>
      </template>
      <!-- ⑧ success -->
      <template v-else-if="stage === 'success'">
        <button type="button" class="btn-modal btn-modal--secondary" @click="stayHome">{{ t('save.import.card.actions.stay') }}</button>
        <button type="button" class="btn-modal btn-modal--primary" data-testid="card-import-enter" @click="enterGame">{{ t('save.import.card.actions.enter') }}</button>
      </template>
      <!-- ✕ error -->
      <template v-else-if="stage === 'error'">
        <button type="button" class="btn-modal btn-modal--secondary" @click="restart">{{ t('save.import.card.actions.reselect') }}</button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.cif { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.cif :where(input, textarea, select) { box-sizing: border-box; max-width: 100%; }
.cif :where(p, h3) { overflow-wrap: anywhere; }
.cif-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }

/* Rail (§6.1) */
.cif-rail { display: flex; flex-wrap: wrap; gap: 14px; padding-bottom: 10px; border-bottom: 1px solid color-mix(in oklch, var(--color-text) 8%, transparent); }
.cif-rail__node { font-size: 0.8rem; color: var(--color-text-secondary); opacity: 0.6; }
.cif-rail__node--done { color: var(--color-sage-400); opacity: 1; }
.cif-rail__node--done::before { content: '✓ '; }
.cif-rail__node--current { color: var(--color-text); opacity: 1; font-weight: 600; }
.cif-rail__node--current::before { content: '● '; color: var(--color-sage-400); }

.cif-stage { display: flex; flex-direction: column; gap: 10px; }
.cif-stage--center { align-items: center; text-align: center; }
.cif-h { margin: 0; font-family: var(--font-serif-cjk); font-size: 1rem; font-weight: 500; color: var(--color-text); }
.cif-h--amber { color: var(--color-amber-400); }
.cif-h:focus-visible { outline: 2px solid color-mix(in oklch, var(--color-sage-400) 50%, transparent); outline-offset: 3px; border-radius: var(--radius-sm); }
.cif-body { margin: 0; font-size: 0.88rem; line-height: 1.55; color: var(--color-text); }
.cif-body--dim { color: var(--color-text-secondary); }
.cif-note { margin: 0; font-size: 0.8rem; line-height: 1.5; color: var(--color-text-secondary); }
.cif-warn { margin: 4px 0 0; font-size: 0.82rem; color: var(--color-amber-400); }
.cif-reading { margin: 0; font-size: 0.82rem; color: var(--color-text-secondary); }

/* ① Upload drop zone */
.cif-drop {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 28px 16px; text-align: center; cursor: pointer;
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--color-bg) 40%, transparent);
  box-shadow: inset 0 0 0 1.5px color-mix(in oklch, var(--color-text) 14%, transparent);
  transition: box-shadow 0.18s var(--ease-out), background 0.18s var(--ease-out);
}
.cif-drop:focus-visible { outline: none; box-shadow: inset 0 0 0 2px color-mix(in oklch, var(--color-sage-400) 55%, transparent); }
.cif-drop--over { background: color-mix(in oklch, var(--color-sage-400) 12%, transparent); box-shadow: inset 0 0 0 2px var(--color-sage-400), 0 0 18px color-mix(in oklch, var(--color-sage-400) 30%, transparent); }
.cif-drop__glyph { color: var(--color-text-secondary); }
.cif-drop__main { margin: 0; font-size: 0.9rem; color: var(--color-text); }
.cif-drop__hint { margin: 0; font-size: 0.78rem; color: var(--color-text-secondary); }
.cif-drop__btn {
  margin: 2px 0; padding: 7px 16px; min-height: 36px; font-size: 0.85rem; cursor: pointer;
  color: var(--color-text); background: transparent; border: none;
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-text) 16%, transparent);
  border-radius: var(--radius-sm);
}
.cif-file { display: none; }

/* ②/⑦ steps + track */
.cif-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.cif-steps__item { font-size: 0.85rem; color: var(--color-text-secondary); padding-left: 20px; position: relative; }
.cif-steps__item::before { content: '·'; position: absolute; left: 6px; }
.cif-steps__item--done { color: var(--color-text); }
.cif-steps__item--done::before { content: '✓'; color: var(--color-sage-400); }
.cif-steps__item--active { color: var(--color-text); }
.cif-steps__item--active::before { content: '◌'; color: var(--color-sage-400); }
.cif-track { height: 4px; border-radius: var(--radius-full); background: color-mix(in oklch, var(--color-text) 10%, transparent); overflow: hidden; }
.cif-track__fill { display: block; height: 100%; background: var(--color-sage-400); transition: width 0.3s var(--ease-out); }
.cif-track--indeterminate .cif-track__fill { width: 40%; animation: cif-slide 1.3s var(--ease-out) infinite; }
@keyframes cif-slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
@media (prefers-reduced-motion: reduce) { .cif-track--indeterminate .cif-track__fill { animation: none; width: 100%; } }

/* ③ preview */
.cif-prev-head { display: flex; gap: 14px; align-items: flex-start; }
.cif-cover { width: 80px; height: 106px; flex-shrink: 0; object-fit: cover; border-radius: var(--radius-sm); }
.cif-cover--ph { display: flex; align-items: center; justify-content: center; font-family: var(--font-serif-cjk); font-size: 2rem; color: var(--color-text-secondary); background: color-mix(in oklch, var(--color-sage-400) 14%, transparent); }
.cif-prev-meta { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.cif-prev-title { margin: 0; font-family: var(--font-serif-cjk); font-size: 1.05rem; color: var(--color-text); }
.cif-prev-author { margin: 0; font-size: 0.8rem; color: var(--color-text-secondary); }
.cif-prev-desc { margin: 2px 0 0; font-size: 0.84rem; line-height: 1.5; color: var(--color-text); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.cif-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
.cif-tag { font-size: 0.76rem; color: var(--color-text-secondary); }
.cif-sub { margin: 4px 0 0; font-size: 0.8rem; color: var(--color-text-secondary); }
.cif-counts { margin: 0; font-size: 0.88rem; color: var(--color-text); line-height: 1.6; }
.cif-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.cif-chips__lead { font-size: 0.8rem; color: var(--color-text-secondary); }
.cif-chip {
  display: inline-block; padding: 3px 9px; font-size: 0.76rem; color: var(--color-text);
  background: color-mix(in oklch, var(--color-sage-400) 14%, transparent); border-radius: var(--radius-full);
  backdrop-filter: blur(6px);
}
.cif-banner { margin: 2px 0 0; padding: 9px 12px; font-size: 0.82rem; line-height: 1.5; border-radius: var(--radius-sm); }
.cif-banner--amber { color: var(--color-text); background: color-mix(in oklch, var(--color-amber-400) 12%, transparent); }
.cif-banner--info { color: var(--color-text-secondary); background: color-mix(in oklch, var(--color-text) 6%, transparent); }

/* ⑤ protagonist */
.cif-fixed { padding: 12px 14px; border-radius: var(--radius-md); background: color-mix(in oklch, var(--color-text) 5%, transparent); opacity: 0.92; }
.cif-fixed__name { margin: 0; font-family: var(--font-serif-cjk); font-size: 1rem; color: var(--color-text); }
.cif-fixed__line { margin: 6px 0 0; font-size: 0.84rem; color: var(--color-text-secondary); }
.cif-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 4px; }
.cif-field__label { font-size: 0.82rem; color: var(--color-text-secondary); }
.cif-input {
  width: 100%; padding: 8px 10px; font-size: 0.9rem; color: var(--color-text);
  background: color-mix(in oklch, var(--color-bg) 55%, transparent); border: none; border-radius: var(--radius-sm);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-text) 10%, transparent);
  transition: box-shadow 0.16s var(--ease-out);
}
.cif-input:focus-visible { outline: none; box-shadow: inset 0 0 0 1.5px color-mix(in oklch, var(--color-sage-400) 55%, transparent); }
.cif-input--area { resize: vertical; min-height: 44px; font-family: inherit; }
.cif-gray { margin-top: 6px; padding: 10px 12px; border-radius: var(--radius-md); background: color-mix(in oklch, var(--color-text) 4%, transparent); opacity: 0.78; }
.cif-gray__warn { margin: 0 0 4px; font-size: 0.78rem; color: var(--color-amber-400); }
.cif-gray__item { margin: 0; font-size: 0.82rem; color: var(--color-text-secondary); }

/* ⑥ global */
.cif-group { margin: 0; padding: 12px 14px; border: none; border-radius: var(--radius-md); background: color-mix(in oklch, var(--color-text) 4%, transparent); display: flex; flex-direction: column; gap: 8px; }
.cif-group__legend { padding: 0; font-size: 0.78rem; color: var(--color-text-secondary); }
.cif-group__auto { margin: 0; font-size: 0.85rem; color: var(--color-sage-400); }
.cif-group__info { margin: 0; font-size: 0.82rem; color: var(--color-text-secondary); line-height: 1.5; }
.cif-check { display: flex; align-items: center; gap: 8px; font-size: 0.86rem; color: var(--color-text); cursor: pointer; }
/* Opt-in checkbox is a list/whitelist multi-select → native control themed by the
   global forms.css foundation (sage accent + focus ring); no bespoke box CSS per
   native-form-styling rule. Keep a modest size for the row rhythm. */
.cif-check input[type='checkbox'] { width: 18px; height: 18px; }
.cif-help {
  display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px;
  font-size: 0.7rem; color: var(--color-text-secondary); cursor: help;
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-text) 22%, transparent); border-radius: var(--radius-full);
}

/* ⑧ success */
.cif-ok { display: flex; align-items: center; justify-content: center; width: 48px; height: 48px; font-size: 1.6rem; font-weight: 700; color: var(--color-bg); background: var(--color-sage-400); border-radius: var(--radius-full); }
.cif-undo-wrap { display: flex; flex-direction: column; align-items: center; gap: 6px; margin-top: 4px; }
.cif-undo {
  padding: 5px 14px; font-size: 0.82rem; cursor: pointer; color: var(--color-text-secondary);
  background: transparent; border: none; border-radius: var(--radius-sm);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-text) 16%, transparent);
  transition: color 0.16s var(--ease-out), box-shadow 0.16s var(--ease-out);
}
.cif-undo:hover:not(:disabled) { color: var(--color-text); box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-amber-400) 45%, transparent); }
.cif-undo:disabled { opacity: 0.5; cursor: progress; }

/* footer buttons */
.btn-modal { padding: 8px 18px; font-size: 0.88rem; min-height: 38px; border: none; border-radius: var(--radius-sm); cursor: pointer; transition: background 0.16s var(--ease-out), box-shadow 0.16s var(--ease-out); }
.btn-modal--secondary { color: var(--color-text-secondary); background: transparent; box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-text) 14%, transparent); }
.btn-modal--primary { color: var(--color-bg); background: var(--color-sage-400); }
.btn-modal--amber { color: var(--color-bg); background: var(--color-amber-400); }
.btn-modal--primary:disabled { opacity: 0.45; cursor: not-allowed; }

@media (max-width: 520px) {
  .cif-prev-head { flex-direction: column; align-items: center; text-align: center; }
  .btn-modal { min-height: 44px; flex: 1; }
}
</style>
