<script setup lang="ts">
// App doc: docs/user-guide/pages/game-inventory.md
/**
 * InventoryPanel — 背包物品与货币展示。
 *
 * 三系统审计结论（2026-04-08）：
 * - 角色.背包.物品 ← Record<id, Item>（set 添加，delete 删除）——非数组
 * - 角色.背包.金钱 ← 容器对象，子键 .现金/.铜/.银/.金 各为 number——非单个数字
 * - 物品 quality 字段：{ quality: "普通|优良|稀有|史诗|传说|神话", grade: 0-10 }
 *
 * 原 P0 Bug（已修复）：
 * 1. items 类型错误为 InventoryItem[]，导致 Array.isArray 永远失败 → 背包永远空
 * 2. currency 类型错误为 number，读取容器对象 → 显示 0
 */
import { ref, computed, watch, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { set } from 'lodash-es';
import { useGameState } from '@/ui/composables/useGameState';
import { useActionQueueStore } from '@/engine/stores/engine-action-queue';
import { readPlotVectorControl, subscribePlotVectorControl } from '@/engine/plot-vector/feature-control';
import { projectSavedElements, savedElementId } from '@/features/plot-vector/saved-elements';
import { usePacedCardTiers } from '@/ui/composables/usePacedCardTiers';
import type { CardTier } from '@/features/plot-vector/rating';
import AgaSelect from '@/ui/components/shared/AgaSelect.vue';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { useInventoryEditor, changedItemFields } from '@/ui/composables/editors';
import { useRouter } from 'vue-router';
import Modal from '@/ui/components/shared/Modal.vue';
import { eventBus } from '@/engine/core/event-bus';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';

const { t } = useI18n();

const { isLoaded, useValue } = useGameState();
const invEditor = useInventoryEditor();
const router = useRouter();

function openAdvancedEditor(): void {
  router.push({ name: 'GameVariables', query: { path: '角色.背包', from: 'inventory' } });
}
const actionQueue = useActionQueueStore();

/** 品质子对象 */
interface ItemQuality {
  quality?: string;
  grade?: number;
}

/** 背包物品结构（Record 的值类型） */
interface InventoryItem {
  名称: string;
  描述?: string;
  数量?: number;
  类型?: string;
  可装备?: boolean;
  已装备?: boolean;
  品质?: ItemQuality | string;
  [key: string]: unknown;
}

/** 展示用：带 Record key 的物品 */
interface DisplayItem extends InventoryItem {
  _id: string;
}

// ─── State reads (correct types after audit) ───

/** Record<id, Item> — 不是数组 */
const items = useValue<Record<string, InventoryItem>>(DEFAULT_ENGINE_PATHS.inventoryItems);

/** 容器对象 { 现金: number, 铜: number, ... } — 不是单个 number */
const currencyMap = useValue<Record<string, number>>(DEFAULT_ENGINE_PATHS.inventoryCurrency);

// ─── Derived display items ───

/** 将 Record 展开为带 _id 的数组 */
const allItems = computed<DisplayItem[]>(() => {
  const raw = items.value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw).map(([id, item]) => ({ ...item, _id: id }));
});

// ─── Filtering & search ───

const searchQuery = ref('');
const filterType = ref('all');

const itemTypes = computed<string[]>(() => {
  const types = new Set<string>();
  for (const item of allItems.value) {
    if (item.类型) types.add(item.类型);
  }
  return Array.from(types).sort();
});

const filteredItems = computed<DisplayItem[]>(() => {
  let list = allItems.value;
  if (filterType.value !== 'all') {
    list = list.filter((i) => i.类型 === filterType.value);
  }
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.trim().toLowerCase();
    list = list.filter(
      (i) => i.名称.toLowerCase().includes(q) || (i.描述 ?? '').toLowerCase().includes(q),
    );
  }
  return list;
});

// ─── Currency display ───

const CURRENCY_ICONS: Record<string, string> = {
  现金: '💴',
  金: '🪙',
  银: '⚪',
  铜: '🟤',
};

