<script setup lang="ts">
/**
 * EngramGraphView — Read-only Cytoscape graph for the Engram relationship editor.
 *
 * Part of Story 1 Game Card Epic (§5.9).
 * Renders entities as nodes and knowledge edges as connections.
 * Toolbar: layout select, label toggle, relayout button (matching EngramDebugPanel style).
 */
// App doc: docs/user-guide/pages/game-relationship-graph.md
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import cytoscape from 'cytoscape';
import type { Core as CyCore, ElementDefinition } from 'cytoscape';
import type { EngramEntity } from '@/engine/memory/engram/entity-builder';
import type { EngramEdge } from '@/engine/memory/engram/knowledge-edge';
import { NODE_COLORS, NODE_SHAPES, NODE_SIZES } from '@/engine/memory/engram/engram-graph-builder';
import AgaSelect, { type SelectOption } from '@/ui/components/shared/AgaSelect.vue';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';

const { t } = useI18n();

// ─── Props & Emits ───

interface Props {
  entities: EngramEntity[];
  edges: EngramEdge[];
  highlightedEntityName?: string;
  highlightedEdgeId?: string;
  stats?: { entities: number; edges: number; core: number; pending: number };
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'click-node', name: string): void;
  (e: 'click-edge', edgeId: string): void;
}>();

// ─── Toolbar state ───

type LayoutName = 'cose' | 'concentric' | 'breadthfirst' | 'circle';
const layout = ref<LayoutName>('cose');
const showLabels = ref(true);
const graphExpanded = ref(true);

const layoutOptions = computed<SelectOption[]>(() => [
  { label: t('engram.graph.layout.cose'), value: 'cose' },
  { label: t('engram.graph.layout.concentric'), value: 'concentric' },
  { label: t('engram.graph.layout.breadthfirst'), value: 'breadthfirst' },
  { label: t('engram.graph.layout.circle'), value: 'circle' },
]);

// ─── Tooltip state (matches EngramDebugPanel pattern) ───

const graphTooltip = ref<{ visible: boolean; x: number; y: number; html: string }>({
  visible: false, x: 0, y: 0, html: '',
});

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Node visual encoding (reuses engram-graph-builder constants) ───

function nodeColor(type: string): string {
  return NODE_COLORS[type] ?? '#7a8590';
}

function nodeWH(type: string): [number, number] {
  return NODE_SIZES[type] ?? [50, 32];
}

function nodeShape(type: string): string {
  return NODE_SHAPES[type] ?? 'ellipse';
}

// ─── Cytoscape styles ───

// @ts-expect-error cytoscape Stylesheet type doesn't accept data() mappers in strict mode
const CY_STYLES: cytoscape.Stylesheet[] = [
  {
    selector: 'node',
    style: {
      'background-color': 'data(bg)' as unknown as string,
      'label': 'data(label)',
      'shape': 'data(shape)' as unknown as string,
      'width': 'data(w)' as unknown as number,
      'height': 'data(h)' as unknown as number,
      'color': '#d4cfc5',
      'font-size': '11px',
      'font-weight': 500,
      'text-valign': 'center',
      'text-halign': 'center',
      'border-width': 1,
      'border-color': 'rgba(255,255,255,0.12)',
      'text-outline-width': 2,
      'text-outline-color': '#1a1917',
      'opacity': 'data(opacity)' as unknown as number,
    },
  },
  {
    selector: 'node[nodeType="player"]',
    style: {
      'border-width': 2.5,
      'border-color': 'rgba(138,158,108,0.5)',
      'font-weight': 700,
      'font-size': '13px',
    },
  },
  {
    selector: 'node[nodeType="location"]',
    style: { 'font-size': '9px' },
  },
  {
    selector: 'node[nodeType="item"]',
    style: { 'font-size': '9px' },
  },
  {
    selector: 'edge',
    style: {
      'width': 'data(w)' as unknown as number,
      'line-color': 'data(lineColor)' as unknown as string,
      'target-arrow-color': 'data(lineColor)' as unknown as string,
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.6,
      'curve-style': 'bezier',
      'label': 'data(label)',
      'font-size': '7px',
      'color': 'rgba(255,255,255,0.3)',
      'text-rotation': 'autorotate',
      'text-outline-width': 1.5,
      'text-outline-color': '#1a1917',
      'line-style': 'data(lineStyle)' as unknown as string,
      'opacity': 'data(opacity)' as unknown as number,
    },
  },
];

