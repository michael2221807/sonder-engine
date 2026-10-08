<script setup lang="ts">
/**
 * FormattedInline — 行内叶子片段渲染
 *
 * 渲染 formatted-text-parser 产出的 InlinePart[]：
 * - judgement  → 判定卡片（独立样式块）
 * - environment 【】 / psychology `` / dialogue "" → AGA 语义着色 span
 * - npc-name   → 可点击 + 悬浮档案卡的 NPC 名
 * - link       → 安全链接
 * - normal     → 普通文本
 * 每个叶子可叠加 bold / italic（markdown 强调）。
 *
 * 判定卡片与 NPC 悬浮档案卡逻辑由 FormattedText.vue 迁入，保持原有交互与样式。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import ImageDisplay from '@/ui/components/image/ImageDisplay.vue';
import type { InlinePart, JudgementData } from './formatted-text-parser';

// App doc: docs/user-guide/pages/game-main.md §3.4

export interface NpcBrief {
  名称: string;
  性别?: string;
  描述?: string;
  好感度?: number;
  类型?: string;
  '图片档案'?: { '已选头像图片ID'?: string };
}

const props = defineProps<{
  parts: InlinePart[];
  npcData?: NpcBrief[];
}>();

const router = useRouter();
const { t } = useI18n();

const npcMap = computed(() => {
  const map = new Map<string, NpcBrief>();
  if (props.npcData) {
    for (const npc of props.npcData) {
      if (npc.名称) map.set(npc.名称, npc);
    }
  }
  return map;
});

const hoveredNpc = ref<NpcBrief | null>(null);
const popoverPos = ref({ x: 0, y: 0 });
let hoverTimer: ReturnType<typeof setTimeout> | null = null;

function onNpcEnter(name: string, event: MouseEvent): void {
  const npc = npcMap.value.get(name);
  if (!npc) return;
  if (hoverTimer) clearTimeout(hoverTimer);
  // 800ms hover delay to match the unified Tooltip primitive's reveal timing.
  // This is a RICH popover (avatar + affinity + multi-line description), so it
  // cannot use the text-only <Tooltip> primitive verbatim, but its delay and
  // z-index are reconciled with the design-system tooltip standard.
  hoverTimer = setTimeout(() => {
    hoveredNpc.value = npc;
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    popoverPos.value = { x: rect.left + rect.width / 2, y: rect.top };
  }, 800);
}

function onNpcLeave(): void {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  hoveredNpc.value = null;
}

function onNpcClick(name: string): void {
  onNpcLeave();
  router.push({ path: '/game/relationships', query: { npc: name } });
}

// ─── Judgement helpers ───
function isSuccess(result: string): boolean {
  return result.includes('成功') && !result.includes('失败');
}
function isFailure(result: string): boolean {
  return result.includes('失败');
}
function isGreatSuccess(result: string): boolean {
  return result.includes('大成功') || result.includes('完美');
}
function isGreatFailure(result: string): boolean {
  return result.includes('大失败');
}

/** Emphasis class map for a leaf part. */
function emphasisClass(part: InlinePart): Record<string, boolean> {
  return { 'ft-strong': !!part.bold, 'ft-em': !!part.italic };
}

/** Judgement type label with i18n fallback when the AI omitted the type. */
function judgementType(j: JudgementData): string {
  return j.type || t('common.formatted.judgement.defaultType');
}
/** The outcome the card's colour and icon follow; a flagged notice (a sentence) has none, whatever words it holds. */
function outcomeOf(j: JudgementData): string {
  return j.notice ? '' : j.result;
}
</script>

