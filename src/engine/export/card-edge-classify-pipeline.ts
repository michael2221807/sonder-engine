// App doc: docs/user-guide/pages/game-save.md §2.7.2
/**
 * CardEdgeClassifyPipeline — Story 7 (P4): batch-classifies a save's knowledge
 * edges into worldview settings vs plot events (D5) ahead of save-to-card export.
 *
 * First multi-batch AI loop in the project (all precedents are single-call with
 * input caps): edges are chunked into BATCH_SIZE batches, one LLM call each.
 * Failure semantics (U8/SC-11): a failed batch (request error OR unparseable
 * response) degrades that batch to "unclassified" — the UI defaults those to
 * unchecked (U2) — and the loop continues; partial failure never aborts the run.
 * Only an explicit AbortSignal cancellation rejects.
 *
 * Engine purity: the classification prompt lives in the pack (cardEdgeClassify,
 * zh + en) and is rendered via PromptAssembler.renderSingle (user overrides
 * apply). There is deliberately NO engine-side fallback prompt — a missing
 * registration throws instead of widening the inline-Chinese violation surface.
 *
 * Context whitelist (SC-9): the prompt is built ONLY from edge
 * id/sourceEntity/targetEntity/fact/createdAtRound/source, entity
 * name/type/summary, and the caller-provided worldBrief. Callers must never
 * hand this pipeline a full state tree.
 */
import type { AIService } from '../ai/ai-service';
import type { AIMessage } from '../ai/types';
import type { PromptAssembler } from '../prompt/prompt-assembler';
import type { EngramEdge } from '../memory/engram/knowledge-edge';
import type { EngramEntity } from '../memory/engram/entity-builder';
import type { ProgressPayload } from '../services/assistant/types';
import { parseLooseJson } from '../ai/json-extract';

/** Mirrors the edgeReview globalCap precedent (engram-types.ts) — one LLM call per batch. */
const BATCH_SIZE = 40;
/** Token-bounding caps for injected context. */
const ENTITY_SUMMARY_CAP = 120;
const WORLD_BRIEF_CAP = 600;

const PROMPT_ID = 'cardEdgeClassify';

export type EdgeCategory = 'worldview' | 'plot-event';

export interface CardEdgeClassifyInput {
  /** Edges to classify. Caller already excludes core===true edges (U5). */
  edges: EngramEdge[];
  /** Entities of the SAME save — only name/type/summary are ever used. */
  entities: EngramEntity[];
  /** Short world description from the target save (e.g. 世界.描述), pre-trimmed by the caller. */
  worldBrief: string;
}

export interface CardEdgeClassifyResult {
  classified: Map<string, EdgeCategory>;
  /** Edge ids the AI failed to classify (failed batch, omitted, or illegal category) — U2: default unchecked. */
  unclassified: string[];
  failedBatches: number;
  totalBatches: number;
}

interface RawClassification {
  edge_id?: unknown;
  category?: unknown;
}

