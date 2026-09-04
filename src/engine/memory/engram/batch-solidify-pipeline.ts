// App doc: docs/user-guide/pages/game-relationship-graph.md §4.19.3a
/**
 * EngramBatchSolidifyPipeline — Story 4 of Game Card Epic.
 *
 * Two tasks:
 * A. Detect unembedded entities/edges (UI exposes vectorizePending button)
 * B. For NEW entities missing knowledge edges, call AI to generate them
 *
 * AI context follows the FieldRepair pattern: full GAME_STATE_JSON +
 * memory block + recent chat history → AI sees complete world data
 * (NPC backgrounds, relationship networks, locations, memories).
 *
 * Pattern: detect → build context → AI → validate → inject → entity refresh
 */
import type { StateManager } from '../../core/state-manager';
import type { AIService } from '../../ai/ai-service';
import type { AIMessage } from '../../ai/types';
import type { EngramEdge } from './knowledge-edge';
import type { EngramEntity } from './entity-builder';
import type { EngramEditor, NewKnowledgeEdge } from './engram-editor';
import type { EngramManager } from './engram-manager';
import type { IMemoryRetriever } from '../../pipeline/types';
import { loadEngramConfig } from './engram-config';
import { stringifySnapshotForPrompt } from '../../memory/snapshot-sanitizer';
import { SUB_PIPELINE_HISTORY_PAIRS } from '../../prompt/context-compiler';

// ─── MissingReport ───

export interface MissingReport {
  missingNpcEntities: string[];
  npcsWithoutEdges: string[];
  missingLocationEntities: string[];
  locationsWithoutEdges: string[];
  existingEdgeCount: number;
  existingEntityCount: number;
  existingEdgeSummary: string;
  hasMissing: boolean;
}

// ─── Extended CoverageStats ───

export interface ExtendedCoverageStats {
  totalNpcs: number;
  npcsWithEntity: number;
  missingNpcNames: string[];
  coveragePercent: number;
  totalLocations: number;
  locationsWithEntity: number;
  missingLocationNames: string[];
  locationCoveragePercent: number;
  totalEdges: number;
  edgesBySource: {
    opening: number;
    user: number;
    'batch-sync': number;
    'card-import': number;
    legacy: number;
  };
}

// ─── Pipeline result ───

export interface BatchSolidifyResult {
  created: number;
  skipped: number;
  skippedDetails: Array<{ input: unknown; reason: string }>;
  alreadyComplete: boolean;
}

// ─── Pipeline progress phases ───

export type BatchSolidifyPhase = 'scanning' | 'generating' | 'applying' | 'done' | 'error';

// ─── Path configuration (detect still needs these to scan state tree) ───

export interface BatchSolidifyPaths {
  relationships: string;
  locations: string;
  engramMemory: string;
  playerName: string;
  roundNumber: string;
  npcNameField: string;
  npcTypeField: string;
  npcTypeExclude: string;
  /** NPC 外貌描述字段名（默认 '外貌描述'）—— 注入避免引擎硬编码游戏中文字段名 */
  npcAppearanceField: string;
  /** NPC 一句话描述字段名（默认 '描述'） */
  npcDescriptionField: string;
  locationNameField: string;
  /** 地点描述字段名（默认 '描述'） */
  locationDescriptionField: string;
  narrativeHistory: string;
}

const MAX_EDGE_SUMMARY_ITEMS = 200;
const MIN_FACT_LENGTH = 15;

/**
 * Normalize location data — 世界.地点信息 can be an Array or Record<id, LocationItem>.
 * Production data is an array; Record shape supported for legacy compatibility.
 */
function normalizeLocations(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw.filter(x => x && typeof x === 'object');
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.values(raw as Record<string, unknown>)
      .filter((v): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v));
  }
  return [];
}

// ─── detect function (UNCHANGED from original) ───

