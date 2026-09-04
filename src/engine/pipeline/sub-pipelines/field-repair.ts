/**
 * FieldRepairPipeline — generic post-turn repair for any required field.
 *
 * Differs from `PrivacyProfileRepairPipeline` in two ways:
 *
 * 1. **Scope**: reads `rules/required-fields.json` from the pack and flags any
 *    missing field, not just 私密信息. This is what auto-populates
 *    `外貌描述` / `身材描写` / `衣着风格` on existing NPCs.
 *
 * 2. **Context**: reuses the main-round step-2 assembly (game state, memory,
 *    recent narrative history, core.md, splitGenContext) but swaps the
 *    `splitGenStep2` module for `fieldRepair`. When split-gen is disabled,
 *    the flow is still fully hydrated from the current state tree — the
 *    repair prompt always sees a complete picture.
 *
 * Privacy repair still runs as a separate specialist pass for its deep NSFW
 * 8-field contract; this generic pipeline handles all non-NSFW-deep cases.
 *
 * All conditional tasks — field repair, entity enrichment, edge review —
 * are combined into a SINGLE AI request (step 3). Which blocks are injected
 * depends on which tasks are detected as needed.
 */
import type { StateManager } from '../../core/state-manager';
import type { CommandExecutor } from '../../core/command-executor';
import type { Command } from '../../types/state';
import type { AIService } from '../../ai/ai-service';
import { AI_SETTINGS_STORAGE_KEY } from '../../ai/ai-service';
import type { AIMessage } from '../../ai/types';
import type { ResponseParser } from '../../ai/response-parser';
import type { PromptAssembler } from '../../prompt/prompt-assembler';
import type { MemoryRetriever } from '../../memory/memory-retriever';
import type { GamePack } from '../../types';
import type { EnginePathConfig } from '../types';
import {
  emitPromptAssemblyDebug,
  emitPromptResponseDebug,
  extractThinkingFromRaw,
} from '../../core/prompt-debug';
import { appendChangesToLastNarrative } from '../../audit/audit-append';
import { isEdgeCurrentlyValid, type EngramEdge } from '../../memory/engram/knowledge-edge';
import type { EngramEntity } from '../../memory/engram/entity-builder';
import { loadEngramConfig } from '../../memory/engram/engram-config';
import { eventBus } from '../../core/event-bus';
import { stringifySnapshotForPrompt } from '../../memory/snapshot-sanitizer';
import { SUB_PIPELINE_HISTORY_PAIRS } from '../../prompt/context-compiler';
import {
  findIncompleteFields,
  readRequiredFieldsConfig,
  formatMissingFieldsSummary,
  type FieldRepairReport,
} from '../../validators/field-completeness-validator';

/** Narrative history entry shape — mirrors the local type in context-assembly. */
interface NarrativeEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
  _delta?: unknown[];
}

const MAX_RETRIES_KEY = AI_SETTINGS_STORAGE_KEY;
const DEFAULT_MAX_RETRIES = 1;

function readMaxRetries(): number {
  try {
    const raw = localStorage.getItem(MAX_RETRIES_KEY);
    if (!raw) return DEFAULT_MAX_RETRIES;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const v = parsed['fieldRepairRetries'];
    if (typeof v === 'number' && v >= 0 && v <= 5) return Math.floor(v);
    return DEFAULT_MAX_RETRIES;
  } catch {
    return DEFAULT_MAX_RETRIES;
  }
}

export interface EdgeReviewDetail {
  edgeId: string;
  fact: string;
  reason: string;
}

export interface EdgeReviewResult {
  reviewed: number;
  invalidated: number;
  kept: number;
  invalidatedEdges: EdgeReviewDetail[];
  keptEdges: EdgeReviewDetail[];
}

export interface EntityEnrichResult {
  enriched: number;
  remaining: number;
  entityNames: string[];
}

export interface FieldRepairResult {
  success: boolean;
  attempts: number;
  remaining: FieldRepairReport;
  entityEnrichResult?: EntityEnrichResult;
  edgeReviewResult?: EdgeReviewResult;
}

/** Detected pending entity enrichment data. */
interface PendingEnrichmentData {
  pending: EngramEntity[];
  nameList: string;
}

/** Detected pending edge review data. */
interface PendingReviewData {
  matchedPairs: Array<{ newFact: string; oldEdgeId: string; similarity: number }>;
  matchedEdges: EngramEdge[];
  reviewList: string;
  edgeList: string;
}

