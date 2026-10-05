// App doc: docs/user-guide/pages/game-save.md §2.6
/**
 * GameCardImportService — Story 6: the single logic entry for .aga-card import.
 *
 * Mirror-inverse of GameCardExportService. Pure orchestration that returns
 * machine-readable CODES (never display strings — UI resolves them); never logs the
 * bundle (SC-9); never touches an existing save until the very last write step (OD-N).
 *
 * importCard is two stages:
 *   Stage 1 (P2) — decodeAndValidateCard (exported pure fn): decode envelope → checksum
 *     → shape → D6 pack binding → blank reject → pack-version drift → sparse-overlay merge.
 *   Stage 2 (P3–P5) — assembleAndPersist: protagonist + engram + payloads + activate +
 *     re-embed + opening + persist (OD-N write order). Wrapped in a try/catch that maps any
 *     throw to `write-failed` (the OD-N rollback boundary).
 *
 * Decoupling: the service depends only on engine stores (real types) + three thin callbacks
 * wired in main.ts — `activateSave` (Pinia engineState.loadGame), `hasEmbedder` (aiService
 * embedding-config probe), `runOpening` (EnhancedOpeningPipeline.executeImportOpening). No
 * Pinia / AIService / opening-pipeline import here.
 *
 * Design: docs/design/story-6-card-import-handover.md
 * Plan:   docs/plans/story-6-card-import-implementation.md (P2 §1 + P5 设计定案)
 */
import { set as _set } from 'lodash-es';
import type { GamePack } from '../types/game-pack';
import type { ProfileMeta } from '../types/persistence';
import type { StateManager } from '../core/state-manager';
import type { SaveManager } from '../persistence/save-manager';
import type { ProfileManager } from '../persistence/profile-manager';
import type { ImageAssetCache } from '../image/asset-cache';
import type { CustomPresetStore } from '../persistence/custom-preset-store';
import type { WorldBookStorage } from '../prompt/world-book-storage';
import type { ConfigStore } from '../core/config-system';
import type { PromptStorage } from '../prompt/prompt-storage';
import { getBootstrapGamePack } from '../bootstrap-pack';
import { gzipDecompress, sha256String } from '../sync/chunked-bundle-packer';
import { compareVersions } from '../persistence/migration-registry';
import { buildSchemaDefaultTree } from '../pipeline/state-defaults';
import { deepMergeOverlay } from '../core/state-merge';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { buildImportedEngramState } from '../memory/engram/engram-import';
import { buildDefaultProtagonistPolicy } from './card-export-paths';
import { validateEditableFields } from './protagonist-template';
import {
  namespaceImageEntries,
  rewriteAssetRefs,
  applyCustomPresets,
  applyWorldBooks,
  applyGlobalConfigOverlays,
  applyGlobalPromptOverrides,
  applyGlobalPromptEdits,
  applyGlobalSettings,
  applyAuthorGameplaySettings,
  recordImportedCard,
} from './card-import-payloads';
import {
  captureGlobalSettingsBackup,
  restoreGlobalSettingsBackup,
  type GlobalSettingsBackup,
} from './card-import-global-backup';
import {
  CARD_FORMAT_VERSION,
  isValidCardBundleShape,
  type GameCardBundle,
  type CardImageAssetEntry,
} from './game-card-bundle.types';
import type {
  ImportOptions,
  ImportResult,
  ImportErrorCode,
  PackVersionDrift,
} from './game-card-import.types';

/** Successful Stage-1 outcome — validated bundle + merged tree, ready for persistence. */
export interface ValidatedCard {
  ok: true;
  bundle: GameCardBundle;
  /** schema-default base deep-merged with the card's sparse stateTree overlay (arrays replace). */
  mergedTree: Record<string, unknown>;
  /** Installed pack (already null-guarded; needed by Stage 2). */
  pack: GamePack;
  /** Present only when card and installed pack versions differ. */
  packVersionDrift?: PackVersionDrift;
}

/** Stage-1 outcome: a validated card, or a failure code. */
export type DecodeOutcome =
  | { ok: false; code: ImportErrorCode; detail?: string }
  | ValidatedCard;

/**
 * Stage-2 dependencies (engine stores + main.ts-wired callbacks). All required EXCEPT
 * `runOpening` (absent → opening skipped, save still created with an empty opening).
 */
