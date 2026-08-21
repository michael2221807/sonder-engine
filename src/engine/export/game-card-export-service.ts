// App doc: docs/user-guide/pages/game-save.md §2.5
/**
 * GameCardExportService — Story 5 (P2): the single logic entry for card export,
 * reused by Story 7 (handover §8A). Pure orchestration; zero回写 to the live save
 * (SC-8); zero secret leakage (SC-9).
 *
 * `options.selectedEdgeIds` is INJECTED, never computed here (reuse seam):
 *   - Story 5 fills it with all edge ids.
 *   - Story 7 fills it with its D5 AI-classification result.
 */
import type { SaveManager } from '../persistence/save-manager';
import type { ConfigStore } from '../core/config-system';
import type { PromptStorage } from '../prompt/prompt-storage';
import type { WorldBookStorage } from '../prompt/world-book-storage';
import type { CustomPresetStore } from '../persistence/custom-preset-store';
import type { ImageAssetCache } from '../image/asset-cache';
import type { EngramEntity } from '../memory/engram/entity-builder';
import type { EngramEdge } from '../memory/engram/knowledge-edge';
import { gzipCompress, sha256String } from '../sync/chunked-bundle-packer';
import { collectAssetIdsFromTree } from '../persistence/backup-service';
import { stripStateTreeForCard, getByPath, isRecord, collectStringsAtPath } from './card-stripper';
import { buildDefaultCardStripPaths, type CardStripPaths } from './card-export-paths';
import { convertCapturedBookForCard, extractCapturedBookFromTree } from './captured-settings-card';
import type { WorldBookExportData } from '../prompt/world-book';
import {
  CARD_FORMAT_VERSION,
  type GameCardBundle,
  type ExportOptions,
  type ApiConfigTemplate,
  type AssignmentPresetExport,
  type ConfigOverlayExport,
  type CardImageAssetEntry,
} from './game-card-bundle.types';

/** Bundle version lineage shared with BackupBundle. */
const CARD_BUNDLE_VERSION = 1;
const ENGINE_VERSION = '0.1.0';

/** App localStorage keys for the API template (non-secret fields only are exported). */
const API_MANAGEMENT_KEY = 'aga_api_management';
const ASSIGNMENT_PRESETS_KEY = 'aga_assignment_presets';

/** Minimum private-text fragment length for engram substring scrubbing (CJK-aware floor — avoids
 *  false-positive hits on short common words). */
const MIN_PRIVATE_FRAGMENT_LENGTH = 4;

import { SETTINGS_EXPORT_WHITELIST } from './settings-export-whitelist';

export class GameCardExportService {
  constructor(
    private saveManager: SaveManager,
    private configStore: ConfigStore,
    private promptStorage: PromptStorage,
    private worldBookStorage: WorldBookStorage,
    private customPresetStore: CustomPresetStore,
    private imageAssetCache: ImageAssetCache,
    /** Injected strip/keep/reset path config (defaults to DEFAULT_ENGINE_PATHS-derived). */
    private stripPaths: CardStripPaths = buildDefaultCardStripPaths(),
  ) {}

  /**
   * Profile world books + the converted captured-settings book.
   *
   * Provenance is dropped and the ids are regenerated during conversion — see
   * `convertCapturedBookForCard`. The id regeneration matters: `importWorldBooks` saves
   * under the incoming id keyed `profileId:book.id`, so shipping the fixed
   * `system_captured_settings` id would overwrite the recipient's own captured book.
   */
  private async collectWorldBooks(
    profileId: string,
    originalTree: Record<string, unknown>,
    cardTitle: string,
  ): Promise<WorldBookExportData> {
    const data = await this.worldBookStorage.exportWorldBooks(profileId);
    const captured = extractCapturedBookFromTree(originalTree, this.stripPaths.capturedSettings);
    if (!captured || captured.entries.length === 0) return data;

    const converted = convertCapturedBookForCard(captured, cardTitle);
    if (converted.entries.length === 0) return data;

    return { ...data, books: [...data.books, converted] };
  }

