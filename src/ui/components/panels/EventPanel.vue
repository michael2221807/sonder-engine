<script setup lang="ts">
// App doc: docs/user-guide/pages/game-events.md
/**
 * EventPanel — the world's event timeline: heartbeat history + world events, newest first.
 *
 * The collapsible 「事件配置」 section (intervals, type switches, custom templates, re-roll) was removed on
 * 2026-10-05 (PO 7A): it wrote `世界.状态.事件配置.*`, which nothing in the engine or the pack ever read.
 * Scheduled world events are a separate feature, not yet ported from the demo.
 */
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useGameState } from '@/ui/composables/useGameState';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';

const { t } = useI18n();

const { isLoaded, useValue } = useGameState();

// ─── Event timeline ───────────────────────────────────────────

/** Event entry shape (normalized from potentially varying game pack formats) */
interface WorldEvent {
  id: string;
  title: string;
  description: string;
  timestamp?: string;
  type?: string;
  round?: number;
  [key: string]: unknown;
}

const heartbeatHistory = useValue<unknown[]>(DEFAULT_ENGINE_PATHS.heartbeatHistory);
const worldEvents = useValue<unknown[]>(DEFAULT_ENGINE_PATHS.worldEvents);

/**
 * Normalize a raw event object into the display format.
 * Handles both heartbeat history entries and general event entries.
 */
function normalizeEvent(raw: unknown, idx: number, source: string): WorldEvent {
  if (typeof raw === 'string') {
    return { id: `${source}_${idx}`, title: raw, description: raw, type: source };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    return {
      id: String(obj['事件ID'] ?? obj['id'] ?? `${source}_${idx}`),
      title: String(obj['事件名称'] ?? obj['标题'] ?? obj['title'] ?? obj['事件'] ?? `事件 #${idx + 1}`),
      description: String(obj['事件描述'] ?? obj['描述'] ?? obj['description'] ?? obj['内容'] ?? ''),
      timestamp: (() => { const ts = obj['发生时间'] ?? obj['时间'] ?? obj['timestamp']; return typeof ts === 'string' ? ts : undefined; })(),
      type: String(obj['事件类型'] ?? obj['类型'] ?? obj['type'] ?? source),
      round: typeof obj['回合'] === 'number' ? obj['回合'] : undefined,
    };
  }
  return { id: `${source}_${idx}`, title: `事件 #${idx + 1}`, description: String(raw), type: source };
}

/** Merged + sorted event timeline */
const timeline = computed<WorldEvent[]>(() => {
  const events: WorldEvent[] = [];

  if (Array.isArray(heartbeatHistory.value)) {
    heartbeatHistory.value.forEach((entry, idx) => {
      events.push(normalizeEvent(entry, idx, '心跳'));
    });
  }

  if (Array.isArray(worldEvents.value)) {
    worldEvents.value.forEach((entry, idx) => {
      events.push(normalizeEvent(entry, idx, '世界'));
    });
  }

  return events.reverse();
});

// ─── Expanded event ───────────────────────────────────────────

const expandedId = ref<string | null>(null);

function toggleExpand(id: string): void {
  expandedId.value = expandedId.value === id ? null : id;
}

/** Type badge color */
function typeColor(type: string | undefined): string {
  switch (type) {
    case '心跳': return 'var(--color-success)';
    case '世界': return 'var(--color-sage-400)';
    case '战斗': return 'var(--color-danger)';
    case '剧情': return 'var(--color-sage-400)';
    default: return 'var(--color-text-secondary)';
  }
}

</script>