export interface ImportServiceDeps {
  stateManager: StateManager;
  saveManager: SaveManager;
  profileManager: ProfileManager;
  imageAssetCache: ImageAssetCache;
  customPresetStore: CustomPresetStore;
  worldBookStorage: WorldBookStorage;
  configStore: ConfigStore;
  promptStorage: PromptStorage;
  /** EngramManager.vectorizePending — re-embeds the imported engram (after activation). */
  engramManager: { vectorizePending(sm: StateManager): Promise<{ vectorized: number }> };
  /** True when an embedding API is configured (() => aiService.getConfigForUsage('embedding') !== undefined). */
  hasEmbedder: () => boolean;
  /** Activate the new save into the live game state (wired to engineState.loadGame — sets active ids + loads tree). */
  activateSave: (tree: Record<string, unknown>, packId: string, profileId: string, slotId: string) => void;
  /** Generate the opening (wired to EnhancedOpeningPipeline.executeImportOpening). Optional. */
  runOpening?: (args: {
    nsfwMode: boolean;
    onProgress?: (phase: string, progress: number) => void;
    abortSignal?: AbortSignal;
    /** D7: optional author hint from bundle.opening.firstRoundSetup — steers the opening style. */
    firstRoundSetup?: string;
  }) => Promise<{ success: boolean }>;
}

const NSFW_SETTINGS_KEY = 'aga_nsfw_settings';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Stage 1 — decode + validate + merge (pure; zero persistence). Exported for direct unit
 * testing. `pack` is the resolved installed Game Pack (or null → no-pack).
 */
export async function decodeAndValidateCard(
  blob: Blob,
  pack: GamePack | null,
): Promise<DecodeOutcome> {
  // DoS guards on an untrusted file: cap the COMPRESSED blob, and cap the DECOMPRESSED output so a
  // zip-bomb (small gzip → GBs of text) can't OOM the tab (security M-1 / impact-audit FIX#8).
  const MAX_CARD_BYTES = 64 * 1024 * 1024;
  const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
  if (blob.size > MAX_CARD_BYTES) {
    return { ok: false, code: 'bad-format', detail: 'card exceeds maximum size' };
  }

  // 1. Decompress + parse the envelope (U1). Any failure (incl. size-limit) → decode-failed.
  let envelopeText: string;
  try {
    envelopeText = await gzipDecompress(blob, MAX_DECOMPRESSED_BYTES);
  } catch {
    return { ok: false, code: 'decode-failed', detail: 'gzip decompress failed' };
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(envelopeText);
  } catch {
    return { ok: false, code: 'decode-failed', detail: 'envelope JSON parse failed' };
  }
  if (!isRecord(envelope)) {
    return { ok: false, code: 'bad-format', detail: 'envelope is not an object' };
  }

  // 2. Envelope format + version gate (U1).
  if (envelope['format'] !== 'aga-card') {
    return { ok: false, code: 'bad-format', detail: 'not an aga-card envelope' };
  }
  const fmtVersion = envelope['formatVersion'];
  if (!Number.isInteger(fmtVersion) || (fmtVersion as number) < 1 || (fmtVersion as number) > CARD_FORMAT_VERSION) {
    return { ok: false, code: 'bad-format', detail: `unsupported formatVersion: ${String(fmtVersion)}` };
  }

  // 3. Checksum over the INNER bundle — recomputed the SAME way the exporter computed it.
  // Round-trip is deterministic because BOTH ends run in the same V8 (the exporter builds the
  // bundle from in-memory native values, and integer-key reordering is identical on re-stringify).
  // A future non-V8 card generator would need a canonical serialization — out of scope today.
  const bundle = envelope['bundle'];
  const checksum = envelope['checksum'];
  if (!isRecord(bundle) || typeof checksum !== 'string') {
    return { ok: false, code: 'invalid-shape', detail: 'missing bundle or checksum' };
  }
  const recomputed = await sha256String(JSON.stringify(bundle));
  if (recomputed !== checksum) {
    return { ok: false, code: 'checksum-mismatch' };
  }

  // 4. Structural shape (U1). isValidCardBundleShape narrows to GameCardBundle.
  if (!isValidCardBundleShape(bundle)) {
    return { ok: false, code: 'invalid-shape', detail: 'bundle shape validation failed' };
  }

  // 5. D6 strict pack binding (U2). No pack loaded → no-pack; id mismatch → pack-mismatch.
  if (!pack) {
    return { ok: false, code: 'no-pack', detail: 'no Game Pack is loaded' };
  }
  if (bundle.cardMeta.packId !== pack.manifest.id) {
    // Truncate the attacker-controlled packId before embedding in the (loggable) detail.
    return {
      ok: false,
      code: 'pack-mismatch',
      detail: `card packId "${String(bundle.cardMeta.packId).slice(0, 64)}" != installed "${pack.manifest.id}"`,
    };
  }

  // 6. blank protagonist is unsupported this release (U12) — reject BEFORE any work (SC-UI-B).
  if (bundle.protagonist.mode === 'blank') {
    return { ok: false, code: 'blank-unsupported' };
  }

  // 7. Pack-version drift signal (U3/OD-I). Explicit three-way narrowing (no `Math.sign ... as`).
  const cardVersion = bundle.cardMeta.packVersion ?? '';
  const installedVersion = pack.manifest.version;
  const rawCmp = compareVersions(cardVersion, installedVersion);
  const cmp: -1 | 0 | 1 = rawCmp < 0 ? -1 : rawCmp > 0 ? 1 : 0;
  const packVersionDrift: PackVersionDrift | undefined =
    cmp === 0 ? undefined : { cardVersion, installedVersion, comparison: cmp };

  // 8. Sparse-overlay merge (U4): schema-default base + card stateTree (arrays replace).
  //    Guarded so this function stays TOTAL (always a code, never throws).
  let mergedTree: Record<string, unknown>;
  try {
    const base = buildSchemaDefaultTree(pack.stateSchema);
    mergedTree = deepMergeOverlay(base, bundle.stateTree);
  } catch {
    return { ok: false, code: 'invalid-shape', detail: 'state tree merge failed' };
  }

  return { ok: true, bundle, mergedTree, pack, packVersionDrift };
}