export function detectMissingEngramData(
  stateManager: StateManager,
  paths: BatchSolidifyPaths,
): MissingReport {
  const engram = stateManager.get<{
    entities: EngramEntity[];
    v2Edges: EngramEdge[];
  }>(paths.engramMemory);

  const entities = engram?.entities ?? [];
  const edges = engram?.v2Edges ?? [];

  const properEntities = entities.filter(e => !e._pendingEnrichment);
  const properEntityNames = new Set(properEntities.map(e => e.name));
  const edgeEntityNames = new Set<string>();
  for (const edge of edges) {
    edgeEntityNames.add(edge.sourceEntity);
    edgeEntityNames.add(edge.targetEntity);
  }

  const rawRelationships = stateManager.get<Array<Record<string, unknown>>>(paths.relationships);
  const relationships = Array.isArray(rawRelationships) ? rawRelationships : [];

  const npcNames: string[] = [];
  for (const npc of relationships) {
    if (!npc || typeof npc !== 'object') continue;
    const name = npc[paths.npcNameField];
    if (typeof name !== 'string' || !name.trim()) continue;
    if (npc[paths.npcTypeField] === paths.npcTypeExclude) continue;
    npcNames.push(name.trim());
  }

  const missingNpcEntities = npcNames.filter(n => !properEntityNames.has(n));
  const npcsWithoutEdges = npcNames.filter(
    n => properEntityNames.has(n) && !edgeEntityNames.has(n),
  );

  const rawLocations = stateManager.get<unknown>(paths.locations);
  const locationRecords = normalizeLocations(rawLocations);

  const locationNames: string[] = [];
  for (const loc of locationRecords) {
    if (!loc || typeof loc !== 'object') continue;
    const name = loc[paths.locationNameField];
    if (typeof name === 'string' && name.trim()) {
      locationNames.push(name.trim());
    }
  }

  const locationEntityNames = new Set(
    properEntities.filter(e => e.type === 'location').map(e => e.name),
  );
  const missingLocationEntities = locationNames.filter(n => !locationEntityNames.has(n));
  const locationsWithoutEdges = locationNames.filter(
    n => locationEntityNames.has(n) && !edgeEntityNames.has(n),
  );

  const summaryLines: string[] = [];
  const edgesToSummarize = edges.slice(0, MAX_EDGE_SUMMARY_ITEMS);
  for (const edge of edgesToSummarize) {
    summaryLines.push(`${edge.sourceEntity} → ${edge.targetEntity}: ${edge.fact}`);
  }
  if (edges.length > MAX_EDGE_SUMMARY_ITEMS) {
    summaryLines.push(`... (共 ${edges.length} 条)`);
  }
  const existingEdgeSummary = summaryLines.join('\n');

  const hasMissing =
    missingNpcEntities.length > 0 ||
    npcsWithoutEdges.length > 0 ||
    missingLocationEntities.length > 0 ||
    locationsWithoutEdges.length > 0;

  return {
    missingNpcEntities,
    npcsWithoutEdges,
    missingLocationEntities,
    locationsWithoutEdges,
    existingEdgeCount: edges.length,
    existingEntityCount: properEntities.length,
    existingEdgeSummary,
    hasMissing,
  };
}

// ─── AI response parser ───

interface ParsedFact {
  source_entity: string;
  target_entity: string;
  fact: string;
}

interface ParsedEntityDesc {
  name: string;
  summary: string;
}

interface ParsedAIOutput {
  facts: ParsedFact[];
  descriptions: ParsedEntityDesc[];
}

/**
 * Tolerant JSON extraction shared across batch AI pipelines (Story 4 solidify,
 * Story 7 card edge classify): scan candidate '{' start positions from the END
 * of the raw response and return the first JSON.parse-able value accepted by
 * `accept`. Survives thinking tags, prose preambles and code fences.
 */
export function parseLooseJson<T>(raw: string, accept: (v: unknown) => v is T): T | null {
  const openBraces: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '{') openBraces.push(i);
  }

  for (let i = openBraces.length - 1; i >= 0; i--) {
    const candidate = raw.slice(openBraces[i]);
    const closeIdx = candidate.lastIndexOf('}');
    if (closeIdx < 0) continue;

    try {
      const parsed: unknown = JSON.parse(candidate.slice(0, closeIdx + 1));
      if (accept(parsed)) return parsed;
    } catch {
      continue;
    }
  }

  return null;
}

function parseAIResponse(raw: string): ParsedAIOutput {
  const parsed = parseLooseJson(
    raw,
    (v): v is { knowledge_facts: ParsedFact[]; entity_descriptions?: ParsedEntityDesc[] } =>
      v !== null && typeof v === 'object' &&
      Array.isArray((v as { knowledge_facts?: unknown }).knowledge_facts),
  );
  if (!parsed) return { facts: [], descriptions: [] };

  const facts = parsed.knowledge_facts.filter(
    f =>
      f &&
      typeof f.source_entity === 'string' &&
      typeof f.target_entity === 'string' &&
      typeof f.fact === 'string',
  );
  const descriptions = (parsed.entity_descriptions ?? []).filter(
    d => d && typeof d.name === 'string' && typeof d.summary === 'string' && d.summary.trim(),
  );
  return { facts, descriptions };
}

