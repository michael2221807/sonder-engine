// App doc: docs/user-guide/pages/game-save.md §2.6.4
/**
 * Card import — optional payload appliers (Story 6 P4, OD-D 9-payload matrix).
 *
 * Each function maps 1:1 to a row of the OD-D matrix (handover §5). They are split into:
 *   - SAVE-SCOPED (always applied): customPresets, imageAssets, worldBooks. These land in
 *     the new save / new profile and never touch the player's global state.
 *   - GLOBAL opt-in (applied ONLY when the player ticked the flag; default OFF; never
 *     silently overwrite): configOverlays, settings, promptOverrides, builtinPromptOverrides.
 *   - apiTemplate: NEVER applied (info-only row). It is surfaced in the UI ("fill your own
 *     key") but never written anywhere — zero secret/config mutation (SC-9).
 *
 * P4 delivers the appliers; P5 orchestrates the call ORDER (OD-N write order) and decides
 * which global appliers to call based on `ImportOptions.optInGlobals`.
 *
 * Engine-layer rule: no game-specific field paths. `rewriteAssetRefs` is a GENERIC deep
 * walk (not the hardcoded traversal in backup-service.collectAssetIdsFromTree) — it rewrites
 * any string leaf that matches a namespaced asset id, so it needs no Chinese field names.
 */
import { namespacedAssetId } from '../image/asset-cache';
import { normalizeImportedWorldBook } from './captured-settings-card';
import { SETTINGS_EXPORT_WHITELIST } from './settings-export-whitelist';
import type {
  CardImageAssetEntry,
  SafeSettingsExport,
  ConfigOverlayExport,
} from './game-card-bundle.types';
import type { WorldBookExportData, BuiltinPromptExportData } from '../prompt/world-book';
import type { CustomPresetStore, CustomPresetEntry } from '../persistence/custom-preset-store';
import type { WorldBookStorage } from '../prompt/world-book-storage';
import type { ConfigStore } from '../core/config-system';
import type { PromptStorage } from '../prompt/prompt-storage';

/** OD-L import ledger key (localStorage; a non-critical UX hint — never persisted into a save). */
export const IMPORTED_CARDS_LEDGER_KEY = 'aga_imported_card_ids';

/**
 * NSFW settings key — owned EXCLUSIVELY by the dedicated NSFW gate (P0-2). The generic
 * settings-import must NEVER write it, so opting into "import settings" can't silently flip
 * adult mode and bypass the explicit gate consent (OD-C).
 */
const NSFW_SETTINGS_KEY = 'aga_nsfw_settings';

/**
 * The settings keys `applyGlobalSettings` is allowed to write = the export whitelist MINUS the
 * NSFW key (a NAMED derived set, so the exclusion is structural + greppable, not a buried
 * string compare). `aga_nsfw_settings` deliberately STAYS in SETTINGS_EXPORT_WHITELIST (the
 * card must carry the author's NSFW hint for the import gate to read), but is excluded here
 * because the NSFW gate (P5/P0-2) is its sole writer. Regression-guarded by the
 * "applyGlobalSettings 绝不写 aga_nsfw_settings" test.
 */
const IMPORT_APPLY_SETTINGS_KEYS: readonly string[] = SETTINGS_EXPORT_WHITELIST.filter(
  (k) => k !== NSFW_SETTINGS_KEY,
);

// ─── Save-scoped: images (OD-K namespace + ref rewrite) ──────────

/**
 * Namespace a card's image assets so they cannot overwrite the player's existing assets
 * in the GLOBAL ImageAssetCache (which keys by `metadata.id`). Returns the namespaced
 * entries AND an `originalId → namespacedId` map for rewriting references in the state tree.
 *
 * P1-c trap: `ImageAssetCache.importEntries` re-keys via `entry.metadata.id` (it calls
 * `store(entry.metadata, blob)`), so BOTH `entry.id` AND `entry.metadata.id` must be namespaced.
 *
 * Pure — input entries are not mutated.
 */
