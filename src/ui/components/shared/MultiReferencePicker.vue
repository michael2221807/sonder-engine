<script setup lang="ts">
// App doc: docs/user-guide/pages/game-image.md §参考重绘（多图）
/**
 * 多图参考选择器（多图参考重绘 epic S3，2026-08-29）。
 *
 * 只在后端声明 `multiReference` 能力时渲染——目前仅豆包 Seedream（官方 `image`
 * 字段是 anyOf string|array，≤14 张）。NovelAI / Civitai 的图生图只吃单图，
 * 它们继续用原来的单张控件，不会看到这个组件（避免死控件）。
 *
 * 顺序即语义：豆包官方多图用法要求提示词里用「图1/图2」按下标指代，所以
 * 每张缩略图都带可见的序号角标，并且**必须**能改顺序。排序提供两条路径：
 * 桌面用 HTML5 拖拽，触屏用左右移动按钮——原生 drag 事件在移动端不触发，
 * 只做拖拽等于对手机用户关掉了这个功能。
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Tooltip from './Tooltip.vue';
import {
  downscaleReferenceDataUrl,
  estimateDataUrlBytes,
  isReferenceOversized,
} from '@/engine/image/reference-downscale';

/** 已选参考图（UI 层轻量结构；提交时由父组件映射成 ImageReferenceInput）。 */
export interface MultiReferenceItem {
  /** 列表内唯一键 */
  id: string;
  /** 缩略图与提交都用它 */
  dataUrl: string;
  /** 持久化后的资产 id（上传成功才有；没有则以 dataUrl 提交） */
  assetId?: string | null;
  /** 展示用名称（文件名 / 来源说明） */
  label: string;
}

/** 快捷来源：已有的头像 / 立绘 / 壁纸等，一键加入而不用重新上传。 */
export interface QuickSource {
  /** 回传给父组件的标识 */
  key: string;
  label: string;
}

const props = withDefaults(defineProps<{
  modelValue: MultiReferenceItem[];
  max: number;
  /**
   * 快捷来源按钮。原来只有一个布尔 `canAddAvatar`，结果主角入口有「头像」和
   * 「立绘」两个来源就塞不下，切到多图后端直接丢了这两个选项（review Minor
   * 2026-08-29 抓到的功能倒退）——所以泛化成列表。
   */
  quickSources?: QuickSource[];
  testid?: string;
}>(), { quickSources: () => [], testid: 'multi-ref' });

const emit = defineEmits<{
  'update:modelValue': [MultiReferenceItem[]];
  /** 请求父组件追加一个快捷来源（父组件掌握 NPC/场景/主角上下文） */
  'add-quick': [string];
  /** 用户选了文件，父组件负责校验大小 + 持久化后 push 进 modelValue */
  'add-files': [FileList];
}>();

const { t } = useI18n();

const full = computed(() => props.modelValue.length >= props.max);
const remaining = computed(() => Math.max(0, props.max - props.modelValue.length));

/**
 * 体积提示与「压缩」按钮（2026-09-02 多图超时修复，PO 决策：不静默压缩，
 * 由用户自选）。上游按输入图总像素量做内容审核——大图会把单次请求拖到
 * 三分钟以上（实测 2560×1440 ×3 = 216s）。这里把代价显性化：超标的图打
 * 角标，并给一个一键压缩的出口。
 */
const oversizedCount = computed(() =>
  props.modelValue.filter((it) => isReferenceOversized(it.dataUrl)).length);
const totalBytes = computed(() =>
  props.modelValue.reduce((sum, it) => sum + estimateDataUrlBytes(it.dataUrl), 0));
const totalMB = computed(() => (totalBytes.value / 1048576).toFixed(1));
const compressing = ref(false);

function isOversized(dataUrl: string): boolean {
  return isReferenceOversized(dataUrl);
}

/**
 * 压缩所有超标图（逐张 fail-soft：某张失败不影响其余，也不改动它）。
 *
 * 并发安全：压缩是异步的（14 张大图的 JPEG 重编码不是一瞬间），期间用户完全
 * 可能删图/加图/改顺序。所以**不能**把开工时的数组快照直接 commit 回去——那会
 * 把用户中途的改动静默回滚。改为按 id 建立「压缩结果表」，收工时对着**当时最新**
 * 的 modelValue 逐项贴用：已删的项自然落空，新加的项原样保留，顺序以用户的为准。
 */
