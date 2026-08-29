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
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Tooltip from './Tooltip.vue';

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
