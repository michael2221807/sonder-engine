<script setup lang="ts">
// App doc: docs/user-guide/pages/game-map.md
/**
 * MapPanel — Cytoscape.js compound-node hierarchical map.
 *
 * 2026-04-12 重写：从 edge-based 平铺 → compound node 层级包含。
 *
 * 核心设计：
 * - Compound nodes：`上级` 字段映射为 Cytoscape `parent`，父节点自动成为容器
 * - cose 布局：内置力导向，原生支持 compound node 层级布局
 * - 20 色系：根节点按名称 hash 分配，子孙继承
 * - 探索三态：已探索 / 部分探索 / 未探索
 * - 双击 drill：聚焦到节点 + 子孙，focus stack 支持多级进入/退出
 * - 滚轮缩放 + zoom-based progressive disclosure
 * - 单击 detail panel（保留原有设计）
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, onActivated, nextTick, toRaw } from 'vue';
import { useI18n } from 'vue-i18n';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { Core as CyCore, NodeSingular, EventObject } from 'cytoscape';
import { useGameState } from '@/ui/composables/useGameState';

const { t } = useI18n();

cytoscape.use(fcose);
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import Modal from '@/ui/components/common/Modal.vue';
import AgaSelect from '@/ui/components/shared/AgaSelect.vue';
import type { SelectOption } from '@/ui/components/shared/AgaSelect.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

import { useLocationEditor } from '@/ui/composables/editors';
import { useRouter } from 'vue-router';
import { eventBus } from '@/engine/core/event-bus';
import type { LocationDeleteImpact, LocationFormData } from '@/ui/composables/editors';

const { isLoaded, useValue } = useGameState();
const locEditor = useLocationEditor();
const router = useRouter();

function openAdvancedEditor(targetPath: string): void {
  router.push({ name: 'GameVariables', query: { path: targetPath, from: 'map' } });
}

// ─── Types ────────────────────────────────────────────────────────

interface LocationEntry {
  名称: string;
  描述?: string;
  上级?: string;
  NPC?: string[];
  类型?: string;
  连接?: string[];
  [key: string]: unknown;
}

// ─── State ────────────────────────────────────────────────────────

const locations = useValue<LocationEntry[]>(DEFAULT_ENGINE_PATHS.locations);
const playerLocation = useValue<string>(DEFAULT_ENGINE_PATHS.playerLocation);
const explorationRecord = useValue<string[]>(DEFAULT_ENGINE_PATHS.explorationRecord);

const showHelp = ref(false);
const cyContainer = ref<HTMLDivElement | null>(null);
let cyInstance: CyCore | null = null;

const selectedEntry = ref<LocationEntry | null>(null);
const focusStack = ref<string[]>([]);
const allLocsWithPlaceholders = ref<LocationEntry[]>([]);

// ─── Color families ──────────────────────────────────────────────

const FAMILY_COLORS = [
  '#c9a84c', '#7aab78', '#6b9e8a', '#a0937a', '#b07565',
  '#c48a50', '#8fa872', '#6d9899', '#7aab78', '#6b9e80',
  '#6d9899', '#a0937a', '#c9a84c', '#7a9a78', '#7aab78',
  '#7a8590', '#c48a50', '#8a8a7a', '#c9a84c', '#b07a7a',
];

function nameHash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function getFamilyColor(rootName: string): string {
  return FAMILY_COLORS[nameHash(rootName) % FAMILY_COLORS.length];
}

function darken(hex: string, amount: number): string {
  const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amount);
  const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amount);
  const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amount);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// ─── Computed ────────────────────────────────────────────────────

/**
 * 2026-04-13 fix：必须返回 deep-cloned plain array，不要直接返回 Proxy-wrapped
 * reactive 元素。
 *
 * 原因：Cytoscape 构建节点时把 loc 对象的属性快照拷进节点 data；若拷贝对象
 * 仍是 reactive Proxy，后续 loc.名称 被改写但 Cytoscape 内部数据仍指向旧
 * Proxy 引用，表现为地图与实际状态不一致。改用 JSON.parse(JSON.stringify(toRaw(...)))
 * 强制获得完全脱钩的 plain array，每次 computed 重新运行都产出全新数据。
 */
const validLocations = computed<LocationEntry[]>(() => {
  const raw = locations.value;
  if (!Array.isArray(raw)) return [];
  // 先 toRaw 剥掉 Vue 的 reactive 包装，再 JSON 深拷贝得到 plain array
  const plain = JSON.parse(JSON.stringify(toRaw(raw))) as LocationEntry[];
  return plain.filter(
    (loc) => loc && typeof loc === 'object' && typeof loc.名称 === 'string' && loc.名称.length > 0,
  );
});

const hasLocations = computed(() => validLocations.value.length > 0);

const exploredSet = computed<Set<string>>(
  () => new Set(Array.isArray(explorationRecord.value) ? explorationRecord.value : []),
);

// ─── Tree utilities ──────────────────────────────────────────────

/** Build a name→children map for fast tree traversal */
function buildChildrenMap(locs: LocationEntry[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const loc of locs) {
    if (!loc.上级) continue;
    const siblings = map.get(loc.上级);
    if (siblings) siblings.push(loc.名称);
    else map.set(loc.上级, [loc.名称]);
  }
  return map;
}

/** Get depth of a location (0 = root) */
function getDepth(name: string, parentMap: Map<string, string>): number {
  let d = 0;
  let cur = name;
  while (parentMap.has(cur)) {
    cur = parentMap.get(cur)!;
    d++;
    if (d > 20) break;
  }
  return d;
}

/** Get root ancestor of a location */
function getRoot(name: string, parentMap: Map<string, string>): string {
  let cur = name;
  while (parentMap.has(cur)) {
    cur = parentMap.get(cur)!;
  }
  return cur;
}

/** Check if any descendant is explored */
function hasExploredDescendant(name: string, childrenMap: Map<string, string[]>, explored: Set<string>): boolean {
  const children = childrenMap.get(name);
  if (!children) return false;
  for (const child of children) {
    if (explored.has(child)) return true;
    if (hasExploredDescendant(child, childrenMap, explored)) return true;
  }
  return false;
}

/** Compute exploration state: 'explored' | 'partial' | 'unexplored' */
function getExplorationState(
  name: string, explored: Set<string>, childrenMap: Map<string, string[]>,
): string {
  if (explored.has(name)) return 'explored';
  if (hasExploredDescendant(name, childrenMap, explored)) return 'partial';
  return 'unexplored';
}

// ─── Selection ───────────────────────────────────────────────────

function selectByName(name: string): void {
  const locs = allLocsWithPlaceholders.value;
  selectedEntry.value = locs.find((l) => l.名称 === name) ?? null;
}

function clearSelection(): void {
  selectedEntry.value = null;
}

/** Children of selected location (for detail panel navigation) — deduplicated by name */
const selectedChildren = computed<LocationEntry[]>(() => {
  if (!selectedEntry.value) return [];
  const parent = selectedEntry.value.名称;
  const seen = new Set<string>();
  return allLocsWithPlaceholders.value.filter((l) => {
    if (l.上级 !== parent || seen.has(l.名称)) return false;
    seen.add(l.名称);
    return true;
  });
});

function navigateToChild(name: string): void {
  selectByName(name);
  if (cyInstance) {
    const node = cyInstance.getElementById(name);
    if (node.nonempty()) {
      cyInstance.animate({ fit: { eles: node.union(node.descendants()), padding: 50 } }, { duration: 300 });
    }
  }
}

// ─── Story 2: Location CRUD ──────────────────────────────────────

const relationships = useValue<Array<{ 名称: string }>>(DEFAULT_ENGINE_PATHS.relationships);
const npcNames = computed<string[]>(() => {
  const list = relationships.value;
  return Array.isArray(list) ? list.map(r => r.名称).filter(Boolean) : [];
});
const locationNames = computed<string[]>(() => validLocations.value.map(l => l.名称));

const showLocationModal = ref(false);
const locationEditIdx = ref(-1);
const locationForm = ref<LocationFormData>({
  名称: '', 描述: '', 类型: '', 上级: '', 连接: [], NPC: [],
});