const currencyEntries = computed<{ name: string; icon: string; amount: number }[]>(() => {
  const raw = currencyMap.value;
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw)
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .map(([name, amount]) => ({
      name,
      icon: CURRENCY_ICONS[name] ?? '💰',
      amount: amount as number,
    }));
});

// ─── Quality badge: an item's card decides its rarity (PO 2026-10-03) ───

/** The six rarity names, common to mythic: an item's own 品质 and its card's tier share one ladder and colour. */
const QUALITY_TIERS: Record<string, CardTier> = { 普通: 'common', 优良: 'uncommon', 稀有: 'rare', 史诗: 'epic', 传说: 'legendary', 神话: 'mythic' };

function getQualityLabel(item: InventoryItem): string | null {
  const q = item.品质;
  if (!q) return null;
  if (typeof q === 'string') return q;
  if (typeof q === 'object' && q.quality) return q.quality;
  return null;
}

const vectorOn = ref(readPlotVectorControl().enabled);
onUnmounted(subscribePlotVectorControl(() => { vectorOn.value = readPlotVectorControl().enabled; }));
const vectorState = useValue<unknown>(DEFAULT_ENGINE_PATHS.plotVector);
/**
 * While plot momentum is on, the tier of each item's card: the card's strength is the item's real strength, so the
 * backpack shows the same rarity the table does. The item's own 品质 stays in the save (it is part of what the card
 * was made from) and shows again whenever there is no card. Cards the runtime has not rated yet are worked out a
 * few at a time (usePacedCardTiers), so opening the backpack never waits on them.
 */
const cardTiers = usePacedCardTiers(() => (vectorOn.value && vectorState.value && items.value
  ? { entries: projectSavedElements(set({}, DEFAULT_ENGINE_PATHS.inventoryItems, items.value)).entries, vectorState: vectorState.value }
  : null));
const cardTierOf = (itemId: string): CardTier | undefined => cardTiers.value.get(savedElementId('item', itemId));

interface QualityShown { label: string; color: string; fromCard: boolean }
/** What an item's badge shows: its card's tier when it has one, else its own 品质. */
const qualities = computed(() => new Map<string, QualityShown | null>(allItems.value.map((item) => {
  const tier = cardTierOf(item._id);
  if (tier) return [item._id, { label: t(`mainGame.vectorTable.tier.${tier}`), color: `var(--tier-${tier})`, fromCard: true }];
  const own = getQualityLabel(item);
  const ownTier = own ? QUALITY_TIERS[own] : undefined;
  return [item._id, own ? { label: own, color: ownTier ? `var(--tier-${ownTier})` : 'var(--color-text-muted)', fromCard: false } : null];
})));

// ─── Item detail ───

const selectedItem = ref<DisplayItem | null>(null);

function selectItem(item: DisplayItem): void {
  selectedItem.value = selectedItem.value?._id === item._id ? null : item;
}

// ─── Actions → action queue ───

