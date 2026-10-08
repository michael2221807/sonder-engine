<template>
  <!--
    Right sidebar — character vitals, status effects, attributes, and quick actions.
    Collapsible to 36px to free horizontal space.

    Polanyi principle: status lives at the periphery (subsidiary awareness)
    so the player absorbs health/effects without shifting focal attention
    away from the narrative in the main panel.
  -->
  <aside
    :class="['right-sidebar', { 'right-sidebar--collapsed': isCollapsed, 'drawer-open': rightOpen }]"
    role="complementary"
    :aria-label="$t('layout.right.ariaStatusBar')"
  >
    <div v-if="!isCollapsed" class="right-sidebar__content">

      <!-- ─── Identity row ─── -->
      <section class="status-card" :aria-label="$t('layout.right.ariaIdentity')">
        <div class="identity-row">
          <span class="identity-name">{{ engineState.characterName }}</span>
          <span v-if="occupation" class="identity-occupation">{{ occupation }}</span>
        </div>
        <div v-if="engineState.currentLocation && engineState.currentLocation !== '未知'" class="location-row">
          <svg viewBox="0 0 12 12" fill="currentColor" width="10" height="10" aria-hidden="true">
            <path fill-rule="evenodd" d="M6 1a3.75 3.75 0 00-3.75 3.75C2.25 7.07 4.875 9.9 5.695 10.713a.413.413 0 00.61 0C7.125 9.9 9.75 7.07 9.75 4.75A3.75 3.75 0 006 1zm0 5.25a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" clip-rule="evenodd" />
          </svg>
          <span class="location-text" :title="engineState.currentLocation">{{ locationDisplay }}</span>
        </div>
      </section>

      <!-- ─── Vitals ─── -->
      <section class="status-card" :aria-label="$t('layout.right.ariaVitals')">
        <h3 class="status-card__title">{{ $t('layout.right.vitalsTitle') }}</h3>

        <!-- Health bar -->
        <div class="vital-row">
          <div class="vital-label">
            <span class="vital-name">{{ $t('layout.right.healthLabel') }}</span>
            <span class="vital-value">{{ engineState.vitalHealth.当前 }}<span class="vital-max">/ {{ engineState.vitalHealth.上限 }}</span></span>
          </div>
          <div
            class="vital-bar"
            role="progressbar"
            :aria-valuenow="engineState.vitalHealth.当前"
            :aria-valuemin="0"
            :aria-valuemax="engineState.vitalHealth.上限"
            :aria-label="`${$t('layout.right.ariaHealth')} ${engineState.vitalHealth.当前} / ${engineState.vitalHealth.上限}`"
          >
            <div
              :class="['vital-bar__fill', 'vital-bar__fill--health', healthColorClass]"
              :style="{ width: healthPct + '%' }"
            />
          </div>
        </div>

        <!-- Energy bar -->
        <div class="vital-row">
          <div class="vital-label">
            <span class="vital-name">{{ $t('layout.right.energyLabel') }}</span>
            <span class="vital-value">{{ engineState.vitalEnergy.当前 }}<span class="vital-max">/ {{ engineState.vitalEnergy.上限 }}</span></span>
          </div>
          <div
            class="vital-bar"
            role="progressbar"
            :aria-valuenow="engineState.vitalEnergy.当前"
            :aria-valuemin="0"
            :aria-valuemax="engineState.vitalEnergy.上限"
            :aria-label="`${$t('layout.right.ariaEnergy')} ${engineState.vitalEnergy.当前} / ${engineState.vitalEnergy.上限}`"
          >
            <div
              :class="['vital-bar__fill', 'vital-bar__fill--energy', energyColorClass]"
              :style="{ width: energyPct + '%' }"
            />
          </div>
        </div>
      </section>

      <!-- ─── Reputation ─── -->
      <section v-if="hasReputation" class="status-card" :aria-label="$t('layout.right.ariaReputation')">
        <h3 class="status-card__title">{{ $t('layout.right.reputationTitle') }}</h3>
        <div class="reputation-row">
          <span class="reputation-value">{{ engineState.reputation }}</span>
          <span class="reputation-tier">{{ reputationTier }}</span>
        </div>
      </section>

      <!-- ─── Status effects ─── -->
      <section v-if="normalizedEffects.length > 0" class="status-card" :aria-label="$t('layout.right.ariaStatusEffects')">
        <h3 class="status-card__title">
          {{ $t('layout.right.statusEffectsTitle') }}
          <span class="effects-count">{{ normalizedEffects.length }}</span>
        </h3>
        <div class="effects-list">
          <component
            :is="effectTipText(effect) ? Tooltip : 'div'"
            v-for="(effect, i) in normalizedEffects"
            :key="i"
            :text="effectTipText(effect) || undefined"
            :position="effectTipText(effect) ? 'bottom' : undefined"
            class="effect-tag-wrap"
          >
            <div
              :class="['effect-tag', effect.isDebuff ? 'effect-tag--debuff' : 'effect-tag--buff']"
              :aria-label="`${effect.isDebuff ? $t('layout.right.ariaDebuff') : $t('layout.right.ariaBuff')}：${effect.name}`"
            >
              <span class="effect-tag__label">{{ effect.name }}</span>
            </div>
          </component>
        </div>
      </section>

      <!-- ─── Attributes (collapsible) ─── -->
      <section class="status-card" :aria-label="$t('layout.right.ariaAttributes')">
        <button
          class="status-card__title status-card__title--btn"
          :aria-expanded="attrsExpanded"
          aria-controls="sidebar-attrs"
          @click="attrsExpanded = !attrsExpanded"
        >
          {{ $t('layout.right.attributesTitle') }}
          <svg
            :class="['collapse-icon', { 'collapse-icon--open': attrsExpanded }]"
            viewBox="0 0 16 16"
            fill="currentColor"
            width="12"
            height="12"
            aria-hidden="true"
          >
            <path fill-rule="evenodd" d="M4.22 6.22a.75.75 0 011.06 0L8 8.94l2.72-2.72a.75.75 0 111.06 1.06l-3.25 3.25a.75.75 0 01-1.06 0L4.22 7.28a.75.75 0 010-1.06z" clip-rule="evenodd" />
          </svg>
        </button>

        <div v-if="attrsExpanded" id="sidebar-attrs" class="attrs-grid">
          <template v-if="hasAttributes">
            <div
              v-for="(val, key) in attributes"
              :key="key"
              class="attr-row"
            >
              <span class="attr-name">{{ key }}</span>
              <div class="attr-bar-wrap">
                <div
                  class="attr-bar"
                  role="progressbar"
                  :aria-valuenow="Number(val)"
                  :aria-valuemin="0"
                  :aria-valuemax="20"
                  :aria-label="`${key} ${val}`"
                >
                  <div class="attr-bar__fill" :style="{ width: attrPct(Number(val)) + '%' }" />
                </div>
                <span class="attr-val">{{ val }}</span>
              </div>
            </div>
          </template>
          <div v-else class="empty-hint">{{ $t('layout.right.noAttributes') }}</div>
        </div>
      </section>

      <!-- ─── Talents ─── -->
      <section v-if="engineState.talents.length > 0" class="status-card" :aria-label="$t('layout.right.ariaTalents')">
        <h3 class="status-card__title">{{ $t('layout.right.talentsTitle') }}</h3>
        <div class="talent-list">
          <component
            :is="t.描述 ? Tooltip : 'span'"
            v-for="t in engineState.talents"
            :key="t.名称"
            :text="t.描述 || undefined"
            :position="t.描述 ? 'bottom' : undefined"
            class="talent-tag-wrap"
          >
            <span class="talent-tag">{{ t.名称 }}</span>
          </component>
        </div>
      </section>

      <!-- ─── Quick actions ─── -->
      <section class="status-card" :aria-label="$t('layout.right.ariaQuickActions')">
        <div class="quick-actions">
          <button
            class="quick-action-btn"
            :aria-label="$t('layout.right.ariaSave')"
            @click="handleSave"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" width="13" height="13">
              <path d="M5.5 2A1.5 1.5 0 004 3.5v13A1.5 1.5 0 005.5 18h9a1.5 1.5 0 001.5-1.5V6.621a1.5 1.5 0 00-.44-1.06l-3.12-3.122A1.5 1.5 0 0011.378 2H5.5zM10 12a2 2 0 100-4 2 2 0 000 4z" />
            </svg>
            <span>{{ $t('layout.right.saveText') }}</span>
          </button>

          <button
            class="quick-action-btn"
            :aria-label="$t('layout.right.ariaExport')"
            @click="handleExport"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" width="13" height="13">
              <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd" />
            </svg>
            <span>{{ $t('layout.right.exportText') }}</span>
          </button>
        </div>
      </section>
    </div>

    <!-- Footer: collapse/expand toggle -->
    <div class="right-sidebar__footer">
      <button
        class="right-sidebar__collapse-btn"
        :aria-label="isCollapsed ? $t('layout.right.ariaExpand') : $t('layout.right.ariaCollapse')"
        :title="isCollapsed ? $t('layout.right.ariaExpand') : $t('layout.right.ariaCollapse')"
        @click="toggleCollapse"
      >
        <svg
          :class="['right-sidebar__toggle-icon', { 'right-sidebar__toggle-icon--flipped': isCollapsed }]"
          viewBox="0 0 20 20"
          fill="currentColor"
          width="16"
          height="16"
        >
          <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd" />
        </svg>
        <span v-if="!isCollapsed" class="right-sidebar__collapse-label">{{ $t('layout.right.collapseText') }}</span>
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
// App doc: docs/user-guide/pages/game-overview.md §4.0.3
import { ref, computed, watch, onUnmounted } from 'vue';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useEngineStateStore } from '@/engine/stores/engine-state';
import { eventBus } from '@/engine/core/event-bus';
import { useSidebarDrawer } from '@/ui/composables/useSidebarDrawer';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