// ─── Layout options ───

function getLayoutOpts(): cytoscape.LayoutOptions {
  const base = { animate: true, animationDuration: 400, padding: 40 };
  if (layout.value === 'cose') {
    return {
      ...base, name: 'cose',
      nodeRepulsion: () => 8000, idealEdgeLength: () => 140,
      gravity: 0.25, numIter: 300,
    } as cytoscape.LayoutOptions;
  }
  if (layout.value === 'concentric') {
    return {
      ...base, name: 'concentric',
      concentric: (n: cytoscape.NodeSingular) => n.data('nodeType') === 'player' ? 10 : n.degree(false),
      levelWidth: () => 2, minNodeSpacing: 50,
    } as cytoscape.LayoutOptions;
  }
  return { ...base, name: layout.value } as cytoscape.LayoutOptions;
}

// ─── Element builders ───

function buildNodeElements(): ElementDefinition[] {
  return props.entities.map((ent) => {
    const [w, h] = nodeWH(ent.type);
    const isLocation = ent.type === 'location';
    const displayLabel = isLocation ? (ent.name.split('·').pop() ?? ent.name) : ent.name;
    return {
      group: 'nodes' as const,
      data: {
        id: `n_${ent.name}`,
        label: showLabels.value ? displayLabel : '',
        fullName: ent.name,
        bg: nodeColor(ent.type),
        shape: nodeShape(ent.type),
        w, h,
        nodeType: ent.type,
        opacity: ent.is_embedded === false ? 0.5 : 1,
        summary: ent.summary || '',
        embedded: ent.is_embedded,
        mentionCount: ent.mentionCount,
        firstSeen: ent.firstSeen,
        lastSeen: ent.lastSeen,
      },
    };
  });
}

function buildEdgeElements(): ElementDefinition[] {
  const entityNames = new Set(props.entities.map((e) => e.name));
  return props.edges
    .filter((edge) => entityNames.has(edge.sourceEntity) && entityNames.has(edge.targetEntity))
    .map((edge) => {
      const isCore = edge.core === true;
      const isUserEdited = edge.source === 'user';
      const isPending = edge.is_embedded === false;
      const label = showLabels.value
        ? (edge.fact.length > 14 ? edge.fact.slice(0, 14) + '…' : edge.fact)
        : '';
      return {
        group: 'edges' as const,
        data: {
          id: `e_${edge.id}`,
          source: `n_${edge.sourceEntity}`,
          target: `n_${edge.targetEntity}`,
          label,
          edgeId: edge.id,
          lineColor: isCore ? '#fbbf24' : 'rgba(255,255,255,0.25)',
          w: isCore ? 3 : 1.5,
          lineStyle: isUserEdited ? 'dashed' : 'solid',
          opacity: isPending ? 0.5 : 1,
          fullFact: edge.fact,
          edgeSource: edge.source,
          createdAtRound: edge.createdAtRound,
          episodes: edge.episodes?.length ?? 0,
          embedded: edge.is_embedded,
          invalidatedAtRound: edge.invalidAtRound ?? edge.invalidatedAtRound,
        },
      };
    });
}

// ─── Empty state ───

const showGraph = computed(() => props.entities.length >= 2);

// ─── Cytoscape lifecycle ───

const graphContainer = ref<HTMLDivElement | null>(null);
let cyInstance: CyCore | null = null;