function generateActionId(): string {
  return `act_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function handleUse(item: DisplayItem): void {
  actionQueue.addAction({
    id: generateActionId(),
    type: 'use_item',
    description: t('inventory.toast.useDesc', { name: item.名称 }),
    data: { itemName: item.名称, itemId: item._id },
    createdAt: Date.now(),
  });
  eventBus.emit('ui:toast', { type: 'info', message: t('inventory.toast.useQueued', { name: item.名称 }), duration: 2000 });
}

function handleEquip(item: DisplayItem): void {
  const action = item.已装备 ? t('inventory.action.unequip') : t('inventory.action.equip');
  actionQueue.addAction({
    id: generateActionId(),
    type: item.已装备 ? 'unequip_item' : 'equip_item',
    description: t('inventory.toast.equipDesc', { action, name: item.名称 }),
    data: { itemName: item.名称, itemId: item._id },
    createdAt: Date.now(),
  });
  eventBus.emit('ui:toast', { type: 'info', message: t('inventory.toast.equipQueued', { action, name: item.名称 }), duration: 2000 });
}

function handleDrop(item: DisplayItem): void {
  actionQueue.addAction({
    id: generateActionId(),
    type: 'drop_item',
    description: t('inventory.toast.dropDesc', { name: item.名称 }),
    data: { itemName: item.名称, itemId: item._id },
    createdAt: Date.now(),
  });
  eventBus.emit('ui:toast', { type: 'warning', message: t('inventory.toast.dropQueued', { name: item.名称 }), duration: 2000 });
}

/** Icon character based on item type */
function itemTypeIcon(type: string | undefined): string {
  const icons: Record<string, string> = {
    武器: '⚔',
    防具: '🛡',
    消耗品: '🧪',
    材料: '📦',
    任务: '📜',
    饰品: '💍',
  };
  return icons[type ?? ''] ?? '🔹';
}

// ─── Story 2: Item CRUD ───

const ITEM_TYPES = ['武器', '防具', '消耗品', '材料', '任务', '饰品', '其他'] as const;
const QUALITY_OPTIONS = ['普通', '优良', '稀有', '史诗', '传说', '神话'] as const;

// AgaSelect option arrays — reproduce the exact original <option> label logic.
const TYPE_OPTION_KEY: Record<string, string> = { 武器: 'weapon', 防具: 'armor', 消耗品: 'consumable', 材料: 'material', 任务: 'quest', 饰品: 'accessory', 其他: 'other' };
const QUALITY_OPTION_KEY: Record<string, string> = { 普通: 'common', 优良: 'fine', 稀有: 'rare', 史诗: 'epic', 传说: 'legendary', 神话: 'mythic' };
const typeSelectOptions = computed(() => ITEM_TYPES.map((tp) => ({ value: tp, label: t(`inventory.edit.typeOption.${TYPE_OPTION_KEY[tp] ?? 'other'}`) })));
const qualitySelectOptions = computed(() => QUALITY_OPTIONS.map((q) => ({ value: q, label: t(`inventory.edit.qualityOption.${QUALITY_OPTION_KEY[q] ?? 'common'}`) })));
const filterSelectOptions = computed(() => [{ value: 'all', label: t('inventory.filter.all') }, ...itemTypes.value.map((tp) => ({ value: tp, label: tp }))]);

interface ItemEditForm {
  名称: string;
  类型: string;
  数量: number;
  品质: string;
  描述: string;
  可装备: boolean;
  已装备: boolean;
}

const showItemModal = ref(false);
const editingItemId = ref<string | null>(null);

watch(showItemModal, (open) => {
  if (!open) editingItemId.value = null;
});
const itemForm = ref<ItemEditForm>({
  名称: '', 类型: '其他', 数量: 1, 品质: '普通', 描述: '', 可装备: false, 已装备: false,
});
/** The form as it opened on an existing item: a save sends only what the player changed from it. */
let formOpenedWith: ItemEditForm | null = null;

function openCreateItem(): void {
  editingItemId.value = null;
  itemForm.value = { 名称: '', 类型: '其他', 数量: 1, 品质: '普通', 描述: '', 可装备: false, 已装备: false };
  showItemModal.value = true;
}

function openEditItem(item: DisplayItem, event: Event): void {
  event.stopPropagation();
  editingItemId.value = item._id;
  const qualityLabel = getQualityLabel(item);
  itemForm.value = {
    名称: item.名称,
    类型: item.类型 ?? '其他',
    数量: item.数量 ?? 1,
    品质: qualityLabel ?? '普通',
    描述: item.描述 ?? '',
    可装备: item.可装备 === true,
    已装备: item.已装备 === true,
  };
  formOpenedWith = { ...itemForm.value };
  showItemModal.value = true;
}

/** An item with a card shows its card's rarity in the form, read only: its own 品质 is kept as it is saved. */
const editingCardTier = computed(() => (editingItemId.value ? cardTierOf(editingItemId.value) : undefined));

function saveItem(): void {
  const form = { ...itemForm.value };
  // An edit writes only what the player changed: the item's other fields are what its card was made from, and a
  // field written for the first time (a default the form showed) would retire the card. Its 品质 cannot change
  // while it has a card (the form shows the card's rarity, read only).
  const result = editingItemId.value
    ? invEditor.update(editingItemId.value, changedItemFields(formOpenedWith ?? form, form))
    : invEditor.create(form);

  if (result.ok) {
    showItemModal.value = false;
  } else if (result.error) {
    eventBus.emit('ui:toast', {
      type: 'error',
      i18nKey: result.error.i18nKey,
      message: result.error.message,
      duration: 3000,
    });
  }
}

const showDeleteConfirm = ref(false);
const deleteTargetId = ref<string | null>(null);
const deleteTargetName = ref('');

function requestDeleteItem(item: DisplayItem, event: Event): void {
  event.stopPropagation();
  deleteTargetId.value = item._id;
  deleteTargetName.value = item.名称;
  showDeleteConfirm.value = true;
}

function confirmDeleteItem(): void {
  if (!deleteTargetId.value) return;
  const result = invEditor.delete(deleteTargetId.value);
  if (result.ok) {
    if (selectedItem.value?._id === deleteTargetId.value) {
      selectedItem.value = null;
    }
  } else if (result.error) {
    eventBus.emit('ui:toast', {
      type: 'error',
      i18nKey: result.error.i18nKey,
      message: result.error.message,
      duration: 3000,
    });
  }
  showDeleteConfirm.value = false;
  deleteTargetId.value = null;
  deleteTargetName.value = '';
}

// ─── Story 2: Currency edit ───

const showCurrencyModal = ref(false);
const currencyForm = ref({ 现金: 0, 铜: 0, 银: 0, 金: 0 });

function openCurrencyEdit(): void {
  const raw = currencyMap.value;
  currencyForm.value = {
    现金: raw?.['现金'] ?? 0,
    铜: raw?.['铜'] ?? 0,
    银: raw?.['银'] ?? 0,
    金: raw?.['金'] ?? 0,
  };
  showCurrencyModal.value = true;
}

function saveCurrency(): void {
  const result = invEditor.updateCurrency(currencyForm.value);
  if (result.ok) {
    showCurrencyModal.value = false;
  } else if (result.error) {
    eventBus.emit('ui:toast', {
      type: 'error',
      i18nKey: result.error.i18nKey,
      message: result.error.message,
      duration: 3000,
    });
  }
}
</script>

<template>
  <div class="inventory-panel">
    <template v-if="isLoaded">
      <!-- ─── Header with currency ─── -->
      <header class="panel-header">
        <div class="panel-header-left">
          <h2 class="panel-title">{{ t('inventory.title') }}</h2>
          <AgaButton variant="primary" size="sm" @click="openCreateItem">+ {{ t('inventory.action.create') }}</AgaButton>
          <AgaButton variant="secondary" size="sm" @click="openCurrencyEdit">{{ t('inventory.action.editCurrency') }}</AgaButton>
          <AgaButton variant="secondary" size="sm" @click="openAdvancedEditor">⚙ {{ t('character.edit.advancedEdit') }}</AgaButton>
        </div>
        <div class="currency-bar">
          <template v-if="currencyEntries.length > 0">
            <div
              v-for="c in currencyEntries"
              :key="c.name"
              class="currency-chip"
            >
              <span class="currency-icon">{{ c.icon }}</span>
              <span class="currency-name">{{ c.name }}</span>
              <span class="currency-amount">{{ c.amount }}</span>
            </div>
          </template>
          <span v-else class="currency-empty">{{ t('inventory.noCurrency') }}</span>
        </div>
      </header>

      <!-- ─── Search and filter bar ─── -->
      <div class="toolbar">
        <input
          v-model="searchQuery"
          type="text"
          class="search-field"
          :placeholder="t('inventory.search.placeholder')"
        />
        <AgaSelect
          v-model="filterType"
          class="filter-select-aga"
          :options="filterSelectOptions"
          :ariaLabel="t('inventory.edit.label.type')"
        />
      </div>

      <!-- ─── Item count ─── -->
      <div class="item-summary">
        <span class="item-count">{{ t('inventory.itemCount', { count: filteredItems.length }) }}</span>
        <span v-if="allItems.length !== filteredItems.length" class="filter-hint">
          {{ t('inventory.itemCountFiltered', { total: allItems.length }) }}
        </span>
      </div>

      <!-- ─── Item list ─── -->
      <div v-if="filteredItems.length" class="item-list">
        <div
          v-for="item in filteredItems"
          :key="item._id"
          :class="['item-card', { 'item-card--selected': selectedItem?._id === item._id, 'item-card--equipped': item.已装备 }]"
          @click="selectItem(item)"
        >
          <div class="item-icon">{{ itemTypeIcon(item.类型) }}</div>
          <div class="item-info">
            <div class="item-name-row">
              <span class="item-name">{{ item.名称 }}</span>
              <span v-if="item.已装备" class="equipped-badge">{{ t('inventory.badge.equipped') }}</span>
              <Tooltip v-if="qualities.get(item._id)?.fromCard" :text="t('inventory.quality.fromCard')" fixed>
                <span
                  class="quality-badge"
                  data-testid="inventory-quality"
                  data-from-card="true"
                  :style="{ color: qualities.get(item._id)!.color, borderColor: qualities.get(item._id)!.color }"
                >{{ qualities.get(item._id)!.label }}</span>
              </Tooltip>
              <span
                v-else-if="qualities.get(item._id)"
                class="quality-badge"
                data-testid="inventory-quality"
                :style="{ color: qualities.get(item._id)!.color, borderColor: qualities.get(item._id)!.color }"
              >{{ qualities.get(item._id)!.label }}</span>
            </div>
            <span v-if="item.描述" class="item-desc">{{ item.描述 }}</span>
            <div class="item-meta">
              <span v-if="item.类型" class="item-type">{{ item.类型 }}</span>
              <span v-if="item.数量 != null && item.数量 > 1" class="item-qty">×{{ item.数量 }}</span>
            </div>
          </div>

          <!-- Expanded actions on selection -->
          <Transition name="actions-slide">
            <div v-if="selectedItem?._id === item._id" class="item-actions" @click.stop>
              <button class="action-btn action-btn--use" @click="handleUse(item)">{{ t('inventory.action.use') }}</button>
              <button
                v-if="item.可装备"
                class="action-btn action-btn--equip"
                @click="handleEquip(item)"
              >
                {{ item.已装备 ? t('inventory.action.unequip') : t('inventory.action.equip') }}
              </button>
              <button class="action-btn action-btn--drop" @click="handleDrop(item)">{{ t('inventory.action.drop') }}</button>
              <span class="action-sep" />
              <button class="action-btn action-btn--edit" @click="openEditItem(item, $event)">{{ t('inventory.action.editItem') }}</button>
              <button class="action-btn action-btn--delete" @click="requestDeleteItem(item, $event)">{{ t('inventory.action.deleteItem') }}</button>
            </div>
          </Transition>
        </div>
      </div>

      <div v-else class="empty-state">
        <p>{{ searchQuery || filterType !== 'all' ? t('inventory.noMatch') : t('inventory.empty') }}</p>
      </div>
    </template>

    <div v-else class="empty-state">
      <p>{{ t('inventory.notLoaded') }}</p>
    </div>

    <!-- ─── Item Edit/Create Modal ─── -->
    <Modal v-model="showItemModal" :title="editingItemId ? t('inventory.edit.titleEdit') : t('inventory.edit.titleCreate')" width="440px">
      <div class="edit-form">
        <div class="form-group">
          <label class="form-label">{{ t('inventory.edit.label.name') }}</label>
          <input v-model="itemForm.名称" type="text" class="form-input" :placeholder="t('inventory.edit.placeholder.name')" />
        </div>
        <div class="form-row">
          <div class="form-group form-group--half">
            <label class="form-label">{{ t('inventory.edit.label.type') }}</label>
            <AgaSelect v-model="itemForm.类型" class="form-select-aga" :options="typeSelectOptions" :ariaLabel="t('inventory.edit.label.type')" />
          </div>
          <div class="form-group form-group--half">
            <label class="form-label">{{ t('inventory.edit.label.quality') }}</label>
            <div v-if="editingCardTier" class="quality-from-card" data-testid="inventory-quality-card">
              <span
                class="quality-badge"
                :style="{ color: `var(--tier-${editingCardTier})`, borderColor: `var(--tier-${editingCardTier})` }"
              >{{ t(`mainGame.vectorTable.tier.${editingCardTier}`) }}</span>
              <span class="quality-from-card__hint">{{ t('inventory.edit.qualityFromCard') }}</span>
            </div>
            <AgaSelect v-else v-model="itemForm.品质" class="form-select-aga" :options="qualitySelectOptions" :ariaLabel="t('inventory.edit.label.quality')" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('inventory.edit.label.quantity') }}</label>
          <input v-model.number="itemForm.数量" type="number" min="1" class="form-input" inputmode="numeric" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('inventory.edit.label.description') }}</label>
          <textarea v-model="itemForm.描述" class="form-textarea" rows="2" :placeholder="t('inventory.edit.placeholder.desc')" />
        </div>
        <div class="form-group form-group--row">
          <AgaToggle v-model="itemForm.可装备" :label="t('inventory.edit.label.equippable')" show-label />
          <AgaToggle v-if="itemForm.可装备" v-model="itemForm.已装备" :label="t('inventory.edit.label.equipped')" show-label />
        </div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="showItemModal = false">{{ t('common.actions.cancel') }}</button>
        <button class="btn-primary" :disabled="!itemForm.名称?.trim()" @click="saveItem">{{ t('common.actions.save') }}</button>
      </template>
    </Modal>

    <!-- ─── Currency Edit Modal ─── -->
    <Modal v-model="showCurrencyModal" :title="t('inventory.edit.titleCurrency')" width="360px">
      <div class="edit-form">
        <div class="form-group" v-for="key in (['现金', '铜', '银', '金'] as const)" :key="key">
          <label class="form-label">{{ CURRENCY_ICONS[key] }} {{ t(`inventory.currency.${({'现金':'cash','铜':'copper','银':'silver','金':'gold'})[key]}`) }}</label>
          <input v-model.number="currencyForm[key]" type="number" min="0" class="form-input" inputmode="numeric" />
        </div>
      </div>
      <template #footer>
        <button class="btn-secondary" @click="showCurrencyModal = false">{{ t('common.actions.cancel') }}</button>
        <button class="btn-primary" @click="saveCurrency">{{ t('common.actions.save') }}</button>
      </template>
    </Modal>

    <!-- ─── Delete Confirmation ─── -->
    <Modal v-model="showDeleteConfirm" :title="t('inventory.action.deleteItem')" width="380px">
      <p style="margin-bottom: 8px">{{ t('inventory.delete.confirm') }}</p>
      <p class="delete-item-name">{{ deleteTargetName }}</p>
      <p class="delete-warning">{{ t('inventory.delete.irreversible') }}</p>
      <template #footer>
        <button class="btn-secondary" @click="showDeleteConfirm = false">{{ t('common.actions.cancel') }}</button>
        <button class="btn-danger" @click="confirmDeleteItem">{{ t('common.actions.delete') }}</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.inventory-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px var(--sidebar-right-reserve, 40px) 20px var(--sidebar-left-reserve, 40px);
  height: 100%;
  overflow-y: auto;
  transition: padding-left var(--duration-open) var(--ease-droplet),
              padding-right var(--duration-open) var(--ease-droplet);
}

/* ── Header ── */
.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.panel-title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--color-text, #e0e0e6);
  flex-shrink: 0;
}

/* ── Currency bar ── */
.currency-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.currency-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px 3px 6px;
  background: color-mix(in oklch, var(--color-amber-400) 8%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-amber-400) 20%, transparent);
  border-radius: 20px;
  box-shadow: var(--lumi-inset-highlight);
}

.currency-icon {
  font-size: 0.9rem;
  line-height: 1;
}

.currency-name {
  font-size: 0.72rem;
  color: var(--color-text-secondary, #8888a0);
}

.currency-amount {
  font-size: 0.82rem;
  font-weight: 700;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-amber-400);
}

.currency-empty {
  font-size: 0.78rem;
  color: var(--color-text-secondary, #8888a0);
  opacity: 0.5;
}

/* ── Toolbar ── */
.toolbar {
  display: flex;
  gap: 8px;
}

.search-field {
  flex: 1;
  height: 36px;
  padding: 0 12px;
  font-size: 0.85rem;
  color: var(--color-text);
  background: var(--color-surface-input);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}
.search-field:focus-visible {
  border-color: var(--color-sage-400);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 14%, transparent);
}
.search-field::placeholder {
  color: var(--color-text-secondary);
  opacity: 0.6;
}

.filter-select-aga { min-width: 130px; }
.form-select-aga { width: 100%; }

/* ── Item summary ── */
.item-summary {
  font-size: 0.75rem;
  color: var(--color-text-secondary, #8888a0);
  display: flex;
  gap: 6px;
}

.filter-hint {
  opacity: 0.6;
}

/* ── Item list ── */
.item-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.item-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s ease;
  flex-wrap: wrap;
}
.item-card:hover {
  background: linear-gradient(135deg, color-mix(in oklch, var(--color-sage-400) 6%, transparent), color-mix(in oklch, var(--color-sage-400) 3%, transparent));
  border-color: color-mix(in oklch, var(--color-sage-400) 25%, transparent);
}
.item-card--selected {
  background: color-mix(in oklch, var(--color-sage-400) 6%, transparent);
  border-color: var(--color-sage-600);
  box-shadow: inset 0 0 10px color-mix(in oklch, var(--color-sage-400) 8%, transparent);
}
.item-card--equipped {
  box-shadow: inset 3px 0 0 var(--color-success);
}

.item-icon {
  font-size: 1.3rem;
  line-height: 1;
  flex-shrink: 0;
  margin-top: 2px;
}

.item-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.item-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.item-name {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--color-text, #e0e0e6);
}

.equipped-badge {
  font-size: 0.65rem;
  font-weight: 600;
  padding: 1px 6px;
  color: var(--color-success);
  background: color-mix(in oklch, var(--color-success) 10%, transparent);
  border-radius: 8px;
}

.quality-badge {
  font-size: 0.65rem;
  font-weight: 600;
  padding: 1px 6px;
  border: 1px solid currentColor;
  border-radius: 8px;
  opacity: 0.9;
  text-shadow: 0 0 4px currentColor;
}

/* An item with a card: its rarity is the card's, shown read only in the form (PO 2026-10-03). */
.quality-from-card {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
}
.quality-from-card .quality-badge {
  font-size: 0.75rem;
  padding: 2px 8px;
}
.quality-from-card__hint {
  font-size: 0.72rem;
  color: var(--color-text-muted);
}

.item-desc {
  font-size: 0.78rem;
  color: var(--color-text-secondary, #8888a0);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-meta {
  display: flex;
  gap: 8px;
  align-items: center;
}

.item-type {
  font-size: 0.7rem;
  color: var(--color-text-secondary, #8888a0);
  opacity: 0.7;
}

.item-qty {
  font-size: 0.75rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text-secondary, #8888a0);
}

/* ── Item actions ── */
.item-actions {
  display: flex;
  gap: 6px;
  width: 100%;
  padding-top: 8px;
  margin-top: 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.action-btn {
  padding: 4px 12px;
  font-size: 0.75rem;
  font-weight: 600;
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 6px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.04);
  color: var(--color-text-secondary, #8888a0);
  transition: all 0.15s ease;
}
.action-btn:hover {
  color: var(--color-text, #e0e0e6);
}

.action-btn--use:hover {
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  border-color: var(--color-sage-600);
  color: var(--color-sage-400);
}

.action-btn--equip:hover {
  background: color-mix(in oklch, var(--color-success) 10%, transparent);
  border-color: var(--color-success);
  color: var(--color-success);
}

.action-btn--drop:hover {
  background: color-mix(in oklch, var(--color-danger) 10%, transparent);
  border-color: var(--color-danger);
  color: var(--color-danger);
}

/* ── Transition ── */
.actions-slide-enter-active {
  transition: all 0.2s ease;
}
.actions-slide-leave-active {
  transition: all 0.15s ease;
}
.actions-slide-enter-from,
.actions-slide-leave-to {
  opacity: 0;
  max-height: 0;
  padding-top: 0;
}

/* ── Empty state ── */
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
.inventory-panel::-webkit-scrollbar {
  width: 5px;
}
.inventory-panel::-webkit-scrollbar-track {
  background: transparent;
}
.inventory-panel::-webkit-scrollbar-thumb {
  background: color-mix(in oklch, var(--color-text-umber) 35%, transparent);
  border-radius: 3px;
}

/* ── Story 2: Header buttons ── */
.panel-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.btn-advanced-inv { padding: 4px 10px; font-size: 0.75rem; font-weight: 500; color: var(--color-text-secondary); background: rgba(255,255,255,0.04); border: 1px solid var(--color-border); border-radius: 5px; cursor: pointer; opacity: 0.5; transition: all 0.15s; }
.btn-advanced-inv:hover { opacity: 1; color: var(--color-sage-400); border-color: var(--color-sage-600); }

/* ── Story 2: Action separator + edit/delete buttons ── */
.action-sep {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.08);
  margin: 0 2px;
}
.action-btn--edit:hover {
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  border-color: var(--color-sage-600);
  color: var(--color-sage-400);
}
.action-btn--delete:hover {
  background: color-mix(in oklch, var(--color-danger) 10%, transparent);
  border-color: var(--color-danger);
  color: var(--color-danger);
}

/* ── Story 2: Edit form (shared with modals) ── */
.edit-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.form-group--half { flex: 1; min-width: 0; }
.form-group--row { flex-direction: row; gap: 16px; align-items: center; }
.form-row { display: flex; gap: 10px; }
.form-label {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--color-text-secondary, #8888a0);
}
.form-input {
  height: 34px;
  padding: 0 10px;
  font-size: 0.84rem;
  color: var(--color-text, #e0e0e6);
  background: var(--color-surface-input, rgba(255,255,255,0.04));
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 6px;
  outline: none;
}
.form-input:focus { box-shadow: 0 0 0 2px color-mix(in oklch, var(--color-sage-400) 30%, transparent); }
.form-textarea {
  padding: 8px 10px;
  font-size: 0.84rem;
  color: var(--color-text, #e0e0e6);
  background: var(--color-surface-input, rgba(255,255,255,0.04));
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 6px;
  outline: none;
  resize: vertical;
}
.form-check-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.82rem;
  color: var(--color-text, #e0e0e6);
  cursor: pointer;
}
.btn-primary {
  padding: 6px 16px;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--color-text-bone, #e0e0e6);
  background: var(--color-sage-400);
  border: none;
  border-radius: var(--radius-md, 6px);
  cursor: pointer;
  transition: background 0.15s ease;
}
.btn-primary:hover { background: var(--color-sage-300); }
.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-secondary {
  padding: 6px 14px;
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--color-text-secondary, #8888a0);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: var(--radius-md, 6px);
  cursor: pointer;
}
.btn-danger {
  padding: 6px 14px;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--color-danger, #ef4444);
  background: color-mix(in oklch, var(--color-danger, #ef4444) 10%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-danger, #ef4444) 25%, transparent);
  border-radius: var(--radius-md, 6px);
  cursor: pointer;
}
.delete-item-name {
  font-weight: 600;
  color: var(--color-text, #e0e0e6);
  margin: 4px 0;
}
.delete-warning {
  font-size: 0.78rem;
  color: var(--color-text-secondary, #8888a0);
  font-style: italic;
}

@media (max-width: 767px) {
  .inventory-panel { padding-left: var(--space-md); padding-right: var(--space-md); transition: none; }
  .panel-header-left { flex-wrap: wrap; }
  .form-row { flex-direction: column; }
  /* Story 2: mobile touch targets */
  .panel-header-left :deep(.aga-btn) { min-height: 44px; }
  .btn-primary { min-height: 44px; }
  .btn-secondary { min-height: 44px; }
  .btn-danger { min-height: 44px; }
  .action-btn { min-height: 44px; }
  .form-input { height: 44px; }
  .form-textarea { min-height: 44px; }
  .search-input { height: 44px; }
}

@media (hover: none) and (pointer: coarse) {
  .action-btn--edit:active, .action-btn--delete:active { background: rgba(163, 190, 140, 0.08); }
}
</style>
