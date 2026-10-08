<template>
  <!--
    DeltaViewer — 展示单回合的状态变更列表。
    用于 MainGamePanel 每条 AI 叙事消息旁的 Delta 按钮弹出的 Modal 内容区。
    变更分组按来源显示：主线 / 字段补齐 / 私密补齐 / 世界心跳 / NPC 生成。
  -->
  <div class="delta-viewer" role="list" :aria-label="$t('common.delta.ariaChanges', { n: changes.length })">
    <div v-if="changes.length === 0" class="delta-empty">{{ $t('common.delta.empty') }}</div>

    <template v-for="group in groupedChanges" :key="group.source">
      <div v-if="group.items.length > 0" class="delta-group">
        <div
          v-if="groupedChanges.length > 1 || group.source !== 'main'"
          :class="['delta-group-header', `delta-group-header--${group.source}`]"
        >
          <span class="delta-group-dot" />
          <span class="delta-group-label">{{ sourceLabel(group.source) }}</span>
          <span class="delta-group-count">{{ group.items.length }}</span>
        </div>
        <div
          v-for="(c, i) in group.items"
          :key="`${group.source}-${i}`"
          :class="['delta-item', `delta-item--${c.action}`]"
          role="listitem"
        >
          <span class="delta-action" :aria-label="actionLabel(c.action)">
            {{ actionIcon(c.action) }}
          </span>
          <span class="delta-path" :title="c.path">{{ c.path }}</span>
          <span v-if="c.action !== 'delete'" class="delta-values">
            <span v-if="c.oldValue !== undefined && c.action !== 'push'" class="delta-old">{{ fmt(c.oldValue) }}</span>
            <span v-if="c.action !== 'push'" class="delta-arrow" aria-hidden="true">→</span>
            <span class="delta-new">{{ fmt(c.newValue) }}</span>
          </span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

type AuditSource =
  | 'main'
  | 'privacyRepair'
  | 'fieldRepair'
  | 'worldHeartbeat'
  | 'npcGeneration'
  | 'bodyPolish';

export interface DeltaChange {
  path: string;
  action: string;
  oldValue?: unknown;
  newValue?: unknown;
  source?: AuditSource;
}

const props = defineProps<{ changes: DeltaChange[] }>();

// Group changes by source in a stable display order. Entries without `source`
// (legacy saves written before the audit tag) fall into the "main" bucket so
// they continue to render without UI regression.
const SOURCE_ORDER: AuditSource[] = ['main', 'fieldRepair', 'privacyRepair', 'npcGeneration', 'worldHeartbeat', 'bodyPolish'];

const groupedChanges = computed(() => {
  const buckets: Record<AuditSource, DeltaChange[]> = {
    main: [], fieldRepair: [], privacyRepair: [], npcGeneration: [], worldHeartbeat: [], bodyPolish: [],
  };
  for (const c of props.changes) {
    const src: AuditSource = (c.source ?? 'main') as AuditSource;
    (buckets[src] ?? buckets.main).push(c);
  }
  return SOURCE_ORDER.map((source) => ({ source, items: buckets[source] }));
});

function sourceLabel(s: AuditSource): string {
  const map: Record<AuditSource, string> = {
    main: t('common.delta.source.main'),
    fieldRepair: t('common.delta.source.fieldRepair'),
    privacyRepair: t('common.delta.source.privacyRepair'),
    worldHeartbeat: t('common.delta.source.worldHeartbeat'),
    npcGeneration: t('common.delta.source.npcGeneration'),
    bodyPolish: t('common.delta.source.bodyPolish'),
  };
  return map[s] ?? s;
}

function actionIcon(action: string): string {
  switch (action) {
    case 'set':    return '✎';
    case 'add':    return '＋';
    case 'delete': return '✕';
    case 'push':   return '↓';
    case 'pull':   return '↑';
    default:       return '·';
  }
}

function actionLabel(action: string): string {
  const map: Record<string, string> = {
    set: t('common.delta.action.set'),
    add: t('common.delta.action.add'),
    delete: t('common.delta.action.delete'),
    push: t('common.delta.action.push'),
    pull: t('common.delta.action.pull'),
  };
  return map[action] ?? action;
}

/** 将任意值格式化为简短可读字符串（最多 60 字符） */
function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      return s.length > 60 ? s.slice(0, 57) + '…' : s;
    } catch {
      return `[${t('common.delta.format.object')}]`;
    }
  }
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}
</script>

