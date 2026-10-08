<script setup lang="ts">
import { ref, computed } from 'vue';
import { injectService } from '@/ui/injection-keys';
import { useI18n } from 'vue-i18n';
import { useGameState } from '@/ui/composables/useGameState';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import {
  validateLoraAir,
  collectActiveLorasForScope,
  buildTriggerInjection,
  mergeAdditionalNetworks,
} from '@/engine/image/civitai-lora';
import { fetchCivitaiLoraMetadata, trainedWordsToTriggers } from '@/engine/image/civitai-metadata';
import type {
  CivitaiLoraShelfItem,
  CivitaiLoraScope,
  CivitaiLoraTrigger,
} from '@/engine/image/types';

const props = defineProps<{
  mode: 'full' | 'compact';
  scope: CivitaiLoraScope;
  matureEnabled: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:scope', scope: CivitaiLoraScope): void;
}>();

const { t } = useI18n();

const SHELF_PATH = '系统.扩展.image.config.civitai.loras';
const RAW_NETWORKS_PATH = '系统.扩展.image.config.civitai.additionalNetworksJson';
const { setValue, useValue } = useGameState();

function scopeLabel(scope: CivitaiLoraScope): string {
  const map: Record<CivitaiLoraScope, string> = {
    player: t('image.lora.scope.player'),
    character: t('image.lora.scope.character'),
    scene: t('image.lora.scope.scene'),
    secret_part: t('image.lora.scope.secretPart'),
  };
  return map[scope];
}

const SCOPE_KEYS: CivitaiLoraScope[] = ['player', 'character', 'scene', 'secret_part'];

// ── Shelf data (useValue for reactive dependency) ──

const shelfRaw = useValue<CivitaiLoraShelfItem[]>(SHELF_PATH);
const shelf = computed<CivitaiLoraShelfItem[]>(() =>
  Array.isArray(shelfRaw.value) ? shelfRaw.value : [],
);
const rawNetworksJson = useValue<string>(RAW_NETWORKS_PATH);

function writeShelf(items: CivitaiLoraShelfItem[]) {
  setValue(SHELF_PATH, items);
}

// ── Selection state ──
const selectedId = ref<string | null>(null);

function selectLora(id: string) {
  if (selectedId.value !== id) {
    newTriggerText.value = '';
    triggerError.value = '';
  }
  selectedId.value = selectedId.value === id ? null : id;
}

// ── Active LoRAs for current scope ──
const activeForScope = computed(() => collectActiveLorasForScope(shelf.value, props.scope));
const activeTriggerCount = computed(() => {
  const tokens = buildTriggerInjection(activeForScope.value, '');
  return tokens.length;
});

// ── Add LoRA ──
const showAddForm = ref(false);
const newName = ref('');
const newAir = ref('');
const newStrength = ref(1.0);
const addError = ref('');

function addLora() {
  const air = newAir.value.trim();
  if (!air) { addError.value = t('image.lora.airEmpty'); return; }

  const dup = shelf.value.find((l) => l.air.trim() === air);
  if (dup) {
    selectedId.value = dup.id;
    showAddForm.value = false;
    addError.value = '';
    return;
  }

  const airResult = validateLoraAir(air);
  if (!airResult.valid) { addError.value = airResult.error ?? t('image.lora.airInvalid'); return; }

  const now = Date.now();
  const item: CivitaiLoraShelfItem = {
    id: `lora_${now}_${Math.random().toString(36).slice(2, 7)}`,
    name: newName.value.trim() || 'LoRA',
    air,
    enabled: true,
    strength: Math.abs(newStrength.value) >= 0.05 ? newStrength.value : 1.0,
    scopes: ['player', 'character'],
    triggers: [],
    autoInjectTriggers: true,
    createdAt: now,
    updatedAt: now,
  };

  writeShelf([...shelf.value, item]);
  selectedId.value = item.id;
  showAddForm.value = false;
  newName.value = '';
  newAir.value = '';
  newStrength.value = 1.0;
  addError.value = '';
}

// ── Mutations ──

function updateLora(id: string, patch: Partial<CivitaiLoraShelfItem>) {
  writeShelf(shelf.value.map((l) =>
    l.id === id ? { ...l, ...patch, updatedAt: Date.now() } : l,
  ));
}

function deleteLora(id: string) {
  writeShelf(shelf.value.filter((l) => l.id !== id));
  if (selectedId.value === id) selectedId.value = null;
}