const showDeleteConfirm = ref(false);
const deleteImpact = ref<LocationDeleteImpact | null>(null);
const deleteIdx = ref(-1);

const contextMenu = ref<{ x: number; y: number; name: string } | null>(null);

function openCreateLocation(): void {
  locationEditIdx.value = -1;
  const currentDrillParent = focusStack.value.length > 0 ? focusStack.value[focusStack.value.length - 1] : '';
  locationForm.value = {
    名称: '', 描述: '', 类型: '', 上级: currentDrillParent, 连接: [], NPC: [],
  };
  showLocationModal.value = true;
}

function openCreateChild(parentName: string): void {
  locationEditIdx.value = -1;
  locationForm.value = {
    名称: '', 描述: '', 类型: '', 上级: parentName, 连接: [], NPC: [],
  };
  contextMenu.value = null;
  showLocationModal.value = true;
}

function openEditLocation(loc: LocationEntry): void {
  const rawLocs = locations.value ?? [];
  locationEditIdx.value = rawLocs.findIndex(l => l.名称 === loc.名称);
  locationForm.value = {
    名称: loc.名称,
    描述: loc.描述 ?? '',
    类型: loc.类型 ?? '',
    上级: loc.上级 ?? '',
    连接: Array.isArray(loc.连接) ? [...loc.连接] : [],
    NPC: Array.isArray(loc.NPC) ? [...loc.NPC] : [],
  };
  contextMenu.value = null;
  showLocationModal.value = true;
}

function saveLocation(): void {
  const result = locationEditIdx.value >= 0
    ? locEditor.update(locationEditIdx.value, locationForm.value)
    : locEditor.create(locationForm.value);
  if (result.ok) {
    showLocationModal.value = false;
    clearSelection();
  } else if (result.error) {
    eventBus.emit('ui:toast', {
      type: 'error', i18nKey: result.error.i18nKey, message: result.error.message, duration: 3000,
    });
  }
}

function requestDeleteLocation(loc: LocationEntry): void {
  const rawLocs = locations.value ?? [];
  const idx = rawLocs.findIndex(l => l.名称 === loc.名称);
  if (idx < 0) return;
  deleteIdx.value = idx;
  deleteImpact.value = locEditor.analyzeDeleteImpact(idx);
  contextMenu.value = null;
  showDeleteConfirm.value = true;
}

function confirmDeleteLocation(): void {
  if (deleteIdx.value < 0) return;
  const result = locEditor.delete(deleteIdx.value);
  if (result.ok) {
    clearSelection();
  } else if (result.error) {
    eventBus.emit('ui:toast', {
      type: 'error', i18nKey: result.error.i18nKey, message: result.error.message, duration: 3000,
    });
  }
  showDeleteConfirm.value = false;
  deleteIdx.value = -1;
  deleteImpact.value = null;
}

// Tag list helpers for the location edit modal
const addConnectionSelect = ref('');
function addConnection(): void {
  const v = addConnectionSelect.value;
  if (v && !locationForm.value.连接!.includes(v)) {
    locationForm.value.连接!.push(v);
  }
  addConnectionSelect.value = '';
}
function removeConnection(idx: number): void {
  locationForm.value.连接!.splice(idx, 1);
}

const addNpcSelect = ref('');
function addNpc(): void {
  const v = addNpcSelect.value;
  if (v && !locationForm.value.NPC!.includes(v)) {
    locationForm.value.NPC!.push(v);
  }
  addNpcSelect.value = '';
}
function removeNpc(idx: number): void {
  locationForm.value.NPC!.splice(idx, 1);
}

// Filtered options (exclude self and already-selected)
const availableParents = computed(() =>
  locationNames.value.filter(n => n !== locationForm.value.名称),
);
const availableConnections = computed(() =>
  locationNames.value.filter(n => n !== locationForm.value.名称 && !locationForm.value.连接!.includes(n)),
);
const availableNpcs = computed(() =>
  npcNames.value.filter(n => !locationForm.value.NPC!.includes(n)),
);

// AgaSelect option lists (preserve exact label logic from the original <option> markup)
const parentOptions = computed<SelectOption[]>(() => [
  // explicit selectable "no parent" entry (a placeholder isn't selectable, so an
  // existing child could never be demoted back to a root location without it)
  { label: t('map.edit.noParent'), value: '' },
  ...availableParents.value.map(p => ({ label: p, value: p })),
]);
const connectionOptions = computed<SelectOption[]>(() =>
  availableConnections.value.map(opt => ({ label: opt, value: opt })),
);
const npcOptions = computed<SelectOption[]>(() =>
  availableNpcs.value.map(opt => ({ label: opt, value: opt })),
);

function openContextMenu(name: string, renderedX: number, renderedY: number): void {
  contextMenu.value = { x: renderedX, y: renderedY, name };
}

function closeContextMenu(): void {
  contextMenu.value = null;
}

// ─── Short label ─────────────────────────────────────────────────

function shortLabel(name: string): string {
  const parts = name.split('·');
  return parts[parts.length - 1];
}

// ─── Build compound graph data ───────────────────────────────────

function buildGraphData() {
  const locs = validLocations.value;
  const explored = exploredSet.value;
  const currentLoc = playerLocation.value ?? '';
  const nameSet = new Set(locs.map((l) => l.名称));

  // Build parent→children map for tree ops
  const parentMap = new Map<string, string>();
  void buildChildrenMap(locs); // consumed after placeholders below
  for (const loc of locs) {
    if (loc.上级 && nameSet.has(loc.上级)) {
      parentMap.set(loc.名称, loc.上级);
    }
  }

  // Auto-create missing ancestor placeholders
  const placeholders: LocationEntry[] = [];
  for (const loc of locs) {
    if (!loc.上级) continue;
    if (!nameSet.has(loc.上级)) {
      // Create placeholder parent (and its ancestors if `·`-delimited)
      let parentName = loc.上级;
      while (parentName && !nameSet.has(parentName)) {
        const segments = parentName.split('·');
        const grandparent = segments.length > 1 ? segments.slice(0, -1).join('·') : undefined;
        placeholders.push({ 名称: parentName, 上级: grandparent });
        nameSet.add(parentName);
        if (grandparent) {
          parentMap.set(parentName, grandparent);
          parentName = grandparent;
        } else {
          break;
        }
      }
    }
  }

  // Re-link children whose parents were just created as placeholders
  for (const loc of locs) {
    if (loc.上级 && !parentMap.has(loc.名称) && nameSet.has(loc.上级)) {
      parentMap.set(loc.名称, loc.上级);
    }
  }

  const allLocs = [...locs, ...placeholders];
  allLocsWithPlaceholders.value = allLocs;
  // Rebuild children map with placeholders
  const fullChildrenMap = buildChildrenMap(allLocs);

  // 玩家位置匹配：精确匹配 → 前缀匹配（玩家可能在一个未单独建节点的子地点）
  const allNames = new Set(allLocs.map((l) => l.名称));
  let matchedPlayerLoc = allNames.has(currentLoc) ? currentLoc : '';
  if (!matchedPlayerLoc && currentLoc) {
    // 从长到短尝试 `·` 前缀匹配，找到最深的已存在祖先
    const segs = currentLoc.split('·');
    for (let i = segs.length - 1; i >= 1; i--) {
      const candidate = segs.slice(0, i).join('·');
      if (allNames.has(candidate)) { matchedPlayerLoc = candidate; break; }
    }
  }

  // 收集玩家位置的所有祖先（用于高亮容器链）
  const playerAncestors = new Set<string>();
  if (matchedPlayerLoc) {
    let cur = matchedPlayerLoc;
    while (parentMap.has(cur)) {
      cur = parentMap.get(cur)!;
      playerAncestors.add(cur);
    }
  }

  const nodes = allLocs.map((loc) => {
    const depth = getDepth(loc.名称, parentMap);
    const root = getRoot(loc.名称, parentMap);
    const color = getFamilyColor(root);
    const hasChildren = fullChildrenMap.has(loc.名称);
    const explState = getExplorationState(loc.名称, explored, fullChildrenMap);
    const isPlayer = loc.名称 === matchedPlayerLoc;
    const isPlayerAncestor = playerAncestors.has(loc.名称);
    const npcs = Array.isArray(loc.NPC) ? loc.NPC : [];

    return {
      data: {
        id: loc.名称,
        label: npcs.length > 0 ? `${shortLabel(loc.名称)} (${npcs.join('、')})` : shortLabel(loc.名称),
        parent: parentMap.get(loc.名称) || undefined,
        depth,
        familyColor: color,
        familyColorDark: darken(color, 160),
        hasChildren: hasChildren ? 'true' : 'false',
        isPlayer,
        isPlayerAncestor,
        npcCount: npcs.length,
        explState,
      },
    };
  });

  // 2026-04-15 fix v2：sibling-chain binding edges
  //
  // Bug 症状：翠湖宾馆 bounding box 横向跨越地图，吞进非自己的子节点。
  //
  // Root cause：图中无 edge → cose 把所有节点当独立粒子铺平 → 兄弟 parent 的
  //   children 穿插 → compound bounding box 被撑成横条。
  //
  // Fix v1（失败）：给每个 parent→child 加 edge。问题：cytoscape compound 里
  //   parent 位置由 children bounding box 决定，edge 又要把 child 拉向 parent
  //   → feedback loop → 布局塌陷为几个巨型 rect。
  //
  // Fix v2（本实现）：**sibling-chain 边** —— 只在同 parent 的 children 之间
  //   加边（c1→c2→...→cn），不跨越 compound 层级。cose 会把兄弟拉成一串紧挨，
  //   但位置仍由 children 独立决定，parent box 自然收紧。无 feedback loop。
  //
  //   注意：chain 用 (i, i+1) 线性串联而非 clique（n(n-1)/2 条边），避免 N 大
  //   时 edge 数爆炸 + 均衡度下降。
  const edges: Array<{ data: { id: string; source: string; target: string } }> = [];
  for (const [, siblings] of fullChildrenMap.entries()) {
    if (siblings.length < 2) continue;
    for (let i = 0; i < siblings.length - 1; i++) {
      const a = siblings[i];
      const b = siblings[i + 1];
      edges.push({
        data: { id: `sib_${a}__${b}`, source: a, target: b },
      });
    }
  }

  return { nodes, edges };
}