// ─── Validation (UNCHANGED) ───

function validateFacts(
  facts: ParsedFact[],
  validNames: Set<string>,
): { valid: NewKnowledgeEdge[]; skipped: Array<{ input: unknown; reason: string }> } {
  const valid: NewKnowledgeEdge[] = [];
  const skipped: Array<{ input: unknown; reason: string }> = [];

  for (const f of facts) {
    const src = f.source_entity.trim();
    const tgt = f.target_entity.trim();

    // M-4 fix (2026-05-28): BOTH endpoints must exist in the post-backfill world
    // entity set. `validNames` is built AFTER Phase 3 backfills entities for every
    // state-tree NPC/location + injects descriptions (run() :424-427, buildValidNameSet
    // :760-787), so a missing endpoint here is an AI hallucination not present in the
    // already-solidified world — reject it. (Was OR: single-endpoint edges slipped
    // through and bulkCreateEdges auto-stubbed a permanent, vectorized phantom entity
    // that no orphan cleanup could remove because the phantom owns this very edge.)
    const srcKnown = validNames.has(src);
    const tgtKnown = validNames.has(tgt);
    if (!srcKnown || !tgtKnown) {
      skipped.push({ input: f, reason: srcKnown || tgtKnown ? 'endpoint_unknown' : 'both_endpoints_unknown' });
      continue;
    }
    if (f.fact.length < MIN_FACT_LENGTH) {
      skipped.push({ input: f, reason: 'fact_too_short' });
      continue;
    }

    valid.push({
      sourceEntity: src,
      targetEntity: tgt,
      fact: f.fact,
    });
  }

  return { valid, skipped };
}

// ─── Pipeline class ───

export interface BatchSolidifyDeps {
  aiService: AIService;
  stateManager: StateManager;
  engramEditor: EngramEditor;
  engramManager: EngramManager;
  paths: BatchSolidifyPaths;
  jailbreakPrompt?: string;
  memoryRetriever?: IMemoryRetriever;
}

export class EngramBatchSolidifyPipeline {
  private readonly deps: BatchSolidifyDeps;

  constructor(deps: BatchSolidifyDeps) {
    this.deps = deps;
  }

