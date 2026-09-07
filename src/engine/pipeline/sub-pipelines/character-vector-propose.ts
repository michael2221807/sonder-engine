// App doc: docs/user-guide/pages/game-relationships.md §人物向量 (world-written proposals)
// Design: docs/design/character-vector-v1-implementation-plan.md S7 · G-V gate in docs/research/textual-open-world-r2-contract-ab.md §3.7
/**
 * Character Vector proposal sub-pipeline (R2 second half, 2026-09-06).
 *
 * The "world writes, the player edits" half of the feature: after the mid-term memory
 * refine (and on a fixed cadence in between), the model reads exactly what the refine
 * saw — contract, main-cast profiles, memory, the last narrative turns, the vectors that
 * already exist — and proposes `{name, toward, never, direction, hidden}` for the main
 * cast members that have RECENT MATERIAL (named in the mid-term entries). Proposals land
 * as `source: 'proposed'` entries that inject immediately; the player deletes or edits
 * them in the relationships panel, never "accepts" (PO decision 2026-09-05).
 *
 * Merge rules (plan §7): a player-written entry (`source: 'player'`) is never overwritten;
 * a proposed entry is replaced by the new proposal; unknown names are dropped; the
 * protagonist is never written. Everything is bounded by the same normaliser the reader
 * uses, so a wild response cannot smuggle an over-long line into the state tree.
 *
 * Gate evidence (G-V, §3.7): six extractions, zero hard-rule violations; the two biases
 * found there are handled here — `hidden` is defined against the PROTAGONIST's knowledge
 * in the pack prompt, and candidates are limited by recent material in code.
 */
import type { AIService } from '../../ai/ai-service';
import type { PromptAssembler } from '../../prompt/prompt-assembler';
import type { MidTermEntry } from '../../memory/memory-manager';
import type { IMemoryManager } from '../types';
import type { GamePack } from '../../types';
import type { EnginePathConfig } from '../types';
import type { StateManager } from '../../core/state-manager';
import { extractJsonObjectByKey } from '../../ai/json-extract';
import { emitPromptAssemblyDebug, emitPromptResponseDebug, extractThinkingFromRaw } from '../../core/prompt-debug';
import { logger } from '../../core/logger';
import { buildNarrativeContractFromState, resolveFocalCast } from '../../prompt/narrative-contract';
import {
  readCharacterVectors,
  normalizeCharacterVectorEntry,
  type CharacterVectorEntry,
  type CharacterVectorsState,
} from '../../prompt/character-vectors';

/** Propose every N rounds even when no refine fired (the refine threshold is ~25 entries). */
export const CHARACTER_VECTOR_PROPOSE_INTERVAL = 5;
/** How many recent narrative turns the model sees. */
const RECENT_NARRATIVE_TURNS = 2;
/** How many mid-term entries at most (the newest) feed one proposal. */
const MAX_MID_TERM_ENTRIES = 25;

interface HistoryEntry { role?: unknown; content?: unknown }

function formatMemory(entries: MidTermEntry[]): string {
  return entries.map((e, i) => {
    const roles = Array.isArray(e.相关角色) && e.相关角色.length > 0 ? `【相关角色: ${e.相关角色.join('、')}】` : '';
    const time = e.事件时间 && e.事件时间.trim() ? `【事件时间: ${e.事件时间.trim()}】` : '';
    return `${i + 1}. ${roles}${time}${e.记忆主体 ?? ''}`;
  }).join('\n');
}

export class CharacterVectorProposePipeline {
  constructor(
    private aiService: AIService,
    private promptAssembler: PromptAssembler,
    private stateManager: StateManager,
    private memoryManager: IMemoryManager,
    private gamePack: GamePack,
    private paths: EnginePathConfig,
  ) {}

  /** Whether the cadence trigger fires this round (independent of the refine trigger). */
  static isCadenceRound(round: number): boolean {
    return round > 0 && round % CHARACTER_VECTOR_PROPOSE_INTERVAL === 0;
  }

