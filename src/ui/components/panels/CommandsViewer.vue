<script setup lang="ts">
/**
 * CommandsViewer — two-tab view of a round's state operations:
 *   - "AI 请求命令" : the commands the AI emitted (narrativeHistory[i]._commands)
 *   - "生效变更"    : the changes actually applied (narrativeHistory[i]._delta)
 *
 * Phase 3 (2026-04-19): unified entry point for both the ☰ button on the
 * RoundDivider (new, current-round only) and the existing
 * Δ badge on assistant bubbles (all rounds). Both triggers open this modal —
 * see MainGamePanel.vue handlers.
 *
 * The embedded DeltaViewer is the existing AGA component; we pass the raw
 * delta list straight through so its grouping/coloring behavior is
 * preserved (no fork).
 */
import { ref, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Modal from '@/ui/components/common/Modal.vue';
import DeltaViewer, { type DeltaChange } from '@/ui/components/common/DeltaViewer.vue';
import {
  computeCommandStats,
  formatCommandValue,
  COMMAND_ACTION_LABEL,
  type Command,
  type CommandStats,
} from './commands-viewer-helpers';

interface Props {
  modelValue: boolean;
  /** AI-requested commands (pre-execution). */
  commands?: Command[];
  /** State changes actually applied (post-execution). Forwarded to DeltaViewer. */
  delta?: DeltaChange[];
  roundNumber?: number;
  /** Which tab to open by default. */
  initialTab?: 'commands' | 'delta';
}

const props = withDefaults(defineProps<Props>(), {
  commands: () => [],
  delta: () => [],
  roundNumber: 0,
  initialTab: 'commands',
});

defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const { t } = useI18n();

type Tab = 'commands' | 'delta';
const activeTab = ref<Tab>(props.initialTab);

// Reset tab on each open to honor the caller's `initialTab` choice —
// "Δ badge → delta tab", "☰ button → commands tab".
watch(
  () => props.modelValue,
  (open) => {
    if (open) activeTab.value = props.initialTab;
  },
);

const commandStats = computed<CommandStats>(() => computeCommandStats(props.commands));

function title(): string {
  return props.roundNumber > 0
    ? t('mainGame.commandsViewer.title', { n: props.roundNumber })
    : t('mainGame.commandsViewer.titleGeneric');
}
</script>

<template>
  <Modal
    :model-value="props.modelValue"
    :title="title()"
    width="720px"
    backdrop-close
    @update:model-value="(v) => $emit('update:modelValue', v)"
  >
    <!-- Tabs -->
    <div class="cmd-viewer__tabs" role="tablist">
      <button
        class="cmd-viewer__tab"
        :class="{ 'cmd-viewer__tab--active': activeTab === 'commands' }"
        role="tab"
        :aria-selected="activeTab === 'commands'"
        @click="activeTab = 'commands'"
      >
        {{ $t('mainGame.commandsViewer.tabCommands') }}
        <span v-if="commandStats.total > 0" class="cmd-viewer__tab-count">{{ commandStats.total }}</span>
      </button>
      <button
        class="cmd-viewer__tab"
        :class="{ 'cmd-viewer__tab--active': activeTab === 'delta' }"
        role="tab"
        :aria-selected="activeTab === 'delta'"
        @click="activeTab = 'delta'"
      >
        {{ $t('mainGame.commandsViewer.tabDelta') }}
        <span v-if="props.delta.length > 0" class="cmd-viewer__tab-count">{{ props.delta.length }}</span>
      </button>
    </div>

    <!-- Commands tab -->
    <div v-if="activeTab === 'commands'" class="cmd-viewer__panel">
      <div v-if="props.commands.length === 0" class="cmd-viewer__empty">
        {{ $t('mainGame.commandsViewer.emptyCommands') }}
      </div>
      <template v-else>
        <div class="cmd-viewer__stats">
          <span v-if="commandStats.set > 0" class="cmd-viewer__stat-chip cmd-viewer__stat-chip--set">
            SET · {{ commandStats.set }}
          </span>
          <span v-if="commandStats.add > 0" class="cmd-viewer__stat-chip cmd-viewer__stat-chip--add">
            ADD · {{ commandStats.add }}
          </span>
          <span v-if="commandStats.push > 0" class="cmd-viewer__stat-chip cmd-viewer__stat-chip--push">
            PUSH · {{ commandStats.push }}
          </span>
          <span v-if="commandStats.delete > 0" class="cmd-viewer__stat-chip cmd-viewer__stat-chip--delete">
            DEL · {{ commandStats.delete }}
          </span>
          <span v-if="commandStats.pull > 0" class="cmd-viewer__stat-chip cmd-viewer__stat-chip--pull">
            PULL · {{ commandStats.pull }}
          </span>
        </div>
        <div class="cmd-viewer__list">
          <div
            v-for="(cmd, idx) in props.commands"
            :key="`${cmd.action}-${cmd.key}-${idx}`"
            class="cmd-row"
            :class="[`cmd-row--${cmd.action}`]"
          >
            <span class="cmd-row__action">{{ COMMAND_ACTION_LABEL[cmd.action] ?? cmd.action.toUpperCase() }}</span>
            <span class="cmd-row__key" :title="cmd.key">{{ cmd.key }}</span>
            <span v-if="cmd.action !== 'delete'" class="cmd-row__value" :title="typeof cmd.value === 'object' ? JSON.stringify(cmd.value) : String(cmd.value ?? '')">
              {{ formatCommandValue(cmd.value) }}
            </span>
          </div>
        </div>
      </template>
    </div>

    <!-- Delta tab — reuses existing DeltaViewer to stay consistent with the Δ badge path -->
    <div v-else class="cmd-viewer__panel">
      <DeltaViewer :changes="props.delta" />
    </div>
  </Modal>
</template>

<style scoped>
/* Sanctuary migration 2026-04-21:
   - Tab active-state indigo → sage-300 text + sage-400 underline
   - Per-action color system: Tailwind indigo/green/amber/red literals replaced
     with sage (set) / success (add) / amber (push/pull) / danger (delete)
   - ABSOLUTE-BAN: `.cmd-row { border-left: … solid }` removed per brief
     "Borders: never colored side-stripes (absolute ban)". Row grouping is
     preserved via (a) a small colored glyph before the action label and
     (b) the action-label text itself carrying the accent color. */

.cmd-viewer__tabs {
  display: flex;
  gap: var(--space-xs);
  margin-bottom: var(--space-md);
  border-bottom: 1px solid var(--color-border-subtle);
}

.cmd-viewer__tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-xs) var(--space-md);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--color-text-muted);
  font-family: var(--font-sans);
  font-size: var(--font-size-xs);
  font-weight: 500;
  letter-spacing: 0.06em;
  cursor: pointer;
  margin-bottom: -1px;
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out);
}

