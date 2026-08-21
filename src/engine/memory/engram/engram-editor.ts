/**
 * EngramEditor — CRUD API for user-driven entity/edge editing
 *
 * Story 1 of Game Card Epic.
 *
 * Design:
 * - All write operations go through `engramManager.withWriteLock(fn)` for
 *   concurrency safety against the main-round pipeline.
 * - Internal `getCurrentRound()` reads from stateManager; the public API
 *   never requires or exposes currentRound.
 * - `loadEngram()` / `saveEngram()` read/write the state path
 *   `系统.扩展.engramMemory` via stateManager.
 */
// App doc: docs/user-guide/pages/game-relationship-graph.md
import type { StateManager } from '../../core/state-manager';
import type { EngramEdge } from './knowledge-edge';
import { engramEdgeId } from './knowledge-edge';
import type { EngramEntity } from './entity-builder';
import { inferEntityType } from './entity-builder';
import type { EngramRelation } from './engram-types';
import type { EngramEventNode } from './event-builder';

// ─── Minimal interface for EngramManager methods we depend on ───
// Using an interface instead of importing the class avoids coupling to its
// full dependency tree and keeps the door open for test doubles.

export interface EngramManagerLike {
  withWriteLock<T>(fn: () => T | Promise<T>): Promise<T>;
  vectorizePending(stateManager: StateManager): Promise<{ vectorized: number }>;
  deleteEdgeVectors(edgeIds: string[]): Promise<void>;
  deleteEntityVectors(names: string[]): Promise<void>;
}

// ─── Engram state shape (matches engram-manager.ts private interface) ───

interface EngramStateData {
  events: EngramEventNode[];
  entities: EngramEntity[];
  relations: EngramRelation[];
  v2Edges: EngramEdge[];
  meta: {
    lastUpdated: number;
    eventCount: number;
    embeddedEventCount: number;
    embeddedEntityCount: number;
    schemaVersion: number;
    v2PendingReview?: Array<{ newFact: string; oldEdgeId: string; similarity: number }> | null;
  };
}

// ─── Error codes ───

export enum EngramEditError {
  NAME_EMPTY = 'name_empty',
  NAME_DUPLICATE = 'name_duplicate',
  FACT_TOO_SHORT = 'fact_too_short',
  EDGE_EXISTS = 'edge_exists',
  NO_ENTITY = 'no_entity',
  ENTITY_NOT_FOUND = 'entity_not_found',
  EDGE_NOT_FOUND = 'edge_not_found',
  RENAME_CONFLICT = 'rename_conflict',
}

// ─── Input types ───

export interface NewEngramEntity {
  name: string;
  type?: EngramEntity['type'];
  summary?: string;
  attributes?: Record<string, unknown>;
}

export interface NewKnowledgeEdge {
  sourceEntity: string;
  targetEntity: string;
  fact: string;
  core?: boolean;
  confidence?: number;
  source?: EngramEdge['source'];
}

interface VectorizeOpts {
  vectorize?: 'immediate';
}

interface DeleteEntityOpts {
  cascade?: boolean;
}

interface BulkEdgeOpts {
  defaultCore?: boolean;
  defaultSource?: EngramEdge['source'];
}

// ─── Result types ───

interface BulkResult<T> {
  created: T[];
  skipped: Array<{ input: unknown; reason: string }>;
}

export interface CoverageStats {
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

// ─── Constants ───

const MIN_FACT_LENGTH = 10;

function normalizeLocationRecords(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw.filter(x => x && typeof x === 'object');
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.values(raw as Record<string, unknown>)
      .filter((v): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v));
  }
  return [];
}

/** Dot-path read over a plain tree (no StateManager) — for save-agnostic analytics. */
function readTreePath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// ─── EngramEditor ───

export class EngramEditor {
  private readonly stateManager: StateManager;
  private readonly engramManager: EngramManagerLike;