export class GameCardImportService {
  /**
   * @param getPack Resolver for the installed Game Pack (defaults to the bootstrap singleton).
   * @param deps   Stage-2 dependencies. Absent → Stage 2 fails with `write-failed` (Stage 1
   *               validation still works; used by the P2 validation-only tests).
   */
  constructor(
    private getPack: () => GamePack | null = getBootstrapGamePack,
    private deps?: ImportServiceDeps,
  ) {}

  /**
   * Snapshot of the global settings the LAST successful import overwrote, kept so the UI can offer
   * a one-click "undo global changes". Cleared after an undo, after a failed import (which
   * auto-restores), and overwritten by the next import. Only one import runs at a time (modal).
   */
  private lastGlobalBackup: GlobalSettingsBackup | null = null;

  /**
   * Revert the global settings the last successful import overwrote, back to their pre-import state
   * (configOverlays / promptOverrides / builtin overrides / whitelisted settings / NSFW flag). The
   * imported SAVE itself is untouched. Returns false if there is nothing to undo, OR if the restore
   * threw (the UI surfaces a retry); the backup handle is retained on failure so undo can be retried.
   *
   * NSFW note: undo reverts the GLOBAL `aga_nsfw_settings` flag, but the already-created save keeps
   * `系统.nsfwMode` in its tree (by design — undo restores globals, not the save). Re-loading that save
   * later will sync the reverted global flag back into the tree.
   */
  async undoGlobalChanges(): Promise<boolean> {
    if (!this.deps || !this.lastGlobalBackup) return false;
    const { failed } = await restoreGlobalSettingsBackup(this.deps, this.lastGlobalBackup);
    if (failed.length > 0) return false; // partial restore → keep the backup so the user can retry
    this.lastGlobalBackup = null;
    return true;
  }

  /**
   * Import a .aga-card blob into a brand-new save. Never mutates an existing save.
   * @returns ImportSuccess with the new save coordinates, or ImportFailure with a code.
   */
  async importCard(blob: Blob, options: ImportOptions): Promise<ImportResult> {
    const validated = await decodeAndValidateCard(blob, this.getPack());
    if (!validated.ok) {
      return { ok: false, code: validated.code, detail: validated.detail };
    }
    // Stage 2 — assemble + persist. The try/catch is the OD-N error boundary: any failure
    // surfaces as `write-failed` (assembleAndPersist rolls back partial profile/save first).
    try {
      return await this.assembleAndPersist(validated, options);
    } catch (err) {
      return {
        ok: false,
        code: 'write-failed',
        // Capped: a non-display diagnostic; never the bundle/secrets. Bounded so internal
        // error text (IDB messages, paths) can't bloat logs (security review H-2).
        detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown error',
      };
    }
  }

  // ─── Stage 2: assemble + persist (P3–P5) ───────────────────────