const engineState = useEngineStateStore();
const router = useRouter();
const { t } = useI18n();

const isCollapsed = ref(false);
const { isMobile, rightOpen, closeAll } = useSidebarDrawer();
const attrsExpanded = ref(true);

function toggleCollapse(): void {
  if (isMobile.value) {
    closeAll();
    return;
  }
  isCollapsed.value = !isCollapsed.value;
}

// ── Location display ──────────────────────────────────────────────
const locationDisplay = computed(() => {
  const loc = engineState.currentLocation;
  if (!loc || loc === '未知') return '';
  const parts = loc.split('·');
  return parts[parts.length - 1].trim();
});

// ── Occupation ───────────────────────────────────────────────────
const occupation = computed(() =>
  engineState.get<string>(DEFAULT_ENGINE_PATHS.characterOccupation) ?? '',
);

// ── Vitals ───────────────────────────────────────────────────────
const healthPct = computed(() => {
  const v = engineState.vitalHealth;
  if (!v.上限) return 100;
  return Math.min(100, Math.max(0, (v.当前 / v.上限) * 100));
});

const energyPct = computed(() => {
  const v = engineState.vitalEnergy;
  if (!v.上限) return 100;
  return Math.min(100, Math.max(0, (v.当前 / v.上限) * 100));
});