  private readonly engramPath: string;
  private readonly roundNumberPath: string;
  private readonly relationshipsPath: string;
  private readonly locationsPath: string;
  private readonly npcNameField: string;
  private readonly npcTypeField: string;
  private readonly npcTypeExclude: string;
  private readonly locationNameField: string;

  constructor(
    stateManager: StateManager,
    engramManager: EngramManagerLike,
    pathOverrides?: {
      engramMemory?: string;
      roundNumber?: string;
      relationships?: string;
      locations?: string;
      npcNameField?: string;
      npcTypeField?: string;
      npcTypeExclude?: string;
      locationNameField?: string;
    },
  ) {
    this.stateManager = stateManager;
    this.engramManager = engramManager;
    this.engramPath = pathOverrides?.engramMemory ?? '系统.扩展.engramMemory';
    this.roundNumberPath = pathOverrides?.roundNumber ?? '元数据.回合序号';
    this.relationshipsPath = pathOverrides?.relationships ?? '社交.关系';
    this.locationsPath = pathOverrides?.locations ?? '世界.地点信息';
    this.npcNameField = pathOverrides?.npcNameField ?? '名称';
    this.npcTypeField = pathOverrides?.npcTypeField ?? '类型';
    this.npcTypeExclude = pathOverrides?.npcTypeExclude ?? '普通';
    this.locationNameField = pathOverrides?.locationNameField ?? '名称';
  }

  // ─── Entity CRUD ───

  async createEntity(
    input: NewEngramEntity,
    opts?: VectorizeOpts,
  ): Promise<EngramEntity> {
    const entity = await this.engramManager.withWriteLock(() => {
      const name = input.name.trim();
      if (!name) throw new Error(EngramEditError.NAME_EMPTY);

      const engram = this.loadEngram();
      if (engram.entities.some((e) => e.name === name)) {
        throw new Error(EngramEditError.NAME_DUPLICATE);
      }

      const round = this.getCurrentRound();
      const created: EngramEntity = {
        name,
        type: input.type ?? inferEntityType(name),
        summary: input.summary ?? '',
        attributes: input.attributes ?? {},
        firstSeen: round,
        lastSeen: round,
        mentionCount: 0,
        is_embedded: false,
        source: 'user',
      };

      engram.entities.push(created);
      engram.meta.lastUpdated = Date.now();
      this.saveEngram(engram);

      return created;
    });

    if (opts?.vectorize === 'immediate') {
      await this.vectorizePending();
    }

    return entity;
  }

  async updateEntity(
    name: string,
    patch: Partial<Pick<EngramEntity, 'summary' | 'type' | 'attributes'>>,
  ): Promise<EngramEntity> {
    return this.engramManager.withWriteLock(() => {
      const engram = this.loadEngram();
      const idx = engram.entities.findIndex((e) => e.name === name);
      if (idx === -1) throw new Error(EngramEditError.ENTITY_NOT_FOUND);

      const entity = { ...engram.entities[idx] };

      if (patch.summary !== undefined && patch.summary !== entity.summary) {
        entity.summary = patch.summary;
        entity.is_embedded = false;
      }
      if (patch.type !== undefined) entity.type = patch.type;
      if (patch.attributes !== undefined) {
        entity.attributes = { ...entity.attributes, ...patch.attributes };
      }

      entity.source = 'user';
      entity.userEditedAtRound = this.getCurrentRound();

      engram.entities[idx] = entity;
      engram.meta.lastUpdated = Date.now();
      this.saveEngram(engram);

      return entity;
    });
  }