/** Combined AI response from a single step-3 request. */
interface CombinedStepResult {
  commands: Command[] | null;
  entityDescriptions: Array<{ name: string; summary: string }> | null;
  edgeUpdates: Array<{ edge_id: string; action: string; reason: string }> | null;
}

export class FieldRepairPipeline {
  constructor(
    private stateManager: StateManager,
    private commandExecutor: CommandExecutor,
    private aiService: AIService,
    private responseParser: ResponseParser,
    private promptAssembler: PromptAssembler,
    private memoryRetriever: MemoryRetriever | null,
    private gamePack: GamePack,
    private paths: EnginePathConfig,
  ) {}

  async execute(): Promise<FieldRepairResult> {
    const config = readRequiredFieldsConfig(this.gamePack.rules);
    const nsfwMode = this.stateManager.get<boolean>('系统.nsfwMode') === true;
    let report = findIncompleteFields(this.stateManager, this.paths, config, { nsfwMode });

    const engramConfig = loadEngramConfig();
    const edgeActive = engramConfig.knowledgeEdgeMode === 'active';

    // ── Detect all conditional tasks ──
    const needsFieldRepair = report.total > 0;
    const enrichData = edgeActive ? this.detectPendingEnrichment() : null;
    const reviewData = edgeActive ? this.detectPendingReview() : null;

    const maxAttempts = readMaxRetries() + 1;
    let attempts = 0;
    let success = !needsFieldRepair;
    let entityEnrichResult: EntityEnrichResult | undefined;
    let edgeReviewResult: EdgeReviewResult | undefined;

    // ── Combined step: all active tasks in ONE AI request ──
    if (needsFieldRepair || enrichData || reviewData) {
      attempts = 1;
      try {
        const combined = await this.runCombinedStep(
          needsFieldRepair ? report : null,
          enrichData,
          reviewData,
          1,
        );

        // Apply field repair results
        if (combined.commands && combined.commands.length > 0) {
          const result = this.commandExecutor.executeBatch(combined.commands);
          console.log(
            `[FieldRepair] Combined step: applied ${combined.commands.length} commands ` +
            `(${result.hasErrors ? 'some errors' : 'all ok'})`,
          );
          appendChangesToLastNarrative(
            this.stateManager, this.paths, 'fieldRepair', result.changeLog.changes,
          );
        }

        // Apply entity enrichment results
        if (enrichData) {
          if (combined.entityDescriptions && combined.entityDescriptions.length > 0) {
            entityEnrichResult = this.applyEntityDescriptions(combined.entityDescriptions, enrichData);
          } else {
            console.log('[FieldRepair] Combined step: no entity descriptions returned');
            entityEnrichResult = {
              enriched: 0,
              remaining: enrichData.pending.length,
              entityNames: enrichData.pending.map((e) => e.name),
            };
          }
        }

        // Apply edge review results
        if (reviewData) {
          if (combined.edgeUpdates) {
            edgeReviewResult = this.applyEdgeUpdates(combined.edgeUpdates, reviewData);
          } else {
            console.warn('[FieldRepair] Combined step: no edge_updates returned — preserving pending');
          }
        }

        // Re-check field repair status
        report = findIncompleteFields(this.stateManager, this.paths, config, { nsfwMode });
        success = report.total === 0;
      } catch (err) {
        console.error('[FieldRepair] Combined step failed:', err);
        eventBus.emit('ui:toast', {
          type: 'warning',
          i18nKey: 'engine.toast.fieldRepairFailed',
          message: '字段补齐/记忆维护失败（不影响本回合）',
          duration: 3000,
        });
      }
    }

    // ── Retry loop: field repair ONLY (enrichment + review already done) ──
    while (report.total > 0 && attempts < maxAttempts) {
      attempts++;
      try {
        await this.runFieldRepairOnly(report, attempts);
      } catch (err) {
        console.error(`[FieldRepair] Retry attempt ${attempts} failed:`, err);
        break;
      }
      report = findIncompleteFields(this.stateManager, this.paths, config, { nsfwMode });
    }

    success = report.total === 0;
    if (success && attempts > 0) {
      console.log(`[FieldRepair] All tasks completed in ${attempts} attempt(s)`);
    } else if (attempts > 0) {
      console.warn(
        `[FieldRepair] ${report.total} entit(ies) still incomplete after ${attempts} attempt(s)`,
      );
    }

    return { success, attempts, remaining: report, entityEnrichResult, edgeReviewResult };
  }

  // ═══════════════════════════════════════════════════════════════
  //  Combined Step — single AI request for all conditional tasks
  // ═══════════════════════════════════════════════════════════════

