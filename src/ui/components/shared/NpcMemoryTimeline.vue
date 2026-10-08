<script setup lang="ts">
/**
 * NpcMemoryTimeline — Sprint Social-3
 *
 * Renders an NPC's memory entries + summaries as a vertical timeline.
 * Handles both legacy `string` and new `{内容, 时间}` entry shapes via
 * `parseMemoryEntry` from the shared helper.
 *
 * Design: vertical timeline with connector line + dots, rendered in AGA tokens
 * (no wuxia borders).
 */
import { computed } from 'vue';
import { parseMemoryEntry } from '@/engine/social/npc-memory-format';

export interface MemorySummary {
  摘要: string;
  涵盖范围?: string;
  生成时间?: string;
}

const props = defineProps<{
  memories: unknown[];
  summaries?: MemorySummary[];
}>();

const recentMemories = computed(() =>
  props.memories.slice(-15).map((m) => parseMemoryEntry(m)),
);
</script>

<template>
  <div class="npc-memory-tl">
    <!-- Summaries (if any) -->
    <div v-if="summaries?.length" class="tl-section">
      <div class="tl-section-label">{{ $t('modal.npcMemory.sectionSummaries') }}</div>
      <div v-for="(s, i) in summaries" :key="'s-' + i" class="tl-item tl-item--summary">
        <span class="tl-dot tl-dot--summary" />
        <div class="tl-content">
          <p class="tl-text">{{ s.摘要 }}</p>
          <span v-if="s.涵盖范围" class="tl-meta">{{ s.涵盖范围 }}</span>
        </div>
      </div>
    </div>

    <!-- Individual memories -->
    <div v-if="memories.length" class="tl-section">
      <div v-if="summaries?.length" class="tl-section-label">{{ $t('modal.npcMemory.sectionRecent') }}</div>
      <div v-for="(mem, i) in recentMemories" :key="'m-' + i" class="tl-item">
        <span class="tl-dot" />
        <div class="tl-content">
          <p class="tl-text">{{ mem.content }}</p>
          <span v-if="mem.time" class="tl-meta">{{ mem.time }}</span>
        </div>
      </div>
    </div>

    <p v-if="!memories.length && !summaries?.length" class="tl-empty">{{ $t('modal.npcMemory.empty') }}</p>
  </div>
</template>

<style scoped>
.npc-memory-tl {
  padding: var(--space-sm) 0;
}

.tl-section { margin-bottom: var(--space-md); }
.tl-section-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: var(--space-xs);
  padding-left: 20px;
}

.tl-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
  padding: var(--space-xs) 0;
  position: relative;
}

.tl-item + .tl-item::before {
  content: '';
  position: absolute;
  left: 5px;
  top: -4px;
  bottom: calc(100% - 8px);
  width: 1px;
  background: linear-gradient(180deg, var(--color-border), transparent);
}

.tl-dot {
  flex-shrink: 0;
  width: 10px;
  height: 10px;
  border-radius: var(--radius-full);
  background: var(--color-sage-muted);
  border: 2px solid var(--color-sage-400);
  margin-top: 4px;
  box-shadow: 0 0 3px currentColor;
}

.tl-dot--summary {
  background: var(--color-amber-muted);
  border-color: var(--color-amber-400);
}

.tl-content { flex: 1; min-width: 0; }
.tl-text {
  font-size: var(--font-size-sm);
  color: var(--color-text);
  line-height: var(--line-height-normal);
}
.tl-meta {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  margin-top: 2px;
  display: block;
}

.tl-item--summary .tl-text { font-style: italic; }

.tl-empty {
  color: var(--color-text-muted);
  text-align: center;
  padding: var(--space-lg);
  font-size: var(--font-size-sm);
}
</style>