  async renameEntity(
    oldName: string,
    newName: string,
  ): Promise<{ entity: EngramEntity; updatedEdgeCount: number }> {
    return this.engramManager.withWriteLock(async () => {
      const trimmed = newName.trim();
      if (!trimmed) throw new Error(EngramEditError.NAME_EMPTY);

      const engram = this.loadEngram();
      const idx = engram.entities.findIndex((e) => e.name === oldName);
      if (idx === -1) throw new Error(EngramEditError.ENTITY_NOT_FOUND);

      if (trimmed !== oldName && engram.entities.some((e) => e.name === trimmed)) {
        throw new Error(EngramEditError.RENAME_CONFLICT);
      }

      // Cascade update edges
      const oldEdgeIds: string[] = [];
      let updatedEdgeCount = 0;

      for (let i = 0; i < engram.v2Edges.length; i++) {
        const edge = engram.v2Edges[i];
        let src = edge.sourceEntity;
        let tgt = edge.targetEntity;
        let changed = false;

        if (src === oldName) { src = trimmed; changed = true; }
        if (tgt === oldName) { tgt = trimmed; changed = true; }

        if (changed) {
          oldEdgeIds.push(edge.id);
          const newId = engramEdgeId(src, tgt, edge.fact);
          engram.v2Edges[i] = {
            ...edge,
            sourceEntity: src,
            targetEntity: tgt,
            id: newId,
            is_embedded: false,
          };
          updatedEdgeCount++;
        }
      }

      // Update entity. Reset is_embedded: the entity vector is keyed by name,
      // so a rename orphans the old-name vector and leaves the new name with
      // none — re-embed it next round so retrieval can still find it.
      const entity: EngramEntity = {
        ...engram.entities[idx],
        name: trimmed,
        source: 'user',
        userEditedAtRound: this.getCurrentRound(),
        is_embedded: false,
      };
      engram.entities[idx] = entity;
      engram.meta.lastUpdated = Date.now();
      this.saveEngram(engram);

      // Clean old edge vectors + the stale old-name entity vector.
      if (oldEdgeIds.length > 0) {
        await this.engramManager.deleteEdgeVectors(oldEdgeIds);
      }
      if (trimmed !== oldName) {
        await this.engramManager.deleteEntityVectors([oldName]);
      }

      return { entity, updatedEdgeCount };
    });
  }

  async deleteEntity(
    name: string,
    options?: DeleteEntityOpts,
  ): Promise<{ deletedEdgeIds: string[] }> {
    return this.engramManager.withWriteLock(async () => {
      const engram = this.loadEngram();
      const idx = engram.entities.findIndex((e) => e.name === name);
      if (idx === -1) throw new Error(EngramEditError.ENTITY_NOT_FOUND);

      engram.entities.splice(idx, 1);

      const cascade = options?.cascade !== false;
      const removedEdgeIds: string[] = [];

      if (cascade) {
        const remaining: EngramEdge[] = [];
        for (const edge of engram.v2Edges) {
          if (edge.sourceEntity === name || edge.targetEntity === name) {
            removedEdgeIds.push(edge.id);
          } else {
            remaining.push(edge);
          }
        }
        engram.v2Edges = remaining;

        // Clean pendingReview entries referencing removed edges
        if (engram.meta.v2PendingReview) {
          const removedSet = new Set(removedEdgeIds);
          engram.meta.v2PendingReview = engram.meta.v2PendingReview.filter(
            (p) => !removedSet.has(p.oldEdgeId),
          );
        }
      }

      engram.meta.lastUpdated = Date.now();
      this.saveEngram(engram);

      if (removedEdgeIds.length > 0) {
        await this.engramManager.deleteEdgeVectors(removedEdgeIds);
      }
      // Immediately drop the deleted entity's vector instead of waiting for the
      // next-round trimToMatchEvents self-heal (L-2: consume deleteEntityVectors).
      await this.engramManager.deleteEntityVectors([name]);

      return { deletedEdgeIds: removedEdgeIds };
    });
  }

  // ─── Edge CRUD ───

