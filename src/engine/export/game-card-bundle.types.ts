/**
 * Game Card (.aga-card) bundle format — Story 5 data contract.
 *
 * Design: docs/design/story-5-card-export-handover.md (v3)
 * Plan:   docs/plans/story-5-card-export-implementation.md (P1)
 *
 * A game card is a trimmed, shareable subset of a single save: world setup is
 * KEPT, gameplay history + ALL secrets are STRIPPED. It is INDEPENDENT of
 * BackupBundle (no change to the backup format) and is serialized as a single
 * gzip-compressed JSON file with an embedded SHA-256 checksum (handover §7).
 */
import type { EngramEntity } from '../memory/engram/entity-builder';
import type { EngramEdge } from '../memory/engram/knowledge-edge';
import type { ImageAsset } from '../image/types';
import type { CustomPresetEntry } from '../persistence/custom-preset-store';
import type { WorldBookExportData, BuiltinPromptExportData } from '../prompt/world-book';
import type { APIConfig, APIAssignment } from '../ai/types';

/** Card schema version — independent of the engine/bundle version. Bump on breaking card-schema changes. */
export const CARD_FORMAT_VERSION = 1;

// ─── Card metadata ───────────────────────────────────────────────

export interface CardMeta {
  /** Card schema version (independent of bundle.version). */
  formatVersion: number;
  /** Stable UUID; reused across re-exports of the same source save within a session. */
  cardId: string;
  /** Card title — REQUIRED, non-empty. */
  title: string;
  /** Player-facing description / blurb. */
  description: string;
  /** Author display name. */
  author: string;
  /** Free-form tags (e.g. "武侠", "现代"). */
  tags: string[];
  /** Cover image as a base64 data string (NOT an asset-id reference). */
  coverImage?: string;
  createdAt: string;
  updatedAt: string;
  /** Bound Game Pack id (D6: strict binding; import validates a match). */
  packId: string;
  /** Pack version at export time — used for cross-version drift warnings. */
  packVersion?: string;
}

// ─── Protagonist template (D2) ───────────────────────────────────

export type ProtagonistMode = 'fixed' | 'template' | 'blank';

export interface ProtagonistTemplate {
  mode: ProtagonistMode;
  /**
   * Trimmed copy of the 角色 subtree.
   * - fixed/template: present (defaults). fixed RETAINS derived 角色.属性 as authoritative (CONTRACT-OD4).
   * - blank: absent (the player creates the character on import via card-character-init, D16).
   */
  data?: Record<string, unknown>;
  /** template mode only: dot-paths (relative to 角色) the player may edit. Blacklist-enforced (handover §4A). */
  editableFields?: string[];
}

// ─── Settings + API template (no secrets — U8/U9/U10) ────────────

/**
 * Whitelisted localStorage settings (key → raw stored value).
 * Only keys in SETTINGS_EXPORT_WHITELIST appear; secrets are never included.
 */
export type SafeSettingsExport = Record<string, string | null>;

/** A single API config with ALL secret fields removed at the type level (U9/U10). */
export type ApiConfigTemplate = Pick<
  APIConfig,
  'name' | 'provider' | 'model' | 'temperature' | 'maxTokens' | 'enabled' | 'apiCategory'
>;

/** Function→config assignment preset (id references only; carries no secrets). */
export interface AssignmentPresetExport {
  id: string;
  name: string;
  createdAt: number;
  assignments: APIAssignment[];
  featureToggles: Record<string, boolean>;
}

export interface ApiTemplateExport {
  /** Non-secret API config templates (apiKey/url/customRoutingPath stripped). Player fills the key on import. */
  configs: ApiConfigTemplate[];
  /** Optional function-allocation presets ("main uses X, utility uses Y"). */
  assignmentPresets?: AssignmentPresetExport[];
}

// ─── Engine config overlays / prompt overrides (U16 / D14) ───────

/**
 * ConfigStore overlay — structurally inlined to avoid a fragile cross-module import
 * (mirrors ConfigOverlay in core/config-system, same rationale as backup-service).
 */
export interface ConfigOverlayExport {
  domainId: string;
  packId: string;
  patches: Record<string, unknown>;
  version: number;
  updatedAt: number;
}

// ─── Image asset entry (mirrors BackupBundle.imageAssets entry shape) ──

export interface CardImageAssetEntry {
  id: string;
  metadata: ImageAsset;
  base64: string;
  mimeType: string;
}

// ─── Export flags (the author's choices — surfaced to import UI) ──