const healthColorClass = computed(() => {
  const p = healthPct.value;
  if (p > 80) return 'vital-bar__fill--normal';
  if (p > 50) return 'vital-bar__fill--warning';
  return 'vital-bar__fill--danger';
});

const energyColorClass = computed(() => {
  const p = energyPct.value;
  if (p > 80) return 'vital-bar__fill--normal';
  if (p > 50) return 'vital-bar__fill--warning';
  return 'vital-bar__fill--danger';
});

// ── Reputation ───────────────────────────────────────────────────
const hasReputation = computed(() => {
  const rep = engineState.reputation;
  return typeof rep === 'number';
});

const reputationTier = computed(() => {
  const r = engineState.reputation;
  if (r < 10)  return t('layout.right.reputation.unknown');
  if (r < 50)  return t('layout.right.reputation.rising');
  if (r < 100) return t('layout.right.reputation.known');
  if (r < 200) return t('layout.right.reputation.renowned');
  if (r < 500) return t('layout.right.reputation.famous');
  return t('layout.right.reputation.legendary');
});

// ── Status effects (normalize field names) ──────────────────────
interface NormalizedEffect {
  name: string;
  isDebuff: boolean;
  desc: string;
  duration: number | null;
}
const normalizedEffects = computed<NormalizedEffect[]>(() => {
  const raw = engineState.statusEffects;
  if (!Array.isArray(raw)) return [];
  // Deduplicate by name (last occurrence wins — newest from AI)
  const seen = new Map<string, NormalizedEffect>();
  for (const e of raw as Record<string, unknown>[]) {
    if (e == null || typeof e !== 'object') continue;
    const name = String(e['状态名称'] ?? e['名称'] ?? e['name'] ?? t('common.fallback.unknownEffect'));
    seen.set(name, {
      name,
      isDebuff: String(e['类型'] ?? e['type'] ?? '').toLowerCase().includes('debuff'),
      desc: String(e['状态描述'] ?? e['描述'] ?? e['description'] ?? ''),
      duration: typeof e['持续时间分钟'] === 'number' ? e['持续时间分钟']
        : typeof e['duration'] === 'number' ? e['duration'] : null,
    });
  }
  return [...seen.values()];
});