  async createEdge(
    input: NewKnowledgeEdge,
    opts?: VectorizeOpts,
  ): Promise<{ edge: EngramEdge; autoStubbed?: string[] }> {
    const result = await this.engramManager.withWriteLock(() => {
      const engram = this.loadEngram();
      const src = input.sourceEntity.trim();
      const tgt = input.targetEntity.trim();

      // C3 strict mode: check entity existence
      const srcExists = engram.entities.some((e) => e.name === src);
      const tgtExists = engram.entities.some((e) => e.name === tgt);

      if (!srcExists && !tgtExists) {
        throw new Error(EngramEditError.NO_ENTITY);
      }

      // I1 fix: validate fact length BEFORE auto-stub to avoid orphaned stubs on throw
      if (input.fact.length < MIN_FACT_LENGTH) {
        throw new Error(EngramEditError.FACT_TOO_SHORT);
      }

      // Check duplicate ID
      const id = engramEdgeId(src, tgt, input.fact);
      if (engram.v2Edges.some((e) => e.id === id)) {
        throw new Error(EngramEditError.EDGE_EXISTS);
      }

      // Auto-stub missing endpoint (after all validation passes)
      const autoStubbed: string[] = [];
      const round = this.getCurrentRound();

      if (!srcExists) {
        engram.entities.push(this.makeStubEntity(src, round));
        autoStubbed.push(src);
      }
      if (!tgtExists) {
        engram.entities.push(this.makeStubEntity(tgt, round));
        autoStubbed.push(tgt);
      }

      const edge: EngramEdge = {
        id,
        sourceEntity: src,
        targetEntity: tgt,
        fact: input.fact,
        episodes: [],
        is_embedded: false,
        createdAtRound: round,
        lastSeenRound: round,
        learnedAtRound: round,
        core: input.core,
        source: 'user',
      };

      engram.v2Edges.push(edge);
      engram.meta.lastUpdated = Date.now();
      this.saveEngram(engram);

      return {
        edge,
        autoStubbed: autoStubbed.length > 0 ? autoStubbed : undefined,
      };
    });

    if (opts?.vectorize === 'immediate') {
      await this.vectorizePending();
    }

    return result;
  }

  async updateEdge(
    edgeId: string,
    patch: Partial<Pick<EngramEdge, 'fact' | 'sourceEntity' | 'targetEntity' | 'core' | 'confidence'>>,
  ): Promise<{ edge: EngramEdge; oldEdgeId?: string }> {
    return this.engramManager.withWriteLock(async () => {
      const engram = this.loadEngram();
      const idx = engram.v2Edges.findIndex((e) => e.id === edgeId);
      if (idx === -1) throw new Error(EngramEditError.EDGE_NOT_FOUND);

      const existing = engram.v2Edges[idx];
      const newFact = patch.fact ?? existing.fact;
      const newSrc = patch.sourceEntity ?? existing.sourceEntity;
      const newTgt = patch.targetEntity ?? existing.targetEntity;

      // Validate fact length if changed
      if (patch.fact !== undefined && newFact.length < MIN_FACT_LENGTH) {
        throw new Error(EngramEditError.FACT_TOO_SHORT);
      }

      const identityChanged =
        newFact !== existing.fact ||
        newSrc !== existing.sourceEntity ||
        newTgt !== existing.targetEntity;

      let oldId: string | undefined;
      let newId = edgeId;

      if (identityChanged) {
        oldId = edgeId;
        newId = engramEdgeId(newSrc, newTgt, newFact);
      }

      const edge: EngramEdge = {
        ...existing,
        id: newId,
        fact: newFact,
        sourceEntity: newSrc,
        targetEntity: newTgt,
        is_embedded: identityChanged ? false : existing.is_embedded,
        source: 'user',
        ...(patch.core !== undefined ? { core: patch.core } : {}),
        ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      };

      engram.v2Edges[idx] = edge;
      engram.meta.lastUpdated = Date.now();
      this.saveEngram(engram);

      // Clean old vectors if identity changed
      if (oldId) {
        await this.engramManager.deleteEdgeVectors([oldId]);
      }

      return { edge, oldEdgeId: oldId };
    });
  }