  private async assembleAndPersist(
    validated: ValidatedCard,
    options: ImportOptions,
  ): Promise<ImportResult> {
    if (!this.deps) {
      throw new Error('import dependencies not wired (construct GameCardImportService with ImportServiceDeps)');
    }
    const d = this.deps;
    const { bundle, mergedTree, pack, packVersionDrift } = validated;
    const packId = pack.manifest.id;
    const paths = DEFAULT_ENGINE_PATHS;
    const policy = buildDefaultProtagonistPolicy(paths);
    const characterRoot = policy.characterRoot;

    // profileId/slotId generated EARLY (IDB keys by string); profile METADATA created LAST
    // (OD-N: no visible half-baked profile until the final step).
    const profileId = `profile_${Date.now()}`;
    const slotId = 'auto';

    let profileCreated = false;
    // Captured BEFORE any global write (step 3) so a failed import auto-restores globals and a
    // successful import can offer a one-click undo (user request 2026-06-04).
    let globalBackup: GlobalSettingsBackup | null = null;

    try {
      // 1a. Protagonist. fixed: 角色 is authoritative as-is (CONTRACT-OD4, no re-derivation).
      //     template: apply ONLY the player's edits on allowed/gray paths (blacklist/unknown ignored).
      if (bundle.protagonist.mode === 'template' && options.protagonistEdits) {
        const declared = new Set(bundle.protagonist.editableFields ?? []);
        const editPaths = Object.keys(options.protagonistEdits);
        const { allowed, downgraded } = validateEditableFields(editPaths, policy);
        const applyable = new Set([...allowed, ...downgraded]);
        for (const p of editPaths) {
          if (!applyable.has(p)) continue;                       // policy reject / unknown → ignore
          if (declared.size > 0 && !declared.has(p)) continue;   // honor the card's declared editable set
          const abs = p.startsWith(characterRoot + '.') ? p : `${characterRoot}.${p}`;
          // Defense-in-depth vs prototype pollution: the whitelist already rejects these, but
          // guard the lodash _set call itself so a careless future policy entry can't pollute.
          if (/(^|[.[])(__proto__|constructor|prototype)([.\]]|$)/.test(abs)) continue;
          _set(mergedTree, abs, options.protagonistEdits[p]);
        }
      }

      // 1b. Engram block into the merged tree (P3). events:[] guard inside the builder.
      _set(mergedTree, paths.engramMemory, buildImportedEngramState(bundle.engram));

      // 1c. Images: namespace ids (entry.id + metadata.id) + rewrite refs in the tree (P4).
      //     Namespace = cardId (stable; the profile doesn't exist yet). Falls back to profileId.
      const namespace = bundle.cardMeta.cardId || profileId;
      let namespacedImages: CardImageAssetEntry[] = [];
      if (Array.isArray(bundle.imageAssets) && bundle.imageAssets.length > 0) {
        const { entries, idMap } = namespaceImageEntries(bundle.imageAssets, namespace);
        namespacedImages = entries;
        rewriteAssetRefs(mergedTree, idMap);
      }

      // 2. Save-scoped IDB writes (profileId known; orphan-safe before profile metadata exists).
      await applyCustomPresets(d.customPresetStore, packId, bundle.customPresets);
      await applyWorldBooks(d.worldBookStorage, profileId, bundle.worldBooks);
      if (namespacedImages.length > 0) await d.imageAssetCache.importEntries(namespacedImages);

      // Snapshot globals BEFORE any global write (reversibility, user request 2026-06-04): a failed
      // import restores them; a successful import can offer a one-click undo. apiTemplate is never
      // written, so it is not part of the snapshot.
      // This single snapshot is the true pre-import state: the only localStorage/IDB global writes are
      // settings (step 3), the NSFW gate (step 4) and authorGameplaySettings (step 6) — ALL after here;
      // activateSave (step 5) only READS localStorage (loadGame syncs it INTO the tree), never writes it.
      const opt = options.optInGlobals;
      globalBackup = await captureGlobalSettingsBackup(d, packId, opt, options.enableNsfw);

      // 3. Global opt-in payloads (only when ticked; default OFF). apiTemplate NEVER applied.
      if (opt.has('configOverlays')) await applyGlobalConfigOverlays(d.configStore, bundle.configOverlays);
      if (opt.has('promptOverrides')) await applyGlobalPromptOverrides(d.promptStorage, bundle.promptOverrides);
      if (opt.has('builtinPromptOverrides')) {
        const prompts = this.getPack()?.prompts;
        applyGlobalPromptEdits(packId, bundle, prompts ? new Set(Object.keys(prompts)) : undefined);
      }
      if (opt.has('settings')) applyGlobalSettings(bundle.settings);

      // 4. NSFW gate: write localStorage BEFORE activation (P0-2 — loadGame's
      //    syncNsfwFromLocalStorage is the ONLY path that carries nsfwMode into the tree).
      if (options.enableNsfw) {
        try {
          const raw = localStorage.getItem(NSFW_SETTINGS_KEY);
          const cur: Record<string, unknown> = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          localStorage.setItem(NSFW_SETTINGS_KEY, JSON.stringify({ ...cur, nsfwMode: true }));
        } catch {
          /* best-effort */
        }
      }

      // 5. Activate: load merged tree into the live StateManager + set active ids (Pinia loadGame).
      //    syncNsfwFromLocalStorage runs here → 系统.nsfwMode reflects step 4.
      d.activateSave(mergedTree, packId, profileId, slotId);

      // 6. authorGameplaySettings (OD-O/P1-j): re-apply AFTER activation so the author's gameplay
      //    settings win over the player's local prefs (which loadGame's sync just applied).
      if (opt.has('authorGameplaySettings')) {
        // Narrow gameplay subset only (P1-j) — NOT the full settings whitelist. nsfw excluded.
        applyAuthorGameplaySettings(bundle.settings);
      }

      // 7. Re-embed engram — ONLY if an embedder is configured (else pseudoEmbed would fake success).
      let retrievalDegraded = false;
      if (!d.hasEmbedder()) {
        retrievalDegraded = true; // no embedder → graph loads, retrieval degraded (never blocks)
      } else {
        try {
          await d.engramManager.vectorizePending(d.stateManager);
        } catch {
          retrievalDegraded = true; // embedding failure is non-fatal
        }
      }

      // 8. Opening (Phase E–F–G on the card-populated tree). Non-fatal: a failure leaves the
      //    narrative empty but the save is still created (first main-round will fill it).
      let openingDegraded = false;
      if (d.runOpening) {
        const nsfwMode = d.stateManager.get<boolean>('系统.nsfwMode') === true;
        try {
          await d.runOpening({
            nsfwMode,
            onProgress: options.onOpeningProgress,
            abortSignal: options.abortSignal,
            firstRoundSetup: bundle.opening?.firstRoundSetup,
          });
        } catch {
          // Surface this instead of swallowing it silently: the user would otherwise enter a
          // game with a blank narrative and no idea why (typically an unconfigured/failing LLM API).
          openingDegraded = true;
        }
      }

      // 9. Persist LAST (OD-N): profile metadata appears only now.
      const characterName = this.extractCharacterName(d.stateManager, paths.playerName, bundle.cardMeta.title);
      const profile: ProfileMeta = {
        profileId,
        createdAt: new Date().toISOString(),
        packId,
        characterName,
        slots: {},
        activeSlotId: slotId,
      };
      await d.profileManager.createProfile(profile);
      profileCreated = true;

      const snapshot = d.stateManager.toSnapshot();
      await d.saveManager.saveGame(profileId, slotId, snapshot as never, {
        characterName,
        packId,
        // OD-I/P1-b: stamp the CARD's packVersion (empty → '0' so an old card still migrates on load).
        packVersion: bundle.cardMeta.packVersion || '0',
      });
      await d.profileManager.setActiveProfile(profileId, slotId); // P1-a: persist active pointer

      // OD-L: record this card in the import ledger (only on confirmed success) so a future preview
      // can show the "already imported" note. Best-effort, non-persistent-to-save UX hint.
      recordImportedCard(bundle.cardMeta.cardId);

      // Keep the snapshot so the success screen can offer a one-click undo of the global overwrites.
      this.lastGlobalBackup = globalBackup.hasChanges ? globalBackup : null;

      return {
        ok: true,
        profileId,
        slotId,
        cardTitle: bundle.cardMeta.title,
        retrievalDegraded,
        openingDegraded,
        packVersionDrift,
        globalChangesApplied: globalBackup.hasChanges,
      };
    } catch (err) {
      // Rollback (OD-N): clean up any created profile/save. Image/vector orphans are harmless
      // (no profile references them → not shown; GC-able). Re-throw → importCard → write-failed.
      if (profileCreated) {
        try { await d.saveManager.deleteGame(profileId, slotId); } catch { /* ignore */ }
        try { await d.profileManager.deleteProfile(profileId); } catch { /* ignore */ }
      }
      // Restore any global settings this failed import overwrote — a failed import must NOT leave
      // the player's globals clobbered (user request 2026-06-04). Best-effort; no undo offered after.
      if (globalBackup?.hasChanges) {
        try { await restoreGlobalSettingsBackup(d, globalBackup); } catch { /* best-effort */ }
      }
      this.lastGlobalBackup = null;
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Read the protagonist name from the activated tree; fall back to the card title. */
  private extractCharacterName(sm: StateManager, playerNamePath: string, fallback: string): string {
    const name = sm.get<string>(playerNamePath);
    return typeof name === 'string' && name.trim() ? name.trim() : fallback;
  }
}