// ── Effect tooltip text (desc + optional duration, single line) ──
function effectTipText(effect: NormalizedEffect): string {
  const parts: string[] = [];
  if (effect.desc) parts.push(effect.desc);
  if (effect.duration) parts.push(`${effect.duration} ${t('layout.right.minutesUnit')}`);
  return parts.join(' · ');
}

// ── Attributes ───────────────────────────────────────────────────
const attributes = computed(() =>
  engineState.get<Record<string, number>>('角色.属性') ?? {},
);

const hasAttributes = computed(() =>
  Object.keys(attributes.value).length > 0,
);

function attrPct(val: number): number {
  return Math.min(100, Math.max(0, (val / 20) * 100));
}

// ── Quick actions ────────────────────────────────────────────────
function handleSave(): void {
  let resolved = false;
  const offComplete = eventBus.on('engine:save-complete', () => {
    if (resolved) return;
    resolved = true;
    offComplete();
    offError();
    eventBus.emit('ui:toast', { type: 'success', message: t('layout.right.saveSuccess'), duration: 2000 });
  });
  const offError = eventBus.on('engine:save-error', (payload: unknown) => {
    if (resolved) return;
    resolved = true;
    offComplete();
    offError();
    const msg = (payload as { error?: string })?.error ?? t('layout.right.saveFailed');
    eventBus.emit('ui:toast', { type: 'error', message: msg });
  });
  setTimeout(() => {
    if (!resolved) { resolved = true; offComplete(); offError(); }
  }, 3000);

  eventBus.emit('engine:request-save', {
    profileId: engineState.activeProfileId,
    slotId: engineState.activeSlotId,
  });
}

function handleExport(): void {
  void router.push('/game/save');
}

/*
 * Post-migration (2026-04-20 Phase 2.4): same pattern as LeftSidebar — this
 * watcher is the sole producer of `--sidebar-right-reserve`, which the
 * GameLayout canvas reads to keep narrative prose clear of the floating
 * droplet sidebar. Observational only — does NOT mutate `isCollapsed` or
 * any existing logic.
 */
watch([isCollapsed, isMobile], ([collapsed, mobile]) => {
  if (mobile) {
    document.documentElement.style.setProperty('--sidebar-right-reserve', '0px');
    return;
  }
  document.documentElement.style.setProperty(
    '--sidebar-right-reserve',
    collapsed ? '40px' : '264px',
  );
}, { immediate: true });

onUnmounted(() => {
  document.documentElement.style.removeProperty('--sidebar-right-reserve');
});
</script>

<style scoped>
/*
 * RightSidebar — sanctuary migration (Phase 2.4, 2026-04-20).
 *
 * Structural change: floating droplet panel (mirrors LeftSidebar treatment).
 * Absolute-positioned at right:12px with 12px top/bottom margin, rounded
 * corners, frosted-glass background. Collapses to 14px thin capsule.
 *
 * Content change: status-cards LOST their individual background/border.
 * Stacking 6+ translucent cards made the frosted sidebar visually opaque.
 * Cards are now separated by a subtle bottom border only — the frosted
 * glass shows through cleanly across the whole panel.
 *
 * Vital bars: replaced Tailwind red/amber/blue/indigo/purple with warm
 * desaturated tokens (rust / amber / sage). Effect tags: warm rust for
 * debuffs, sage for buffs. Talent tags: sage chips. No indigo anywhere.
 *
 * Template + <script setup> UNTOUCHED. Every v-if, v-for, prop, computed,
 * ARIA role, ARIA label, :style, :class binding preserved byte-for-byte.
 */