  async deleteEdge(edgeId: string): Promise<void> {
    return this.engramManager.withWriteLock(async () => {
      const engram = this.loadEngram();
      const idx = engram.v2Edges.findIndex((e) => e.id === edgeId);
      if (idx === -1) throw new Error(EngramEditError.EDGE_NOT_FOUND);

      engram.v2Edges.splice(idx, 1);

      // Clean pendingReview entries referencing this edge
      if (engram.meta.v2PendingReview) {
        engram.meta.v2PendingReview = engram.meta.v2PendingReview.filter(
          (p) => p.oldEdgeId !== edgeId,
        );
      }

      engram.meta.lastUpdated = Date.now();
      this.saveEngram(engram);

      await this.engramManager.deleteEdgeVectors([edgeId]);
    });
  }

  async markEdgeCore(edgeId: string, core: boolean): Promise<EngramEdge> {
    return this.engramManager.withWriteLock(() => {
      const engram = this.loadEngram();
      const idx = engram.v2Edges.findIndex((e) => e.id === edgeId);
      if (idx === -1) throw new Error(EngramEditError.EDGE_NOT_FOUND);

      const edge: EngramEdge = {
        ...engram.v2Edges[idx],
        core,
      };

      engram.v2Edges[idx] = edge;
      engram.meta.lastUpdated = Date.now();
      this.saveEngram(engram);

      return edge;
    });
  }

  // ─── Bulk operations ───

  async bulkCreateEntities(
    inputs: NewEngramEntity[],
  ): Promise<BulkResult<EngramEntity>> {
    return this.engramManager.withWriteLock(() => {
      const engram = this.loadEngram();
      const round = this.getCurrentRound();
      const existingNames = new Set(engram.entities.map((e) => e.name));

      const created: EngramEntity[] = [];
      const skipped: Array<{ input: unknown; reason: string }> = [];

      for (const input of inputs) {
        const name = input.name.trim();
        if (!name) {
          skipped.push({ input, reason: EngramEditError.NAME_EMPTY });
          continue;
        }
        if (existingNames.has(name)) {
          skipped.push({ input, reason: EngramEditError.NAME_DUPLICATE });
          continue;
        }

        const entity: EngramEntity = {
          name,
          type: input.type ?? inferEntityType(name),
          summary: input.summary ?? '',
          attributes: input.attributes ?? {},
          firstSeen: round,
          lastSeen: round,
          mentionCount: 0,
          is_embedded: false,
          source: 'user',
        };

        engram.entities.push(entity);
        existingNames.add(name);
        created.push(entity);
      }

      if (created.length > 0) {
        engram.meta.lastUpdated = Date.now();
        this.saveEngram(engram);
      }

      return { created, skipped };
    });
  }

  async bulkCreateEdges(
    inputs: NewKnowledgeEdge[],
    options?: BulkEdgeOpts,
  ): Promise<BulkResult<EngramEdge>> {
    return this.engramManager.withWriteLock(() => {
      const engram = this.loadEngram();
      const round = this.getCurrentRound();
      const entityNames = new Set(engram.entities.map((e) => e.name));
      const edgeIds = new Set(engram.v2Edges.map((e) => e.id));

      const created: EngramEdge[] = [];
      const skipped: Array<{ input: unknown; reason: string }> = [];

      for (const input of inputs) {
        const src = input.sourceEntity.trim();
        const tgt = input.targetEntity.trim();

        // C3 strict: both missing → skip
        const srcExists = entityNames.has(src);
        const tgtExists = entityNames.has(tgt);

        if (!srcExists && !tgtExists) {
          skipped.push({ input, reason: EngramEditError.NO_ENTITY });
          continue;
        }

        if (input.fact.length < MIN_FACT_LENGTH) {
          skipped.push({ input, reason: EngramEditError.FACT_TOO_SHORT });
          continue;
        }

        // Auto-stub missing endpoint
        if (!srcExists) {
          engram.entities.push(this.makeStubEntity(src, round));
          entityNames.add(src);
        }
        if (!tgtExists) {
          engram.entities.push(this.makeStubEntity(tgt, round));
          entityNames.add(tgt);
        }

        const id = engramEdgeId(src, tgt, input.fact);
        if (edgeIds.has(id)) {
          skipped.push({ input, reason: EngramEditError.EDGE_EXISTS });
          continue;
        }

        const edge: EngramEdge = {
          id,
          sourceEntity: src,
          targetEntity: tgt,
          fact: input.fact,
          episodes: [],
          is_embedded: false,
          createdAtRound: round,
          lastSeenRound: round,
          learnedAtRound: round,
          core: input.core ?? options?.defaultCore,
          source: input.source ?? options?.defaultSource ?? 'user',
        };

        engram.v2Edges.push(edge);
        edgeIds.add(id);
        created.push(edge);
      }

      if (created.length > 0) {
        engram.meta.lastUpdated = Date.now();
        this.saveEngram(engram);
      }

      return { created, skipped };
    });
  }