<template>
  <span class="formatted-inline">
    <template v-for="(part, i) in parts" :key="i">
      <!-- Judgement card -->
      <span v-if="part.kind === 'judgement' && part.judgement" class="judgement-card" :class="{
        'judgement-card--success': isSuccess(outcomeOf(part.judgement)) && !isGreatSuccess(outcomeOf(part.judgement)),
        'judgement-card--failure': isFailure(outcomeOf(part.judgement)) && !isGreatFailure(outcomeOf(part.judgement)),
        'judgement-card--great-success': isGreatSuccess(outcomeOf(part.judgement)),
        'judgement-card--great-failure': isGreatFailure(outcomeOf(part.judgement)),
        'judgement-card--notice': part.judgement.notice,
      }">
        <!-- Icon -->
        <span class="jc-icon" aria-hidden="true">
          <svg v-if="isGreatSuccess(outcomeOf(part.judgement))" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <svg v-else-if="isSuccess(outcomeOf(part.judgement))" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
          <svg v-else-if="isGreatFailure(outcomeOf(part.judgement))" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
          <svg v-else-if="isFailure(outcomeOf(part.judgement))" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
          <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </span>

        <!-- Type + Result (a notice says a sentence: plain text that wraps, not an outcome pill) -->
        <span class="jc-type">{{ judgementType(part.judgement) }}</span>
        <span v-if="part.judgement.notice" class="jc-note">{{ part.judgement.result }}</span>
        <span v-else class="jc-badge">{{ part.judgement.result }}</span>

        <!-- Stats row -->
        <span v-if="!part.judgement.notice" class="jc-stats">
          <span v-if="part.judgement.finalValue" class="jc-stat">
            <span class="jc-stat-label">{{ $t('common.formatted.judgement.finalValue') }}</span>
            <span class="jc-stat-value">{{ part.judgement.finalValue }}</span>
          </span>
          <span v-if="part.judgement.difficulty" class="jc-stat">
            <span class="jc-stat-label">{{ $t('common.formatted.judgement.difficulty') }}</span>
            <span class="jc-stat-value">{{ part.judgement.difficulty }}</span>
          </span>
          <span v-if="part.judgement.base" class="jc-stat">
            <span class="jc-stat-label">{{ $t('common.formatted.judgement.base') }}</span>
            <span class="jc-stat-value">{{ part.judgement.base }}</span>
          </span>
          <span v-if="part.judgement.lucky" class="jc-stat" :class="{ 'jc-stat--positive': part.judgement.lucky.startsWith('+'), 'jc-stat--negative': part.judgement.lucky.startsWith('-') }">
            <span class="jc-stat-label">{{ $t('common.formatted.judgement.lucky') }}</span>
            <span class="jc-stat-value">{{ part.judgement.lucky }}</span>
          </span>
          <span v-if="part.judgement.environment && part.judgement.environment !== '0'" class="jc-stat">
            <span class="jc-stat-label">{{ $t('common.formatted.judgement.environment') }}</span>
            <span class="jc-stat-value">{{ part.judgement.environment }}</span>
          </span>
          <span v-if="part.judgement.status && part.judgement.status !== '0'" class="jc-stat">
            <span class="jc-stat-label">{{ $t('common.formatted.judgement.status') }}</span>
            <span class="jc-stat-value">{{ part.judgement.status }}</span>
          </span>
          <span v-for="(d, di) in part.judgement.details" :key="di" class="jc-stat jc-stat--detail">
            <span class="jc-stat-value">{{ d }}</span>
          </span>
        </span>
      </span>

      <!-- Environment 【】 -->
      <span v-else-if="part.kind === 'environment'" class="ft-environment" :class="emphasisClass(part)">{{ part.text }}</span>

      <!-- Psychology `` -->
      <span v-else-if="part.kind === 'psychology'" class="ft-psychology" :class="emphasisClass(part)">{{ part.text }}</span>

      <!-- Dialogue "" / "" -->
      <span v-else-if="part.kind === 'dialogue'" class="ft-dialogue" :class="emphasisClass(part)">{{ part.text }}</span>

      <!-- Link -->
      <a
        v-else-if="part.kind === 'link'"
        class="ft-link"
        :class="emphasisClass(part)"
        :href="part.href"
        target="_blank"
        rel="noopener noreferrer nofollow"
      >{{ part.text }}</a>

      <!-- NPC name -->
      <span
        v-else-if="part.kind === 'npc-name'"
        class="ft-npc-name"
        :class="emphasisClass(part)"
        @mouseenter="onNpcEnter(part.text ?? '', $event)"
        @mouseleave="onNpcLeave"
        @click.stop="onNpcClick(part.text ?? '')"
      >{{ part.text }}</span>

      <!-- Normal text -->
      <span v-else class="ft-normal" :class="emphasisClass(part)">{{ part.text }}</span>
    </template>

    <!-- NPC hover popover -->
    <Teleport to="body">
      <Transition name="npc-pop">
        <div
          v-if="hoveredNpc"
          class="npc-popover"
          :style="{ left: popoverPos.x + 'px', top: popoverPos.y + 'px' }"
        >
          <div class="npc-pop-row">
            <ImageDisplay
              :asset-id="hoveredNpc['图片档案']?.['已选头像图片ID']"
              :fallback-letter="hoveredNpc.名称?.charAt(0) ?? '?'"
              size="sm"
              class="npc-pop-avatar"
            />
            <div class="npc-pop-info">
              <span class="npc-pop-name">{{ hoveredNpc.名称 }}</span>
              <span v-if="hoveredNpc.性别 || hoveredNpc.类型" class="npc-pop-meta">{{ [hoveredNpc.性别, hoveredNpc.类型].filter(Boolean).join(' · ') }}</span>
            </div>
            <span v-if="hoveredNpc.好感度 != null" class="npc-pop-affinity">♡ {{ hoveredNpc.好感度 }}</span>
          </div>
          <p v-if="hoveredNpc.描述" class="npc-pop-desc">{{ hoveredNpc.描述 }}</p>
        </div>
      </Transition>
    </Teleport>
  </span>