function initGraph(): void {
  if (!graphContainer.value) return;
  const rect = graphContainer.value.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  destroyGraph();

  const elements = [...buildNodeElements(), ...buildEdgeElements()];
  if (elements.length === 0) return;

  cyInstance = cytoscape({
    container: graphContainer.value,
    elements,
    style: CY_STYLES,
    layout: getLayoutOpts(),
    userZoomingEnabled: true,
    userPanningEnabled: true,
    boxSelectionEnabled: false,
    wheelSensitivity: 0.3,
    minZoom: 0.3,
    maxZoom: 3,
  });

  cyInstance.on('tap', 'node', (evt) => {
    const name = (evt.target.data('fullName') as string) || evt.target.id().replace('n_', '');
    emit('click-node', name);
  });

  cyInstance.on('tap', 'edge', (evt) => {
    const edgeId = evt.target.data('edgeId') as string;
    if (edgeId) emit('click-edge', edgeId);
  });

  // ── Hover tooltips (matches EngramDebugPanel pattern) ──
  const typeLabels: Record<string, string> = {
    player: t('engram.entity.typePlayer'),
    npc: 'NPC',
    location: t('engram.entity.typeLocation'),
    item: t('engram.entity.typeItem'),
  };
  const sourceLabels: Record<string, string> = {
    'ai': t('engram.editor.edge.sourceLabel.ai'),
    'user': t('engram.editor.edge.sourceLabel.user'),
    'opening': t('engram.editor.edge.sourceLabel.opening'),
    'batch-sync': t('engram.editor.edge.sourceLabel.batch-sync'),
    'card-import': t('engram.editor.edge.sourceLabel.card-import'),
    'user-canon': t('engram.editor.edge.sourceLabel.user-canon'),
  };

  cyInstance.on('mouseover', 'node', (evt) => {
    const d = evt.target.data();
    const e = evt.originalEvent as MouseEvent;
    const embedStr = d.embedded ? t('engram.graph.tooltip.embedded') : t('engram.graph.tooltip.notEmbedded');
    const typeStr = typeLabels[d.nodeType] || d.nodeType;
    graphTooltip.value = {
      visible: true, x: e.clientX, y: e.clientY,
      html: `<div class="gtt-type">${esc(typeStr)}</div>`
        + `<div class="gtt-title">${esc(d.fullName)}</div>`
        + (d.summary ? `<div class="gtt-body">${esc(d.summary.length > 80 ? d.summary.slice(0, 80) + '…' : d.summary)}</div>` : '')
        + `<div class="gtt-meta">${esc(t('engram.graph.tooltip.mentionCount', { count: d.mentionCount, first: d.firstSeen, last: d.lastSeen, embedStatus: embedStr }))}</div>`,
    };
  });

  cyInstance.on('mouseover', 'edge', (evt) => {
    const d = evt.target.data();
    const e = evt.originalEvent as MouseEvent;
    const statusText = d.invalidatedAtRound
      ? `<span style="color:#df6b6b;">${esc(t('engram.graph.tooltip.factInvalid', { round: d.invalidatedAtRound }))}</span>`
      : esc(t('engram.graph.tooltip.factValid'));
    const embedStr = d.embedded ? t('engram.graph.tooltip.embedded') : t('engram.graph.tooltip.notEmbedded');
    const srcLabel = sourceLabels[d.edgeSource] || t('engram.editor.edge.sourceLabel.ai');
    graphTooltip.value = {
      visible: true, x: e.clientX, y: e.clientY,
      html: `<div class="gtt-type">${t('engram.graph.tooltip.factEdge', { status: '' })} ${statusText}</div>`
        + `<div class="gtt-fact">${esc(d.fullFact)}</div>`
        + `<div class="gtt-meta">${esc(srcLabel)} · ${esc(t('engram.graph.tooltip.factMeta', { episodes: d.episodes, created: d.createdAtRound, embedStatus: embedStr }))}</div>`,
    };
  });

  cyInstance.on('mouseout', () => { graphTooltip.value.visible = false; });
  cyInstance.on('mousemove', (evt) => {
    if (!graphTooltip.value.visible) return;
    const e = evt.originalEvent as MouseEvent;
    graphTooltip.value.x = e.clientX;
    graphTooltip.value.y = e.clientY;
  });

  applyHighlight();
}

function runLayout(): void {
  if (!cyInstance || cyInstance.elements().length === 0) return;
  cyInstance.layout(getLayoutOpts()).run();
}

function updateElements(): void {
  if (!cyInstance) {
    if (showGraph.value) nextTick(() => initGraph());
    return;
  }
  const newElements = [...buildNodeElements(), ...buildEdgeElements()];
  if (newElements.length === 0) {
    nextTick(() => destroyGraph());
    return;
  }
  cyInstance.elements().remove();
  cyInstance.add(newElements);
  runLayout();
  applyHighlight();
}