// ─── Layout config ──────────────────────────────────────────────

function getLayoutConfig(): cytoscape.LayoutOptions {
  return {
    name: 'fcose',
    animate: false,
    nodeDimensionsIncludeLabels: true,
    quality: 'proof',
    nodeSeparation: 60,
    idealEdgeLength: () => 50,
    nodeRepulsion: () => 6000,
    packComponents: true,
    tile: true,
    tilingPaddingVertical: 20,
    tilingPaddingHorizontal: 20,
    numIter: 2500,
  } as cytoscape.LayoutOptions;
}

// ─── Cytoscape lifecycle ─────────────────────────────────────────

function initCytoscape(): void {
  if (!cyContainer.value || !hasLocations.value) return;

  const { nodes, edges } = buildGraphData();

  cyInstance = cytoscape({
    container: cyContainer.value,
    elements: [
      ...nodes.map((n) => ({ group: 'nodes' as const, ...n })),
      ...edges.map((e) => ({ group: 'edges' as const, ...e })),
    ],
    style: [
      // ── Compound parent (container) ──
      {
        selector: 'node:parent',
        style: {
          shape: 'roundrectangle',
          'background-color': 'data(familyColorDark)',
          'background-opacity': 0.35,
          'border-width': 1.5,
          'border-color': 'data(familyColor)',
          'border-opacity': 0.25,
          // 2026-04-15：compound 内边距减半，让 children 更贴近边框，
          //   减少空白空间。文字 label 在顶部需要 ~12px 留白，所以不能 < 10。
          padding: '10px',
          label: 'data(label)',
          color: 'data(familyColor)',
          'font-size': '11px',
          'font-weight': 'bold',
          'text-valign': 'top',
          'text-halign': 'center',
          'text-margin-y': -4,
          'text-wrap': 'ellipsis',
          'text-max-width': '120px',
        },
      },
      // ── Leaf node (no children) ──
      {
        selector: 'node:childless',
        style: {
          shape: 'ellipse',
          'background-color': 'data(familyColorDark)',
          'background-opacity': 0.6,
          'border-width': 2,
          'border-color': 'data(familyColor)',
          'border-opacity': 0.5,
          width: 24,
          height: 24,
          label: 'data(label)',
          color: '#d4cfc5',
          'font-size': '9px',
          'text-valign': 'bottom',
          'text-margin-y': 4,
          'text-wrap': 'ellipsis',
          'text-max-width': '80px',
        },
      },
      // ── Current player location ──
      //
      // 2026-04-15 v5（用户定稿）：只有一圈会呼吸的红色外环
      //
      // 设计：
      // - background / border：**完全不改**，节点保持其探索状态的自然色（绿色等）
      // - outline：红色 solid 环，脉动 width + opacity 产生呼吸效果
      // - 不改 label 颜色（让节点整体视觉仍贴合地图风格）
      //
      // 静态基线保留一丝微弱的红环（width 1 / opacity 0.3）—— 即便动画还没
      // 启动或用户切 tab 回来，也能清楚识别"这是我"。
      {
        selector: 'node[?isPlayer]',
        style: {
          // 呼吸红环
          'outline-color': '#b05a4a',
          'outline-style': 'solid',
          'outline-offset': 1,
          'outline-width': 1,          // 静态基线；pulse 动画里会扩到 6
          'outline-opacity': 0.3,       // 静态基线；pulse 动画里会升到 0.95
        } as cytoscape.Css.Node,
      },
      // ── Player ancestor containers (red border, subtler than direct) ──
      {
        selector: 'node[?isPlayerAncestor]',
        style: {
          'border-color': '#b05a4a',
          'border-opacity': 0.5,
          'border-width': 2,
        },
      },
      // ── Explored ──
      {
        selector: 'node[explState="explored"]:not([?isPlayer])',
        style: {
          'border-color': '#7aab78',
          'border-opacity': 0.7,
        },
      },
      // ── Partial explored ──
      {
        selector: 'node[explState="partial"]:not([?isPlayer])',
        style: {
          'border-color': '#c9a84c',
          'border-opacity': 0.5,
          'border-style': 'dashed',
        },
      },
      // ── Unexplored ──
      {
        selector: 'node[explState="unexplored"]:not([?isPlayer])',
        style: {
          opacity: 0.45,
        },
      },
      // ── Selected node ──
      {
        selector: 'node:selected',
        style: {
          'border-color': '#c9a84c',
          'border-width': 3,
          'border-opacity': 1,
          opacity: 1,
        },
      },
      // ── Sibling-chain edges (invisible, 2026-04-15 fix v2) ──
      // 用来让 cose 把同 parent 的 children 拉在一起，用户看不到。
      //   - width: 0 + opacity: 0：完全隐藏
      //   - curve-style: haystack：最便宜的 edge style（无控制点 / 无 bezier 计算）
      //   - target-arrow-shape: none：无箭头
      // 不用 `events: 'no'` —— 那是 node 属性，edge 即使 opacity=0 也几乎不会被
      //   pointer 命中（因为 width=0，hit 区域是 0 像素）。
      {
        selector: 'edge',
        style: {
          width: 0,
          'line-opacity': 0,
          opacity: 0,
          'target-arrow-shape': 'none',
          'curve-style': 'haystack',
        },
      },
    ],
    layout: getLayoutConfig(),
    userZoomingEnabled: true,
    userPanningEnabled: true,
    boxSelectionEnabled: false,
    minZoom: 0.15,
    maxZoom: 6,
  });

  // ── 初始化后处理：clamp zoom + 启动 player 呼吸动画 ──
  //
  // 注意：cose layout 在 `cytoscape({})` 构造函数内就**同步跑完**了（我们设
  // `animate: false`），所以 `layoutstop` 事件早于本行的 handler 注册 —— 用
  // `cy.one('layoutstop', ...)` 永远监听不到（最初的实现 bug）。
  //
  // 解决：不依赖事件，直接在下一帧（rAF）调用 —— 此时 layout 肯定已完成，
  // DOM/canvas 已 ready，动画 API 能安全启动。rAF 优于 setTimeout(0) 因为
  // 它和浏览器绘制节奏对齐，启动动画不会掉第一帧。
  //
  // 2026-04-15 revert：移除 zoom clamp。与 fitView 保持一致 —— 都是纯 fit
  // 不 clamp。紧凑化的 cose 参数已保证 fit 后的 zoom 自然处于合理范围，
  // clamp 反而会在极端情况下产生不必要的视觉跳变。
  requestAnimationFrame(() => {
    if (!cyInstance) return;
    // 启动 player 呼吸光晕动画
    startPlayerPulse();
  });

  // ── Single click → select detail ──
  cyInstance.on('tap', 'node', (evt: EventObject) => {
    const node = evt.target as NodeSingular;
    selectByName(node.id());
  });

  // ── Click background → deselect ──
  cyInstance.on('tap', (evt: EventObject) => {
    if (evt.target === cyInstance) { clearSelection(); closeContextMenu(); }
  });

  // Story 2: Right-click context menu on nodes
  cyInstance.on('cxttap', 'node', (evt: EventObject) => {
    const node = evt.target as NodeSingular;
    const pos = node.renderedPosition();
    openContextMenu(node.id(), pos.x, pos.y);
  });

  // ── Double-click → drill into compound node ──
  cyInstance.on('dbltap', 'node', (evt: EventObject) => {
    const node = evt.target as NodeSingular;
    const descendants = node.descendants();
    if (descendants.empty()) return; // leaf node, no drill

    focusStack.value.push(node.id());
    cyInstance!.animate(
      { fit: { eles: node.union(descendants), padding: 40 } },
      { duration: 350, easing: 'ease-out-cubic' },
    );
  });

  // ── Double-click background → pop focus ──
  cyInstance.on('dbltap', (evt: EventObject) => {
    if (evt.target !== cyInstance) return;

    if (focusStack.value.length > 0) {
      focusStack.value.pop();
      const parentId = focusStack.value[focusStack.value.length - 1];
      if (parentId && cyInstance) {
        const parentNode = cyInstance.getElementById(parentId);
        if (parentNode.nonempty()) {
          cyInstance.animate(
            { fit: { eles: parentNode.union(parentNode.descendants()), padding: 40 } },
            { duration: 300, easing: 'ease-out-cubic' },
          );
          return;
        }
      }
      // Stack empty or parent not found → fit all
      cyInstance!.animate(
        { fit: { eles: cyInstance!.elements(), padding: 30 } },
        { duration: 300, easing: 'ease-out-cubic' },
      );
    }
  });

  // ── Drag-end overlap resolution (fcose only) ──
  let relayoutPending = false;
  cyInstance.on('free', 'node', (evt: EventObject) => {
    if (!cyInstance || relayoutPending) return;
    const dragged = evt.target as NodeSingular;
    const parentId = dragged.data('parent') ?? null;
    const bb = dragged.boundingBox();
    const siblings = cyInstance.nodes().filter((n) =>
      n.id() !== dragged.id() && (n.data('parent') ?? null) === parentId,
    );
    let overlaps = false;
    siblings.forEach((sib) => {
      const sbb = sib.boundingBox();
      if (bb.x1 < sbb.x2 && bb.x2 > sbb.x1 && bb.y1 < sbb.y2 && bb.y2 > sbb.y1) overlaps = true;
    });
    if (!overlaps) return;

    relayoutPending = true;
    const unfixed = new Set<string>();
    unfixed.add(dragged.id());
    dragged.descendants().forEach((d) => { unfixed.add(d.id()); });
    const fixed: Array<{ nodeId: string; position: { x: number; y: number } }> = [];
    cyInstance.nodes().forEach((n) => {
      if (n.isParent() || unfixed.has(n.id())) return;
      fixed.push({ nodeId: n.id(), position: { ...n.position() } });
    });
    const ly = cyInstance.layout({
      name: 'fcose',
      animate: true,
      animationDuration: 200,
      animationEasing: 'ease-out',
      quality: 'default',
      nodeDimensionsIncludeLabels: true,
      nodeSeparation: 60,
      idealEdgeLength: () => 50,
      nodeRepulsion: () => 6000,
      numIter: 300,
      fixedNodeConstraint: fixed,
    } as cytoscape.LayoutOptions);
    ly.on('layoutstop', () => { relayoutPending = false; });
    ly.run();
  });

  // ── Hover tooltip ──
  cyInstance.on('mouseover', 'node', (evt: EventObject) => {
    const node = evt.target as NodeSingular;
    showTooltip(node);
  });
  cyInstance.on('mouseout', 'node', () => {
    hideTooltip();
  });
}