  async run(
    onProgress?: (phase: BatchSolidifyPhase) => void,
  ): Promise<BatchSolidifyResult> {
    const { aiService, stateManager, engramEditor, engramManager, paths, jailbreakPrompt } = this.deps;

    if (!loadEngramConfig().enabled) {
      throw new Error('Engram is not enabled');
    }

    // Phase 1: Detect
    onProgress?.('scanning');
    const report = detectMissingEngramData(stateManager, paths);

    // ── Data sync: handle deletions + description updates BEFORE AI call ──

    const knownDescriptions = this.buildKnownDescriptions();
    const locationNameSet = new Set<string>();
    for (const loc of normalizeLocations(stateManager.get<unknown>(paths.locations))) {
      const n = loc[paths.locationNameField];
      if (typeof n === 'string' && n.trim()) locationNameSet.add(n.trim());
    }

    // Build the full set of names that currently exist in state tree
    const stateTreeNames = new Set<string>();
    const rawNpcs = stateManager.get<Array<Record<string, unknown>>>(paths.relationships);
    if (Array.isArray(rawNpcs)) {
      for (const npc of rawNpcs) {
        const name = npc?.[paths.npcNameField];
        if (typeof name === 'string' && name.trim()) stateTreeNames.add(name.trim());
      }
    }
    for (const n of locationNameSet) stateTreeNames.add(n);
    const playerName = stateManager.get<string>(paths.playerName);
    if (playerName) stateTreeNames.add(playerName);

    // 1. Invalidate edges + entities for deleted NPC/locations (removed from state tree)
    await engramManager.withWriteLock(() => {
      const currentEngram = stateManager.get<{
        entities: EngramEntity[];
        v2Edges: EngramEdge[];
      }>(paths.engramMemory);
      if (!currentEngram?.entities) return;

      const currentRound = stateManager.get<number>(paths.roundNumber) ?? 0;
      let changed = false;

      for (const edge of currentEngram.v2Edges) {
        if (edge.invalidAtRound != null) continue;
        const srcGone = !stateTreeNames.has(edge.sourceEntity);
        const tgtGone = !stateTreeNames.has(edge.targetEntity);
        if (srcGone || tgtGone) {
          edge.invalidAtRound = currentRound;
          edge.temporalStatus = 'historical';
          changed = true;
        }
      }

      for (const entity of currentEngram.entities) {
        if (entity.type === 'player') continue;
        if (!stateTreeNames.has(entity.name) && !entity._pendingEnrichment) {
          entity._pendingEnrichment = true;
          entity.summary = '';
          entity.is_embedded = false;
          changed = true;
        }
      }

      if (changed) {
        stateManager.set(paths.engramMemory, currentEngram, 'system');
        console.log('[BatchSolidify] Invalidated edges/entities for deleted state tree entries');
      }
    });

    // 2. Sync descriptions: update non-user-edited entities whose state tree description changed
    await engramManager.withWriteLock(() => {
      const currentEngram = stateManager.get<{ entities: EngramEntity[] }>(paths.engramMemory);
      if (!currentEngram?.entities) return;
      let fixedCount = 0;
      for (const entity of currentEngram.entities) {
        const desc = knownDescriptions.get(entity.name);
        if (!desc) continue;

        if (entity.source === 'user') continue;

        const needsFix = entity._pendingEnrichment
          || !entity.summary
          || entity.summary === entity.name
          || entity.summary !== desc;
        if (!needsFix) continue;

        entity.summary = desc;
        if (locationNameSet.has(entity.name)) entity.type = 'location';
        if (entity._pendingEnrichment) entity._pendingEnrichment = undefined;
        entity.is_embedded = false;
        fixedCount++;
      }
      if (fixedCount > 0) stateManager.set(paths.engramMemory, currentEngram, 'system');
      if (fixedCount > 0) console.log(`[BatchSolidify] Synced ${fixedCount} entity descriptions from state tree`);
    });

    if (!report.hasMissing) {
      onProgress?.('done');
      return { created: 0, skipped: 0, skippedDetails: [], alreadyComplete: true };
    }

    // 3. Create entities for names in state tree but not in Engram
    const allMissing = [
      ...report.missingNpcEntities,
      ...report.missingLocationEntities,
    ];

    if (allMissing.length > 0) {
      const engram = stateManager.get<{ entities: EngramEntity[] }>(paths.engramMemory);
      const existingNames = new Set(
        (engram?.entities ?? []).filter(e => !e._pendingEnrichment).map(e => e.name),
      );
      const toCreate: Array<{ name: string; type?: 'npc' | 'location' | 'item' | 'player'; summary?: string }> = [];
      for (const name of allMissing) {
        if (existingNames.has(name)) continue;
        existingNames.add(name);
        toCreate.push({
          name,
          type: locationNameSet.has(name) ? 'location' : undefined,
          summary: knownDescriptions.get(name) || name,
        });
      }
      if (toCreate.length > 0) {
        const r = await engramEditor.bulkCreateEntities(toCreate);
        console.log(`[BatchSolidify] Created ${r.created.length} missing entities`);
      }
    }

    // ── Build AI context and call ──
    onProgress?.('generating');

    const gameStateJson = this.buildGameStateJson();
    const memoryBlock = this.buildMemoryBlock();
    const chatHistory = this.loadChatHistory();
    // Entities needing AI descriptions: all missing + those that exist but have
    // empty summaries and no state-tree description (npcsWithoutEdges, locationsWithoutEdges)
    const allNeedingCheck = new Set([
      ...allMissing,
      ...report.npcsWithoutEdges,
      ...report.locationsWithoutEdges,
    ]);
    const currentEngram = stateManager.get<{ entities: EngramEntity[] }>(paths.engramMemory);
    const entitiesWithoutDesc: string[] = [];
    for (const name of allNeedingCheck) {
      if (knownDescriptions.get(name)) continue;
      const entity = (currentEngram?.entities ?? []).find(e => e.name === name);
      if (!entity || !entity.summary || entity.summary === entity.name) {
        entitiesWithoutDesc.push(name);
      }
    }
    const taskMessage = this.buildTaskMessage(report, entitiesWithoutDesc);

    const systemContent =
      `## 当前游戏状态\n\n\`\`\`json\n${gameStateJson}\n\`\`\`\n\n` +
      `## 记忆摘要\n\n${memoryBlock}`;

    const messages: AIMessage[] = [];
    if (jailbreakPrompt?.trim()) {
      messages.push({ role: 'system', content: jailbreakPrompt.trim() });
    }
    messages.push({ role: 'system', content: systemContent });
    messages.push(...chatHistory);
    messages.push({ role: 'user', content: taskMessage });

    let rawResponse: string;
    try {
      rawResponse = await aiService.generate({
        messages,
        stream: false,
        usageType: 'engram_batch_solidify',
        temperature: 0.3,
      });
    } catch (err) {
      onProgress?.('error');
      throw err;
    }

    // Phase 3: Parse + validate
    const aiOutput = parseAIResponse(rawResponse);
    console.log(`[BatchSolidify] Parsed ${aiOutput.facts.length} facts, ${aiOutput.descriptions.length} descriptions from AI response`);

    // Write AI-generated descriptions BEFORE checking facts — AI may return
    // only descriptions with empty facts, and we must not discard them.
    if (aiOutput.descriptions.length > 0) {
      await engramManager.withWriteLock(() => {
        const currentEngram = stateManager.get<{ entities: EngramEntity[] }>(paths.engramMemory);
        if (!currentEngram?.entities) return;
        let count = 0;
        for (const desc of aiOutput.descriptions) {
          const name = desc.name.trim();
          const summary = desc.summary.trim();
          if (!name || !summary) continue;
          const entity = currentEngram.entities.find(e => e.name === name);
          if (entity && (!entity.summary || entity.summary === entity.name)) {
            entity.summary = summary;
            if (entity._pendingEnrichment) entity._pendingEnrichment = undefined;
            entity.is_embedded = false;
            count++;
          }
        }
        if (count > 0) {
          stateManager.set(paths.engramMemory, currentEngram, 'system');
          console.log(`[BatchSolidify] Applied ${count} AI-generated descriptions`);
        }
      });
    }

    if (aiOutput.facts.length === 0) {
      onProgress?.('done');
      return { created: 0, skipped: 0, skippedDetails: [], alreadyComplete: false };
    }

    const validNames = this.buildValidNameSet();
    const { valid, skipped: validationSkipped } = validateFacts(aiOutput.facts, validNames);

    if (valid.length === 0) {
      onProgress?.('done');
      return {
        created: 0,
        skipped: validationSkipped.length,
        skippedDetails: validationSkipped,
        alreadyComplete: false,
      };
    }

    // Inject via bulkCreateEdges
    onProgress?.('applying');
    console.log(`[BatchSolidify] Injecting ${valid.length} validated edges (${validationSkipped.length} skipped in validation)`);
    const bulkResult = await engramEditor.bulkCreateEdges(valid, {
      defaultCore: false,
      defaultSource: 'batch-sync',
    });
    console.log(`[BatchSolidify] bulkCreateEdges: created=${bulkResult.created.length}, skipped=${bulkResult.skipped.length}`);
    if (bulkResult.skipped.length > 0) {
      console.log('[BatchSolidify] Skipped edges:', bulkResult.skipped.slice(0, 5));
    }

    // Clean up orphan stubs: entities with _pendingEnrichment that have zero edges.
    // These are created by bulkCreateEdges auto-stub for AI-hallucinated names.
    await engramManager.withWriteLock(() => {
      const postEngram = stateManager.get<{ entities: EngramEntity[]; v2Edges: EngramEdge[] }>(paths.engramMemory);
      if (!postEngram?.entities) return;
      const edgeNames = new Set<string>();
      for (const e of postEngram.v2Edges ?? []) {
        edgeNames.add(e.sourceEntity);
        edgeNames.add(e.targetEntity);
      }
      const before = postEngram.entities.length;
      postEngram.entities = postEngram.entities.filter(
        e => !e._pendingEnrichment || edgeNames.has(e.name),
      );
      const removed = before - postEngram.entities.length;
      if (removed > 0) {
        stateManager.set(paths.engramMemory, postEngram, 'system');
        console.log(`[BatchSolidify] Removed ${removed} orphan stub entities`);
      }
    });

    // Note: we intentionally do NOT call processResponse(syntheticEmpty) here.
    // processResponse triggers Step 4 "NPC importance filter" which deletes edges
    // where neither endpoint is an "important NPC" — this kills all location↔location
    // edges we just created. Entity descriptions are already filled in the fix step
    // above, so EntityBuilder rebuild is not needed.

    // Auto-vectorize new entities and edges (fire-and-forget)
    engramManager.vectorizePending(stateManager).catch(err =>
      console.warn('[BatchSolidify] Vectorization failed (non-blocking):', err),
    );

    onProgress?.('done');

    const allSkipped = [
      ...validationSkipped,
      ...bulkResult.skipped,
    ];

    return {
      created: bulkResult.created.length,
      skipped: allSkipped.length,
      skippedDetails: allSkipped,
      alreadyComplete: false,
    };
  }

