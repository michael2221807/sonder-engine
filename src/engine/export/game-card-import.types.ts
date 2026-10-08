/**
 * Game Card (.aga-card) IMPORT contract — Story 6.
 *
 * Mirror of the export side (`game-card-export-service.ts` / `game-card-bundle.types.ts`).
 * The import service is pure orchestration: it returns machine-readable CODES, never
 * human-facing display strings — the UI layer resolves codes to i18n text. This keeps
 * `src/engine/` free of locale strings (engine i18n constraint).
 *
 * Design: docs/design/story-6-card-import-handover.md
 * Plan:   docs/plans/story-6-card-import-implementation.md (P1)
 */

// ─── Error codes (U1/U2/U12) ─────────────────────────────────────

/**
 * Failure reasons surfaced by `GameCardImportService.importCard`. Every code maps to
 * a UI error screen; no code carries a pre-rendered message.
 */
export type ImportErrorCode =
  /** gzip decompression or JSON.parse of the envelope failed (U1). */
  | 'decode-failed'
  /** Envelope `format !== 'aga-card'` or an unsupported `formatVersion` (U1). */
  | 'bad-format'
  /** Recomputed SHA-256 over the inner bundle does not match the stored checksum (U1). */
  | 'checksum-mismatch'
  /** `isValidCardBundleShape` rejected the bundle, or a deeper field check failed (U1). */
  | 'invalid-shape'
  /** No Game Pack is loaded (`getBootstrapGamePack()` returned null) — D6 guard (U2). */
  | 'no-pack'
  /** `cardMeta.packId` does not match the installed pack id — D6 strict binding (U2). */
  | 'pack-mismatch'
  /** Card uses `protagonist.mode === 'blank'`, unsupported this release — ZERO persistence (U12). */
  | 'blank-unsupported'
  /** Persisting the new save failed after rollback (OD-N); existing data is untouched. */
  | 'write-failed';

// ─── Global-scope opt-in flags (OD-D / handover §5 Group B + P1-j) ──

/**
 * Global-scope payloads the player may opt into at the import checklist (⑥). All
 * DEFAULT OFF and are NEVER applied silently — each one mutates state shared across
 * every save, so it requires an explicit tick.
 *
 * Save-scoped payloads (customPresets / imageAssets / worldBooks / the in-stateTree
 * promptSettings·heroinePlan·plotDirection) are applied automatically and are NOT
 * represented here. `apiTemplate` is an INFO row only — it is always imported DISABLED
 * regardless of any flag (SC-9), so it is intentionally not a member of this union.
 */
export type GlobalOptInFlag =
  /** ConfigStore pack-config overlays — `importAll` puts without clear → can clobber the
   *  player's same-domain config, hence opt-in (handover §5; plan §4 critic correction). */
  | 'configOverlays'
  /** Built-in prompt overrides — replaces engine-wide built-in prompts. */
  | 'builtinPromptOverrides'
  /** Custom prompt overrides — changes global prompts. */
  | 'promptOverrides'
  /** Whitelisted localStorage settings — changes the player's global settings. */
  | 'settings'
  /** OD-O (P1-j): the card author's gameplay settings (action options / chain-of-thought /
   *  world heartbeat / prose polish). Opt-in → author's values win; off → player local wins. */
  | 'authorGameplaySettings';

// ─── Protagonist edits (template mode only — U6) ─────────────────

/**
 * Player edits to the template protagonist. Keys are dot-paths RELATIVE to `角色`
 * (e.g. `属性.体力`); values are the edited leaf values. Only paths on the card's
 * `editableFields` whitelist are honored — blacklisted/unknown paths are ignored at
 * apply time. `fixed` mode ignores this entirely (CONTRACT-OD4).
 */
type ProtagonistEdits = Record<string, unknown>;

// ─── Import options (caller → service) ───────────────────────────

export interface ImportOptions {
  /** template mode: player's edits to allowed fields (U6). Ignored for `fixed`. */
  protagonistEdits?: ProtagonistEdits;
  /** Global-scope flags the player ticked at ⑥ (default: empty set). */
  optInGlobals: Set<GlobalOptInFlag>;
  /**
   * OD-C/OD-O NSFW gate: player chose "启用成人模式" at ④. When true, the service writes
   * the adult-mode localStorage flag BEFORE `loadGame` so `syncNsfwFromLocalStorage`
   * carries it into the card tree (`系统.nsfwMode`). When false, nothing is written.
   */
  enableNsfw: boolean;
  /** Optional opening-generation progress callback (UI ⑦ progress). Phase ∈ phaseE/F/G. */
  onOpeningProgress?: (phase: string, progress: number) => void;
  /** Optional abort signal for the opening (the UI's skip-opening button aborts it: CardImportFlow cancelOpening). */
  abortSignal?: AbortSignal;
}

// ─── Pack-version drift (U3 / OD-I) ──────────────────────────────

/**
 * Cross-version drift between the card and the installed pack, surfaced to the
 * preview/banner. The new save's slot is stamped with the CARD's packVersion (OD-I).
 */
export interface PackVersionDrift {
  /** Pack version recorded in the card (`cardMeta.packVersion`); '' if absent. */
  cardVersion: string;
  /** Installed pack version (`manifest.version`). */
  installedVersion: string;
  /** -1 = card is older, 0 = equal, 1 = card is newer than installed. */
  comparison: -1 | 0 | 1;
}

// ─── Import result (service → caller) ────────────────────────────

interface ImportSuccess {
  ok: true;
  /** New profile id — the slot the UI navigates into at ⑧ (`router.push`). */
  profileId: string;
  /** New save slot id under that profile. */
  slotId: string;
  /** Card title echoed for the success screen (UI may localize surrounding copy). */
  cardTitle: string;
  /**
   * True when no embedder is configured: the engram graph was stored but NOT vectorized,
   * so semantic retrieval is degraded until the player configures an embedding API. Drives
   * the ⑦/⑧ "检索受限" notice (U7/OD-E). Never blocks the import.
   */
  retrievalDegraded: boolean;
  /**
   * True when the opening narrative could not be generated (the AI call threw — e.g. no usable
   * LLM API configured). The save is still created; the first main round will fill the narrative.
   * Drives a success-screen hint so a blank opening never looks like a silent failure.
   */
  openingDegraded: boolean;
  /** Present only when the card and installed pack versions differ (U3/OD-F). */
  packVersionDrift?: PackVersionDrift;
  /**
   * True when the import overwrote ANY global setting (the player ticked a global opt-in and/or
   * enabled adult mode). The UI surfaces a one-click "undo global changes" → `undoGlobalChanges()`.
   * A FAILED import auto-restores globals, so this is only meaningful on success.
   */
  globalChangesApplied: boolean;
}

interface ImportFailure {
  ok: false;
  code: ImportErrorCode;
  /**
   * Optional non-display diagnostic context (e.g. the offending packId for a mismatch).
   * MUST be safe to log — NEVER the bundle, never secrets (SC-9).
   */
  detail?: string;
}

export type ImportResult = ImportSuccess | ImportFailure;