export function namespaceImageEntries(
  entries: readonly CardImageAssetEntry[],
  namespace: string,
): { entries: CardImageAssetEntry[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const out: CardImageAssetEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e.id !== 'string' || !e.id) continue;
    const nsId = namespacedAssetId(namespace, e.id);
    idMap.set(e.id, nsId);
    const metadata =
      e.metadata !== null && typeof e.metadata === 'object'
        ? { ...e.metadata, id: nsId } // P1-c: importEntries keys on metadata.id
        : e.metadata;
    out.push({ ...e, id: nsId, metadata });
  }
  return { entries: out, idMap };
}

/**
 * Rewrite asset-id references inside the merged state tree from original → namespaced id.
 *
 * GENERIC deep walk: every string leaf whose value is a key in `idMap` is replaced. This
 * finds references at ANY path (player/NPC archives, generation history entries, scene
 * archive, …) without hardcoding game-specific field names. False positives are effectively
 * impossible — the only candidates are the card's own (unique) asset ids.
 *
 * Mutates `tree` IN PLACE (the import pipeline owns the freshly-merged tree; in-place avoids
 * a second deep clone of a potentially large tree).
 */
export function rewriteAssetRefs(tree: unknown, idMap: ReadonlyMap<string, string>): void {
  if (idMap.size === 0) return;
  walkAndRewrite(tree, idMap);
}

/** Dangerous keys never rewritten/recursed — structurally rules out prototype pollution. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function walkAndRewrite(node: unknown, idMap: ReadonlyMap<string, string>): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (typeof v === 'string') {
        const mapped = idMap.get(v);
        if (mapped !== undefined) node[i] = mapped;
      } else if (v && typeof v === 'object') {
        walkAndRewrite(v, idMap);
      }
    }
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (UNSAFE_KEYS.has(key)) continue; // never write/recurse into a prototype-polluting key
      const v = obj[key];
      if (typeof v === 'string') {
        const mapped = idMap.get(v);
        if (mapped !== undefined) obj[key] = mapped;
      } else if (v && typeof v === 'object') {
        walkAndRewrite(v, idMap);
      }
    }
  }
}

// ─── Save-scoped: presets + world books ──────────────────────────

/**
 * Append the card's custom presets (for the card's pack) WITHOUT wiping the player's presets
 * and PRESERVING the card's preset ids (so the card's 角色 references resolve — OD-J).
 * @returns number of presets actually added.
 */
export async function applyCustomPresets(
  store: CustomPresetStore,
  packId: string,
  customPresets: Record<string, Record<string, CustomPresetEntry[]>> | undefined,
): Promise<number> {
  if (!customPresets) return 0;
  const byType = customPresets[packId];
  if (!byType || typeof byType !== 'object') return 0;
  const added = await store.appendPreservingIds(packId, byType);
  return added.length;
}

/** Import the card's world books into the NEW profile (re-keyed to the new profileId). */
export async function applyWorldBooks(
  wb: WorldBookStorage,
  profileId: string,
  worldBooks: WorldBookExportData | undefined,
): Promise<number> {
  if (!worldBooks) return 0;
  // Defence in depth: a card built by an older or hand-edited exporter could still carry
  // `ownership: 'slot'` / `origin: 'system-captured'`. Profile IndexedDB has no notion of
  // slot ownership, so such a book would render under the wrong panel group AND be
  // budgeted as auto-captured content the recipient never captured.
  const normalized: WorldBookExportData = {
    ...worldBooks,
    books: worldBooks.books.map(normalizeImportedWorldBook),
  };
  return wb.importWorldBooks(profileId, normalized);
}

// ─── Global opt-in (default OFF; only when the player ticked) ─────

/**
 * Apply the card author's pack config overlays. GLOBAL opt-in: `ConfigStore.importAll` puts
 * with no clear, so it CAN overwrite the player's same-domain config — never call unless the
 * player explicitly opted in (handover §5; plan §4 critic correction).
 * @returns number of overlays written.
 */
export async function applyGlobalConfigOverlays(
  configStore: ConfigStore,
  overlays: ConfigOverlayExport[] | undefined,
): Promise<number> {
  if (!overlays || overlays.length === 0) return 0;
  // ConfigOverlayExport is structurally identical to ConfigStore's ConfigOverlay (same five
  // fields) — this cast mirrors the export side's inverse cast (game-card-export-service.ts:97).
  // If ConfigOverlay.domainId is ever narrowed from `string`, replace this with a mapping step.
  await configStore.importAll(overlays as unknown as Parameters<typeof configStore.importAll>[0]);
  return overlays.length;
}

