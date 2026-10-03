/**
 * useInventoryEditor — CRUD composable for inventory items and currency.
 *
 * Wraps: useGameState().setValue() on 角色.背包.物品 (Record) and 角色.背包.金钱
 * Why: Centralizes item create/update/delete with validation and toast feedback.
 *      Items are stored as Record<id, Item> (not array), so CRUD uses set/delete patterns.
 *
 * Story 2 — Phase 1 foundation.
 */
import { useGameState } from '@/ui/composables/useGameState';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import type {
  EditorResult,
  InventoryItem,
  InventoryItemFormData,
  CurrencyData,
} from './types';
import { emitEditorToast } from './types';

/** The form fields besides the name, which every save sends (it is required). */
const ITEM_FORM_FIELDS = ['类型', '数量', '品质', '描述', '可装备', '已装备'] as const satisfies readonly (keyof InventoryItemFormData)[];

/**
 * What an edit changed: the name, and each other field only when the player changed it from what the form showed
 * when it opened. A field the item never had is not written because the form showed a default for it: an item's
 * fields other than its name, description and count are what its plot-vector card was made from, so writing one
 * retires the card (PO 2026-10-03: a description fix must not change the item's rarity).
 */
export function changedItemFields(opened: InventoryItemFormData, now: InventoryItemFormData): InventoryItemFormData {
  const patch: InventoryItemFormData = { 名称: now.名称 };
  for (const key of ITEM_FORM_FIELDS) {
    if (now[key] !== opened[key]) Object.assign(patch, { [key]: now[key] });
  }
  return patch;
}

export interface UseInventoryEditorReturn {
  create(formData: InventoryItemFormData): EditorResult<{ id: string }>;
  update(itemId: string, formData: InventoryItemFormData): EditorResult;
  delete(itemId: string): EditorResult;
  updateCurrency(currency: CurrencyData): EditorResult;
}

export function useInventoryEditor(): UseInventoryEditorReturn {
  const { setValue, get } = useGameState();
  const P = DEFAULT_ENGINE_PATHS;

  function create(
    formData: InventoryItemFormData,
  ): EditorResult<{ id: string }> {
    if (!formData.名称?.trim()) {
      return {
        ok: false,
        error: {
          code: 'FIELD_REQUIRED',
          i18nKey: 'inventory.validate.nameRequired',
          message: 'Name required',
        },
      };
    }
    if (formData.数量 !== undefined && formData.数量 < 1) {
      return {
        ok: false,
        error: {
          code: 'ITEM_QUANTITY_INVALID',
          i18nKey: 'inventory.validate.quantityMin',
          message: 'Quantity must be >= 1',
        },
      };
    }

    const type = formData.类型 ?? '其他';
    const id = `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const item: InventoryItem = {
      ...formData,
      名称: formData.名称.trim(),
      数量: formData.数量 ?? 1,
    };

    setValue(`${P.inventoryItems}.${id}`, item);
    emitEditorToast('success', 'inventory.toast.created');
    return { ok: true, data: { id } };
  }

  function update(
    itemId: string,
    formData: InventoryItemFormData,
  ): EditorResult {
    const items = get<Record<string, InventoryItem>>(P.inventoryItems) ?? {};
    if (!items[itemId]) {
      return {
        ok: false,
        error: {
          code: 'ITEM_NOT_FOUND',
          i18nKey: 'inventory.validate.notFound',
          message: 'Item not found',
        },
      };
    }
    if (formData.数量 !== undefined && formData.数量 < 1) {
      return {
        ok: false,
        error: {
          code: 'ITEM_QUANTITY_INVALID',
          i18nKey: 'inventory.validate.quantityMin',
          message: 'Quantity must be >= 1',
        },
      };
    }
    if (!formData.名称?.trim()) {
      return {
        ok: false,
        error: {
          code: 'FIELD_REQUIRED',
          i18nKey: 'inventory.validate.nameRequired',
          message: 'Name required',
        },
      };
    }

    const safeForm = { ...formData };
    if (safeForm.可装备 === false) safeForm.已装备 = false;

    const merged: InventoryItem = {
      ...items[itemId],
      ...safeForm,
      名称: formData.名称.trim(),
    };
    setValue(`${P.inventoryItems}.${itemId}`, merged);
    emitEditorToast('success', 'inventory.toast.updated');
    return { ok: true };
  }

  function delete_(itemId: string): EditorResult {
    const items = get<Record<string, InventoryItem>>(P.inventoryItems) ?? {};
    if (!items[itemId]) {
      return {
        ok: false,
        error: {
          code: 'ITEM_NOT_FOUND',
          i18nKey: 'inventory.validate.notFound',
          message: 'Item not found',
        },
      };
    }

    const updated = { ...items };
    delete updated[itemId];
    setValue(P.inventoryItems, updated);
    emitEditorToast('success', 'inventory.toast.deleted');
    return { ok: true };
  }

  function updateCurrency(currency: CurrencyData): EditorResult {
    for (const [key, val] of Object.entries(currency)) {
      if (val < 0) {
        return {
          ok: false,
          error: {
            code: 'FIELD_INVALID',
            i18nKey: 'inventory.validate.currencyNonNegative',
            message: `${key} must be >= 0`,
          },
        };
      }
    }
    setValue(P.inventoryCurrency, currency);
    emitEditorToast('success', 'inventory.toast.currencyUpdated');
    return { ok: true };
  }

  return {
    create,
    update,
    delete: delete_,
    updateCurrency,
  };
}