function toggleLoraEnabled(id: string) {
  const lora = shelf.value.find((l) => l.id === id);
  if (lora) updateLora(id, { enabled: !lora.enabled });
}

function setStrength(id: string, val: number) {
  const clamped = Math.min(2, Math.max(-2, val));
  updateLora(id, { strength: clamped });
}

function toggleScope(id: string, scope: CivitaiLoraScope) {
  const lora = shelf.value.find((l) => l.id === id);
  if (!lora) return;
  const has = lora.scopes.includes(scope);
  const next = has ? lora.scopes.filter((s) => s !== scope) : [...lora.scopes, scope];
  updateLora(id, { scopes: next });
}

// ── Trigger management ──
const newTriggerText = ref('');
const triggerError = ref('');

function addTrigger(loraId: string) {
  const text = newTriggerText.value.trim();
  if (!text) return;
  if (/<lora:/i.test(text)) {
    triggerError.value = t('image.lora.triggerFormatError');
    return;
  }
  triggerError.value = '';
  const lora = shelf.value.find((l) => l.id === loraId);
  if (!lora) return;

  const exists = lora.triggers.some((t) => t.text.trim().toLowerCase() === text.toLowerCase());
  if (exists) { newTriggerText.value = ''; return; }

  const now = Date.now();
  const trigger: CivitaiLoraTrigger = {
    id: `trig_${now}_${Math.random().toString(36).slice(2, 6)}`,
    text,
    enabled: true,
    source: 'manual',
    createdAt: now,
    updatedAt: now,
  };
  updateLora(loraId, { triggers: [...lora.triggers, trigger] });
  newTriggerText.value = '';
}

function toggleTrigger(loraId: string, triggerId: string) {
  const lora = shelf.value.find((l) => l.id === loraId);
  if (!lora) return;
  const triggers = lora.triggers.map((t) =>
    t.id === triggerId ? { ...t, enabled: !t.enabled, updatedAt: Date.now() } : t,
  );
  updateLora(loraId, { triggers });
}

function deleteTrigger(loraId: string, triggerId: string) {
  const lora = shelf.value.find((l) => l.id === loraId);
  if (!lora) return;
  updateLora(loraId, { triggers: lora.triggers.filter((t) => t.id !== triggerId) });
}

// ── Metadata import ──
const aiService = injectService('aiService', undefined);
const metadataLoading = ref<string | null>(null);
const metadataError = ref('');

async function importMetadata(loraId: string) {
  const lora = shelf.value.find((l) => l.id === loraId);
  if (!lora) return;
  metadataLoading.value = loraId;
  metadataError.value = '';
  try {
    const apiKey = aiService?.getImageConfigForBackend('civitai')?.apiKey;
    const result = await fetchCivitaiLoraMetadata({ air: lora.air, apiKey });
    if (!result.success) {
      metadataError.value = result.error;
      return;
    }
    const d = result.data;
    const existingTexts = new Set(lora.triggers.map((t) => t.text.trim().toLowerCase()));
    const newTriggers = trainedWordsToTriggers(d.trainedWords)
      .filter((t) => !existingTexts.has(t.text.toLowerCase()));

    updateLora(loraId, {
      modelName: d.modelName || lora.modelName,
      versionName: d.versionName || lora.versionName,
      baseModel: d.baseModel || lora.baseModel,
      modelVersionId: d.modelVersionId || lora.modelVersionId,
      sourceUrl: d.sourceUrl || lora.sourceUrl,
      mature: d.mature || lora.mature === true,
      name: lora.name === 'LoRA' && d.modelName ? d.modelName : lora.name,
      triggers: [...lora.triggers, ...newTriggers],
    });
  } catch {
    metadataError.value = t('image.lora.metadataFailed');
  } finally {
    metadataLoading.value = null;
  }
}

// ── Validation helpers (used in row badges + preview) ──
function isAirInvalid(air: string): boolean {
  return !validateLoraAir(air).valid;
}

// ── Preview (full mode) ──
const previewScope = ref<CivitaiLoraScope>(props.scope);
const previewActive = computed(() => collectActiveLorasForScope(shelf.value, previewScope.value));
const previewTriggers = computed(() => buildTriggerInjection(previewActive.value, ''));
const previewNetworks = computed(() => {
  return mergeAdditionalNetworks(previewActive.value, rawNetworksJson.value ?? '');
});

// ── Validation helpers ──
function strengthWarning(strength: number): string {
  if (Math.abs(strength) > 1.5) return t('image.lora.strengthWarning');
  return '';
}