function destroyGraph(): void {
  if (cyInstance) {
    cyInstance.destroy();
    cyInstance = null;
  }
}

function onLayoutChange(value: string): void {
  layout.value = value as LayoutName;
  runLayout();
}

function onToggleLabels(): void {
  showLabels.value = !showLabels.value;
  if (cyInstance) {
    updateElements();
  }
}

// ─── Highlight logic ───

function applyHighlight(): void {
  if (!cyInstance) return;

  const highlightNode = props.highlightedEntityName;
  const highlightEdge = props.highlightedEdgeId;

  cyInstance.batch(() => {
    cyInstance!.nodes().forEach((node) => {
      node.style({
        'width': node.data('w') as number,
        'height': node.data('h') as number,
        'opacity': node.data('opacity') as number,
        'background-color': node.data('bg') as string,
        'border-width': node.data('nodeType') === 'player' ? 2.5 : 1,
      });
    });
    cyInstance!.edges().forEach((edge) => {
      edge.style({
        'width': edge.data('w') as number,
        'opacity': edge.data('opacity') as number,
        'line-color': edge.data('lineColor') as string,
        'target-arrow-color': edge.data('lineColor') as string,
      });
    });
  });

  if (highlightNode) {
    const targetNodeId = `n_${highlightNode}`;
    cyInstance.batch(() => {
      cyInstance!.elements().style('opacity', 0.2);
      const targetNode = cyInstance!.getElementById(targetNodeId);
      if (targetNode.length > 0) {
        const neighborhood = targetNode.neighborhood().add(targetNode);
        neighborhood.style('opacity', 1);
        targetNode.style({
          'width': (targetNode.data('w') as number) * 1.3,
          'height': (targetNode.data('h') as number) * 1.3,
        });
      }
    });
  }

  if (highlightEdge) {
    const targetEdgeId = `e_${highlightEdge}`;
    cyInstance.batch(() => {
      if (!highlightNode) cyInstance!.elements().style('opacity', 0.2);
      const targetEdge = cyInstance!.getElementById(targetEdgeId);
      if (targetEdge.length > 0) {
        targetEdge.style({ 'opacity': 1, 'width': 4, 'line-color': '#fbbf24', 'target-arrow-color': '#fbbf24' });
        targetEdge.connectedNodes().style('opacity', 1);
      }
    });
  }
}

// ─── Watchers ───

watch(
  () => [props.entities, props.edges],
  () => {
    if (!showGraph.value) { nextTick(() => destroyGraph()); return; }
    if (cyInstance) updateElements();
    else nextTick(() => initGraph());
  },
  { deep: true },
);

watch(
  () => [props.highlightedEntityName, props.highlightedEdgeId],
  () => applyHighlight(),
);

watch(graphExpanded, (expanded) => {
  if (expanded) {
    nextTick(() => initGraph());
  } else {
    destroyGraph();
  }
});

// ─── Lifecycle ───

onMounted(async () => {
  if (showGraph.value) {
    await nextTick();
    initGraph();
  }
});

onBeforeUnmount(() => destroyGraph());
</script>