// ─── Tooltip ─────────────────────────────────────────────────────

const tooltip = ref<{ x: number; y: number; name: string; desc: string; npcs: string[]; state: string } | null>(null);

function showTooltip(node: NodeSingular): void {
  if (!cyInstance) return;
  const pos = node.renderedPosition();
  const container = cyContainer.value;
  if (!container) return;

  const name = node.id();
  const loc = validLocations.value.find((l) => l.名称 === name);
  const stateMap: Record<string, string> = {
    explored: t('map.tooltip.explored'), partial: t('map.tooltip.partial'), unexplored: t('map.tooltip.unexplored'),
  };

  tooltip.value = {
    x: pos.x,
    y: pos.y - 20,
    name: shortLabel(name),
    desc: loc?.描述 ?? '',
    npcs: Array.isArray(loc?.NPC) ? loc!.NPC! : [],
    state: stateMap[node.data('explState') as string] ?? t('map.tooltip.unknown'),
  };
}

function hideTooltip(): void {
  tooltip.value = null;
}

// ─── Player location pulse animation (2026-04-15) ────────────────
//
// 呼吸光晕：让当前位置的红 overlay 在 [0.15, 0.55] 之间循环，同时 border-width
// 在 [3, 4.5] 脉动，视觉上像荧光呼吸灯。用 cytoscape 原生 node.animate()
// 链式回调实现（避免 setInterval + zombie timer）。
//
// 生命周期：
//   - startPlayerPulse() 在 layoutstop 后调用（initCytoscape 内）
//   - stopPlayerPulse() 在 destroyCytoscape 调用，把 cancelled=true 打断下一轮
//   - 每次启动前先 stop 避免多个循环叠加

let pulseCancelled = false;

function stopPlayerPulse(): void {
  pulseCancelled = true;
  // 直接停止当前节点的所有动画
  if (cyInstance) {
    cyInstance.nodes('[?isPlayer]').stop(true, true);
  }
}

function startPlayerPulse(): void {
  if (!cyInstance) return;
  pulseCancelled = false;

  // 呼吸视觉：只动外环（outline），向外扩 + 透明度起伏
  //   - 扩张（吸气）：outline-width 6 + opacity 0.95 → 清晰红环
  //   - 收缩（呼气）：outline-width 1 + opacity 0.3  → 几乎隐去，只剩微痕
  // 纯粹向外扩（outline 总绘制在 border 外），不吃节点本身。
  const doPulse = (expand: boolean): void => {
    if (pulseCancelled || !cyInstance) return;
    const playerNodes = cyInstance.nodes('[?isPlayer]');
    if (playerNodes.empty()) return;

    const targetStyle: Record<string, number> = expand
      ? { 'outline-width': 6, 'outline-opacity': 0.95 }
      : { 'outline-width': 1, 'outline-opacity': 0.3 };

    playerNodes.animate(
      { style: targetStyle as cytoscape.Css.Node },
      {
        // 1500ms × 2（吸气 + 呼气）= 3s 一圈，贴合自然呼吸节奏
        // （之前 900ms 偏快，像紧张/告警感）
        duration: 1500,
        easing: 'ease-in-out-sine',
        complete: () => doPulse(!expand),
      },
    );
  };
  doPulse(true);
}