</template>

<style scoped>
.formatted-inline {
  display: inline;
}

/* ── markdown emphasis (compose on top of AGA semantic colors) ── */
.ft-strong { font-weight: 700; }
.ft-em { font-style: italic; }

/* ── Inline text styles (sanctuary migration 2026-04-21) ───────────
   Three distinct spectral "voices" so each marker reads at a glance
   even in a long prose block:

   - Dialogue "..."      → warm amber-kissed bone. Per .impeccable.md:
                           "amber … used sparingly for warmth, confirmation,
                           and narrative emphasis" — dialogue is the
                           canonical warm beacon INSIDE the prose.
   - Environment 【...】  → umber italic. Stage direction / world.
   - Psychology  `...`   → sage-tinged italic. Inner thought / mental
                           state — sage is the "focus / state" accent
                           per the brief. */

.ft-environment {
  color: var(--color-text-umber);
  font-style: italic;
  opacity: 0.92;
}

.ft-psychology {
  color: color-mix(in oklch, var(--color-sage-400) 26%, var(--color-text-secondary));
  font-style: italic;
  opacity: 0.85;
}

.ft-npc-name {
  color: var(--color-sage-300);
  font-weight: 600;
  border-bottom: 1px solid color-mix(in oklch, var(--color-sage-400) 30%, transparent);
  cursor: pointer;
  transition: color var(--duration-fast, 120ms) ease, border-color var(--duration-fast, 120ms) ease;
}
.ft-npc-name:hover {
  color: var(--color-sage-400);
  border-color: var(--color-sage-400);
  text-shadow: 0 0 6px color-mix(in oklch, var(--color-sage-400) 25%, transparent);
}

.ft-dialogue {
  /* Direct amber-300 — the warm beacon for narrative emphasis per
     .impeccable.md. A prior 30% color-mix made dialogue look nearly
     identical to body bone in the real theme (user flagged it
     2026-04-21). Direct amber gives clear, readable contrast. */
  color: var(--color-amber-300);
  font-weight: 500;
  letter-spacing: 0.015em;
}

.ft-link {
  color: var(--color-sage-300);
  text-decoration: underline;
  text-decoration-color: color-mix(in oklch, var(--color-sage-400) 40%, transparent);
  text-underline-offset: 2px;
  cursor: pointer;
  transition: color var(--duration-fast, 120ms) ease;
}
.ft-link:hover {
  color: var(--color-sage-400);
  text-decoration-color: var(--color-sage-400);
}

/* ── Judgement card (sanctuary rebuild, 2026-04-21) ────────────────
   ABSOLUTE-BAN `border-left: 3px solid …` has been REMOVED per
   .impeccable.md "Borders: never colored side-stripes (absolute ban)".
   Replaced with a full 1px border tinted by the judgement accent +
   symmetrical 8px corners + tokenized sanctuary washes. */

.judgement-card {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding: 6px 12px;
  margin: 3px 0;
  border-radius: var(--radius-md, 8px);
  border: 1px solid color-mix(in oklch,
    var(--jc-accent, var(--color-text-umber)) 30%,
    var(--color-border));
  background:
    linear-gradient(135deg,
      color-mix(in oklch, var(--jc-accent, var(--color-text-umber)) 6%, transparent),
      transparent 60%),
    var(--jc-bg, color-mix(in oklch, var(--color-text-umber) 6%, transparent));
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  font-size: 0.82rem;
  line-height: 1.4;
  vertical-align: middle;
  transition: box-shadow var(--duration-normal, 240ms) var(--ease-out);
  position: relative;
}
.judgement-card::after {
  content: '';
  position: absolute;
  top: 0;
  left: 10%;
  right: 10%;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
  pointer-events: none;
}