  private buildKnownDescriptions(): Map<string, string> {
    const { stateManager, paths } = this.deps;
    const map = new Map<string, string>();

    const rawNpcs = stateManager.get<Array<Record<string, unknown>>>(paths.relationships);
    if (Array.isArray(rawNpcs)) {
      for (const npc of rawNpcs) {
        const name = npc?.[paths.npcNameField];
        if (typeof name !== 'string' || !name.trim()) continue;
        const appearance = npc[paths.npcAppearanceField];
        const description = npc[paths.npcDescriptionField];
        const desc = typeof appearance === 'string' ? appearance.trim()
          : typeof description === 'string' ? description.trim()
          : '';
        if (desc) map.set(name.trim(), desc);
      }
    }

    for (const loc of normalizeLocations(stateManager.get<unknown>(paths.locations))) {
      const n = loc[paths.locationNameField];
      if (typeof n === 'string' && n.trim()) {
        const locDesc = loc[paths.locationDescriptionField];
        const desc = typeof locDesc === 'string' ? locDesc.trim() : '';
        if (desc) map.set(n.trim(), desc);
      }
    }

    return map;
  }

  // ─── Context builders (FieldRepair pattern) ───

  private buildGameStateJson(): string {
    try {
      const nsfwMode = this.deps.stateManager.get<boolean>('系统.nsfwMode') === true;
      return stringifySnapshotForPrompt(this.deps.stateManager.toSnapshot(), nsfwMode, 0);
    } catch {
      return '{}';
    }
  }