// ─── Graph operations ────────────────────────────────────────────

function destroyCytoscape(): void {
  stopPlayerPulse();
  if (cyInstance) {
    cyInstance.destroy();
    cyInstance = null;
  }
}

function refreshGraph(): void {
  focusStack.value = [];
  destroyCytoscape();
  nextTick(() => initCytoscape());
}

function fitView(): void {
  // 2026-04-15 revert：移除 zoom clamp。用户要求"适应视图"单一职责 —— 保证能
  // 看到地图全貌即可。之前的 clamp(0.85) 会在 fit 完成后突然把 zoom 拉大，
  // 产生"缩小→放大"的视觉跳变。现在相信 cose 紧凑布局 + cytoscape.fit 的结果。
  focusStack.value = [];
  if (!cyInstance) return;
  cyInstance.animate(
    { fit: { eles: cyInstance.elements(), padding: 30 } },
    { duration: 300 },
  );
}

// ─── Style-only updates (no re-layout) ──────────────────────────

function updateNodeStyles(): void {
  if (!cyInstance) return;
  const currentLoc = playerLocation.value ?? '';
  const explored = exploredSet.value;
  const locs = validLocations.value;
  const childrenMap = buildChildrenMap(locs);

  // 同 buildGraphData 的匹配逻辑：精确 → 前缀祖先
  const allIds = new Set(locs.map((l) => l.名称));
  let matched = allIds.has(currentLoc) ? currentLoc : '';
  if (!matched && currentLoc) {
    const segs = currentLoc.split('·');
    for (let i = segs.length - 1; i >= 1; i--) {
      const c = segs.slice(0, i).join('·');
      if (allIds.has(c)) { matched = c; break; }
    }
  }

  // 收集祖先链
  const parentMap = new Map<string, string>();
  for (const loc of locs) {
    if (loc.上级 && allIds.has(loc.上级)) parentMap.set(loc.名称, loc.上级);
  }
  const ancestors = new Set<string>();
  if (matched) {
    let cur = matched;
    while (parentMap.has(cur)) { cur = parentMap.get(cur)!; ancestors.add(cur); }
  }

  cyInstance.nodes().forEach((node) => {
    const id = node.id();
    node.data('isPlayer', id === matched);
    node.data('isPlayerAncestor', ancestors.has(id));
    node.data('explState', getExplorationState(id, explored, childrenMap));
  });
}

// ─── Lifecycle ───────────────────────────────────────────────────

onMounted(() => {
  if (isLoaded.value) nextTick(() => initCytoscape());
});

onBeforeUnmount(() => destroyCytoscape());

watch(isLoaded, (loaded) => {
  if (loaded) nextTick(() => initCytoscape());
});

/**
 * 2026-04-13 fix（第二轮）：彻底可靠的刷新触发
 *
 * 第一轮改用 `watch(validLocations, ..., {deep: true})` 仍不 100% 可靠 ——
 * Vue 的 deep watch 对 computed 返回的 reactive 数组在某些边界下漏触发
 * （例如 cloneDeep 写入整个数组替换引用时，deep traverse 的 dep 重建时序
 * 与 Proxy set trap 之间偶有竞态）。
 *
 * 改为监听 **JSON 序列化后的字符串**：任一字段变更 → 字符串不同 → 一定触发。
 * validLocations 本身已经是 plain array（见上方 computed 的 toRaw+JSON clone），
 * 序列化开销可控。配合 Vue effect 调度器的 tick 去重，不会抖动。
 */
watch(
  () => JSON.stringify(validLocations.value),
  () => refreshGraph(),
);

/**
 * 玩家位置 + 探索记录的监听 —— 同理改为稳定序列化对比
 */
watch(
  () => `${playerLocation.value ?? ''}|${JSON.stringify(toRaw(explorationRecord.value) ?? [])}`,
  () => updateNodeStyles(),
);

/**
 * onActivated：用户通过路由再次进入地图面板时（KeepAlive 情况下不会 remount），
 * 强制重建图。这是一张兜底保险 —— 即使 watch 因任何原因未触发，切页面回来
 * 也必定看到最新数据。
 */
onActivated(() => {
  if (isLoaded.value) nextTick(() => refreshGraph());
});
</script>