  /**
   * Trim a save into a shareable game card and serialize it to a single gzip blob.
   * Read-only: loads the persisted save, deep-clones, never writes back.
   */
  async exportCard(
    profileId: string,
    slotId: string,
    options: ExportOptions,
  ): Promise<{ blob: Blob; checksum: string; bundle: GameCardBundle }> {
    const tree = await this.saveManager.loadGame(profileId, slotId);
    if (!tree) throw new Error(`存档不存在：${profileId}/${slotId}`);
    const original = tree as unknown as Record<string, unknown>;
    const flags = options.checklist;

    // 1. Engram extracted from the ORIGINAL tree (before strip), then NSFW-redacted if needed.
    const engram = this.extractEngram(
      original,
      options.selectedEdgeIds,
      flags.containsNsfw,
      options.markSelectedEdgesCore === true,
    );

    // 2. Trim the state tree (deep-cloned inside; engramMemory cleared to avoid double-carry, G5;
    //    blank protagonist mode also drops 角色 — see card-stripper).
    const stateTree = stripStateTreeForCard(original, this.stripPaths, flags, options.protagonist.mode);

    // 3. Images from the TRIMMED tree (history/gallery already removed per flags → only selected survive).
    const imageAssets = await this.collectImages(stateTree, flags.includedReferenceGallery);

    // 4. Optional creative assets (each gated by a checklist flag).
    // World books: the author's profile books, plus — when they opted in — this save's
    // captured-settings book converted into an ordinary profile book.
    //
    // The captured book is read from the ORIGINAL tree (same pattern as engram above),
    // because `stripStateTreeForCard` has already removed it from the exported copy. If
    // it were only stripped and never re-added, ticking "include world books" would
    // silently do nothing for it.
    const worldBooks = flags.includedWorldBooks
      ? await this.collectWorldBooks(profileId, original, options.cardMeta.title)
      : undefined;

    const builtinPromptOverrides = flags.includedBuiltinOverrides
      ? await this.worldBookStorage.exportBuiltinOverrides(options.cardMeta.packId)
      : undefined;

    let configOverlays: ConfigOverlayExport[] | undefined;
    let promptOverrides: Array<{ key: string; value: unknown }> | undefined;
    if (flags.includedEngineConfig) {
      // Only THIS card's pack overlays (not all packs the author played — F4 privacy).
      // Structural passthrough — avoids a fragile ConfigOverlay import (same rationale as backup-service).
      configOverlays = (await this.configStore.listOverlays(options.cardMeta.packId)) as unknown as ConfigOverlayExport[];
      promptOverrides = await this.promptStorage.exportAll();
    }

    const settings = flags.includedSettings ? this.collectSafeSettings() : undefined;
    const apiTemplate = flags.includedApiTemplate ? this.collectApiTemplate() : undefined;

    // customPresets always travel (D14) — protagonist origins/talents may reference them (esp. blank mode).
    const customPresets = await this.collectCustomPresets(options.cardMeta.packId);

    // 5. Assemble.
    const now = new Date().toISOString();
    const bundle: GameCardBundle = {
      bundleType: 'card',
      version: CARD_BUNDLE_VERSION,
      exportedAt: now,
      engineVersion: ENGINE_VERSION,
      cardMeta: { ...options.cardMeta, formatVersion: CARD_FORMAT_VERSION, updatedAt: now },
      protagonist: options.protagonist,
      stateTree,
      engram,
      worldBooks,
      builtinPromptOverrides,
      configOverlays,
      promptOverrides,
      settings,
      apiTemplate,
      imageAssets: imageAssets.length > 0 ? imageAssets : undefined,
      customPresets: customPresets && Object.keys(customPresets).length > 0 ? customPresets : undefined,
      // D7: carry the author's opening-style hint (any mode) so import can steer the opening.
      // blank mode keeps the legacy empty-string marker even when no hint is supplied.
      opening: this.buildOpening(options),
      exportFlags: flags,
    };

    // 6. Single-file gzip envelope with an embedded SHA-256 checksum over the bundle (handover §7).
    const bundleJson = JSON.stringify(bundle);
    const checksum = await sha256String(bundleJson);
    const envelope = JSON.stringify({ format: 'aga-card', formatVersion: CARD_FORMAT_VERSION, checksum, bundle });
    const blob = await gzipCompress(envelope);

    return { blob, checksum, bundle };
  }

