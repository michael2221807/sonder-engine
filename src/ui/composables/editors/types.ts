/**
 * Editor composable shared types — Story 2 UI inline editing foundation.
 *
 * All editor composables return EditorResult from mutation methods.
 * UI components inspect `ok` and display `error.i18nKey` via toast on failure.
 */

// ─── Result types ─────────────────────────────────────────────

export interface EditorResult<T = void> {
  ok: boolean;
  data?: T;
  error?: EditorError;
}

interface EditorError {
  code: EditorErrorCode;
  /** i18n key for the error message — Toast.vue resolves via $t() */
  i18nKey: string;
  /** Interpolation params for the i18n key */
  i18nParams?: Record<string, unknown>;
  /** Fallback English message when i18n key is not found */
  message: string;
}

// ─── Error codes ──────────────────────────────────────────────

type EditorErrorCode =
  // Generic
  | 'FIELD_REQUIRED'
  | 'FIELD_INVALID'
  | 'NAME_DUPLICATE'
  // NPC
  | 'NPC_NOT_FOUND'
  | 'NPC_NAME_CONFLICT'
  // Location
  | 'LOCATION_NOT_FOUND'
  | 'LOCATION_NAME_CONFLICT'
  | 'LOCATION_CIRCULAR_PARENT'
  // Inventory
  | 'ITEM_NOT_FOUND'
  | 'ITEM_QUANTITY_INVALID';

// ─── Domain data shapes (used by editor composables) ──────────

export interface LocationEntry {
  名称: string;
  描述?: string;
  上级?: string;
  NPC?: string[];
  类型?: string;
  连接?: string[];
  [key: string]: unknown;
}

export interface InventoryItem {
  名称: string;
  描述?: string;
  数量?: number;
  类型?: string;
  可装备?: boolean;
  已装备?: boolean;
  品质?: string;
  [key: string]: unknown;
}

export interface InventoryItemFormData {
  名称: string;
  类型?: string;
  数量?: number;
  品质?: string;
  描述?: string;
  可装备?: boolean;
  已装备?: boolean;
}

export interface CurrencyData {
  现金: number;
  铜: number;
  银: number;
  金: number;
}

export interface LocationFormData {
  名称: string;
  描述?: string;
  类型?: string;
  上级?: string;
  连接?: string[];
  NPC?: string[];
}

export interface LocationDeleteImpact {
  locationName: string;
  childLocations: string[];
  npcRefs: string[];
  connectionRefs: string[];
}

export interface NpcFormData extends Record<string, unknown> {
  名称: string;
}

export interface DeleteImpact {
  npcName: string;
  locationRefs: string[];
  hasEngramEntity: boolean;
}

export type NpcFlag = '关注' | '心跳锁定' | '是否在场' | '是否主要角色';

// ─── Toast helper ─────────────────────────────────────────────

import { eventBus } from '@/engine/core/event-bus';

export function emitEditorToast(
  type: 'success' | 'warning' | 'error',
  i18nKey: string,
  params?: Record<string, unknown>,
): void {
  eventBus.emit('ui:toast', {
    type,
    i18nKey,
    message: i18nKey,
    i18nParams: params,
    duration: 2000,
  });
}