/* ─── Floating droplet container ─── */
.right-sidebar {
  position: absolute;
  top: 12px;
  bottom: 12px;
  right: 12px;
  width: 240px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 10;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: none;
  border-radius: 16px;
  box-shadow: var(--glass-shadow);
  transition:
    width var(--duration-open) var(--ease-droplet),
    top var(--duration-open) var(--ease-droplet),
    bottom var(--duration-open) var(--ease-droplet),
    right var(--duration-open) var(--ease-droplet),
    border-radius var(--duration-open) var(--ease-droplet),
    border-color var(--duration-open) var(--ease-droplet),
    background var(--duration-open) var(--ease-droplet),
    box-shadow var(--duration-open) var(--ease-droplet);
}

/* Gradient border — light refraction on top-left edge */
.right-sidebar::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: var(--glass-edge-gradient);
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
  z-index: 1;
}
.right-sidebar--collapsed::before {
  display: none;
}

/* Collapsed → thin edge rail flush with the right border,
   spanning from round-divider height to input-area top. */
.right-sidebar--collapsed {
  top: 40px;
  bottom: 90px;
  right: 0;
  width: 10px;
  border-radius: 6px 0 0 6px;
  border-color: transparent;
  border-right: none;
  box-shadow: none;
  background: color-mix(in oklch, var(--color-text-umber) 10%, transparent);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  transition-duration: var(--duration-close);
  cursor: pointer;
}
@media (hover: hover) {
  .right-sidebar--collapsed:hover {
    background: color-mix(in oklch, var(--color-sage-400) 15%, transparent);
    box-shadow: inset 1px 0 0 color-mix(in oklch, var(--color-sage-400) 30%, transparent);
  }
}
.right-sidebar--collapsed > *:not(.right-sidebar__footer) {
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms var(--ease-out);
}
.right-sidebar--collapsed .right-sidebar__footer {
  position: absolute;
  inset: 0;
  border: none;
  background: transparent;
}
.right-sidebar--collapsed .right-sidebar__collapse-btn {
  width: 100%;
  height: 100%;
  padding: 0;
}

/* ─── Footer / Collapse-Expand ─── */
.right-sidebar__footer {
  flex-shrink: 0;
  padding: 6px 0;
  border-top: 1px solid var(--color-border-subtle);
}

.right-sidebar__collapse-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 12px;
  background: transparent;
  border: none;
  color: var(--color-text-secondary);
  font-size: 0.78rem;
  font-family: var(--font-sans);
  cursor: pointer;
  transition: color var(--duration-normal) var(--ease-out),
              background var(--duration-normal) var(--ease-out);
}

@media (hover: hover) {
  .right-sidebar__collapse-btn:hover {
    color: var(--color-text);
    background: color-mix(in oklch, var(--color-sage-400) 5%, transparent);
  }
}
.right-sidebar__collapse-btn:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px color-mix(in oklch, var(--color-sage-400) 40%, transparent);
}

.right-sidebar__collapse-label {
  font-size: 0.78rem;
  white-space: nowrap;
}

.right-sidebar__toggle-icon {
  transition: transform var(--duration-normal) var(--ease-out);
}
.right-sidebar__toggle-icon--flipped {
  transform: rotate(180deg);
}

/* ─── Content ─── */
.right-sidebar__content {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 6px 4px 4px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

/*
 * Status card: transparent; section separation via bottom divider only.
 * This keeps the frosted sidebar visually transparent across its height.
 */
.status-card {
  padding: 10px 12px 14px;
  border-radius: 0;
  background: transparent;
  border-bottom: 1px solid var(--color-border-subtle);
}
.right-sidebar__content > .status-card:last-child {
  border-bottom: none;
}

.status-card__title {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0 0 8px;
  font-size: 0.66rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--color-text-muted);
}