<template>
  <div class="map-panel">
    <template v-if="isLoaded">
      <!-- Header -->
      <header class="panel-header">
        <h2 class="panel-title">{{ $t('map.title') }}</h2>
        <div class="header-actions">
          <button class="btn-secondary" @click="fitView">{{ $t('map.fitView') }}</button>
          <button class="btn-secondary" @click="refreshGraph">{{ $t('map.refresh') }}</button>
          <button class="btn-create-loc" @click="openCreateLocation">+ {{ $t('map.action.create') }}</button>
          <Tooltip :text="$t('map.helpBtn')" interactive>
            <button class="btn-help" :aria-label="$t('map.helpBtn')" @click="showHelp = true">?</button>
          </Tooltip>
        </div>
      </header>

      <!-- Map container -->
      <div class="map-container">
        <div v-if="!hasLocations" class="map-empty">
          <svg class="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
            <circle cx="12" cy="9" r="2.5" />
          </svg>
          <p class="empty-title">{{ $t('map.empty.title') }}</p>
          <p class="empty-hint">{{ $t('map.empty.hint') }}</p>
        </div>

        <div v-else ref="cyContainer" class="cy-viewport" />

        <!-- Tooltip (follows mouse, hover only) -->
        <div
          v-if="tooltip"
          class="map-tooltip"
          :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }"
        >
          <div class="tooltip-name">{{ tooltip.name }}</div>
          <span :class="['tooltip-state', `tooltip-state--${tooltip.state}`]">{{ tooltip.state }}</span>
          <p v-if="tooltip.desc" class="tooltip-desc">{{ tooltip.desc }}</p>
          <div v-if="tooltip.npcs.length" class="tooltip-npcs">
            <span v-for="n in tooltip.npcs" :key="n" class="tooltip-npc">{{ n }}</span>
          </div>
        </div>

        <!-- Legend -->
        <div v-if="hasLocations" class="map-legend" role="list" :aria-label="$t('map.legend.ariaLabel')">
          <div class="legend-item" role="listitem">
            <span class="legend-dot legend-dot--player" aria-hidden="true" />
            <span class="legend-label">{{ $t('map.legend.player') }}</span>
          </div>
          <div class="legend-item" role="listitem">
            <span class="legend-dot legend-dot--explored" aria-hidden="true" />
            <span class="legend-label">{{ $t('map.legend.explored') }}</span>
          </div>
          <div class="legend-item" role="listitem">
            <span class="legend-dot legend-dot--partial" aria-hidden="true" />
            <span class="legend-label">{{ $t('map.legend.partial') }}</span>
          </div>
          <div class="legend-item" role="listitem">
            <span class="legend-dot legend-dot--unknown" aria-hidden="true" />
            <span class="legend-label">{{ $t('map.legend.unexplored') }}</span>
          </div>
        </div>

        <!-- Drill breadcrumb -->
        <div v-if="focusStack.length" class="drill-breadcrumb">
          <button class="drill-back" @click="fitView">{{ $t('map.drill.all') }}</button>
          <span v-for="(id, i) in focusStack" :key="id" class="drill-seg">
            <span class="drill-sep">/</span>
            <button class="drill-link" @click="focusStack.splice(i + 1); navigateToChild(id)">
              {{ shortLabel(id) }}
            </button>
          </span>
        </div>

        <!-- Context menu (right-click on node) — inside .map-container for correct coordinate space -->
        <div v-if="contextMenu" class="ctx-menu" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }" @mouseleave="closeContextMenu" @keydown.escape="closeContextMenu" tabindex="-1">
          <button class="ctx-item" @click="openEditLocation(validLocations.find(l => l.名称 === contextMenu!.name)!)">✏ {{ $t('map.action.edit') }}</button>
          <button class="ctx-item" @click="requestDeleteLocation(validLocations.find(l => l.名称 === contextMenu!.name)!)">🗑 {{ $t('map.action.delete') }}</button>
          <button class="ctx-item" @click="openCreateChild(contextMenu.name)">+ {{ $t('map.action.createChild') }}</button>
        </div>
      </div>

      <!-- Location detail panel -->
      <Transition name="detail-slide">
        <div v-if="selectedEntry" class="location-detail" role="region" :aria-label="$t('map.detail.ariaLabel')">
          <div class="detail-header">
            <h3 class="detail-name">{{ selectedEntry.名称 }}</h3>
            <Tooltip :text="$t('map.detail.close')" interactive>
              <button class="btn-icon" :aria-label="$t('map.detail.close')" @click="clearSelection">✕</button>
            </Tooltip>
          </div>

          <div class="exploration-badge">
            <span v-if="exploredSet.has(selectedEntry.名称)" class="badge badge--explored">{{ $t('map.detail.explored') }}</span>
            <span v-else class="badge badge--unknown">{{ $t('map.detail.unexplored') }}</span>
            <span v-if="selectedEntry.名称 === playerLocation" class="badge badge--here">📍 {{ $t('map.detail.youAreHere') }}</span>
          </div>
          <div class="detail-crud-actions">
            <button class="btn-secondary btn-sm-loc" @click="openEditLocation(selectedEntry)">✏ {{ $t('map.action.edit') }}</button>
            <button class="btn-secondary btn-sm-loc" @click="openAdvancedEditor('世界.地点信息')">⚙ {{ $t('character.edit.advancedEdit') }}</button>
            <button class="btn-danger-loc btn-sm-loc" @click="requestDeleteLocation(selectedEntry)">{{ $t('map.action.delete') }}</button>
          </div>

          <p v-if="selectedEntry.描述" class="detail-desc">{{ selectedEntry.描述 }}</p>
          <p v-else class="detail-no-desc">{{ $t('map.detail.noDesc') }}</p>

          <div v-if="selectedEntry.类型" class="detail-row">
            <span class="detail-label">{{ $t('map.detail.type') }}</span>
            <span class="detail-value">{{ selectedEntry.类型 }}</span>
          </div>
          <div v-if="selectedEntry.上级" class="detail-row">
            <span class="detail-label">{{ $t('map.detail.parent') }}</span>
            <button class="detail-link" @click="navigateToChild(selectedEntry.上级!)">{{ selectedEntry.上级 }}</button>
          </div>
          <div v-if="selectedEntry.NPC?.length" class="detail-row">
            <span class="detail-label">{{ $t('map.detail.npc') }}</span>
            <div class="npc-tags">
              <span v-for="npc in selectedEntry.NPC" :key="npc" class="npc-tag">{{ npc }}</span>
            </div>
          </div>

          <!-- Child locations (navigable) -->
          <div v-if="selectedChildren.length" class="detail-row">
            <span class="detail-label">{{ $t('map.detail.children') }}</span>
            <div class="child-links">
              <button
                v-for="child in selectedChildren"
                :key="child.名称"
                class="child-link"
                @click="navigateToChild(child.名称)"
              >{{ shortLabel(child.名称) }}</button>
            </div>
          </div>

        </div>
      </Transition>
    </template>

    <div v-else class="empty-state"><p>{{ $t('map.notLoaded') }}</p></div>

    <!-- Context menu moved to inside .map-container for correct positioning -->

    <!-- Location edit/create modal -->
    <Modal v-model="showLocationModal" :title="locationEditIdx >= 0 ? $t('map.edit.title') : $t('map.edit.titleCreate')" width="480px">
      <div class="loc-edit-form">
        <div class="loc-form-group">
          <label class="loc-form-label">{{ $t('map.edit.label.name') }}</label>
          <input v-model="locationForm.名称" type="text" class="loc-form-input" :placeholder="$t('map.edit.placeholder.name')" />
        </div>
        <div class="loc-form-group">
          <label class="loc-form-label">{{ $t('map.edit.label.description') }}</label>
          <textarea v-model="locationForm.描述" class="loc-form-textarea" rows="3" :placeholder="$t('map.edit.placeholder.description')" />
        </div>
        <div class="loc-form-group">
          <label class="loc-form-label">{{ $t('map.edit.label.type') }}</label>
          <input v-model="locationForm.类型" type="text" class="loc-form-input" />
        </div>
        <div class="loc-form-group">
          <label class="loc-form-label">{{ $t('map.edit.label.parent') }}</label>
          <AgaSelect :modelValue="locationForm.上级 ?? ''" :options="parentOptions" @update:modelValue="v => locationForm.上级 = v" />
        </div>

        <div class="loc-form-group">
          <label class="loc-form-label">{{ $t('map.edit.label.connections') }}</label>
          <div class="tag-list-edit">
            <span v-for="(c, ci) in locationForm.连接" :key="ci" class="tag-chip">{{ c }} <button class="tag-x" @click="removeConnection(ci)">&times;</button></span>
          </div>
          <div class="tag-add-row">
            <AgaSelect
              :modelValue="addConnectionSelect"
              :options="connectionOptions"
              :placeholder="$t('map.edit.addConnection')"
              @update:modelValue="v => { addConnectionSelect = v; addConnection(); }"
            />
          </div>
          <span class="loc-form-hint">ⓘ {{ $t('map.edit.connectionHint') }}</span>
        </div>

        <div class="loc-form-group">
          <label class="loc-form-label">{{ $t('map.edit.label.npcs') }}</label>
          <div class="tag-list-edit">
            <span v-for="(n, ni) in locationForm.NPC" :key="ni" class="tag-chip">{{ n }} <button class="tag-x" @click="removeNpc(ni)">&times;</button></span>
          </div>
          <div class="tag-add-row">
            <AgaSelect
              :modelValue="addNpcSelect"
              :options="npcOptions"
              :placeholder="$t('map.edit.addNpc')"
              @update:modelValue="v => { addNpcSelect = v; addNpc(); }"
            />
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="showLocationModal = false">{{ $t('common.actions.cancel') }}</button>
        <button class="btn-primary" :disabled="!locationForm.名称?.trim()" @click="saveLocation">{{ $t('common.actions.save') }}</button>
      </template>
    </Modal>

    <!-- Delete confirmation modal -->
    <Modal v-model="showDeleteConfirm" :title="$t('map.delete.confirm')" width="400px">
      <div v-if="deleteImpact" class="delete-impact">
        <p style="margin-bottom: 8px; font-weight: 600">{{ deleteImpact.locationName }}</p>
        <ul v-if="deleteImpact.childLocations.length || deleteImpact.npcRefs.length || deleteImpact.connectionRefs.length" class="impact-list">
          <li v-if="deleteImpact.childLocations.length">{{ $t('map.delete.cascadeChildren') }}: <strong>{{ deleteImpact.childLocations.join(', ') }}</strong></li>
          <li v-if="deleteImpact.npcRefs.length">{{ $t('map.delete.cascadeNpcs') }}: <strong>{{ deleteImpact.npcRefs.join(', ') }}</strong></li>
          <li v-if="deleteImpact.connectionRefs.length">{{ $t('map.delete.cascadeConnections') }}: <strong>{{ deleteImpact.connectionRefs.join(', ') }}</strong></li>
        </ul>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="showDeleteConfirm = false; deleteIdx = -1; deleteImpact = null">{{ $t('common.actions.cancel') }}</button>
        <button class="btn-danger-loc" @click="confirmDeleteLocation">{{ $t('common.actions.delete') }}</button>
      </template>
    </Modal>

    <!-- Help modal -->
    <Modal v-model="showHelp" :title="$t('map.helpTitle')">
      <ul class="help-list" role="list">
        <li><span class="help-icon">🖱</span><span><strong>{{ $t('map.help.zoomWheel') }}</strong>：{{ $t('map.help.zoomDesc') }}</span></li>
        <li><span class="help-icon">🖱</span><span><strong>{{ $t('map.help.panDrag') }}</strong>：{{ $t('map.help.panDesc') }}</span></li>
        <li><span class="help-icon">🖱</span><span><strong>{{ $t('map.help.tapNode') }}</strong>：{{ $t('map.help.tapDesc') }}</span></li>
        <li><span class="help-icon">🖱</span><span><strong>{{ $t('map.help.dblRegion') }}</strong>：{{ $t('map.help.dblRegionDesc') }}</span></li>
        <li><span class="help-icon">🖱</span><span><strong>{{ $t('map.help.dblBg') }}</strong>：{{ $t('map.help.dblBgDesc') }}</span></li>
        <li><span class="help-icon">🔴</span><span><strong>{{ $t('map.help.redGlow') }}</strong>：{{ $t('map.help.redGlowDesc') }}</span></li>
        <li><span class="help-icon">🟢</span><span><strong>{{ $t('map.help.greenBorder') }}</strong>：{{ $t('map.help.greenBorderDesc') }}</span></li>
        <li><span class="help-icon">🟡</span><span><strong>{{ $t('map.help.yellowDash') }}</strong>：{{ $t('map.help.yellowDashDesc') }}</span></li>
        <li><span class="help-icon">🔲</span><span><strong>{{ $t('map.help.rectContainer') }}</strong>：{{ $t('map.help.rectContainerDesc') }}</span></li>
        <li><span class="help-icon">⚪</span><span><strong>{{ $t('map.help.circleNode') }}</strong>：{{ $t('map.help.circleNodeDesc') }}</span></li>
        <li><span class="help-icon">🎨</span><span><strong>{{ $t('map.help.colorFamily') }}</strong>：{{ $t('map.help.colorFamilyDesc') }}</span></li>
      </ul>
    </Modal>
  </div>