  /**
   * Run one proposal. Returns true when the state was updated, false on no-op (switch
   * off, no candidates, no flow) or failure. Never throws.
   */
  async execute(): Promise<boolean> {
    const current = readCharacterVectors(this.stateManager, this.paths);
    if (!current.enabled) return false;
    const flow = this.gamePack.promptFlows['characterVectorExtract'];
    if (!flow) {
      logger.warn('[CharacterVectors] No "characterVectorExtract" prompt flow in Game Pack');
      return false;
    }

    const playerName = this.stateManager.get<string>(this.paths.playerName) ?? '';
    const relationships = this.stateManager.get<unknown>(this.paths.relationships);
    const cast = resolveFocalCast(relationships, this.paths).filter((n) => n !== playerName);
    const midTerm = this.memoryManager.getMidTermEntries().slice(-MAX_MID_TERM_ENTRIES);
    const recentNames = new Set<string>();
    for (const e of midTerm) for (const r of e.相关角色 ?? []) recentNames.add(r);
    const candidates = cast.filter((n) => recentNames.has(n));
    if (candidates.length === 0) {
      logger.debug('[CharacterVectors] no main-cast member with recent material — skip');
      return false;
    }

    const F = this.paths.npcFieldNames;
    const profiles = (Array.isArray(relationships) ? relationships : [])
      .filter((r): r is Record<string, unknown> => r != null && typeof r === 'object' && candidates.includes(String((r as Record<string, unknown>)[F.name] ?? '')))
      .map((r) => {
        const pick = (k: string): string => {
          const v = r[k];
          if (v === undefined || v === null || v === '') return '';
          return `${k}：${Array.isArray(v) ? v.join('、') : String(v)}`;
        };
        return `- ${String(r[F.name])}｜` + [pick(F.type), pick(F.affinity), pick(F.description), pick(F.background), pick(F.innerThought), pick(F.currentActivity)].filter(Boolean).join('；');
      }).join('\n');

    const { block: contractBlock } = buildNarrativeContractFromState(this.stateManager, this.paths, this.gamePack.engineFragments);
    const longTerm = this.memoryManager.getLongTermEntries();
    const history = this.stateManager.get<HistoryEntry[]>(this.paths.narrativeHistory) ?? [];
    const recent = history.filter((h) => h.role === 'assistant' && typeof h.content === 'string').slice(-RECENT_NARRATIVE_TURNS)
      .map((h, i) => `--- ${i + 1} ---\n${String(h.content)}`).join('\n');
    const existing = current.entries.filter((e) => candidates.includes(e.name))
      .map((e) => JSON.stringify({ name: e.name, toward: e.toward, never: e.never, direction: e.direction, hidden: e.hidden, source: e.source }))
      .join('\n');

    const variables: Record<string, string> = {
      PLAYER_NAME: playerName,
      CANDIDATE_NAMES: candidates.join('、'),
      CONTRACT_BLOCK: contractBlock,
      CAST_PROFILES: profiles,
      LONG_TERM_MEMORY: longTerm.map((e, i) => `${i + 1}. 【${e.category}】${e.content}`).join('\n'),
      MID_TERM_MEMORY: formatMemory(midTerm),
      RECENT_NARRATIVE: recent,
      EXISTING_VECTORS: existing,
    };

    const assembled = this.promptAssembler.assemble(flow, variables);
    const generationId = `characterVectorExtract_${Date.now()}`;
    emitPromptAssemblyDebug({ flow: 'characterVectorExtract', variables, messages: assembled.messages, messageSources: assembled.messageSources, generationId });

    let raw: string;
    try {
      raw = await this.aiService.generate({ messages: assembled.messages, usageType: 'memory_summary' });
    } catch (err) {
      logger.error('[CharacterVectors] proposal call failed', err);
      return false;
    }
    emitPromptResponseDebug({ flow: 'characterVectorExtract', generationId, thinking: extractThinkingFromRaw(raw), rawResponse: raw });

    const proposals = this.parse(raw, candidates, playerName);
    if (proposals.length === 0) {
      logger.warn('[CharacterVectors] response carried no usable vectors');
      return false;
    }
    const round = this.stateManager.get<number>(this.paths.roundNumber) ?? 0;
    const { next, applied } = mergeProposals(current, proposals, round);
    if (applied === 0) {
      logger.debug('[CharacterVectors] every proposal targeted a player-written entry — nothing to write');
      return false;
    }
    this.stateManager.set(this.paths.characterVectors, next, 'system');
    logger.debug(`[CharacterVectors] ${applied} proposals merged (entries now ${next.entries.length})`);
    return true;
  }

  /** Parse `{"vectors":[…]}`; keep only candidates, never the protagonist. */
  private parse(raw: string, candidates: readonly string[], playerName: string): CharacterVectorEntry[] {
    const obj = extractJsonObjectByKey(raw, 'vectors');
    const list = obj && Array.isArray(obj['vectors']) ? (obj['vectors'] as unknown[]) : [];
    const out: CharacterVectorEntry[] = [];
    const seen = new Set<string>();
    list.forEach((item, i) => {
      const e = normalizeCharacterVectorEntry(item, i);
      if (!e || e.name === playerName || !candidates.includes(e.name) || seen.has(e.name)) return;
      if (!(e.toward || e.never || e.direction || e.hidden)) return;
      seen.add(e.name);
      out.push(e);
    });
    return out;
  }
}

/**
 * Merge world proposals into the stored state: player-written entries are untouched,
 * proposed ones are replaced, new names are appended — all as `source: 'proposed'`.
 */
export function mergeProposals(
  current: CharacterVectorsState,
  proposals: readonly CharacterVectorEntry[],
  round: number,
): { next: CharacterVectorsState; applied: number } {
  const byName = new Map(current.entries.map((e) => [e.name, e] as const));
  const entries = [...current.entries];
  let applied = 0;
  for (const p of proposals) {
    const existing = byName.get(p.name);
    if (existing && existing.source !== 'proposed') continue;
    const merged: CharacterVectorEntry = {
      id: existing?.id ?? p.id,
      name: p.name,
      toward: p.toward,
      never: p.never,
      direction: p.direction,
      hidden: p.hidden,
      enabled: existing?.enabled ?? true,
      source: 'proposed',
      updatedRound: round,
    };
    if (existing) {
      const idx = entries.findIndex((e) => e.name === p.name);
      entries[idx] = merged;
    } else {
      entries.push(merged);
    }
    applied += 1;
  }
  return { next: { enabled: current.enabled, entries }, applied };
}