  /**
   * Run all detected tasks in a single AI request.
   *
   * Conditionally injects: field repair, entity enrichment, edge review.
   * Uses the richer prompt-flow context when field repair is active;
   * falls back to simple system context otherwise.
   */
  private async runCombinedStep(
    fieldReport: FieldRepairReport | null,
    enrichData: PendingEnrichmentData | null,
    reviewData: PendingReviewData | null,
    attempt: number,
  ): Promise<CombinedStepResult> {
    const chatHistory = this.loadChatHistory();
    const hasChatHistory = chatHistory.length > 0;

    let baseMessages: AIMessage[];
    let messageSources: string[];
    let variables: Record<string, string> = {};

    if (fieldReport) {
      variables = this.buildVariables(fieldReport, hasChatHistory);
      const flow = this.gamePack.promptFlows['fieldRepair'];
      if (flow) {
        const assembled = this.promptAssembler.assemble(flow, variables, chatHistory);
        baseMessages = assembled.messages;
        messageSources = assembled.messageSources;
      } else {
        console.warn('[FieldRepair] No "fieldRepair" prompt flow in pack');
        baseMessages = this.buildSimpleMessages(chatHistory, hasChatHistory);
        messageSources = ['system_context', ...chatHistory.map(() => 'history')];
      }
    } else {
      baseMessages = this.buildSimpleMessages(chatHistory, hasChatHistory);
      messageSources = ['system_context', ...chatHistory.map(() => 'history')];
    }

    // Build combined user prompt with all active task blocks
    const parts: string[] = [];
    const formatParts: string[] = [];

    // Only inject <本回合叙事> when chatHistory is empty — otherwise the latest
    // narrative is already present as the last assistant message in chatHistory.
    if (chatHistory.length === 0) {
      const currentNarrative = this.extractCurrentRoundNarrative();
      if (currentNarrative) {
        parts.push(
          `<本回合叙事>\n` +
          `以下是本回合刚生成的叙事内容，请基于此上下文完成后续任务：\n\n` +
          `${currentNarrative}\n` +
          `</本回合叙事>`,
        );
      }
    }

    if (fieldReport) {
      const enforcement = this.promptAssembler.renderSingle('narratorEnforcement', variables);
      if (enforcement) parts.push(enforcement);

      parts.push(
        `<字段补齐任务>\n` +
        `请补齐下列缺失字段。要求：\n` +
        `1. **完整性**：${fieldReport.entities.length} 个实体的全部缺失字段必须补齐，不得遗漏。\n` +
        `2. **只补不改**：仅修改缺失字段对应的 path；其他字段保持不动。\n` +
        `3. **贴合世界**：每条 value 必须与 GAME_STATE_JSON / 记忆摘要 / 本回合叙事一致，禁止编造冲突设定。\n` +
        `4. **不截断**：即使需要输出大量 commands，也要完整输出，禁止 "(略)" / "(后续类似)" 敷衍。\n\n` +
        `缺失清单：\n${variables.MISSING_FIELDS_SUMMARY}\n` +
        `</字段补齐任务>`,
      );
      formatParts.push('"commands": [{...}, ...]');
    }

    if (enrichData) {
      const enrichPrompt = this.gamePack.prompts['entityEnrich'];
      let block = enrichPrompt
        ? enrichPrompt.replace('{{MISSING_ENTITIES}}', enrichData.nameList)
        : this.buildDefaultEntityEnrichPrompt(enrichData.nameList);
      // ── Problem 1 fix: inject engram edge context for pending entities ──
      const edgeContext = this.buildEnrichmentEdgeContext(enrichData);
      if (edgeContext) block += '\n\n' + edgeContext;
      parts.push(block);
      formatParts.push('"entity_descriptions": [{"name": "...", "summary": "..."}, ...]');
    }

    if (reviewData) {
      const edgeReviewPrompt = this.gamePack.prompts['edgeReview'];
      let block = edgeReviewPrompt
        ? edgeReviewPrompt
            .replace('{{REVIEW_EDGES_LIST}}', reviewData.reviewList)
            .replace('{{MATCHED_EDGES}}', reviewData.edgeList)
        : this.buildDefaultEdgeReviewPrompt(reviewData.reviewList, reviewData.edgeList);
      // ── Problem 1 fix: inject entity summaries for reviewed edges ──
      const entityContext = this.buildReviewEntityContext(reviewData);
      if (entityContext) block += '\n\n' + entityContext;
      parts.push(block);
      formatParts.push('"edge_updates": [{"edge_id": "...", "action": "keep|invalidate", "reason": "..."}, ...]');
    }

    parts.push(
      `请一次性输出一个合法 JSON 对象，包含以上全部任务的结果。格式：\n` +
      `{${formatParts.join(', ')}}\n` +
      `直接输出 JSON，不要解释、不要代码围栏、不要思维链。`,
    );

    const finalUserContent = parts.join('\n\n');
    const finalMessages: AIMessage[] = [...baseMessages, { role: 'user', content: finalUserContent }];
    messageSources.push('combined_tasks');

    const generationId = `combinedRepair_${attempt}_${Date.now()}`;
    emitPromptAssemblyDebug({
      flow: `combinedRepair#${attempt}`,
      variables,
      messages: finalMessages,
      messageSources,
      generationId,
    });

    const rawResponse = await this.aiService.generate({
      messages: finalMessages,
      usageType: 'field_repair',
    });

    emitPromptResponseDebug({
      flow: `combinedRepair#${attempt}`,
      generationId,
      thinking: extractThinkingFromRaw(rawResponse),
      rawResponse,
    });

    return this.parseCombinedResponse(rawResponse);
  }