<template>
  <div class="engram-graph-view">
    <div v-if="!showGraph" class="graph-empty">
      {{ t('engram.editor.graph.empty') }}
    </div>
    <template v-else>
      <div class="graph-card">
        <!-- Toolbar — inside card, no border of its own -->
        <div class="gf-bar">
          <button class="gf-collapse-btn" @click="graphExpanded = !graphExpanded">
            <span class="gf-collapse-chevron" :class="{ 'gf-collapse-chevron--open': graphExpanded }">▸</span>
            <span class="gf-collapse-label">{{ t('engram.section.graph') }}</span>
          </button>
          <template v-if="graphExpanded">
            <span class="gf-sep" />
            <div class="gf-group">
              <AgaToggle
                :modelValue="showLabels"
                :label="showLabels ? t('engram.graph.labelToggleOn') : t('engram.graph.labelToggleOff')"
                @update:modelValue="() => onToggleLabels()"
              />
              <span class="gf-group__label" aria-hidden="true">{{ showLabels ? t('engram.graph.labelToggleOn') : t('engram.graph.labelToggleOff') }}</span>
            </div>
            <span class="gf-sep" />
            <div class="gf-group">
              <AgaSelect
                class="gf-select-aga"
                :modelValue="layout"
                :options="layoutOptions"
                :ariaLabel="t('engram.section.graph')"
                @update:modelValue="(v) => onLayoutChange(v)"
              />
              <AgaButton size="sm" variant="ghost" @click="runLayout">{{ t('engram.graph.relayout') }}</AgaButton>
            </div>
          </template>
        </div>

        <!-- Canvas + overlays -->
        <div v-if="graphExpanded" class="graph-canvas-wrap">
          <div ref="graphContainer" class="cy-container" />

          <!-- Stats overlay (bottom-left) -->
          <div v-if="props.stats" class="graph-overlay graph-overlay--stats">
            <span>{{ t('engram.editor.stats.entities') }} <b>{{ props.stats.entities }}</b></span>
            <span class="ov-sep" />
            <span>{{ t('engram.editor.stats.edges') }} <b>{{ props.stats.edges }}</b></span>
            <span class="ov-sep" />
            <span>{{ t('engram.editor.stats.core') }} <b class="ov-core">{{ props.stats.core }}</b></span>
            <span class="ov-sep" />
            <span>{{ t('engram.editor.stats.pending') }} <b class="ov-pending">{{ props.stats.pending }}</b></span>
          </div>

          <!-- Tooltip (fixed position, follows cursor) -->
          <div
            v-if="graphTooltip.visible"
            class="graph-tooltip"
            :style="{ left: (graphTooltip.x + 12) + 'px', top: (graphTooltip.y + 12) + 'px' }"
            v-html="graphTooltip.html"
          />

          <!-- Legend overlay (bottom-right) -->
          <div class="graph-overlay graph-overlay--legend">
            <div class="legend-row"><span class="legend-shape legend-shape--npc" /> NPC</div>
            <div class="legend-row"><span class="legend-shape legend-shape--player" /> {{ t('engram.entity.typePlayer') }}</div>
            <div class="legend-row"><span class="legend-shape legend-shape--location" /> {{ t('engram.entity.typeLocation') }}</div>
            <div class="legend-row"><span class="legend-shape legend-shape--item" /> {{ t('engram.entity.typeItem') }}</div>
            <div class="legend-sep" />
            <div class="legend-row"><span class="legend-line legend-line--solid" /> {{ t('engram.graph.edgeType.fact') }}</div>
            <div class="legend-row"><span class="legend-line legend-line--dashed" /> {{ t('engram.editor.edge.sourceLabel.user') }}</div>
            <div class="legend-row"><span class="legend-line legend-line--core" /> {{ t('engram.editor.edge.core') }}</div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.engram-graph-view { width: 100%; }

/* ── Card container — single unit, no visible seam ── */
.graph-card {
  border: 1px solid var(--color-border-subtle, transparent); border-radius: 8px;
  background: rgba(0,0,0,0.15); overflow: hidden;
}