  async bulkMarkEdgesCore(
    edgeIds: string[],
    core: boolean,
  ): Promise<{ updated: number; notFound: string[] }> {
    return this.engramManager.withWriteLock(() => {
      const engram = this.loadEngram();
      const edgeMap = new Map(engram.v2Edges.map((e, i) => [e.id, i]));

      let updated = 0;
      const notFound: string[] = [];

      for (const id of edgeIds) {
        const idx = edgeMap.get(id);
        if (idx === undefined) {
          notFound.push(id);
          continue;
        }
        engram.v2Edges[idx] = { ...engram.v2Edges[idx], core };
        updated++;
      }

      if (updated > 0) {
        engram.meta.lastUpdated = Date.now();
        this.saveEngram(engram);
      }

      return { updated, notFound };
    });
  }

  // ─── Analytics (read-only, no write lock — best-effort / eventually consistent) ───

  getCoverageStats(): CoverageStats {
    return this.computeCoverage(
      this.loadEngram(),
      this.stateManager.get<unknown>(this.relationshipsPath),
      this.stateManager.get<unknown>(this.locationsPath),
    );
  }

  /**
   * Save-agnostic variant (Story 7 save-to-card): same coverage stats computed
   * from an arbitrary persisted state tree (e.g. a non-active save returned by
   * SaveManager.loadGame) instead of the live StateManager. Shares paths/field
   * config and the exact computation with getCoverageStats().
   */
  getCoverageStatsForTree(tree: Record<string, unknown>): CoverageStats {
    return this.computeCoverage(
      this.normalizeEngram(readTreePath(tree, this.engramPath)),
      readTreePath(tree, this.relationshipsPath),
      readTreePath(tree, this.locationsPath),
    );
  }