<template>
  <div class="event-panel">
    <template v-if="isLoaded">
      <header class="panel-header">
        <h2 class="panel-title">
          {{ t('event.title') }}
          <span v-if="timeline.length" class="badge">{{ timeline.length }}</span>
        </h2>
      </header>

      <!-- ── Timeline ── -->
      <div v-if="timeline.length" class="timeline">
        <div
          v-for="event in timeline"
          :key="event.id"
          :class="['timeline-item', { 'timeline-item--expanded': expandedId === event.id }]"
          @click="toggleExpand(event.id)"
        >
          <!-- Timeline indicator -->
          <div class="timeline-dot" :style="{ background: typeColor(event.type) }" />
          <div class="timeline-line" />

          <div class="event-content">
            <div class="event-header">
              <span class="event-title">{{ event.title }}</span>
              <div class="event-meta">
                <span v-if="event.type" class="event-type" :style="{ color: typeColor(event.type) }">
                  {{ event.type }}
                </span>
                <span v-if="event.round != null" class="event-round">R{{ event.round }}</span>
                <span v-if="event.timestamp" class="event-time">{{ event.timestamp }}</span>
              </div>
            </div>

            <Transition name="desc-expand">
              <div v-if="expandedId === event.id && event.description" class="event-description">
                {{ event.description }}
              </div>
            </Transition>
          </div>
        </div>
      </div>

      <div v-else class="empty-state">
        <p>{{ t('event.empty') }}</p>
      </div>
    </template>

    <div v-else class="empty-state">
      <p>{{ t('event.notLoaded') }}</p>
    </div>
  </div>

</template>

<style scoped>
.event-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px var(--sidebar-right-reserve, 40px) 20px var(--sidebar-left-reserve, 40px);
  transition: padding-left var(--duration-open) var(--ease-droplet), padding-right var(--duration-open) var(--ease-droplet);
  height: 100%;
  overflow-y: auto;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.panel-title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--color-text, #e0e0e6);
  display: flex;
  align-items: center;
  gap: 8px;
}

.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--color-text-bone);
  background: var(--color-sage-600);
  border-radius: 10px;
}

/* ── Timeline ── */
.timeline {
  display: flex;
  flex-direction: column;
}

.timeline-item {
  display: flex;
  gap: 12px;
  padding: 10px 0;
  position: relative;
  cursor: pointer;
  transition: background 0.15s ease;
}
.timeline-item:hover {
  background: rgba(255, 255, 255, 0.02);
  border-radius: 6px;
}
.timeline-item--expanded {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.02), transparent 60%);
  border-radius: 6px;
}

.timeline-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 5px;
  z-index: 1;
  box-shadow: 0 0 4px currentColor;
}

.timeline-line {
  position: absolute;
  left: 4px;
  top: 20px;
  bottom: 0;
  width: 2px;
  background: rgba(255, 255, 255, 0.06);
}

.timeline-item:last-child .timeline-line {
  display: none;
}

.event-content {
  flex: 1;
  min-width: 0;
}

.event-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}

.event-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--color-text, #e0e0e6);
  flex: 1;
}

.event-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.event-type {
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.event-round {
  font-size: 0.7rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text-secondary, #8888a0);
}

.event-time {
  font-size: 0.7rem;
  color: var(--color-text-secondary, #8888a0);
}

.event-description {
  margin-top: 6px;
  font-size: 0.8rem;
  color: var(--color-text, #e0e0e6);
  opacity: 0.8;
  line-height: 1.55;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 6px;
  box-shadow: inset 3px 0 0 color-mix(in oklch, var(--color-sage-400) 25%, transparent);
}

/* ── Transitions ── */
.desc-expand-enter-active { transition: all 0.2s ease; }
.desc-expand-leave-active { transition: all 0.15s ease; }
.desc-expand-enter-from,
.desc-expand-leave-to { opacity: 0; max-height: 0; margin-top: 0; }

/* ── Empty ── */
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 120px;
  color: var(--color-text-secondary, #8888a0);
  font-size: 0.88rem;
}

/* ── Scrollbar ── */
.event-panel::-webkit-scrollbar { width: 5px; }
.event-panel::-webkit-scrollbar-track { background: transparent; }
.event-panel::-webkit-scrollbar-thumb { background: color-mix(in oklch, var(--color-text-umber) 35%, transparent); border-radius: 3px; }

@media (max-width: 767px) {
  .event-panel { padding-left: var(--space-md); padding-right: var(--space-md); transition: none; }
}
</style>