</template>

<style scoped>
.map-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px var(--sidebar-right-reserve, 40px) 16px var(--sidebar-left-reserve, 40px);
  gap: 10px;
  overflow: hidden;
  transition: padding-left var(--duration-open) var(--ease-droplet),
              padding-right var(--duration-open) var(--ease-droplet);
}

/* ── Header ── */
.panel-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
.panel-title { margin: 0; font-size: 1.1rem; font-weight: 700; color: var(--color-text); }
.header-actions { display: flex; gap: 6px; align-items: center; }

/* ── Map container ── */
.map-container {
  flex: 1; position: relative;
  border: 1px solid var(--color-border); border-radius: 10px;
  overflow: hidden; background: var(--color-bg); min-height: 200px;
}
.cy-viewport { width: 100%; height: 100%; position: absolute; inset: 0; }

/* ── Empty state ── */
.map-empty {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 0.75rem; color: var(--color-text-secondary); padding: 2rem; text-align: center;
}
.empty-icon { opacity: 0.3; }
.empty-title { font-size: 0.9rem; font-weight: 600; margin: 0; }
.empty-hint { font-size: 0.78rem; opacity: 0.7; margin: 0; line-height: 1.5; }

/* ── Tooltip ── */
.map-tooltip {
  position: absolute; transform: translate(-50%, -100%);
  padding: 8px 12px; border-radius: 8px;
  background: var(--glass-bg); border: none;
  backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
  pointer-events: none;
  z-index: 20; max-width: 220px;
  box-shadow: var(--glass-shadow), inset 0 0 10px color-mix(in oklch, var(--color-sage-400) 4%, transparent);
}
.tooltip-name { font-size: 0.82rem; font-weight: 600; color: var(--color-text-bone); }
.tooltip-state { font-size: 0.62rem; font-weight: 600; padding: 1px 6px; border-radius: 4px; margin-left: 4px; }
.tooltip-state--已探索 { background: color-mix(in oklch, var(--color-success) 15%, transparent); color: var(--color-success); }
.tooltip-state--部分探索 { background: color-mix(in oklch, var(--color-amber-400) 15%, transparent); color: var(--color-amber-300); }
.tooltip-state--未探索 { background: color-mix(in oklch, var(--color-text-bone) 6%, transparent); color: var(--color-text-muted); }
.tooltip-desc { margin: 4px 0 0; font-size: 0.72rem; color: color-mix(in oklch, var(--color-text-bone) 70%, transparent); line-height: 1.4; }
.tooltip-npcs { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px; }
.tooltip-npc { padding: 1px 6px; font-size: 0.62rem; background: color-mix(in oklch, var(--color-sage-400) 12%, transparent); color: var(--color-sage-300); border-radius: 4px; }

/* ── Legend ── */
.map-legend {
  position: absolute; bottom: 10px; left: 10px;
  display: flex; gap: 10px; padding: 5px 10px;
  background: color-mix(in oklch, var(--color-bg) 85%, transparent); border-radius: 7px;
  border: 1px solid var(--color-border); backdrop-filter: blur(4px);
}
.legend-item { display: flex; align-items: center; gap: 5px; }
.legend-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.legend-dot--player { background: var(--color-surface); border: 2px solid var(--color-danger); box-shadow: 0 0 6px var(--color-danger), 0 0 12px color-mix(in oklch, var(--color-danger) 30%, transparent); }
.legend-dot--explored { background: color-mix(in oklch, var(--color-success) 12%, var(--color-surface)); border: 2px solid var(--color-success); }
.legend-dot--partial { background: var(--color-surface-elevated); border: 2px dashed var(--color-amber-400); }
.legend-dot--unknown { background: var(--color-surface-elevated); opacity: 0.45; border: 1px solid var(--color-border); }
.legend-label { font-size: 0.68rem; color: var(--color-text-secondary); white-space: nowrap; }

/* ── Drill breadcrumb ── */
.drill-breadcrumb {
  position: absolute; top: 10px; left: 10px;
  display: flex; align-items: center; gap: 2px;
  padding: 4px 10px; border-radius: 6px;
  background: color-mix(in oklch, var(--color-bg) 85%, transparent); backdrop-filter: blur(4px);
  border: 1px solid var(--color-border);
  font-size: 0.72rem;
}
.drill-back, .drill-link {
  background: none; border: none; color: var(--color-sage-400);
  cursor: pointer; font-size: 0.72rem; padding: 0;
}
.drill-back:hover, .drill-link:hover { text-decoration: underline; }
.drill-sep { color: var(--color-text-secondary); opacity: 0.4; margin: 0 2px; }

/* ── Location detail ── */
.location-detail {
  flex-shrink: 0; padding: 12px 14px;
  background: color-mix(in oklch, var(--color-text-bone) 2%, transparent);
  border: 1px solid var(--color-border); border-radius: 10px;
  max-height: 240px; overflow-y: auto;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  box-shadow: var(--lumi-inset-highlight);
}
.location-detail::-webkit-scrollbar { width: 3px; }
.location-detail::-webkit-scrollbar-thumb { background: color-mix(in oklch, var(--color-text-umber) 35%, transparent); border-radius: 2px; }
.detail-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.detail-name { margin: 0; font-size: 0.95rem; font-weight: 700; color: var(--color-text); }
.exploration-badge { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.7rem; font-weight: 600; }
.badge--explored { background: color-mix(in oklch, var(--color-success) 12%, transparent); color: var(--color-success); border: 1px solid color-mix(in oklch, var(--color-success) 30%, transparent); }
.badge--unknown { background: color-mix(in oklch, var(--color-text-bone) 4%, transparent); color: var(--color-text-secondary); border: 1px solid var(--color-border); }
.badge--here { background: color-mix(in oklch, var(--color-danger) 12%, transparent); color: var(--color-danger-hover); border: 1px solid color-mix(in oklch, var(--color-danger) 30%, transparent); }
.detail-desc { font-size: 0.82rem; color: var(--color-text); opacity: 0.85; margin: 0 0 6px; line-height: 1.55; }
.detail-no-desc { font-size: 0.78rem; color: var(--color-text-secondary); opacity: 0.5; font-style: italic; margin: 0 0 6px; }
.detail-row { display: flex; align-items: flex-start; gap: 10px; padding: 3px 0; font-size: 0.8rem; }
.detail-label { color: var(--color-text-secondary); min-width: 36px; flex-shrink: 0; font-size: 0.72rem; }
.detail-value { color: var(--color-text); }
.detail-link {
  background: none; border: none; color: var(--color-sage-400);
  cursor: pointer; font-size: 0.8rem; padding: 0; text-decoration: none;
}
.detail-link:hover { text-decoration: underline; }
.npc-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.npc-tag { padding: 1px 7px; font-size: 0.7rem; font-weight: 500; color: var(--color-sage-300); background: color-mix(in oklch, var(--color-sage-400) 12%, transparent); border-radius: 10px; }
.child-links { display: flex; flex-wrap: wrap; gap: 4px; }
.child-link {
  padding: 2px 8px; font-size: 0.7rem; font-weight: 500;
  color: var(--color-sage-400); background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 15%, transparent); border-radius: 8px;
  cursor: pointer; transition: all 0.12s;
}
.child-link:hover { background: color-mix(in oklch, var(--color-sage-400) 18%, transparent); border-color: color-mix(in oklch, var(--color-sage-400) 30%, transparent); }