<style scoped>
/* Sanctuary migration 2026-04-21 — ABSOLUTE-BAN FIX + color system:
   - `.delta-item--* { border-left: 2px solid … }` REMOVED per brief
     "Borders: never colored side-stripes (absolute ban)". Each row now
     carries a full 1px subtle border; the action-icon on the left holds
     the accent color so rows stay scannable at a glance.
   - Six source colors retokenized into the sanctuary palette (no more
     six-hue rainbow: indigo / teal / pink / violet / amber / green).
     All sources now ride sage / amber / warm-rust only:
       main            → sage-400        (primary state)
       fieldRepair     → amber-400       (correction warmth)
       privacyRepair   → danger×umber    (sensitive / deep rust)
       npcGeneration   → sage×amber mix  (mixed beacon — character enters)
       worldHeartbeat  → amber-500       (pulse)
       bodyPolish      → sage-300        (polish / brightened)
   - Five action colors (set/add/delete/push/pull) retokenized to sage /
     success / danger / amber tokens.
   - Header backgrounds now tint with the group accent via color-mix so
     each source reads at a glance without losing sanctuary palette
     restraint.
   - Local `::-webkit-scrollbar` removed — global sanctuary scrollbar
     in tokens.css applies consistently.
   - All raw hex fallbacks removed now that tokens are guaranteed loaded. */

.delta-viewer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 420px;
  overflow-y: auto;
  font-size: 0.78rem;
}

.delta-empty {
  color: var(--color-text-muted);
  text-align: center;
  padding: var(--space-lg);
  font-family: var(--font-serif-cjk);
  font-style: italic;
}

.delta-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.delta-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  margin-top: 6px;
  font-family: var(--font-sans);
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--group-accent, var(--color-text-muted));
  border-radius: var(--radius-sm);
  background: linear-gradient(90deg,
    color-mix(in oklch, var(--group-accent, var(--color-text-muted)) 10%, transparent),
    color-mix(in oklch, var(--group-accent, var(--color-text-muted)) 4%, transparent));
}
.delta-group:first-child .delta-group-header { margin-top: 0; }

.delta-group-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--group-accent, var(--color-text-muted));
  box-shadow:
    0 0 6px color-mix(in oklch, var(--group-accent, var(--color-text-muted)) 55%, transparent),
    0 0 12px color-mix(in oklch, var(--group-accent, var(--color-text-muted)) 20%, transparent),
    inset 0 1px 1px rgba(255, 255, 255, 0.15);
}
.delta-group-label { flex: 1; }
.delta-group-count {
  font-family: var(--font-mono);
  font-size: 0.64rem;
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: color-mix(in oklch, var(--color-text) 6%, transparent);
  color: var(--color-text-secondary);
  letter-spacing: 0.05em;
}

/* Six audit sources — all on sanctuary sage / amber / rust axes. */
.delta-group-header--main           { --group-accent: var(--color-sage-400); }
.delta-group-header--fieldRepair    { --group-accent: var(--color-amber-400); }
.delta-group-header--privacyRepair  { --group-accent: color-mix(in oklch, var(--color-danger) 55%, var(--color-text-umber)); }
.delta-group-header--npcGeneration  { --group-accent: color-mix(in oklch, var(--color-sage-400) 60%, var(--color-amber-400)); }
.delta-group-header--worldHeartbeat { --group-accent: var(--color-amber-500); }
.delta-group-header--bodyPolish     { --group-accent: var(--color-sage-300); }

.delta-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: color-mix(in oklch, var(--color-surface-elevated) 50%, transparent);
  border: 1px solid var(--color-border-subtle);
  min-width: 0;
}

.delta-action {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  font-weight: 700;
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  color: var(--row-accent, var(--color-text-umber));
}

/* Five action colors tokenized to the sanctuary palette. */
.delta-item--set    { --row-accent: var(--color-sage-400); }
.delta-item--add    { --row-accent: var(--color-success); }
.delta-item--delete { --row-accent: var(--color-danger); }
.delta-item--push   { --row-accent: var(--color-amber-400); }
.delta-item--pull   { --row-accent: var(--color-amber-400); }

.delta-path {
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: 0.7rem;
  font-weight: 600;
  flex-shrink: 0;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.delta-values {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.delta-old {
  color: var(--color-danger-hover);
  text-decoration: line-through;
  opacity: 0.7;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

.delta-arrow {
  color: var(--color-text-muted);
  opacity: 0.6;
  flex-shrink: 0;
}

.delta-new {
  color: var(--color-sage-300);
  font-family: var(--font-mono);
  font-size: 0.7rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}
</style>