/* ── Toolbar — flush inside card top ── */
.gf-bar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 7px 10px;
  background: rgba(255,255,255,0.02);
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.gf-group { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--color-text-secondary,#8888a0); }
.gf-group__label { font-size: var(--font-size-sm, 11px); color: var(--color-text-secondary, #8888a0); user-select: none; }
.gf-sep { width: 1px; height: 18px; background: var(--color-border, #2a2a3a); flex-shrink: 0; }
.gf-select-aga { min-width: 120px; }

/* ── Collapse toggle ── */
.gf-collapse-btn {
  display: flex; align-items: center; gap: 4px;
  background: none; border: none; cursor: pointer;
  color: var(--color-text, #d4cfc5); font-size: 11px; font-weight: 600;
  padding: 2px 4px; transition: color 0.15s;
}
.gf-collapse-btn:hover { color: var(--color-sage-400); }
.gf-collapse-chevron {
  font-size: 10px; transition: transform 0.2s ease; display: inline-block;
}
.gf-collapse-chevron--open { transform: rotate(90deg); }
.gf-collapse-label { letter-spacing: 0.02em; }

/* ── Canvas wrapper (position context for overlays) ── */
.graph-canvas-wrap { position: relative; }
.cy-container { width: 100%; height: 520px; }

/* ── Floating overlays inside graph ── */
.graph-overlay {
  position: absolute; z-index: 5; pointer-events: none;
  padding: 6px 10px; border-radius: 6px;
  background: rgba(20,20,18,0.82);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  font-size: 10.5px; color: var(--color-text-secondary, #8888a0);
  border: 1px solid rgba(255,255,255,0.06);
}

/* Stats — bottom-left */
.graph-overlay--stats {
  bottom: 10px; left: 10px;
  display: flex; align-items: center; gap: 6px;
}
.graph-overlay--stats b { color: var(--color-text, #d4cfc5); font-weight: 600; }
.ov-sep { width: 1px; height: 12px; background: rgba(255,255,255,0.1); }
.ov-core { color: #fbbf24 !important; }
.ov-pending { color: var(--color-sage-400, #8a9e6c) !important; }

/* Legend — bottom-right */
.graph-overlay--legend {
  bottom: 10px; right: 10px;
  display: flex; flex-direction: column; gap: 3px;
}
.legend-row { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.legend-sep { height: 1px; background: rgba(255,255,255,0.06); margin: 2px 0; }

/* Node shapes */
.legend-shape {
  display: inline-block; width: 12px; height: 10px; flex-shrink: 0;
}
.legend-shape--npc {
  width: 11px; height: 11px; border-radius: 50%;
  background: #7aab78; border: 1px solid rgba(255,255,255,0.12);
}
.legend-shape--player {
  width: 14px; height: 10px; border-radius: 50%;
  background: #8a9e6c; border: 2px solid rgba(138,158,108,0.5);
}
.legend-shape--location {
  width: 11px; height: 11px; transform: rotate(45deg);
  background: #d4a44c; border: 1px solid rgba(255,255,255,0.12);
}
.legend-shape--item {
  width: 12px; height: 9px; border-radius: 3px;
  background: #6b9e8a; border: 1px solid rgba(255,255,255,0.12);
}

/* Edge lines */
.legend-line {
  display: inline-block; width: 18px; height: 0; flex-shrink: 0;
  border-top-width: 2px; border-top-style: solid;
}
.legend-line--solid { border-color: rgba(255,255,255,0.3); }
.legend-line--dashed { border-color: rgba(255,255,255,0.3); border-top-style: dashed; }
.legend-line--core { border-color: #fbbf24; border-top-width: 3px; }

/* ── Empty state ── */
.graph-empty {
  display: flex; align-items: center; justify-content: center;
  height: 200px; color: var(--color-text-secondary, #8888a0); font-size: 0.85rem;
}

/* ── Graph tooltip (matches EngramDebugPanel .graph-tooltip + .gtt-* pattern) ── */
/* Canvas exception: cytoscape nodes/edges are canvas-rendered and cannot host
   Tooltip.vue, so this stays JS-driven but is aligned to the unified glass-chip
   tokens (bg / blur / z-index / color / radius). */
.graph-tooltip {
  position: fixed;
  z-index: var(--z-tooltip, 1000);
  pointer-events: none;
  max-width: 360px;
  padding: 8px 12px;
  border-radius: var(--radius-sm, 6px);
  background: rgba(25, 24, 22, 0.92);
  backdrop-filter: blur(6px) saturate(1.2);
  -webkit-backdrop-filter: blur(6px) saturate(1.2);
  box-shadow: var(--glass-shadow, 0 4px 16px rgba(0, 0, 0, 0.4));
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-text, #d4cfc5);
}
.graph-tooltip :deep(.gtt-type) {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-sage-400, #8a9e6c);
  margin-bottom: 2px;
}
.graph-tooltip :deep(.gtt-title) {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-bone, #d4cfc5);
  margin-bottom: 3px;
}
.graph-tooltip :deep(.gtt-body) {
  font-size: 10.5px;
  color: var(--color-text-secondary, #a0a0a0);
  margin-bottom: 3px;
}
.graph-tooltip :deep(.gtt-fact) {
  font-size: 11px;
  color: var(--color-text-bone, #d4cfc5);
  margin-bottom: 3px;
}
.graph-tooltip :deep(.gtt-meta) {
  font-size: 9px;
  color: var(--color-text-muted, #666);
}
</style>