export interface ExportFlags {
  containsNsfw: boolean;
  includedGenerationHistory: boolean;
  includedReferenceGallery: boolean;
  includedSettings: boolean;
  includedApiTemplate: boolean;
  includedEngineConfig: boolean;     // U16/D14 — configOverlays + promptOverrides
  includedWorldBooks: boolean;
  includedBuiltinOverrides: boolean;
  includedPromptSettings: boolean;   // 游戏设定 (U7①)
  includedHeroinePlan: boolean;      // 剧情规划·女主线 (U7②)
  includedPlotDirection: boolean;    // 剧情走向 (U7③)
  includedNarrativeContract: boolean; // 叙事契约 (R2, 2026-09-05) — default ON
}

// ─── The bundle ──────────────────────────────────────────────────

export interface GameCardBundle {
  bundleType: 'card';
  /** Shares BackupBundle's version-number lineage. */
  version: number;
  exportedAt: string;
  engineVersion: string;

  cardMeta: CardMeta;
  protagonist: ProtagonistTemplate;

  /** Trimmed state tree (gameplay history stripped; conditional world-setup kept per flags). */
  stateTree: Record<string, unknown>;

  /** Engram graph: entities + knowledge edges (events/legacy relations/vectors excluded; edges carry `core`). */
  engram: {
    entities: EngramEntity[];
    knowledgeEdges: EngramEdge[];
  };

  // Optional content — presence gated by the export checklist:
  worldBooks?: WorldBookExportData;                          // U5
  builtinPromptOverrides?: BuiltinPromptExportData;          // U6
  configOverlays?: ConfigOverlayExport[];                    // U16/D14
  promptOverrides?: Array<{ key: string; value: unknown }>;  // U16/D14
  settings?: SafeSettingsExport;                             // U8
  apiTemplate?: ApiTemplateExport;                           // U9
  imageAssets?: CardImageAssetEntry[];                       // U11
  customPresets?: Record<string, Record<string, CustomPresetEntry[]>>;  // D14

  /** D7: opening narrative is generated on import, not stored; only an optional setup hint travels. */
  opening?: { firstRoundSetup?: string };

  exportFlags?: ExportFlags;
}

/** Options passed to GameCardExportService.exportCard — runtime only, NOT serialized into the bundle. */
export interface ExportOptions {
  protagonist: ProtagonistTemplate;
  cardMeta: CardMeta;
  /**
   * Engram edge ids to include — INJECTED, never computed inside the service (handover §8A reuse seam).
   * Story 5 fills this with all edge ids; Story 7 fills it with its D5 AI-classification result.
   */
  selectedEdgeIds: Set<string>;
  /**
   * Story 7 (D5): when true, every selected edge is stamped `core: true` in the
   * exported bundle copy (never written back to the source save). Default false
   * (Story 5 behavior: edges carry their existing core value unchanged).
   */
  markSelectedEdgesCore?: boolean;
  /**
   * D7: optional author hint that steers the AI-generated opening narrative on import.
   * Written to `bundle.opening.firstRoundSetup`; consumed by the import opening pipeline
   * (Phase E). Only meaningful for fixed/template modes (blank is import-rejected).
   */
  firstRoundSetup?: string;
  checklist: ExportFlags;
}

// ─── Validation ──────────────────────────────────────────────────

const PROTAGONIST_MODES: ReadonlySet<string> = new Set<ProtagonistMode>(['fixed', 'template', 'blank']);

/**
 * Structural shape validator for a parsed .aga-card bundle.
 * Pure shape check — deeper field validation happens during import (Story 6).
 * NEW standalone function (no interaction with backup-service's isValidBundleShape).
 */
export function isValidCardBundleShape(data: unknown): data is GameCardBundle {
  if (typeof data !== 'object' || data === null) return false;
  const o = data as Record<string, unknown>;

  if (o['bundleType'] !== 'card') return false;
  if (typeof o['version'] !== 'number') return false;
  if (typeof o['exportedAt'] !== 'string') return false;
  if (typeof o['engineVersion'] !== 'string') return false;

  const meta = o['cardMeta'];
  if (typeof meta !== 'object' || meta === null) return false;
  const m = meta as Record<string, unknown>;
  if (typeof m['title'] !== 'string' || m['title'].trim() === '') return false;
  if (typeof m['packId'] !== 'string') return false;
  if (typeof m['formatVersion'] !== 'number') return false;
  // packVersion is optional but, when present, MUST be a string (compareVersions consumes it).
  if (m['packVersion'] !== undefined && typeof m['packVersion'] !== 'string') return false;

  const prot = o['protagonist'];
  if (typeof prot !== 'object' || prot === null) return false;
  if (!PROTAGONIST_MODES.has((prot as Record<string, unknown>)['mode'] as string)) return false;

  if (typeof o['stateTree'] !== 'object' || o['stateTree'] === null) return false;

  const engram = o['engram'];
  if (typeof engram !== 'object' || engram === null) return false;
  const e = engram as Record<string, unknown>;
  if (!Array.isArray(e['entities']) || !Array.isArray(e['knowledgeEdges'])) return false;

  return true;
}