.cmd-viewer__tab:hover {
  color: var(--color-text);
}

.cmd-viewer__tab--active {
  color: var(--color-sage-300);
  border-bottom-color: var(--color-sage-400);
}

.cmd-viewer__tab-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  padding: 0 4px;
  border-radius: var(--radius-full);
  background: color-mix(in oklch, var(--color-text) 6%, transparent);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  color: var(--color-text-secondary);
}

.cmd-viewer__panel {
  min-height: 120px;
}

.cmd-viewer__empty {
  padding: var(--space-2xl) 0;
  text-align: center;
  color: var(--color-text-muted);
  font-family: var(--font-serif-cjk);
  font-style: italic;
  font-size: var(--font-size-sm);
}

.cmd-viewer__stats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  margin-bottom: var(--space-sm);
  padding-bottom: var(--space-xs);
  border-bottom: 1px dashed var(--color-border-subtle);
}

.cmd-viewer__stat-chip {
  display: inline-block;
  padding: 2px var(--space-sm);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  border-radius: var(--radius-sm);
  border: 1px solid currentColor;
}

/* Sanctuary-tokenized action color system: shared across chip + row accent */
.cmd-viewer__stat-chip--set    { color: var(--color-sage-300);  background: var(--color-sage-muted); }
.cmd-viewer__stat-chip--add    { color: var(--color-success);   background: color-mix(in oklch, var(--color-success) 12%, transparent); }
.cmd-viewer__stat-chip--push   { color: var(--color-amber-400); background: var(--color-amber-muted); }
.cmd-viewer__stat-chip--delete { color: var(--color-danger);    background: color-mix(in oklch, var(--color-danger) 10%, transparent); }
.cmd-viewer__stat-chip--pull   { color: var(--color-amber-400); background: var(--color-amber-muted); }

.cmd-viewer__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  max-height: 420px;
  overflow-y: auto;
}
/* Local scrollbar override removed — global sanctuary scrollbar applies. */

.cmd-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
  padding: var(--space-xs) var(--space-sm);
  background: color-mix(in oklch, var(--color-surface-elevated) 60%, transparent);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  font-size: 0.78rem;
  min-width: 0;
}

.cmd-row__action {
  position: relative;
  flex-shrink: 0;
  /* Extra left padding reserves space for the leading accent dot so the
     action label stays aligned across action types. */
  padding-left: 12px;
  width: 52px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
}
.cmd-row__action::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  width: 6px;
  height: 6px;
  margin-top: -3px;
  border-radius: 50%;
  background: var(--row-accent, var(--color-text-muted));
  box-shadow: 0 0 4px color-mix(in oklch, var(--row-accent, var(--color-text-muted)) 50%, transparent);
}
.cmd-row--set    { --row-accent: var(--color-sage-400);  }
.cmd-row--set    .cmd-row__action { color: var(--color-sage-300);  }
.cmd-row--add    { --row-accent: var(--color-success);   }
.cmd-row--add    .cmd-row__action { color: var(--color-success);   }
.cmd-row--push   { --row-accent: var(--color-amber-400); }
.cmd-row--push   .cmd-row__action { color: var(--color-amber-400); }
.cmd-row--delete { --row-accent: var(--color-danger);    }
.cmd-row--delete .cmd-row__action { color: var(--color-danger);    }
.cmd-row--pull   { --row-accent: var(--color-amber-400); }
.cmd-row--pull   .cmd-row__action { color: var(--color-amber-400); }

.cmd-row__key {
  flex-shrink: 0;
  max-width: 200px;
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cmd-row__value {
  flex: 1;
  min-width: 0;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