.judgement-card--success {
  --jc-accent: var(--color-sage-400);
  --jc-bg: var(--color-judgement-success-bg);
  --jc-badge-bg: color-mix(in oklch, var(--color-sage-400) 22%, transparent);
  --jc-badge-color: var(--color-sage-300);
  --jc-icon-color: var(--color-sage-400);
}

.judgement-card--great-success {
  --jc-accent: var(--color-amber-400);
  --jc-bg: var(--color-judgement-great-success-bg);
  --jc-badge-bg: color-mix(in oklch, var(--color-amber-400) 24%, transparent);
  --jc-badge-color: var(--color-amber-300);
  --jc-icon-color: var(--color-amber-400);
  box-shadow: 0 0 18px color-mix(in oklch, var(--color-amber-400) 14%, transparent);
}

.judgement-card--failure {
  --jc-accent: var(--color-danger);
  --jc-bg: var(--color-judgement-failure-bg);
  --jc-badge-bg: color-mix(in oklch, var(--color-danger) 18%, transparent);
  --jc-badge-color: color-mix(in oklch, var(--color-danger) 90%, var(--color-text));
  --jc-icon-color: var(--color-danger);
}

.judgement-card--great-failure {
  --jc-accent: var(--color-danger);
  --jc-bg: var(--color-judgement-great-failure-bg);
  --jc-badge-bg: color-mix(in oklch, var(--color-danger) 28%, transparent);
  --jc-badge-color: color-mix(in oklch, var(--color-danger) 95%, var(--color-text));
  --jc-icon-color: var(--color-danger);
}

.jc-icon {
  color: var(--jc-icon-color, var(--color-text-umber));
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.jc-type {
  font-weight: 600;
  color: var(--color-text);
  letter-spacing: 0.05em;
}

/* A notice (PO 2026-10-02): its whole sentence reads as quiet text after the label, neither cut at a comma nor
   squeezed into an outcome pill. Icon, label and sentence flow like a line of prose inside the card, so a long
   label or a long sentence wraps instead of crushing the other (a flex row did). */
.judgement-card--notice {
  display: inline-block;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.judgement-card--notice .jc-icon {
  display: inline-flex;
  vertical-align: -3px;
  margin-right: 8px;
}
.judgement-card--notice .jc-type {
  margin-right: 10px;
}
.jc-note {
  color: var(--color-text-secondary);
  font-size: 0.8rem;
  line-height: 1.55;
  letter-spacing: 0.02em;
}

.jc-badge {
  padding: 2px 10px;
  border-radius: var(--radius-full, 999px);
  background: var(--jc-badge-bg, var(--color-sage-muted));
  color: var(--jc-badge-color, var(--color-sage-300));
  font-weight: 600;
  font-size: 0.76rem;
  letter-spacing: 0.04em;
}

.jc-stats {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  align-items: center;
}

.jc-stat {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm, 4px);
  padding: 1px 6px;
  font-family: var(--font-mono);
  font-size: 0.72rem;
}

.jc-stat-label {
  color: var(--color-text-muted);
  margin-right: 2px;
}

.jc-stat-value {
  color: var(--color-text);
  font-weight: 600;
}

.jc-stat--positive .jc-stat-value { color: var(--color-sage-300); }
.jc-stat--negative .jc-stat-value { color: var(--color-danger-hover); }
.jc-stat--detail { opacity: 0.7; }

/* ── NPC popover ── */
.npc-popover {
  position: fixed;
  transform: translate(-50%, calc(-100% - 8px));
  z-index: var(--z-tooltip);
  min-width: 200px;
  max-width: 280px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: none;
  box-shadow: var(--glass-shadow);
  pointer-events: none;
}
.npc-pop-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.npc-pop-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  flex-shrink: 0;
}
.npc-pop-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.npc-pop-name {
  font-size: 0.88rem;
  font-weight: 700;
  color: var(--color-text-bone);
  font-family: var(--font-serif-cjk);
}
.npc-pop-meta {
  font-size: 0.68rem;
  color: var(--color-text-secondary);
}
.npc-pop-affinity {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--color-sage-400);
  flex-shrink: 0;
}
.npc-pop-desc {
  margin: 6px 0 0;
  font-size: 0.74rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.npc-pop-enter-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.npc-pop-leave-active { transition: opacity 0.1s ease; }
.npc-pop-enter-from { opacity: 0; transform: translate(-50%, calc(-100% - 2px)); }
.npc-pop-leave-to { opacity: 0; }
</style>