async function compressOversized(): Promise<void> {
  if (compressing.value) return;
  compressing.value = true;
  try {
    const targets = props.modelValue.filter((it) => isReferenceOversized(it.dataUrl));
    const compressed = new Map<string, string>();
    await Promise.all(targets.map(async (it) => {
      const dataUrl = await downscaleReferenceDataUrl(it.dataUrl);
      if (dataUrl !== it.dataUrl) compressed.set(it.id, dataUrl);
    }));
    if (compressed.size === 0) return;
    // 关键：这里重新读 props.modelValue（而不是用开工时的快照）
    commit(props.modelValue.map((it) => {
      const dataUrl = compressed.get(it.id);
      // 压缩后与已存资产不再一致 → 丢掉 assetId，改以 dataUrl 提交，
      // 否则引擎会按 assetId 重新取回未压缩的原图，压缩就白做了。
      return dataUrl ? { ...it, dataUrl, assetId: null } : it;
    }));
  } finally {
    compressing.value = false;
  }
}

function commit(next: MultiReferenceItem[]): void {
  emit('update:modelValue', next);
}

function removeAt(i: number): void {
  const next = [...props.modelValue];
  next.splice(i, 1);
  commit(next);
}

/** 把 from 位置的项移到 to 位置（越界自动夹紧）。排序的唯一出口。 */
function move(from: number, to: number): void {
  const clamped = Math.max(0, Math.min(props.modelValue.length - 1, to));
  if (from === clamped) return;
  const next = [...props.modelValue];
  const [item] = next.splice(from, 1);
  next.splice(clamped, 0, item);
  commit(next);
}

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement;
  if (input.files?.length) emit('add-files', input.files);
  // 允许连续选同一个文件：不清空的话第二次 change 不触发
  input.value = '';
}

// ── 拖拽排序（桌面）──
let dragFrom = -1;
function onDragStart(i: number, e: DragEvent): void {
  dragFrom = i;
  // 不设 dataTransfer 的话 Firefox 不会启动拖拽
  e.dataTransfer?.setData('text/plain', String(i));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function onDrop(i: number): void {
  if (dragFrom >= 0) move(dragFrom, i);
  dragFrom = -1;
}
</script>

<template>
  <div class="mref" :data-testid="testid">
    <div class="mref-head">
      <span class="form-label">{{ t('image.multiRef.label') }}</span>
      <span class="mref-count" :data-testid="`${testid}-count`">
        {{ t('image.multiRef.count', { n: modelValue.length, max }) }}
      </span>
    </div>

    <ul v-if="modelValue.length > 0" class="mref-list">
      <li
        v-for="(item, i) in modelValue"
        :key="item.id"
        class="mref-item"
        draggable="true"
        :data-testid="`${testid}-item-${i}`"
        @dragstart="onDragStart(i, $event)"
        @dragover.prevent
        @drop.prevent="onDrop(i)"
      >
        <img :src="item.dataUrl" :alt="item.label" class="mref-thumb" />
        <span class="mref-badge" :data-testid="`${testid}-badge-${i}`">
          {{ t('image.multiRef.nth', { n: i + 1 }) }}
        </span>
        <!-- Tooltip 的 wrapper 是 position:relative，会抢走绝对定位角标的定位父级
             （2026-09-02 截图目检抓到：角标被挤到缩略图外）→ 由外层槽位负责定位，
             角标本身保持静态排布。 -->
        <div v-if="isOversized(item.dataUrl)" class="mref-warn-slot">
          <Tooltip :text="t('image.multiRef.oversizedTip')" fixed>
            <span class="mref-warn-badge" :data-testid="`${testid}-oversized-${i}`">
              {{ t('image.multiRef.oversizedMark') }}
            </span>
          </Tooltip>
        </div>
        <div class="mref-actions">
          <!-- 触屏没有原生 drag：移动按钮是手机上排序的唯一途径，不是可选装饰 -->
          <Tooltip :text="t('image.multiRef.moveEarlier')">
            <button
              type="button" class="mref-btn" :disabled="i === 0"
              :data-testid="`${testid}-up-${i}`" @click="move(i, i - 1)"
            >‹</button>
          </Tooltip>
          <Tooltip :text="t('image.multiRef.moveLater')">
            <button
              type="button" class="mref-btn" :disabled="i === modelValue.length - 1"
              :data-testid="`${testid}-down-${i}`" @click="move(i, i + 1)"
            >›</button>
          </Tooltip>
          <Tooltip :text="t('image.multiRef.remove')">
            <button
              type="button" class="mref-btn mref-btn--danger"
              :data-testid="`${testid}-remove-${i}`" @click="removeAt(i)"
            >×</button>
          </Tooltip>
        </div>
      </li>
    </ul>

    <div class="mref-add">
      <label class="mref-addbtn" :class="{ 'mref-addbtn--disabled': full }">
        {{ full ? t('image.multiRef.full', { max }) : t('image.multiRef.addUpload', { n: remaining }) }}
        <input
          type="file" accept="image/*" multiple style="display:none"
          :disabled="full" :data-testid="`${testid}-file`" @change="onFileChange"
        />
      </label>
      <button
        v-for="q in quickSources" :key="q.key" type="button" class="mref-addbtn"
        :disabled="full" :data-testid="`${testid}-quick-${q.key}`" @click="emit('add-quick', q.key)"
      >
        ＋ {{ q.label }}
      </button>
    </div>

    <!-- 体积代价显性化：超标才出现，不打扰正常用图的人 -->
    <div v-if="oversizedCount > 0" class="mref-size" :data-testid="`${testid}-oversize-bar`">
      <span class="form-hint">
        {{ t('image.multiRef.oversizedNotice', { n: oversizedCount, mb: totalMB }) }}
      </span>
      <button
        type="button" class="mref-addbtn" :disabled="compressing"
        :data-testid="`${testid}-compress`" @click="compressOversized"
      >
        {{ compressing ? t('image.multiRef.compressing') : t('image.multiRef.compress') }}
      </button>
    </div>

    <p class="form-hint mref-hint">{{ t('image.multiRef.hint') }}</p>
  </div>
</template>

<style scoped>
.mref { display: flex; flex-direction: column; gap: var(--space-xs); }
.mref-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-xs); }
.mref-count { font-size: 0.75rem; opacity: 0.65; }

