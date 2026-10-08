<script setup lang="ts">
// App doc: docs/user-guide/pages/game-save.md §2.7.2
/**
 * CardStripPreview — Story 7 (P5): strip preview for card export, shared by the
 * Story 5 flow (active save) and the Story 7 save-to-card flow (U12).
 *
 * Three groups: kept / cleared / reset. Only two flags change what is shown
 * (includedPlotDirection, containsNsfw); the cleared / reset lists are static i18n text
 * (save.export.preview.stripItems / resetItems) with no code link to card-stripper's rules,
 * so a new strip rule must be added to that text by hand.
 * Engram is carried separately in bundle.engram, so it is shown under "kept"
 * (never as "lost"). Includes the NSFW silent-drop hint (hardening F2) and the
 * missing-image warning (U16).
 */
import { useI18n } from 'vue-i18n';
import type { ExportFlags } from '@/engine/export/game-card-bundle.types';

const props = defineProps<{
  counts: { npc: number; loc: number; img: number };
  /** Edge count entering the card (classified selection in target mode, all edges otherwise). */
  edgeCount: number;
  flags: ExportFlags;
  /** Referenced-but-absent-from-cache image count (0 = no warning). */
  missingImageCount: number;
  /** Story 7 save-to-card mode: engram line says "confirmed" instead of plain count. */
  targetMode: boolean;
}>();

const { t } = useI18n();
</script>

<template>
  <div class="csp">
    <!-- kept -->
    <p class="csp-line csp-line--keep">
      <span class="csp-tag csp-tag--keep">{{ t('save.export.preview.keepTitle') }}</span>
      {{ t('save.export.preview.keepWorld', { npc: props.counts.npc, loc: props.counts.loc, img: props.counts.img }) }}
    </p>
    <p class="csp-line csp-line--keep csp-line--sub">
      {{ t(props.targetMode ? 'save.export.preview.keepEngramCurated' : 'save.export.preview.keepEngram', { n: props.edgeCount }) }}
    </p>

    <!-- cleared -->
    <p class="csp-line csp-line--strip">
      <span class="csp-tag csp-tag--strip">{{ t('save.export.preview.stripTitle') }}</span>
      {{ t('save.export.preview.stripItems') }}
    </p>

    <!-- reset -->
    <p class="csp-line csp-line--reset">
      <span class="csp-tag csp-tag--reset">{{ t('save.export.preview.resetTitle') }}</span>
      {{ t('save.export.preview.resetItems') }}<template v-if="props.flags.includedPlotDirection"> · {{ t('save.export.preview.resetPlot') }}</template>
    </p>

    <!-- F2: NSFW silent-drop hint -->
    <p v-if="!props.flags.containsNsfw && props.edgeCount > 0" class="csp-warn">
      {{ t('save.export.preview.nsfwDropHint') }}
    </p>

    <!-- U16: missing-image warning -->
    <p v-if="props.missingImageCount > 0" class="csp-warn">
      {{ t('save.export.preview.missingImages', { n: props.missingImageCount }) }}
    </p>

    <div class="csp-never">
      <p class="csp-never__title">{{ t('save.export.neverExport.title') }}</p>
      <p class="csp-never__items">{{ t('save.export.neverExport.items') }}</p>
    </div>
  </div>
</template>

<style scoped>
.csp { display: flex; flex-direction: column; gap: 6px; }
.csp-line { margin: 0; font-size: 0.84rem; line-height: 1.55; overflow-wrap: anywhere; }
.csp-line--keep { color: var(--color-text); }
.csp-line--sub { padding-left: 2px; color: var(--color-text-secondary); }
.csp-line--strip, .csp-line--reset { color: var(--color-text-secondary); }

.csp-tag {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 8px;
  font-size: 0.74rem;
  border-radius: var(--radius-full);
  vertical-align: 1px;
}
.csp-tag--keep { color: var(--color-sage-400); background: color-mix(in oklch, var(--color-sage-400) 14%, transparent); }
.csp-tag--strip { color: var(--color-text-secondary); background: color-mix(in oklch, var(--color-text) 8%, transparent); }
.csp-tag--reset { color: var(--color-amber-400); background: color-mix(in oklch, var(--color-amber-400) 12%, transparent); }

.csp-warn { margin: 0; font-size: 0.8rem; color: var(--color-amber-400); }

.csp-never {
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--color-text) 5%, transparent);
  opacity: 0.85;
}
.csp-never__title { margin: 0 0 2px; font-size: 0.8rem; font-weight: 600; color: var(--color-text-secondary); }
.csp-never__items { margin: 0; font-size: 0.8rem; color: var(--color-text-secondary); }
</style>