  // ─── Opening hint (D7) ─────────────────────────────────────────

  /** Opening hint travels when the author supplied one; blank keeps its legacy empty marker. */
  private buildOpening(options: ExportOptions): { firstRoundSetup: string } | undefined {
    const hint = options.firstRoundSetup?.trim() ?? '';
    if (hint) return { firstRoundSetup: hint };
    return options.protagonist.mode === 'blank' ? { firstRoundSetup: '' } : undefined;
  }

  // ─── Engram ────────────────────────────────────────────────────

  private extractEngram(
    tree: Record<string, unknown>,
    selectedEdgeIds: Set<string>,
    includeNsfw: boolean,
    markSelectedEdgesCore: boolean,
  ): { entities: EngramEntity[]; knowledgeEdges: EngramEdge[] } {
    const engramState = getByPath(tree, this.stripPaths.engramMemory);
    const rawEntities = isRecord(engramState) && Array.isArray(engramState['entities'])
      ? (engramState['entities'] as EngramEntity[]) : [];
    const rawEdges = isRecord(engramState) && Array.isArray(engramState['v2Edges'])
      ? (engramState['v2Edges'] as EngramEdge[]) : [];

    // Drop events + legacy relations + vectors; reset is_embedded (import re-embeds).
    // Story 7 (D5): retained edges are world-setting by author confirmation → stamp core
    // on the exported COPY only (the source save is never touched, SC-8).
    let entities = rawEntities.map((e) => ({ ...e, is_embedded: false }));
    let knowledgeEdges = rawEdges
      .filter((e) => e && selectedEdgeIds.has(e.id))
      .map((e) => (markSelectedEdgesCore ? { ...e, is_embedded: false, core: true } : { ...e, is_embedded: false }));

    // NSFW re-leak guard (SC-9): when adult content is excluded, scrub private text from
    // free-text engram fields. Entity summaries are 背景+外貌描述 by construction (clean),
    // but edge facts are AI-generated free text → drop any edge mentioning stripped private text.
    // Note: edge.episodes carries event IDs (not human-readable text, see knowledge-edge.ts) so it
    // is intentionally not scrubbed; if a future code path stores free-form text there, extend this.
    if (!includeNsfw) {
      // Best-effort scrub: drop edges / blank summaries that echo materialized private text.
      // Heuristic (substring) — paraphrased NSFW in AI-generated edge facts can't be fully caught;
      // SFW saves carry no NSFW edges, so residual risk is low. P9 asserts the materialized case.
      // (Always run — containsAny is a no-op when no private fragments exist.)
      const privateTexts = this.collectPrivateTexts(tree);
      knowledgeEdges = knowledgeEdges.filter((e) => !containsAny(e.fact, privateTexts));
      entities = entities.map((e) => (containsAny(e.summary, privateTexts) ? { ...e, summary: '' } : e));
    }
    return { entities, knowledgeEdges };
  }

  /** Gather private/NSFW string fragments from the original tree (for engram scrubbing). */
  private collectPrivateTexts(tree: Record<string, unknown>): string[] {
    const out: string[] = [];
    for (const path of this.stripPaths.nsfw) {
      out.push(...collectStringsAtPath(tree, path.split('.')));
    }
    // Only meaningfully long fragments — avoid false-positive substring matches on short words.
    return out.filter((s) => s.trim().length >= MIN_PRIVATE_FRAGMENT_LENGTH);
  }