function isLoraActiveForScope(lora: CivitaiLoraShelfItem): boolean {
  return lora.enabled && lora.scopes.includes(props.scope);
}

function formatAirShort(air: string): string {
  const m = air.match(/:(\d+@\d+)$/);
  return m ? m[1] : air.slice(-20);
}
</script>

<template>
  <!-- ═══ COMPACT MODE ═══ -->
  <div v-if="mode === 'compact'" class="lora-compact">
    <div v-if="activeForScope.length > 0" class="lora-compact__summary">
      <span class="lora-compact__badge">LoRA ×{{ activeForScope.length }}</span>
      <span v-if="activeTriggerCount > 0" class="lora-compact__badge lora-compact__badge--trigger">
        {{ $t('image.lora.trigger') }} ×{{ activeTriggerCount }}
      </span>
      <span
        v-for="lora in activeForScope" :key="lora.id"
        class="lora-compact__chip"
        :class="{ 'lora-compact__chip--mature': lora.mature && !matureEnabled }"
      >
        {{ lora.name }} <small>{{ lora.strength.toFixed(2) }}</small>
      </span>
    </div>
    <div v-else class="lora-compact__empty">
      {{ $t('image.lora.compactEmpty') }}
    </div>
    <div v-if="activeForScope.some(l => l.mature) && !matureEnabled" class="lora-compact__warn">
      {{ $t('image.lora.matureWarning') }}
    </div>
    <div class="lora-compact__hint">{{ $t('image.lora.compactHint') }}</div>
  </div>

  <!-- ═══ FULL MODE ═══ -->
  <div v-else class="lora-shelf">
    <!-- Stats bar -->
    <div class="lora-shelf__stats">
      <span class="lora-shelf__pill"><strong>{{ activeForScope.length }}</strong> {{ $t('image.lora.activeSuffix') }}</span>
      <span class="lora-shelf__pill lora-shelf__pill--warm"><strong>{{ activeTriggerCount }}</strong> {{ $t('image.lora.triggerInjectSuffix') }}</span>
      <span class="lora-shelf__pill"><strong>{{ shelf.length }}</strong> {{ $t('image.lora.shelfSuffix') }}</span>
      <AgaButton variant="primary" size="sm" @click="showAddForm = !showAddForm">
        {{ showAddForm ? $t('image.lora.addCancel') : $t('image.lora.addLora') }}
      </AgaButton>
    </div>

    <!-- Add form -->
    <div v-if="showAddForm" class="lora-shelf__add">
      <div class="lora-shelf__add-grid">
        <div class="lora-shelf__field">
          <label class="form-label">{{ $t('image.lora.label.name') }}</label>
          <input v-model="newName" class="form-input" :placeholder="$t('image.lora.placeholder.name')" />
        </div>
        <div class="lora-shelf__field">
          <label class="form-label">{{ $t('image.lora.label.air') }}</label>
          <input v-model="newAir" class="form-input" :placeholder="$t('image.lora.placeholder.air')" />
        </div>
        <div class="lora-shelf__field">
          <label class="form-label">{{ $t('image.lora.strength') }}</label>
          <input v-model.number="newStrength" type="number" min="-2" max="2" step="0.05" class="form-input" />
        </div>
        <AgaButton variant="primary" size="sm" @click="addLora">{{ $t('image.lora.addSubmit') }}</AgaButton>
      </div>
      <p v-if="addError" class="lora-shelf__error">{{ addError }}</p>
    </div>

    <!-- Empty state -->
    <div v-if="shelf.length === 0 && !showAddForm" class="lora-shelf__empty">
      <p>{{ $t('image.lora.emptyHint') }}</p>
    </div>

    <!-- LoRA list -->
    <div class="lora-shelf__list">
      <article
        v-for="lora in shelf" :key="lora.id"
        class="lora-item"
        :class="{
          'lora-item--selected': selectedId === lora.id,
          'lora-item--inactive': !isLoraActiveForScope(lora),
        }"
      >
        <!-- Row head -->
        <div class="lora-item__head">
          <AgaToggle :model-value="lora.enabled" @update:model-value="toggleLoraEnabled(lora.id)" />
          <button class="lora-item__name-btn" @click="selectLora(lora.id)">
            <strong class="lora-item__name">{{ lora.name }}</strong>
            <small class="lora-item__air">{{ formatAirShort(lora.air) }}</small>
          </button>
          <div class="lora-item__strength">
            <input
              type="range" min="-2" max="2" step="0.05"
              :value="lora.strength"
              @input="setStrength(lora.id, Number(($event.target as HTMLInputElement).value))"
            />
            <output>{{ lora.strength.toFixed(2) }}</output>
          </div>
          <div class="lora-item__badges">
            <span v-for="s in lora.scopes" :key="s" class="lora-item__scope-badge">{{ scopeLabel(s) }}</span>
            <span v-if="lora.triggers.filter(tr => tr.enabled).length > 0" class="lora-item__trigger-badge">
              {{ $t('image.lora.trigger') }} ×{{ lora.triggers.filter(tr => tr.enabled).length }}
            </span>
            <span v-if="lora.mature" class="lora-item__mature-badge">Mature</span>
            <span v-if="lora.enabled && isAirInvalid(lora.air)" class="lora-item__error-badge">{{ $t('image.lora.airInvalid') }}</span>
            <span v-if="strengthWarning(lora.strength)" class="lora-item__warn-badge">{{ strengthWarning(lora.strength) }}</span>
          </div>
          <Tooltip :text="selectedId === lora.id ? $t('image.lora.collapse') : $t('image.lora.expand')" interactive>
            <button class="lora-item__expand" :aria-label="selectedId === lora.id ? $t('image.lora.collapse') : $t('image.lora.expand')" @click="selectLora(lora.id)">{{ selectedId === lora.id ? '▴' : '▾' }}</button>
          </Tooltip>
          <Tooltip :text="$t('image.lora.deleteAriaLabel')" interactive>
            <button class="lora-item__delete" :aria-label="$t('image.lora.deleteAriaLabel')" @click="deleteLora(lora.id)">×</button>
          </Tooltip>
        </div>

        <!-- Expanded editor -->
        <div v-if="selectedId === lora.id" class="lora-item__editor">
          <div class="lora-editor__main">
            <!-- Identity -->
            <div class="lora-editor__section">
              <div class="lora-shelf__field">
                <label class="form-label">{{ $t('image.lora.label.name') }}</label>
                <input
                  class="form-input" :value="lora.name"
                  @change="updateLora(lora.id, { name: ($event.target as HTMLInputElement).value })"
                />
              </div>
              <div class="lora-shelf__field">
                <label class="form-label">{{ $t('image.lora.label.air') }}</label>
                <input
                  class="form-input" :value="lora.air"
                  @change="updateLora(lora.id, { air: ($event.target as HTMLInputElement).value.trim() })"
                />
              </div>
              <div class="lora-shelf__field">
                <label class="form-label">{{ $t('image.lora.label.notes') }}</label>
                <input
                  class="form-input" :value="lora.notes ?? ''"
                  @change="updateLora(lora.id, { notes: ($event.target as HTMLInputElement).value || undefined })"
                  :placeholder="$t('image.lora.placeholder.notes')"
                />
              </div>
            </div>

            <!-- Metadata import -->
            <div class="lora-editor__section">
              <div class="lora-editor__meta-row">
                <AgaButton
                  variant="secondary" size="sm"
                  :loading="metadataLoading === lora.id"
                  @click="importMetadata(lora.id)"
                >
                  {{ metadataLoading === lora.id ? $t('image.lora.importingMeta') : $t('image.lora.importMeta') }}
                </AgaButton>
                <span v-if="lora.modelName" class="form-hint">{{ lora.modelName }}{{ lora.versionName ? ` · ${lora.versionName}` : '' }}{{ lora.baseModel ? ` · ${lora.baseModel}` : '' }}</span>
                <span v-else class="form-hint">{{ $t('image.lora.noMetadata') }}</span>
              </div>
              <p v-if="metadataError && metadataLoading === null && selectedId === lora.id" class="lora-shelf__error">{{ metadataError }}</p>
            </div>

            <!-- Strength with quick buttons -->
            <div class="lora-editor__section">
              <label class="form-label">Strength</label>
              <div class="lora-editor__strength-row">
                <input
                  type="range" class="lora-editor__slider" min="-2" max="2" step="0.05"
                  :value="lora.strength"
                  @input="setStrength(lora.id, Number(($event.target as HTMLInputElement).value))"
                />
                <input
                  type="number" class="form-input lora-editor__strength-num" min="-2" max="2" step="0.05"
                  :value="lora.strength"
                  @change="setStrength(lora.id, Number(($event.target as HTMLInputElement).value))"
                />
              </div>
              <div class="lora-editor__quick-btns">
                <button v-for="q in [0.6, 1.0, 1.3]" :key="q" class="lora-editor__quick" @click="setStrength(lora.id, q)">
                  {{ q }}
                </button>
              </div>
            </div>

            <!-- Trigger dictionary -->
            <div class="lora-editor__section">
              <div class="lora-editor__trigger-header">
                <label class="form-label">{{ $t('image.lora.triggerLabel') }}</label>
                <AgaToggle
                  :model-value="lora.autoInjectTriggers"
                  @update:model-value="updateLora(lora.id, { autoInjectTriggers: $event })"
                  :label="$t('image.lora.autoInjectLabel')"
                />
                <span class="form-hint">{{ lora.autoInjectTriggers ? $t('image.lora.autoInjectOnHint') : $t('image.lora.autoInjectOffHint') }}</span>
              </div>
              <div v-if="lora.triggers.length > 0" class="lora-editor__triggers">
                <span
                  v-for="tt in lora.triggers" :key="tt.id"
                  class="lora-editor__trigger-chip"
                  :class="{ 'lora-editor__trigger-chip--off': !tt.enabled }"
                >
                  <Tooltip :text="tt.enabled ? $t('image.lora.disableTrigger') : $t('image.lora.enableTrigger')" interactive>
                    <button :aria-label="tt.enabled ? $t('image.lora.disableTrigger') : $t('image.lora.enableTrigger')" @click="toggleTrigger(lora.id, tt.id)">{{ tt.enabled ? '●' : '○' }}</button>
                  </Tooltip>
                  {{ tt.text }}
                  <Tooltip :text="$t('image.lora.deleteTrigger')" interactive>
                    <button class="lora-editor__trigger-del" :aria-label="$t('image.lora.deleteTrigger')" @click="deleteTrigger(lora.id, tt.id)">×</button>
                  </Tooltip>
                </span>
              </div>
              <div v-else class="form-hint">{{ $t('image.lora.noTriggers') }}</div>
              <div class="lora-editor__trigger-add">
                <input
                  v-model="newTriggerText" class="form-input"
                  placeholder="例如：moonlit robe"
                  @keydown.enter="addTrigger(lora.id)"
                />
                <AgaButton variant="secondary" size="sm" @click="addTrigger(lora.id)">{{ $t('image.lora.addTrigger') }}</AgaButton>
              </div>
              <p v-if="triggerError" class="lora-shelf__error">{{ triggerError }}</p>
            </div>
          </div>

          <!-- Scopes -->
          <div class="lora-editor__side">
            <label class="form-label">{{ $t('image.lora.scopeLabel') }}</label>
            <div class="lora-editor__scopes">
              <button
                v-for="sk in SCOPE_KEYS" :key="sk"
                class="lora-editor__scope-chip"
                :class="{ 'lora-editor__scope-chip--on': lora.scopes.includes(sk) }"
                :aria-pressed="lora.scopes.includes(sk)"
                @click="toggleScope(lora.id, sk)"
              >
                {{ lora.scopes.includes(sk) ? '●' : '○' }} {{ scopeLabel(sk) }}
              </button>
            </div>
            <!-- Danger zone -->
            <div class="lora-editor__danger">
              <AgaButton variant="danger" size="sm" @click="deleteLora(lora.id)">{{ $t('image.lora.deleteLora') }}</AgaButton>
            </div>
          </div>
        </div>
      </article>
    </div>

    <!-- Request preview -->
    <details v-if="shelf.length > 0" class="lora-shelf__preview form-advanced">
      <summary>{{ $t('image.lora.previewTitle') }}</summary>
      <div class="lora-shelf__preview-body">
        <div class="lora-shelf__field">
          <label class="form-label">{{ $t('image.lora.previewFlow') }}</label>
          <div class="lora-editor__scopes">
            <button
              v-for="sk in SCOPE_KEYS" :key="sk"
              class="lora-editor__scope-chip"
              :class="{ 'lora-editor__scope-chip--on': previewScope === sk }"
              @click="previewScope = sk; emit('update:scope', sk)"
            >
              {{ scopeLabel(sk) }}
            </button>
          </div>
        </div>
        <div class="lora-shelf__field">
          <label class="form-label">{{ $t('image.lora.activeLoras', { n: previewActive.length }) }}</label>
          <div v-if="previewActive.length > 0" class="lora-shelf__preview-list">
            <span v-for="l in previewActive" :key="l.id" class="lora-compact__chip">
              {{ l.name }} <small>{{ l.strength.toFixed(2) }}</small>
            </span>
          </div>
          <span v-else class="form-hint">{{ $t('image.lora.previewNone') }}</span>
        </div>
        <div v-if="previewTriggers.length > 0" class="lora-shelf__field">
          <label class="form-label">{{ $t('image.lora.injectedTriggers') }}</label>
          <pre class="lora-shelf__preview-code">{{ previewTriggers.join(', ') }}</pre>
        </div>
        <div class="lora-shelf__field">
          <label class="form-label">additionalNetworks</label>
          <pre class="lora-shelf__preview-code">{{ previewNetworks.mergedJson ? JSON.stringify(previewNetworks.merged, null, 2) : $t('image.lora.previewEmpty') }}</pre>
        </div>
        <div v-if="previewNetworks.conflicts.length > 0" class="lora-shelf__preview-warn">
          {{ $t('image.lora.conflict', { list: previewNetworks.conflicts.join(', ') }) }}
        </div>
        <div v-if="previewActive.some(l => l.mature) && !matureEnabled" class="lora-shelf__preview-warn">
          {{ $t('image.lora.matureWarning') }}
        </div>
        <div v-if="previewActive.length > 5" class="lora-shelf__preview-warn">
          {{ $t('image.lora.tooMany', { n: previewActive.length }) }}
        </div>
        <div v-if="previewActive.some(l => isAirInvalid(l.air))" class="lora-shelf__preview-warn lora-shelf__preview-warn--error">
          {{ $t('image.lora.invalidAir') }}
        </div>
      </div>
    </details>
  </div>