.status-card__title--btn {
  width: 100%;
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  justify-content: space-between;
  font-family: var(--font-sans);
}
.status-card__title--btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 25%, transparent);
  border-radius: 4px;
}

/* ─── Identity ─── */
.identity-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 4px;
  flex-wrap: wrap;
}
.identity-name {
  font-size: 0.98rem;
  font-weight: 500;
  font-family: var(--font-serif-cjk);
  color: var(--color-text);
}
.identity-occupation {
  font-size: 0.74rem;
  color: var(--color-text-umber);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.location-row {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--color-text-muted);
}
.location-text {
  font-size: 0.74rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 150px;
}

/* ─── Vitals (warm desaturated; no Tailwind red/blue/purple) ─── */
.vital-row {
  margin-bottom: 8px;
}
.vital-row:last-child {
  margin-bottom: 0;
}

.vital-label {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 4px;
}
.vital-name {
  font-size: 0.74rem;
  color: var(--color-text-secondary);
  font-family: var(--font-serif-cjk);
}
.vital-value {
  font-size: 0.74rem;
  font-weight: 600;
  color: var(--color-text);
  font-family: var(--font-mono);
}
.vital-max {
  font-weight: 400;
  color: var(--color-text-muted);
  font-size: 0.68rem;
}

.vital-bar {
  height: 5px;
  background: color-mix(in oklch, var(--color-border) 60%, transparent);
  border-radius: 999px;
  overflow: hidden;
}
.vital-bar__fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.4s var(--ease-out), background 0.3s var(--ease-out), box-shadow var(--duration-normal) var(--ease-out);
}

/*
 * Health = warm rust (oklch shift from Tailwind red/crimson/amber trio).
 * Energy = amber bronze (from Tailwind blue/indigo/purple trio).
 * The 3-tier script logic (normal > 80 / warning > 50 / danger <= 50)
 * is untouched; only the colors change to stay on the warm axis.
 */
.vital-bar__fill--health.vital-bar__fill--normal  { background: var(--color-vital-health); opacity: 0.78; }
.vital-bar__fill--health.vital-bar__fill--warning { background: var(--color-vital-health); }
.vital-bar__fill--health.vital-bar__fill--danger  {
  background: var(--color-danger);
  box-shadow:
    0 0 6px color-mix(in oklch, var(--color-danger) 40%, transparent),
    inset 0 0 4px color-mix(in oklch, var(--color-danger) 25%, transparent);
}

.vital-bar__fill--energy.vital-bar__fill--normal  { background: var(--color-vital-energy); opacity: 0.78; }
.vital-bar__fill--energy.vital-bar__fill--warning { background: var(--color-vital-energy); }
.vital-bar__fill--energy.vital-bar__fill--danger  { background: oklch(0.62 0.08 50); }

/* ─── Reputation ─── */
.reputation-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.reputation-value {
  font-size: 0.96rem;
  font-weight: 700;
  color: var(--color-text);
  font-family: var(--font-mono);
}
.reputation-tier {
  font-size: 0.74rem;
  color: var(--color-amber-400);
  font-weight: 500;
  font-family: var(--font-serif-cjk);
}

/* ─── Status effects ─── */
.effects-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  font-size: 0.62rem;
  font-weight: 700;
  color: var(--color-bg);
  background: var(--color-sage-400);
  border-radius: 999px;
}

.effects-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.effect-tag {
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: 2px 9px;
  font-size: 0.7rem;
  font-weight: 500;
  border-radius: 999px;
  cursor: pointer;
  max-width: 100%;
  white-space: nowrap;
}