/** Apply the card author's custom prompt overrides (global). Opt-in only. */
export async function applyGlobalPromptOverrides(
  promptStorage: PromptStorage,
  overrides: Array<{ key: string; value: unknown }> | undefined,
): Promise<number> {
  if (!overrides || overrides.length === 0) return 0;
  await promptStorage.importAll(overrides);
  return overrides.length;
}

/** Apply the card author's built-in prompt overrides (global, per pack). Opt-in only. */
export async function applyGlobalBuiltinOverrides(
  wb: WorldBookStorage,
  packId: string,
  builtin: BuiltinPromptExportData | undefined,
): Promise<number> {
  if (!builtin) return 0;
  return wb.importBuiltinOverrides(packId, builtin);
}

/**
 * Apply the card author's whitelisted localStorage settings (global). Opt-in only.
 *
 * Iterates `IMPORT_APPLY_SETTINGS_KEYS` (the export whitelist minus the NSFW key) — a CLOSED
 * SET, so a denylisted/secret key present in the bundle can never be written (SC-9), and the
 * NSFW key is structurally excluded.
 *
 * `null` values are SKIPPED (the player's existing value for that key is preserved, NOT
 * deleted). Only string values are written.
 * @returns number of settings keys written.
 */
export function applyGlobalSettings(settings: SafeSettingsExport | undefined): number {
  if (!settings) return 0;
  let applied = 0;
  for (const key of IMPORT_APPLY_SETTINGS_KEYS) {
    const val = settings[key];
    if (typeof val === 'string') {
      localStorage.setItem(key, val);
      applied++;
    }
  }
  return applied;
}

/**
 * The card author's GAMEPLAY settings subset (OD-O/P1-j) — a STRICT subset of the whitelist:
 * action options / chain-of-thought / world heartbeat / prose polish. NOT all settings (theme,
 * fonts, memory thresholds, etc. stay the player's). Excludes nsfw (the gate owns it). Applied
 * (opt-in) AFTER activation so the author's gameplay choices win over the player's local prefs.
 */
const AUTHOR_GAMEPLAY_SETTINGS_KEYS: readonly string[] = [
  'aga_action_options_settings', // 行动选项
  'aga_cot_settings',            // 思维链
  'aga_heartbeat_settings',      // 世界心跳
  'aga_body_polish_settings',    // 正文润色
];

/**
 * Re-apply ONLY the card author's gameplay settings subset (opt-in OD-O). Distinct from
 * `applyGlobalSettings` (which applies the full whitelist) — this is the narrow set P1-j defines.
 * @returns number of gameplay keys written.
 */
export function applyAuthorGameplaySettings(settings: SafeSettingsExport | undefined): number {
  if (!settings) return 0;
  let applied = 0;
  for (const key of AUTHOR_GAMEPLAY_SETTINGS_KEYS) {
    const val = settings[key];
    if (typeof val === 'string') {
      localStorage.setItem(key, val);
      applied++;
    }
  }
  return applied;
}

// ─── apiTemplate (info-only — intentionally NEVER applied) ───────
// The card's apiTemplate is surfaced in the import UI as an info row ("this card includes
// API config templates — set up your own key in API settings"). It is NEVER written to the
// player's API management: zero keys, zero silent config mutation, no checkbox (SC-9). There
// is intentionally NO applier function here.

// ─── OD-L import ledger (localStorage UX hint) ───────────────────

/** Read the list of previously-imported card ids (OD-L). Tolerant of missing/corrupt data. */
export function readImportedCardLedger(): string[] {
  try {
    const raw = localStorage.getItem(IMPORTED_CARDS_LEDGER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Record a successfully-imported card id (OD-L), de-duplicated. The preview (P6) reads the
 * ledger to show a "you already imported this — importing again creates another save" note.
 * Best-effort: a write failure is swallowed (the ledger is a non-critical UX hint).
 */
export function recordImportedCard(cardId: string): void {
  if (!cardId) return;
  const ledger = readImportedCardLedger();
  if (ledger.includes(cardId)) return;
  ledger.push(cardId);
  try {
    localStorage.setItem(IMPORTED_CARDS_LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    /* best-effort */
  }
}