  // ─── Images ────────────────────────────────────────────────────

  private async collectImages(trimmedTree: Record<string, unknown>, includeReferenceGallery: boolean): Promise<CardImageAssetEntry[]> {
    const ids = new Set<string>();
    collectAssetIdsFromTree(trimmedTree, ids, includeReferenceGallery);
    if (ids.size === 0) return [];
    try {
      return await this.imageAssetCache.exportByIds(ids);
    } catch {
      return [];
    }
  }

  // ─── Settings + API template (no secrets) ──────────────────────

  private collectSafeSettings(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const key of SETTINGS_EXPORT_WHITELIST) {
      const val = localStorage.getItem(key);
      if (val !== null) out[key] = val;
    }
    return out;
  }

  private collectApiTemplate(): { configs: ApiConfigTemplate[]; assignmentPresets?: AssignmentPresetExport[] } | undefined {
    const configs: ApiConfigTemplate[] = [];
    const rawMgmt = localStorage.getItem(API_MANAGEMENT_KEY);
    if (rawMgmt) {
      try {
        const parsed: unknown = JSON.parse(rawMgmt);
        const list = isRecord(parsed) && Array.isArray(parsed['apiConfigs']) ? parsed['apiConfigs'] : [];
        for (const c of list) {
          if (!isRecord(c)) continue;
          // Pick non-secret fields only — apiKey / url / customRoutingPath are NEVER copied.
          configs.push({
            name: String(c['name'] ?? ''),
            provider: c['provider'] as ApiConfigTemplate['provider'],
            model: String(c['model'] ?? ''),
            temperature: typeof c['temperature'] === 'number' ? c['temperature'] : 0,
            maxTokens: typeof c['maxTokens'] === 'number' ? c['maxTokens'] : 0,
            enabled: c['enabled'] === true,
            apiCategory: c['apiCategory'] as ApiConfigTemplate['apiCategory'],
          });
        }
      } catch {
        /* malformed — skip API template */
      }
    }

    let assignmentPresets: AssignmentPresetExport[] | undefined;
    const rawPresets = localStorage.getItem(ASSIGNMENT_PRESETS_KEY);
    if (rawPresets) {
      try {
        const parsed: unknown = JSON.parse(rawPresets);
        if (Array.isArray(parsed)) {
          // Reconstruct known fields only — drop any unknown top-level keys a rogue/old write may carry (F1).
          assignmentPresets = parsed.filter(isRecord).map((p) => ({
            id: String(p['id'] ?? ''),
            name: String(p['name'] ?? ''),
            createdAt: typeof p['createdAt'] === 'number' ? p['createdAt'] : 0,
            assignments: Array.isArray(p['assignments']) ? (p['assignments'] as AssignmentPresetExport['assignments']) : [],
            featureToggles: isRecord(p['featureToggles']) ? (p['featureToggles'] as AssignmentPresetExport['featureToggles']) : {},
          }));
        }
      } catch {
        /* malformed — skip presets */
      }
    }

    if (configs.length === 0 && !assignmentPresets) return undefined;
    return { configs, assignmentPresets };
  }

  // ─── Custom presets (current pack only, D6) ────────────────────

  private async collectCustomPresets(packId: string): Promise<Record<string, Record<string, import('../persistence/custom-preset-store').CustomPresetEntry[]>> | undefined> {
    try {
      const data = await this.customPresetStore.load(packId);
      if (data && data.presets && Object.keys(data.presets).length > 0) {
        return { [packId]: data.presets };
      }
    } catch {
      /* best-effort */
    }
    return undefined;
  }
}

/** Case-sensitive substring check against any fragment. */
function containsAny(haystack: string, fragments: string[]): boolean {
  if (typeof haystack !== 'string' || haystack.length === 0) return false;
  return fragments.some((f) => haystack.includes(f));
}