  private computeCoverage(
    engram: EngramStateData,
    rawRelationships: unknown,
    rawLocations: unknown,
  ): CoverageStats {
    const properEntities = engram.entities.filter(e => !e._pendingEnrichment);
    const properEntityNames = new Set(properEntities.map(e => e.name));

    // NPC coverage (exclude npcTypeExclude='普通', consistent with EntityBuilder entity-builder.ts:131)
    const relationships = Array.isArray(rawRelationships)
      ? (rawRelationships as Array<Record<string, unknown>>)
      : [];

    const npcNames: string[] = [];
    for (const npc of relationships) {
      const name = npc[this.npcNameField];
      if (typeof name !== 'string' || !name.trim()) continue;
      if (npc[this.npcTypeField] === this.npcTypeExclude) continue;
      npcNames.push(name.trim());
    }

    const missingNpcNames = npcNames.filter(n => !properEntityNames.has(n));

    // Location coverage — 世界.地点信息 is Record<id, LocationItem>, not array
    const locationRecords = normalizeLocationRecords(rawLocations);

    const locationNames: string[] = [];
    for (const loc of locationRecords) {
      const name = loc[this.locationNameField];
      if (typeof name === 'string' && name.trim()) {
        locationNames.push(name.trim());
      }
    }

    const locationEntityNames = new Set(
      properEntities.filter(e => e.type === 'location').map(e => e.name),
    );
    const missingLocationNames = locationNames.filter(n => !locationEntityNames.has(n));

    // Edge source distribution
    const edges = engram.v2Edges;
    const edgesBySource = {
      opening: 0,
      user: 0,
      // Canon Capture projections. Counted separately from `user` (hand-authored in the
      // graph editor) because they are owned by a world-book entry — lumping them into
      // `legacy` would have hidden the whole feature from the coverage panel.
      'user-canon': 0,
      'batch-sync': 0,
      'card-import': 0,
      legacy: 0,
    };
    for (const edge of edges) {
      if (edge.source === 'opening') edgesBySource.opening++;
      else if (edge.source === 'user') edgesBySource.user++;
      else if (edge.source === 'user-canon') edgesBySource['user-canon']++;
      else if (edge.source === 'batch-sync') edgesBySource['batch-sync']++;
      else if (edge.source === 'card-import') edgesBySource['card-import']++;
      else edgesBySource.legacy++; // undefined or 'ai'
    }

    return {
      totalNpcs: npcNames.length,
      npcsWithEntity: npcNames.length - missingNpcNames.length,
      missingNpcNames,
      coveragePercent: npcNames.length === 0
        ? 100
        : Math.round(((npcNames.length - missingNpcNames.length) / npcNames.length) * 100),
      totalLocations: locationNames.length,
      locationsWithEntity: locationNames.length - missingLocationNames.length,
      missingLocationNames,
      locationCoveragePercent: locationNames.length === 0
        ? 100
        : Math.round(((locationNames.length - missingLocationNames.length) / locationNames.length) * 100),
      totalEdges: edges.length,
      edgesBySource,
    };
  }

  // ─── Vectorization delegate ───

  async vectorizePending(): Promise<{ vectorized: number }> {
    return this.engramManager.vectorizePending(this.stateManager);
  }

  // ─── Private helpers ───

  private getCurrentRound(): number {
    return this.stateManager.get<number>(this.roundNumberPath) ?? 0;
  }

  private loadEngram(): EngramStateData {
    return this.normalizeEngram(this.stateManager.get<Partial<EngramStateData>>(this.engramPath));
  }

  private normalizeEngram(rawValue: unknown): EngramStateData {
    const raw =
      rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
        ? (rawValue as Partial<EngramStateData>)
        : undefined;
    if (raw && Array.isArray(raw.events)) {
      return {
        events: raw.events,
        entities: Array.isArray(raw.entities) ? raw.entities : [],
        relations: Array.isArray(raw.relations) ? raw.relations : [],
        v2Edges: Array.isArray(raw.v2Edges) ? raw.v2Edges : [],
        meta: {
          lastUpdated: raw.meta?.lastUpdated ?? 0,
          eventCount: raw.meta?.eventCount ?? raw.events.length,
          embeddedEventCount: raw.meta?.embeddedEventCount ?? 0,
          embeddedEntityCount: raw.meta?.embeddedEntityCount ?? 0,
          schemaVersion: raw.meta?.schemaVersion ?? 1,
          v2PendingReview: raw.meta?.v2PendingReview ?? null,
        },
      };
    }
    return {
      events: [],
      entities: [],
      relations: [],
      v2Edges: [],
      meta: {
        lastUpdated: 0,
        eventCount: 0,
        embeddedEventCount: 0,
        embeddedEntityCount: 0,
        schemaVersion: 5,
        v2PendingReview: null,
      },
    };
  }

  private saveEngram(engram: EngramStateData): void {
    this.stateManager.set(this.engramPath, engram, 'system');
  }

  private makeStubEntity(name: string, round: number): EngramEntity {
    return {
      name,
      type: inferEntityType(name),
      summary: '',
      attributes: {},
      firstSeen: round,
      lastSeen: round,
      mentionCount: 0,
      is_embedded: false,
      source: 'user',
      _pendingEnrichment: true,
    };
  }
}