  private buildMemoryBlock(): string {
    if (this.deps.memoryRetriever) {
      try {
        const retrieved = this.deps.memoryRetriever.retrieve(this.deps.stateManager);
        if (retrieved?.trim()) return retrieved;
      } catch { /* fallback */ }
    }
    const shortTerm = this.deps.stateManager.get<unknown[]>('记忆.短期') ?? [];
    if (!Array.isArray(shortTerm) || shortTerm.length === 0) return '（暂无记忆）';
    return shortTerm
      .slice(-8)
      .map(m => {
        if (typeof m === 'string') return `- ${m}`;
        if (m && typeof m === 'object') {
          const content = (m as Record<string, unknown>)['内容'] ?? (m as Record<string, unknown>)['content'];
          return typeof content === 'string' ? `- ${content}` : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n') || '（暂无记忆）';
  }

  private loadChatHistory(): AIMessage[] {
    const narrativeHistory = this.deps.stateManager.get<Array<{ role: string; content: string }>>(
      this.deps.paths.narrativeHistory,
    );
    if (!Array.isArray(narrativeHistory) || narrativeHistory.length === 0) return [];

    // Recent narrative as CONTEXT for edge generation (not format examples). Constant since
    // 2026-09-04 (Context Compiler v1, PO decision Q3 removed the player setting).
    const keepCount = SUB_PIPELINE_HISTORY_PAIRS * 2;
    const tail = narrativeHistory.slice(-keepCount);
    return tail.map((m): AIMessage => {
      const role = m.role as AIMessage['role'];
      let wrapped = m.content ?? '';
      if (role === 'user') wrapped = `<玩家输入>\n${wrapped}\n</玩家输入>`;
      else if (role === 'assistant') wrapped = `<叙事正文>\n${wrapped}\n</叙事正文>`;
      return { role, content: wrapped };
    });
  }

  private buildTaskMessage(report: MissingReport, entitiesWithoutDesc: string[]): string {
    const missingNpcs = [
      ...report.missingNpcEntities,
      ...report.npcsWithoutEdges,
    ];
    const missingLocations = [
      ...report.missingLocationEntities,
      ...report.locationsWithoutEdges,
    ];

    const missingSection = [
      missingNpcs.length > 0 ? `NPC：\n${missingNpcs.map(n => `- ${n}`).join('\n')}` : '',
      missingLocations.length > 0 ? `地点：\n${missingLocations.map(n => `- ${n}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');

    const hasDescTask = entitiesWithoutDesc.length > 0;

    const parts: string[] = [
      `<Engram补全任务>`,
      ``,
      `## 任务一：生成关系知识边`,
      ``,
      `以下实体缺少知识边。请根据上方 GAME_STATE_JSON 中的世界数据为它们生成关系事实。`,
      ``,
      `重点参考：`,
      `- NPC 的「背景」字段中的家庭/师徒/出身地关系`,
      `- NPC 的「关系网变量」字段中已声明的 NPC↔NPC 关系`,
      `- NPC 的「关系状态」和「位置」`,
      `- 地点的「连接」字段中的相邻/隶属关系`,
      `- 地点的「NPC」字段中的常驻 NPC`,
      ``,
      `需要补全的实体：`,
      ``,
      missingSection,
      ``,
      `## 已有知识边（不要生成重复或高度相似的）`,
      ``,
      report.existingEdgeSummary || '（无）',
    ];

    if (hasDescTask) {
      parts.push(
        ``,
        `## 任务二：补全实体描述（必须完成，不可遗漏）`,
        ``,
        `以下 ${entitiesWithoutDesc.length} 个实体在游戏数据中没有描述，需要你根据上下文推断并生成。`,
        `entity_descriptions 数组必须包含恰好 ${entitiesWithoutDesc.length} 项，每项对应下方一个实体。`,
        ``,
        ...entitiesWithoutDesc.map(n => `- ${n}`),
      );
    }

    parts.push(
      ``,
      `## 输出格式`,
      ``,
      `仅输出一个 JSON 对象：`,
    );

    if (hasDescTask) {
      parts.push(
        `{`,
        `  "knowledge_facts": [{"source_entity": "实体A", "target_entity": "实体B", "fact": "15-40字关系描述"}],`,
        `  "entity_descriptions": [{"name": "实体名", "summary": "20-50字描述"}]`,
        `}`,
      );
    } else {
      parts.push(
        `{"knowledge_facts": [{"source_entity": "实体A", "target_entity": "实体B", "fact": "15-40字关系描述"}]}`,
      );
    }

    parts.push(
      ``,
      `## 约束`,
      ``,
      `1. source_entity 和 target_entity 必须是 GAME_STATE_JSON 中存在的名称`,
      `2. 仅基于已有数据推导，不编造不在数据中的关系`,
      `3. fact 必须是 15-40 字的自然语言句子`,
      `4. 每个缺失 NPC 生成 1-3 条边（优先与玩家角色的关系）`,
      `5. 每个缺失地点生成 0-2 条边（与常驻 NPC 或相邻地点的关联）`,
      hasDescTask
        ? `6. entity_descriptions 必须包含 ${entitiesWithoutDesc.length} 项，不可省略`
        : `6. 如果无法推导有意义的关系，knowledge_facts 可以为空数组`,
      ``,
      `直接输出 JSON，不要解释。`,
      `</Engram补全任务>`,
    );

    return parts.join('\n');
  }

  private buildValidNameSet(): Set<string> {
    const { stateManager, paths } = this.deps;
    const validNames = new Set<string>();

    // State tree NPC names
    const rawRelationships = stateManager.get<Array<Record<string, unknown>>>(paths.relationships);
    if (Array.isArray(rawRelationships)) {
      for (const npc of rawRelationships) {
        const name = npc?.[paths.npcNameField];
        if (typeof name === 'string' && name.trim()) validNames.add(name.trim());
      }
    }
    // State tree location names
    for (const loc of normalizeLocations(stateManager.get<unknown>(paths.locations))) {
      const name = loc[paths.locationNameField];
      if (typeof name === 'string' && name.trim()) validNames.add(name.trim());
    }
    // Player name
    const playerName = stateManager.get<string>(paths.playerName);
    if (playerName) validNames.add(playerName);
    // Existing Engram entities (event-derived entities not in state tree lists)
    const engram = stateManager.get<{ entities: EngramEntity[] }>(paths.engramMemory);
    for (const entity of engram?.entities ?? []) {
      if (!entity._pendingEnrichment && entity.name) validNames.add(entity.name);
    }

    return validNames;
  }
}