function isClassificationPayload(v: unknown): v is { edge_classifications: RawClassification[] } {
  return (
    v !== null &&
    typeof v === 'object' &&
    Array.isArray((v as { edge_classifications?: unknown }).edge_classifications)
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Strip whitespace and a single wrapping [ ] pair (models often echo the list markup). */
function normalizeEdgeId(raw: string): string {
  let id = raw.trim();
  if (id.startsWith('[') && id.endsWith(']')) id = id.slice(1, -1).trim();
  return id;
}

export class CardEdgeClassifyPipeline {
  constructor(
    private readonly aiService: AIService,
    private readonly promptAssembler: PromptAssembler,
  ) {}

  async run(
    input: CardEdgeClassifyInput,
    onProgress?: (p: ProgressPayload) => void,
    signal?: AbortSignal,
  ): Promise<CardEdgeClassifyResult> {
    const edges = input.edges.filter((e) => e && typeof e.id === 'string' && e.id.length > 0);
    const result: CardEdgeClassifyResult = {
      classified: new Map<string, EdgeCategory>(),
      unclassified: [],
      failedBatches: 0,
      totalBatches: 0,
    };
    if (edges.length === 0) return result;

    // Pre-flight: a missing pack prompt is a configuration error and must throw
    // loudly — NOT degrade every batch to "unclassified" via the per-batch catch.
    const probe = this.promptAssembler.renderSingle(PROMPT_ID, {
      WORLD_BRIEF: '',
      ENTITY_CONTEXT: '',
      EDGES_LIST: '',
    });
    if (!probe) {
      throw new Error(`[CardEdgeClassifyPipeline] prompt "${PROMPT_ID}" is not registered in the pack`);
    }

    const batches = chunk(edges, BATCH_SIZE);
    result.totalBatches = batches.length;
    const entityByName = new Map(input.entities.map((e) => [e.name, e]));
    const worldBrief = input.worldBrief.slice(0, WORLD_BRIEF_CAP);

    let done = 0;
    for (const batch of batches) {
      throwIfAborted(signal);
      // renderPrompt runs OUTSIDE the try: a missing pack prompt is a config error
      // that must propagate, not be swallowed as a failed batch (e.g. pack hot-reload
      // between the pre-flight probe and here).
      const messages: AIMessage[] = [{ role: 'user', content: this.renderPrompt(batch, entityByName, worldBrief) }];
      try {
        const raw = await this.aiService.generate({
          messages,
          stream: false,
          usageType: 'card_edge_classify',
          temperature: 0.3,
          signal,
        });
        this.applyBatch(raw, batch, result.classified);
      } catch (err) {
        // Cancellation propagates (external signal OR an AbortError from the AIService's
        // own timeout/cancel); any other failure degrades the batch to unclassified.
        if (signal?.aborted || isAbortError(err)) throw err;
        result.failedBatches++;
      }
      done += batch.length;
      onProgress?.({
        i18nKey: 'save.toCard.classify.progress',
        i18nParams: { done, total: edges.length },
        message: `${done}/${edges.length}`,
      });
    }

    // U2 sweep: everything not classified (failed batch / omitted / illegal category)
    // is reported explicitly so the UI can group it as "未分类" (default unchecked).
    for (const e of edges) {
      if (!result.classified.has(e.id)) result.unclassified.push(e.id);
    }
    return result;
  }

  private renderPrompt(
    batch: EngramEdge[],
    entityByName: Map<string, EngramEntity>,
    worldBrief: string,
  ): string {
    // SC-9 boundary: only id/sourceEntity/targetEntity/fact/createdAtRound/source travel —
    // never entity.attributes or edge.episodes (which may hold non-display data). The fact
    // text MAY be NSFW: it reaches the author's OWN configured LLM (same exposure as every
    // game round / batch-solidify). The card's `containsNsfw` flag governs what survives into
    // the SHARED card (scrubbed later in export-service.extractEngram), NOT this authoring-time
    // transmission to the user's own provider.
    const edgeLines = batch
      .map((e) => {
        const source = e.source ?? 'play';
        return `- [${e.id}] ${e.sourceEntity} -> ${e.targetEntity}: ${e.fact} (round:${e.createdAtRound}, source:${source})`;
      })
      .join('\n');

    const seen = new Set<string>();
    const entityLines: string[] = [];
    for (const e of batch) {
      for (const name of [e.sourceEntity, e.targetEntity]) {
        if (seen.has(name)) continue;
        seen.add(name);
        const ent = entityByName.get(name);
        if (!ent) continue;
        const summary = (ent.summary ?? '').slice(0, ENTITY_SUMMARY_CAP);
        entityLines.push(`- ${ent.name} (${ent.type})${summary ? `: ${summary}` : ''}`);
      }
    }

    const rendered = this.promptAssembler.renderSingle(PROMPT_ID, {
      WORLD_BRIEF: worldBrief,
      ENTITY_CONTEXT: entityLines.join('\n'),
      EDGES_LIST: edgeLines,
    });
    if (!rendered) {
      throw new Error(`[CardEdgeClassifyPipeline] prompt "${PROMPT_ID}" is not registered in the pack`);
    }
    return rendered;
  }

  private applyBatch(
    raw: string,
    batch: EngramEdge[],
    classified: Map<string, EdgeCategory>,
  ): void {
    const payload = parseLooseJson(raw, isClassificationPayload);
    if (!payload) throw new Error('[CardEdgeClassifyPipeline] unparseable classification response');

    const exact = new Set(batch.map((e) => e.id));
    const byLower = new Map<string, string>();
    for (const e of batch) {
      const lower = e.id.toLowerCase();
      // Only safe when unique under lowercasing — ambiguous keys are dropped.
      byLower.set(lower, byLower.has(lower) ? '' : e.id);
    }

    for (const item of payload.edge_classifications) {
      if (!item || typeof item.edge_id !== 'string') continue;
      const category = item.category;
      if (category !== 'worldview' && category !== 'plot-event') continue;

      const normalized = normalizeEdgeId(item.edge_id);
      let id: string | undefined;
      if (exact.has(normalized)) {
        id = normalized;
      } else {
        const candidate = byLower.get(normalized.toLowerCase());
        id = candidate || undefined; // unknown or lowercase-ambiguous → ignored
      }
      if (!id) continue;
      if (classified.has(id)) continue; // first answer wins
      classified.set(id, category);
    }
  }
}