  // ═══════════════════════════════════════════════════════════════
  //  Detection — check which tasks need to run
  // ═══════════════════════════════════════════════════════════════

  private detectPendingEnrichment(): PendingEnrichmentData | null {
    const engramPath = this.paths.engramMemory;
    const entities = this.stateManager.get<EngramEntity[]>(engramPath + '.entities') ?? [];
    const pending = entities.filter((e) => e._pendingEnrichment === true);
    if (pending.length === 0) return null;
    const nameList = pending.map((e) => `- ${e.name}`).join('\n');
    return { pending, nameList };
  }

  private detectPendingReview(): PendingReviewData | null {
    const engramPath = this.paths.engramMemory;
    const pending = this.stateManager.get<Array<{ newFact: string; oldEdgeId: string; similarity: number }>>(
      engramPath + '.meta.v2PendingReview',
    );
    if (!Array.isArray(pending) || pending.length === 0) return null;

    const v2Edges = this.stateManager.get<EngramEdge[]>(engramPath + '.v2Edges') ?? [];
    if (v2Edges.length === 0) return null;

    const engramConfig = loadEngramConfig();
    const perFactCap = engramConfig.edgeReviewPerFactCap ?? 5;
    const globalCap = engramConfig.edgeReviewGlobalCap ?? 40;

    const edgeMap = new Map(v2Edges.map((e) => [e.id, e]));
    const validPairs: Array<{ newFact: string; oldEdgeId: string; similarity: number }> = [];
    for (const pair of pending) {
      const edge = edgeMap.get(pair.oldEdgeId);
      if (edge && isEdgeCurrentlyValid(edge) && edge.core !== true) {
        validPairs.push(pair);
      }
    }
    if (validPairs.length === 0) return null;

    // Group by newFact, keep top-N per fact by similarity, then apply global cap
    const grouped = new Map<string, Array<{ newFact: string; oldEdgeId: string; similarity: number }>>();
    for (const p of validPairs) {
      if (!grouped.has(p.newFact)) grouped.set(p.newFact, []);
      grouped.get(p.newFact)!.push(p);
    }
    const cappedPairs: Array<{ newFact: string; oldEdgeId: string; similarity: number }> = [];
    for (const pairs of grouped.values()) {
      pairs.sort((a, b) => b.similarity - a.similarity);
      cappedPairs.push(...pairs.slice(0, perFactCap));
    }
    cappedPairs.sort((a, b) => b.similarity - a.similarity);
    const matchedPairs = cappedPairs.slice(0, globalCap);

    const matchedEdgeIds = new Set(matchedPairs.map((p) => p.oldEdgeId));
    const matchedEdges = [...matchedEdgeIds]
      .map((id) => edgeMap.get(id))
      .filter((e): e is EngramEdge => e != null);

    const reviewList = matchedPairs
      .map((p) => {
        const old = edgeMap.get(p.oldEdgeId)!;
        return `- 新事实「${p.newFact}」与旧边「${old.sourceEntity}→${old.targetEntity}: ${old.fact}」（相似度=${p.similarity.toFixed(2)}）`;
      })
      .join('\n');
    const edgeList = matchedEdges
      .map((e) => `- [${e.id}] ${e.sourceEntity}→${e.targetEntity}: ${e.fact}（第${e.lastSeenRound}轮）`)
      .join('\n');

    return { matchedPairs, matchedEdges, reviewList, edgeList };
  }