</template>

<style scoped>
/* ═══ Local form tokens (scoped — cannot inherit from ImagePanel) ═══ */
.form-label { font-size: var(--font-size-sm); color: var(--color-text-secondary); }
.form-hint { font-size: var(--font-size-xs); color: var(--color-text-muted); }
.form-input {
  width: 100%; padding: var(--space-2xs) var(--space-xs);
  background: var(--color-surface); border: 1px solid var(--color-border);
  border-radius: var(--radius-sm); color: var(--color-text);
  font-size: var(--font-size-sm); font-family: var(--font-sans);
  transition: border-color var(--duration-fast);
}
.form-input:focus { outline: none; border-color: var(--color-primary); }
.form-advanced {
  border: 1px solid var(--color-border); border-radius: var(--radius-md);
  padding: var(--space-xs) var(--space-sm);
  background: color-mix(in oklch, var(--color-surface) 60%, transparent);
}
.form-advanced > summary {
  cursor: pointer; font-size: var(--font-size-sm); color: var(--color-text-secondary);
  padding: var(--space-2xs) 0; user-select: none;
}

/* ═══ Compact mode ═══ */
.lora-compact { display: flex; flex-direction: column; gap: var(--space-2xs); }
.lora-compact__summary { display: flex; flex-wrap: wrap; gap: var(--space-2xs); align-items: center; }
.lora-compact__badge {
  font-size: var(--font-size-xs); padding: 1px 6px;
  border: 1px solid var(--color-border); border-radius: 999px;
  color: var(--color-text-secondary);
  background: color-mix(in oklch, var(--color-surface) 60%, transparent);
}
.lora-compact__badge--trigger { color: var(--color-sage-300); border-color: color-mix(in oklch, var(--color-sage-400) 30%, transparent); }
.lora-compact__chip {
  font-size: var(--font-size-xs); padding: 1px 6px;
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  color: var(--color-text); background: transparent;
  backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
}
.lora-compact__chip small { color: var(--color-sage-300); font-family: var(--font-mono, monospace); }
.lora-compact__chip--mature { border-color: color-mix(in oklch, var(--color-danger) 40%, transparent); }
.lora-compact__empty { font-size: var(--font-size-xs); color: var(--color-text-muted); }
.lora-compact__hint { font-size: 10px; color: var(--color-text-muted); opacity: 0.7; }
.lora-compact__warn {
  font-size: var(--font-size-xs); color: var(--color-amber-400, #d4af37);
  padding: var(--space-2xs) var(--space-xs);
  border: 1px solid color-mix(in oklch, var(--color-amber-400, #d4af37) 30%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in oklch, var(--color-amber-400, #d4af37) 6%, transparent);
}

/* ═══ Full mode ═══ */
.lora-shelf { display: flex; flex-direction: column; gap: var(--space-sm); }

.lora-shelf__stats {
  display: flex; flex-wrap: wrap; gap: var(--space-xs); align-items: center;
}
.lora-shelf__pill {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: var(--font-size-xs); padding: 2px 8px;
  border: 1px solid var(--color-border); border-radius: 999px;
  color: var(--color-text-secondary);
}
.lora-shelf__pill strong { color: var(--color-sage-300); font-weight: 600; }
.lora-shelf__pill--warm strong { color: var(--color-amber-400, #d4af37); }

/* Add form */
.lora-shelf__add {
  padding: var(--space-sm);
  border: 1px solid var(--color-border); border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--color-surface) 70%, transparent);
}
.lora-shelf__add-grid {
  display: grid; grid-template-columns: minmax(100px, 0.6fr) minmax(180px, 1.2fr) 90px auto;
  gap: var(--space-xs); align-items: end;
}
.lora-shelf__field { display: flex; flex-direction: column; gap: 3px; }
.lora-shelf__error { font-size: var(--font-size-xs); color: var(--color-danger, #f87171); margin: var(--space-2xs) 0 0; }

/* Empty */
.lora-shelf__empty {
  padding: var(--space-md);
  border: 1px dashed var(--color-border); border-radius: var(--radius-md);
  color: var(--color-text-muted); text-align: center;
  font-size: var(--font-size-sm);
}

/* LoRA list */
.lora-shelf__list { display: flex; flex-direction: column; gap: var(--space-xs); }

.lora-item {
  border: 1px solid var(--color-border); border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--color-surface) 80%, transparent);
  overflow: hidden; transition: border-color var(--duration-fast);
}
.lora-item--selected { border-color: color-mix(in oklch, var(--color-sage-400) 50%, transparent); box-shadow: 0 0 8px color-mix(in oklch, var(--color-sage-400) 15%, transparent); }
.lora-item--inactive { opacity: 0.65; }

.lora-item__head {
  display: grid; grid-template-columns: auto minmax(0, 1fr) 140px auto auto auto;
  gap: var(--space-xs); align-items: center;
  padding: var(--space-xs) var(--space-sm);
}

.lora-item__name-btn {
  background: transparent; border: none; color: var(--color-text);
  text-align: left; cursor: pointer; padding: 0; min-width: 0;
}
.lora-item__name {
  display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--font-size-sm); font-weight: 500;
}
.lora-item__air {
  display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 10px; color: var(--color-text-muted); font-family: var(--font-mono, monospace);
}

.lora-item__strength {
  display: grid; grid-template-columns: 1fr 44px; gap: var(--space-2xs); align-items: center;
}
.lora-item__strength input[type="range"] { padding: 0; accent-color: var(--color-sage-400, #8fbc8f); width: 100%; }
.lora-item__strength output {
  font-size: 11px; font-family: var(--font-mono, monospace); color: var(--color-sage-300);
  text-align: right;
}

.lora-item__badges { display: flex; flex-wrap: wrap; gap: 3px; }
.lora-item__scope-badge,
.lora-item__trigger-badge,
.lora-item__mature-badge,
.lora-item__warn-badge {
  font-size: 9px; padding: 1px 5px;
  border-radius: 999px; white-space: nowrap;
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
}
.lora-item__trigger-badge { color: var(--color-sage-300); border-color: color-mix(in oklch, var(--color-sage-400) 25%, transparent); }
.lora-item__mature-badge { color: var(--color-danger, #f87171); border-color: color-mix(in oklch, var(--color-danger) 30%, transparent); }
.lora-item__warn-badge { color: var(--color-amber-400, #d4af37); border-color: color-mix(in oklch, var(--color-amber-400, #d4af37) 30%, transparent); }
.lora-item__error-badge { color: var(--color-danger, #f87171); border-color: color-mix(in oklch, var(--color-danger) 40%, transparent); background: color-mix(in oklch, var(--color-danger) 8%, transparent); }

.lora-item__expand, .lora-item__delete {
  background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm);
  color: var(--color-text-muted); cursor: pointer;
  width: 26px; height: 26px; display: inline-grid; place-items: center;
  font-size: 14px; transition: all var(--duration-fast);
}
.lora-item__expand:hover { border-color: var(--color-border); }
.lora-item__delete:hover { border-color: color-mix(in oklch, var(--color-danger) 50%, transparent); color: var(--color-danger, #f87171); }

/* Editor */
.lora-item__editor {
  display: grid; grid-template-columns: minmax(0, 1fr) 180px;
  gap: var(--space-sm); padding: 0 var(--space-sm) var(--space-sm);
  border-top: 1px solid var(--color-border);
}

.lora-editor__main { display: flex; flex-direction: column; gap: var(--space-sm); padding-top: var(--space-sm); }
.lora-editor__section { display: flex; flex-direction: column; gap: var(--space-2xs); }

.lora-editor__strength-row {
  display: grid; grid-template-columns: 1fr 70px; gap: var(--space-xs); align-items: center;
}
.lora-editor__slider { accent-color: var(--color-sage-400, #8fbc8f); width: 100%; }
.lora-editor__strength-num { text-align: center; }
.lora-editor__quick-btns { display: flex; gap: var(--space-2xs); }
.lora-editor__quick {
  padding: 2px 8px; font-size: var(--font-size-xs);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  background: transparent; color: var(--color-text-secondary); cursor: pointer;
  transition: all var(--duration-fast);
}
.lora-editor__quick:hover { border-color: var(--color-sage-400); color: var(--color-sage-300); }

/* Trigger */
.lora-editor__trigger-header { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); }
.lora-editor__triggers {
  display: flex; flex-wrap: wrap; gap: var(--space-2xs);
  min-height: 28px; padding: var(--space-xs);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  background: color-mix(in oklch, var(--color-surface) 50%, transparent);
}
.lora-editor__trigger-chip {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: var(--font-size-xs); padding: 2px 7px;
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 35%, transparent);
  border-radius: 999px; color: var(--color-text);
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
  box-shadow: var(--lumi-inset-highlight);
}
.lora-editor__trigger-chip--off {
  text-decoration: line-through; opacity: 0.5;
  border-color: var(--color-border);
  background: transparent;
}
.lora-editor__trigger-chip button {
  background: transparent; border: none; color: inherit; cursor: pointer; padding: 0; font-size: 10px;
}
.lora-editor__trigger-del { font-size: 12px !important; }
.lora-editor__trigger-add {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-xs); margin-top: var(--space-2xs);
}
.lora-editor__meta-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); }

/* Scopes side panel */
.lora-editor__side {
  display: flex; flex-direction: column; gap: var(--space-sm);
  padding-top: var(--space-sm); border-left: 1px solid var(--color-border); padding-left: var(--space-sm);
}
.lora-editor__scopes { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2xs); }
.lora-editor__scope-chip {
  font-size: var(--font-size-xs); padding: 4px 8px;
  border: 1px solid var(--color-border); border-radius: 999px;
  background: transparent; color: var(--color-text-muted); cursor: pointer;
  text-align: center; transition: all var(--duration-fast);
}
.lora-editor__scope-chip--on {
  color: var(--color-text); border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
  box-shadow: inset 0 0 6px color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}
.lora-editor__danger { margin-top: auto; padding-top: var(--space-sm); border-top: 1px solid var(--color-border); }

/* Preview */
.lora-shelf__preview { margin-top: var(--space-xs); }
.lora-shelf__preview-body { display: flex; flex-direction: column; gap: var(--space-sm); padding-top: var(--space-xs); }
.lora-shelf__preview-list { display: flex; flex-wrap: wrap; gap: var(--space-2xs); }
.lora-shelf__preview-code {
  margin: 0; padding: var(--space-xs);
  font-size: 11px; font-family: var(--font-mono, monospace);
  color: var(--color-sage-300);
  background: color-mix(in oklch, var(--color-surface) 50%, transparent);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  white-space: pre-wrap; word-break: break-word;
  max-height: 180px; overflow-y: auto;
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.2);
}
.lora-shelf__preview-warn {
  font-size: var(--font-size-xs);
  color: var(--color-amber-400, #d4af37);
  padding: var(--space-2xs) var(--space-xs);
  border: 1px solid color-mix(in oklch, var(--color-amber-400, #d4af37) 30%, transparent);
  border-radius: var(--radius-sm);
}
.lora-shelf__preview-warn--error {
  color: var(--color-danger, #f87171);
  border-color: color-mix(in oklch, var(--color-danger, #f87171) 30%, transparent);
}

/* ═══ Responsive ═══ */
@media (max-width: 760px) {
  .lora-shelf__add-grid { grid-template-columns: 1fr; }
  .lora-item__head { grid-template-columns: auto minmax(0, 1fr) auto auto; }
  .lora-item__strength { display: none; }
  .lora-item__badges { display: none; }
  .lora-item__editor { grid-template-columns: 1fr; }
  .lora-editor__side { border-left: none; padding-left: 0; border-top: 1px solid var(--color-border); padding-top: var(--space-sm); }
  .lora-editor__scopes { grid-template-columns: 1fr; }
}
</style>