.effect-tag--buff {
  background: var(--color-sage-muted);
  color: var(--color-sage-300);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 22%, transparent);
}
.effect-tag--debuff {
  background: var(--color-danger-muted);
  color: oklch(0.78 0.08 30);
  border: 1px solid color-mix(in oklch, var(--color-danger) 22%, transparent);
}
.effect-tag__label {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Tooltip / fallback wrapper around each effect tag — keep tags inline in the
   flex row and let the tag fill the wrapper so its pill styling is unchanged. */
.effect-tag-wrap {
  display: inline-flex;
  max-width: 100%;
}

/* ─── Attributes ─── */
.collapse-icon {
  transition: transform var(--duration-normal) var(--ease-out);
  opacity: 0.6;
  margin-left: auto;
}
.collapse-icon--open {
  transform: rotate(0deg);
}
.collapse-icon:not(.collapse-icon--open) {
  transform: rotate(-90deg);
}

.attrs-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attr-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.attr-name {
  width: 36px;
  font-size: 0.73rem;
  color: var(--color-text-secondary);
  font-family: var(--font-serif-cjk);
  flex-shrink: 0;
}
.attr-bar-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
}
.attr-bar {
  flex: 1;
  height: 4px;
  background: color-mix(in oklch, var(--color-border) 60%, transparent);
  border-radius: 999px;
  overflow: hidden;
}
.attr-bar__fill {
  height: 100%;
  background:
    repeating-linear-gradient(90deg,
      transparent 0px,
      transparent 2px,
      rgba(255, 255, 255, 0.04) 2px,
      rgba(255, 255, 255, 0.04) 3px),
    var(--color-sage-500);
  border-radius: 999px;
  transition: width 0.3s var(--ease-out);
  opacity: 0.8;
}
.attr-val {
  width: 20px;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--color-text);
  text-align: right;
  font-family: var(--font-mono);
  text-shadow: 0 0 4px color-mix(in oklch, var(--color-sage-400) 15%, transparent);
}

/* ─── Talents ─── */
.talent-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.talent-tag-wrap {
  display: inline-flex;
  max-width: 100%;
}
.talent-tag {
  display: inline-flex;
  padding: 2px 9px;
  font-size: 0.72rem;
  font-weight: 500;
  background: var(--color-sage-muted);
  color: var(--color-sage-300);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 22%, transparent);
  border-radius: 999px;
  font-family: var(--font-serif-cjk);
}

/* ─── Quick actions ─── */
.quick-actions {
  display: flex;
  gap: 6px;
}

.quick-action-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  padding: 0 10px;
  font-size: 0.76rem;
  font-weight: 500;
  color: var(--color-text-secondary);
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  cursor: pointer;
  font-family: var(--font-sans);
  transition: color var(--duration-normal) var(--ease-out),
              border-color var(--duration-normal) var(--ease-out),
              background var(--duration-normal) var(--ease-out);
}
@media (hover: hover) {
  .quick-action-btn:hover {
    color: var(--color-text);
    border-color: color-mix(in oklch, var(--color-sage-400) 30%, var(--color-border));
    background: color-mix(in oklch, var(--color-sage-400) 4%, transparent);
  }
}
@media (hover: none) and (pointer: coarse) {
  .quick-action-btn:active {
    color: var(--color-text);
    border-color: color-mix(in oklch, var(--color-sage-400) 30%, var(--color-border));
    background: color-mix(in oklch, var(--color-sage-400) 4%, transparent);
  }
}
.quick-action-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 25%, transparent);
}

/* ─── Empty hint ─── */
.empty-hint {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  text-align: center;
  padding: 6px 0;
}

/* ─── Responsive ─── */
@media (min-width: 768px) and (max-width: 1024px) {
  .right-sidebar { display: none; }
}

/* ─── Mobile: off-screen drawer, slides in via .drawer-open ─── */
@media (max-width: 767px) {
  .right-sidebar {
    position: fixed;
    top: 0;
    bottom: 0;
    right: 0;
    width: 280px;
    border-radius: 16px 0 0 16px;
    z-index: 200;
    transform: translateX(100%);
    transition: transform var(--duration-open) var(--ease-droplet);
    background: var(--glass-bg);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    box-shadow: var(--glass-shadow);
  }
  .right-sidebar.drawer-open {
    transform: translateX(0);
  }
  .right-sidebar--collapsed {
    top: 0;
    bottom: 0;
    right: 0;
    width: 280px;
    border-radius: 16px 0 0 16px;
    background: var(--glass-bg);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    box-shadow: var(--glass-shadow);
    opacity: 1;
  }
  .right-sidebar--collapsed > * {
    opacity: 1;
    pointer-events: auto;
  }
}
</style>