  // ═══════════════════════════════════════════════════════════════
  //  Context extraction — enrich task blocks with engram data
  // ═══════════════════════════════════════════════════════════════

  /** Extract the narrative text generated by the main round AI (last assistant entry). */
  private extractCurrentRoundNarrative(): string | null {
    const narrativeHistory = this.stateManager.get<NarrativeEntry[]>(this.paths.narrativeHistory);
    if (!Array.isArray(narrativeHistory) || narrativeHistory.length === 0) return null;
    for (let i = narrativeHistory.length - 1; i >= 0; i--) {
      if (narrativeHistory[i].role === 'assistant' && narrativeHistory[i].content) {
        return narrativeHistory[i].content;
      }
    }
    return null;
  }

  /** Build edge context for entity enrichment — show valid edges referencing pending entities. */
  private buildEnrichmentEdgeContext(enrichData: PendingEnrichmentData): string {
    const engramPath = this.paths.engramMemory;
    const v2Edges = this.stateManager.get<EngramEdge[]>(engramPath + '.v2Edges') ?? [];
    if (v2Edges.length === 0) return '';

    const pendingNames = new Set(enrichData.pending.map((e) => e.name));
    const relevantEdges = v2Edges
      .filter((e) => isEdgeCurrentlyValid(e))
      .filter((e) => pendingNames.has(e.sourceEntity) || pendingNames.has(e.targetEntity))
      .slice(0, 30);

    if (relevantEdges.length === 0) return '';

    const lines = relevantEdges.map(
      (e) => `- ${e.sourceEntity} → ${e.targetEntity}: ${e.fact}`,
    );
    return (
      `以下是知识图谱中与待补全实体相关的已有事实边，可作为描述参考：\n` +
      lines.join('\n')
    );
  }

  /** Build entity summary context for edge review — show descriptions of entities involved. */
  private buildReviewEntityContext(reviewData: PendingReviewData): string {
    const engramPath = this.paths.engramMemory;
    const entities = this.stateManager.get<EngramEntity[]>(engramPath + '.entities') ?? [];
    if (entities.length === 0) return '';

    const involvedNames = new Set<string>();
    for (const edge of reviewData.matchedEdges) {
      involvedNames.add(edge.sourceEntity);
      involvedNames.add(edge.targetEntity);
    }

    const relevantEntities = entities.filter(
      (e) => involvedNames.has(e.name) && e.summary,
    );
    if (relevantEntities.length === 0) return '';

    const lines = relevantEntities.map((e) => `- ${e.name}: ${e.summary}`);
    return (
      `以下是被审查知识边涉及的实体当前描述，供判断参考：\n` +
      lines.join('\n')
    );
  }

  // ═══════════════════════════════════════════════════════════════
  //  Apply results — process parsed AI output
  // ═══════════════════════════════════════════════════════════════

  private applyEntityDescriptions(
    descriptions: Array<{ name: string; summary: string }>,
    data: PendingEnrichmentData,
  ): EntityEnrichResult {
    if (descriptions.length === 0) {
      return { enriched: 0, remaining: data.pending.length, entityNames: data.pending.map((e) => e.name) };
    }

    const engramPath = this.paths.engramMemory;
    const currentEntities = this.stateManager.get<EngramEntity[]>(engramPath + '.entities') ?? [];
    const descMap = new Map(descriptions.map((d) => [d.name, d.summary]));
    let enriched = 0;

    const updated = currentEntities.map((e) => {
      if (!e._pendingEnrichment) return e;
      const summary = descMap.get(e.name);
      if (summary && summary.length > 0) {
        enriched++;
        const currentRound = this.stateManager.get<number>(this.paths.roundNumber) ?? 0;
        const { _pendingEnrichment: _, ...rest } = e;
        return { ...rest, summary, is_embedded: false, enrichedAtRound: currentRound };
      }
      return e;
    });

    if (enriched > 0) {
      this.stateManager.set(engramPath + '.entities', updated, 'system');
      console.log(`[EntityEnrich] Enriched ${enriched} entity(s) with descriptions`);
    }

    return { enriched, remaining: data.pending.length - enriched, entityNames: descriptions.map((d) => d.name) };
  }