.mref-list {
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-wrap: wrap; gap: var(--space-xs);
}
.mref-item {
  position: relative; width: 84px;
  border-radius: var(--radius-sm, 6px);
  overflow: hidden;
  cursor: grab;
  background: var(--glass-bg);
  backdrop-filter: blur(6px);
  transition: transform 160ms ease, box-shadow 160ms ease;
}
.mref-item:active { cursor: grabbing; }
.mref-item:hover { transform: translateY(-2px); box-shadow: var(--glass-shadow); }

.mref-thumb { display: block; width: 84px; height: 84px; object-fit: cover; }

.mref-badge {
  position: absolute; top: 4px; left: 4px;
  padding: 1px 6px; border-radius: 999px;
  font-size: 0.68rem; font-variant-numeric: tabular-nums;
  background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(4px);
  color: #fff; pointer-events: none;
}

.mref-warn-slot { position: absolute; top: 4px; right: 4px; z-index: 1; }
.mref-warn-badge {
  display: inline-block;
  padding: 1px 6px; border-radius: 999px;
  font-size: 0.68rem; line-height: 1.5;
  background: rgba(251, 191, 36, 0.9); color: #1a1a1a;
  cursor: help;
}

.mref-size {
  display: flex; align-items: center; flex-wrap: wrap;
  gap: var(--space-xs);
}

.mref-actions {
  position: absolute; inset: auto 0 0 0;
  display: flex; justify-content: center; gap: 2px;
  padding: 2px 0;
  background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(4px);
}
.mref-btn {
  min-width: 22px; min-height: 22px;
  border: none; background: transparent; color: #fff;
  font-size: 0.85rem; line-height: 1; cursor: pointer;
  border-radius: 4px;
}
.mref-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.18); }
.mref-btn:disabled { opacity: 0.3; cursor: default; }
.mref-btn--danger:hover:not(:disabled) { background: rgba(248, 113, 113, 0.35); }

.mref-add { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
.mref-addbtn {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 32px; padding: 0 12px;
  font-size: 0.8rem; cursor: pointer;
  border: none; border-radius: var(--radius-sm, 6px);
  background: var(--glass-bg); backdrop-filter: blur(6px);
  color: inherit;
  transition: background 160ms ease;
}
.mref-addbtn:hover:not(.mref-addbtn--disabled):not(:disabled) { background: rgba(255, 255, 255, 0.1); }
.mref-addbtn--disabled, .mref-addbtn:disabled { opacity: 0.45; cursor: default; }

.mref-hint { margin-top: 0; }

/* 触屏上没有 hover，按钮常驻可见即可；同时放大热区到 44px 触控标准 */
@media (hover: none) and (pointer: coarse) {
  .mref-btn { min-width: 32px; min-height: 32px; }
  .mref-item:hover { transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .mref-item, .mref-addbtn { transition: none; }
  .mref-item:hover { transform: none; }
}
</style>