/* ── Buttons ── */
.btn-secondary { padding: 4px 10px; font-size: 0.76rem; font-weight: 500; color: var(--color-text-secondary); background: color-mix(in oklch, var(--color-text-bone) 3%, transparent); border: 1px solid var(--color-border); border-radius: 6px; cursor: pointer; transition: color 0.15s, border-color 0.15s; }
.btn-secondary:hover { color: var(--color-text-bone); border-color: var(--color-sage-600); }
.btn-help { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 50%; background: color-mix(in oklch, var(--color-sage-400) 10%, transparent); border: 1px solid color-mix(in oklch, var(--color-sage-400) 25%, transparent); color: var(--color-sage-300); font-size: 0.8rem; font-weight: 700; cursor: pointer; transition: background-color 0.15s; }
.btn-help:hover { background: color-mix(in oklch, var(--color-sage-400) 20%, transparent); }
.btn-icon { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; background: transparent; border: none; color: var(--color-text-secondary); border-radius: 4px; cursor: pointer; font-size: 0.8rem; }
.btn-icon:hover { color: var(--color-text); }

/* ── Help modal ── */
.help-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.75rem; }
.help-list li { display: flex; align-items: flex-start; gap: 0.75rem; font-size: 0.86rem; color: var(--color-text); line-height: 1.5; }
.help-icon { font-size: 1.1rem; flex-shrink: 0; width: 1.5rem; text-align: center; }

/* ── Transitions ── */
.detail-slide-enter-active { transition: all 0.2s ease; }
.detail-slide-leave-active { transition: all 0.15s ease; }
.detail-slide-enter-from, .detail-slide-leave-to { opacity: 0; transform: translateY(6px); }

.empty-state { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--color-text-secondary); font-size: 0.88rem; }

/* ── Story 2: CRUD buttons ── */
.btn-create-loc { padding: 4px 12px; font-size: 0.78rem; font-weight: 600; color: var(--color-sage-400); background: color-mix(in oklch, var(--color-sage-400) 10%, transparent); border: 1px solid color-mix(in oklch, var(--color-sage-400) 25%, transparent); border-radius: 6px; cursor: pointer; }
.btn-create-loc:hover { background: color-mix(in oklch, var(--color-sage-400) 18%, transparent); }
.detail-crud-actions { display: flex; gap: 6px; margin: 8px 0; }
.btn-sm-loc { padding: 4px 10px; font-size: 0.75rem; border-radius: 5px; cursor: pointer; }
.btn-danger-loc { padding: 4px 10px; font-size: 0.75rem; font-weight: 600; color: var(--color-danger); background: color-mix(in oklch, var(--color-danger) 10%, transparent); border: 1px solid color-mix(in oklch, var(--color-danger) 25%, transparent); border-radius: 5px; cursor: pointer; }

/* Context menu */
.ctx-menu { position: absolute; z-index: 100; background: var(--glass-bg, rgba(30,30,40,0.92)); backdrop-filter: var(--glass-blur, blur(16px)); border: 1px solid var(--color-border); border-radius: 8px; padding: 4px 0; box-shadow: 0 8px 24px rgba(0,0,0,0.4); min-width: 140px; }
.ctx-item { display: block; width: 100%; padding: 8px 14px; font-size: 0.8rem; color: var(--color-text); background: none; border: none; cursor: pointer; text-align: left; transition: background 0.12s; }
.ctx-item:hover { background: color-mix(in oklch, var(--color-sage-400) 12%, transparent); }

/* Location edit form */
.loc-edit-form { display: flex; flex-direction: column; gap: 12px; }
.loc-form-group { display: flex; flex-direction: column; gap: 4px; }
.loc-form-label { font-size: 0.75rem; font-weight: 500; color: var(--color-text-secondary); }
.loc-form-input { height: 34px; padding: 0 10px; font-size: 0.84rem; color: var(--color-text); background: var(--color-surface-input, rgba(255,255,255,0.04)); border: 1px solid var(--color-border); border-radius: 6px; outline: none; appearance: none; -webkit-appearance: none; }
.loc-form-textarea { padding: 8px 10px; font-size: 0.84rem; color: var(--color-text); background: var(--color-surface-input, rgba(255,255,255,0.04)); border: 1px solid var(--color-border); border-radius: 6px; outline: none; resize: vertical; }
.loc-form-hint { font-size: 0.72rem; color: var(--color-sage-400); font-style: italic; padding: 4px 8px; background: color-mix(in oklch, var(--color-sage-400) 6%, transparent); border-radius: 4px; }
.tag-list-edit { display: flex; flex-wrap: wrap; gap: 4px; min-height: 28px; }
.tag-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; font-size: 0.78rem; color: var(--color-text); background: color-mix(in oklch, var(--color-sage-400) 10%, transparent); border: 1px solid color-mix(in oklch, var(--color-sage-400) 20%, transparent); border-radius: 12px; }
.tag-x { background: none; border: none; color: var(--color-text-secondary); cursor: pointer; font-size: 0.9rem; line-height: 1; padding: 0 2px; }
.tag-x:hover { color: var(--color-danger); }
.tag-add-row { margin-top: 4px; }
.btn-primary { padding: 6px 16px; font-size: 0.82rem; font-weight: 600; color: var(--color-text-bone, #e0e0e6); background: var(--color-sage-400); border: none; border-radius: 6px; cursor: pointer; }
.btn-primary:hover { background: var(--color-sage-300); }
.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-advanced-map { padding: 4px 10px; font-size: 0.75rem; font-weight: 500; color: var(--color-text-secondary); background: rgba(255,255,255,0.04); border: 1px solid var(--color-border); border-radius: 5px; cursor: pointer; opacity: 0.5; transition: all 0.15s; }
.btn-advanced-map:hover { opacity: 1; color: var(--color-sage-400); border-color: var(--color-sage-600); }

/* Delete impact */
.delete-impact { font-size: 0.84rem; color: var(--color-text); }
.impact-list { list-style: disc; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }

@media (max-width: 767px) {
  .map-panel { padding-left: var(--space-sm); padding-right: var(--space-sm); transition: none; }
  .cy-viewport { touch-action: manipulation; }
  .ctx-menu { position: fixed; left: 50% !important; top: auto !important; bottom: 20px; transform: translateX(-50%); }

  /* Story 2: mobile touch targets */
  .btn-create-loc { min-height: 44px; }
  .btn-sm-loc { min-height: 44px; }
  .btn-danger-loc { min-height: 44px; }
  .btn-secondary { min-height: 44px; }
  .btn-primary { min-height: 44px; }
  .loc-form-input { height: 44px; }
  .loc-form-textarea { min-height: 44px; }
  .tag-x { min-width: 44px; min-height: 44px; display: flex; align-items: center; justify-content: center; }
  .ctx-item { min-height: 44px; }
  .loc-edit-form { gap: 16px; }
}

@media (hover: none) and (pointer: coarse) {
  .detail-link:active { background: rgba(163, 190, 140, 0.08); border-radius: 4px; }
  .child-link:active { background: color-mix(in oklch, var(--color-sage-400) 25%, transparent); }
}
</style>