  private applyEdgeUpdates(
    updates: Array<{ edge_id: string; action: string; reason: string }>,
    data: PendingReviewData,
  ): EdgeReviewResult {
    const engramPath = this.paths.engramMemory;

    // Clear pending — AI responded, no need to retry
    this.stateManager.set(engramPath + '.meta.v2PendingReview', null, 'system');

    if (updates.length === 0) {
      const allKept: EdgeReviewDetail[] = data.matchedEdges.map((e) => ({ edgeId: e.id, fact: e.fact, reason: '' }));
      return { reviewed: data.matchedEdges.length, invalidated: 0, kept: data.matchedEdges.length, invalidatedEdges: [], keptEdges: allKept };
    }

    const currentRound = this.stateManager.get<number>(this.paths.roundNumber) ?? 0;
    const v2Edges = this.stateManager.get<EngramEdge[]>(engramPath + '.v2Edges') ?? [];
    const clonedEdges = v2Edges.map((e) => ({ ...e }));
    const clonedMap = new Map(clonedEdges.map((e) => [e.id, e]));
    const invalidatedEdges: EdgeReviewDetail[] = [];
    const auditChanges: Array<{ path: string; action: 'set'; oldValue: unknown; newValue: unknown; timestamp: number }> = [];
    const processedIds = new Set<string>();

    for (const update of updates) {
      if (update.action !== 'invalidate') continue;
      const edge = clonedMap.get(update.edge_id);
      if (!edge || edge.invalidAtRound != null || edge.invalidatedAtRound != null) continue;

      edge.invalidatedAtRound = currentRound;
      edge.invalidAtRound = currentRound;
      edge.temporalStatus = 'historical';
      invalidatedEdges.push({ edgeId: edge.id, fact: edge.fact, reason: update.reason });
      processedIds.add(edge.id);
      auditChanges.push({
        path: `${engramPath}.v2Edges[id=${update.edge_id}].invalidAtRound`,
        action: 'set', oldValue: undefined, newValue: currentRound, timestamp: Date.now(),
      });
    }

    if (invalidatedEdges.length > 0) {
      this.stateManager.set(engramPath + '.v2Edges', clonedEdges, 'system');
      if (auditChanges.length > 0) {
        appendChangesToLastNarrative(this.stateManager, this.paths, 'edgeReview', auditChanges);
      }
      console.log(`[EdgeReview] Invalidated ${invalidatedEdges.length} edge(s)`);
    }

    const keptEdges: EdgeReviewDetail[] = data.matchedEdges
      .filter((e) => !processedIds.has(e.id))
      .map((e) => {
        const u = updates.find((up) => up.edge_id === e.id);
        return { edgeId: e.id, fact: e.fact, reason: u?.reason ?? '' };
      });

    return {
      reviewed: data.matchedEdges.length,
      invalidated: invalidatedEdges.length,
      kept: keptEdges.length,
      invalidatedEdges,
      keptEdges,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  Response parsing
  // ═══════════════════════════════════════════════════════════════

  private parseCombinedResponse(raw: string): CombinedStepResult {
    const cleaned = raw
      .replace(/<(?:think|thinking|reasoning|thought)>[\s\S]*?<\/(?:think|thinking|reasoning|thought)>/gi, '')
      .trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');

    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return { commands: null, entityDescriptions: null, edgeUpdates: null };
    }

    try {
      const json = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;

      // Extract commands — validate minimum shape (action + key)
      let commands: Command[] | null = null;
      if (Array.isArray(json.commands)) {
        commands = json.commands
          .filter((c): c is Record<string, unknown> => c != null && typeof c === 'object')
          .filter((c) => typeof c.action === 'string' && typeof c.key === 'string')
          .map((c) => ({ action: c.action, key: c.key, value: c.value } as Command));
      }

      // Extract entity descriptions
      let entityDescriptions: Array<{ name: string; summary: string }> | null = null;
      if (Array.isArray(json.entity_descriptions)) {
        entityDescriptions = (json.entity_descriptions as Array<Record<string, unknown>>)
          .filter((d) => typeof d.name === 'string' && typeof d.summary === 'string')
          .map((d) => ({ name: (d.name as string).trim(), summary: (d.summary as string).trim() }))
          .filter((d) => d.name && d.summary);
      }

      // Extract edge updates
      let edgeUpdates: Array<{ edge_id: string; action: string; reason: string }> | null = null;
      if (Array.isArray(json.edge_updates)) {
        edgeUpdates = (json.edge_updates as Array<Record<string, unknown>>)
          .filter((u) => typeof u.edge_id === 'string' && typeof u.action === 'string')
          .map((u) => ({
            edge_id: (u.edge_id as string).trim().toLowerCase().replace(/^\[|\]$/g, ''),
            action: (u.action as string).trim(),
            reason: typeof u.reason === 'string' ? (u.reason as string).trim() : '',
          }));
      }

      return { commands, entityDescriptions, edgeUpdates };
    } catch {
      return { commands: null, entityDescriptions: null, edgeUpdates: null };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Field-repair-only retry (used for retries after combined step)
  // ═══════════════════════════════════════════════════════════════

  /**
   * One field-repair-only iteration — used for retries when the combined step
   * didn't fully resolve missing fields.
   */
  private async runFieldRepairOnly(report: FieldRepairReport, attempt: number): Promise<void> {
    const flow = this.gamePack.promptFlows['fieldRepair'];
    if (!flow) {
      console.warn('[FieldRepair] No "fieldRepair" prompt flow in pack — skipping');
      return;
    }

    const chatHistory = this.loadChatHistory();
    const hasChatHistory = chatHistory.length > 0;
    const variables = this.buildVariables(report, hasChatHistory);
    const assembled = this.promptAssembler.assemble(flow, variables, chatHistory);

    const enforcement = this.promptAssembler.renderSingle('narratorEnforcement', variables);
    const retryParts: string[] = [];

    if (enforcement) retryParts.push(enforcement);

    if (!hasChatHistory) {
      const currentNarrative = this.extractCurrentRoundNarrative();
      if (currentNarrative) {
        retryParts.push(
          `<本回合叙事>\n` +
          `以下是本回合刚生成的叙事内容，请基于此上下文补齐字段：\n\n` +
          `${currentNarrative}\n` +
          `</本回合叙事>`,
        );
      }
    }

    retryParts.push(
      `<字段补齐任务>\n` +
      `请立即输出 commands JSON 补齐下列缺失字段。要求：\n` +
      `1. **完整性**：${report.entities.length} 个实体的全部缺失字段必须补齐，不得遗漏。\n` +
      `2. **只补不改**：仅修改缺失字段对应的 path；其他字段保持不动。\n` +
      `3. **贴合世界**：每条 value 必须与 GAME_STATE_JSON / 记忆摘要 / 本回合叙事一致，禁止编造冲突设定。\n` +
      `4. **不截断**：即使需要输出大量 commands，也要完整输出，禁止 "(略)" / "(后续类似)" 敷衍。\n` +
      `5. **直接 JSON**：一个合法 JSON 对象，只含 commands 数组；不要 text/memory/action_options/代码围栏/解释/思维链。\n` +
      `</字段补齐任务>\n\n` +
      `缺失清单（重复一次以便对齐）：\n${variables.MISSING_FIELDS_SUMMARY}\n\n` +
      `现在请输出 commands JSON。`,
    );

    const finalUserContent = retryParts.join('\n\n');

    const finalMessages: AIMessage[] = [
      ...assembled.messages,
      { role: 'user', content: finalUserContent },
    ];
    const finalSources = [...assembled.messageSources, 'current_input'];
    const generationId = `fieldRepair_${attempt}_${Date.now()}`;

    emitPromptAssemblyDebug({
      flow: `fieldRepair#${attempt}`,
      variables,
      messages: finalMessages,
      messageSources: finalSources,
      generationId,
    });

    const rawResponse = await this.aiService.generate({
      messages: finalMessages,
      usageType: 'field_repair',
    });

    emitPromptResponseDebug({
      flow: `fieldRepair#${attempt}`,
      generationId,
      thinking: extractThinkingFromRaw(rawResponse),
      rawResponse,
    });

    const parsed = this.responseParser.parse(rawResponse);
    if (!parsed.commands || parsed.commands.length === 0) {
      console.warn(`[FieldRepair] Attempt ${attempt}: AI returned no commands`);
      return;
    }

    const result = this.commandExecutor.executeBatch(parsed.commands);
    console.log(
      `[FieldRepair] Attempt ${attempt}: applied ${parsed.commands.length} commands ` +
      `(${result.hasErrors ? 'some errors' : 'all ok'})`,
    );
    appendChangesToLastNarrative(
      this.stateManager,
      this.paths,
      'fieldRepair',
      result.changeLog.changes,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  //  Context building helpers
  // ═══════════════════════════════════════════════════════════════

  /**
   * Build the same variable bag used by step-2 context-assembly, plus the
   * repair-specific `MISSING_FIELDS_SUMMARY`. We intentionally skip CoT /
   * Engram plugin vars — the repair prompt doesn't reference them.
   */
  private buildVariables(report: FieldRepairReport, skipShortTerm: boolean = false): Record<string, string> {
    const gameStateJson = this.buildGameStateJson();
    const memoryBlock = this.buildMemoryBlock(skipShortTerm);
    return {
      PLAYER_NAME: this.stateManager.get<string>(this.paths.playerName) ?? '',
      CURRENT_LOCATION: this.stateManager.get<string>(this.paths.playerLocation) ?? '',
      GAME_STATE_JSON: gameStateJson,
      MEMORY_BLOCK: memoryBlock,
      USER_INPUT: '',
      MISSING_FIELDS_SUMMARY: formatMissingFieldsSummary(report),
    };
  }

  /** Snapshot the state tree — sanitized (strips narrative history, memory, engram, etc.). */
  private buildGameStateJson(): string {
    try {
      const nsfwMode = this.stateManager.get<boolean>('系统.nsfwMode') === true;
      return stringifySnapshotForPrompt(this.stateManager.toSnapshot(), nsfwMode, 0);
    } catch {
      return '{}';
    }
  }

  /**
   * Minimal memory block — prefers MemoryRetriever when available; otherwise
   * falls back to a short summary from 记忆.短期 to keep the repair prompt
   * grounded without re-implementing the full retrieval stage.
   */
  private buildMemoryBlock(skipShortTerm: boolean = false): string {
    if (this.memoryRetriever) {
      try {
        const retrieved = this.memoryRetriever.retrieve(this.stateManager, skipShortTerm ? { skipShortTerm } : undefined);
        if (retrieved && retrieved.trim()) return retrieved;
      } catch {
        // swallow — fall through to short-term fallback
      }
    }
    const shortTerm = this.stateManager.get<unknown[]>('记忆.短期') ?? [];
    if (!Array.isArray(shortTerm) || shortTerm.length === 0) return '（暂无短期记忆）';
    return shortTerm
      .slice(-8)
      .map((m) => {
        if (typeof m === 'string') return `- ${m}`;
        if (m && typeof m === 'object') {
          const content = (m as Record<string, unknown>)['内容'] ?? (m as Record<string, unknown>)['content'];
          return typeof content === 'string' ? `- ${content}` : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Load the last few-shot pairs from narrative history, wrapped with the
   * same XML tags `context-assembly` uses, so the AI sees a coherent format.
   */
  private loadChatHistory(): AIMessage[] {
    const narrativeHistory = this.stateManager.get<NarrativeEntry[]>(this.paths.narrativeHistory);
    if (!Array.isArray(narrativeHistory) || narrativeHistory.length === 0) return [];

    // Recent narrative as CONTEXT for the repair call. Constant since 2026-09-04
    // (Context Compiler v1, PO decision Q3 removed the player setting).
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

  /**
   * Simple system context for when no field repair prompt flow is available.
   * Used when only entity enrichment and/or edge review need to run.
   */
  private buildSimpleMessages(chatHistory: AIMessage[], skipShortTerm: boolean = false): AIMessage[] {
    const gameStateJson = this.buildGameStateJson();
    const memoryBlock = this.buildMemoryBlock(skipShortTerm);
    const systemContent =
      `## 当前游戏状态\n\n\`\`\`json\n${gameStateJson}\n\`\`\`\n\n` +
      `## 记忆摘要\n\n${memoryBlock}`;
    return [{ role: 'system', content: systemContent }, ...chatHistory];
  }

  // ═══════════════════════════════════════════════════════════════
  //  Default prompt templates (used when pack doesn't override)
  // ═══════════════════════════════════════════════════════════════

  private buildDefaultEntityEnrichPrompt(nameList: string): string {
    return (
      `<实体描述补全任务>\n` +
      `以下实体出现在知识图谱的事实边中，但系统中缺少它们的描述。\n` +
      `请根据游戏状态和最近叙事，为每个实体提供一句简短描述。\n\n` +
      `${nameList}\n\n` +
      `要求：\n` +
      `- 每个实体都必须有 summary\n` +
      `- summary 必须贴合当前游戏世界观和叙事\n` +
      `</实体描述补全任务>`
    );
  }

  private buildDefaultEdgeReviewPrompt(reviewList: string, edgeList: string): string {
    return (
      `<知识边审查任务>\n` +
      `本回合 AI 标记了以下实体对的记忆可能需要更新：\n${reviewList}\n\n` +
      `以下是这些实体对之间的全部已有知识边：\n${edgeList}\n\n` +
      `请判断每条边的状态：\n` +
      `- "keep"：事实仍然成立\n` +
      `- "invalidate"：事实已不成立\n` +
      `</知识边审查任务>`
    );
  }
}
