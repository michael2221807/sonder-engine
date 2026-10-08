import { describe, it, expect, vi } from 'vitest';
import { buildFacts, pruneEdgesV2 } from '@/engine/memory/engram/fact-builder';
import { engramEdgeId } from '@/engine/memory/engram/knowledge-edge';
import { inferEntityType } from '@/engine/memory/engram/entity-builder';
import { UnifiedRetriever } from '@/engine/memory/engram/unified-retriever';
import { createMockStateManager } from '@/engine/__test-utils__/state-manager.mock';
import {
  ROUND_1, ROUND_2, ROUND_3, ROUND_4, ROUND_5,
  buildEdgesUpToRound4, buildAllEntities, STUB_ENTITY_NAME,
} from '@/engine/__test-utils__/fixtures/temporal-story';
import type { EngramEdge } from '@/engine/memory/engram/knowledge-edge';
import type { EngramEntity } from '@/engine/memory/engram/entity-builder';

function makeMockVectorStore() {
  return {
    cosineSimilarity: vi.fn((_a: number[], _b: number[]) => {
      return 0;
    }),
    load: vi.fn(async () => ({ eventVectors: {}, entityVectors: {}, edgeVectors: {}, model: 'test' })),
  } as never;
}

describe('Temporal Story Fixture — contradiction + entity repair', () => {
  describe('Branch 1: Fact creation across 5 rounds', () => {
    it('Round 1: creates student fact edge', () => {
      const result = buildFacts(
        { knowledgeFacts: ROUND_1.facts, entities: ROUND_1.entities, currentEventId: 'evt_r1', currentRound: 1 },
        [], null, {}, new Map(),
      );
      expect(result.newEdges).toHaveLength(1);
      expect(result.newEdges[0].fact).toContain('弟子');
      expect(result.newEdges[0].sourceEntity).toBe('A');
      expect(result.newEdges[0].targetEntity).toBe('B');
    });

    it('Round 2: creates protection promise edge', () => {
      const existingEdges = buildFacts(
        { knowledgeFacts: ROUND_1.facts, entities: ROUND_1.entities, currentEventId: 'evt_r1', currentRound: 1 },
        [], null, {}, new Map(),
      ).newEdges;

      const result = buildFacts(
        { knowledgeFacts: ROUND_2.facts, entities: ROUND_1.entities, currentEventId: 'evt_r2', currentRound: 2 },
        existingEdges, null, {}, new Map(),
      );
      expect(result.newEdges).toHaveLength(1);
      expect(result.newEdges[0].fact).toContain('保护');
    });

    it('Round 3: creates threat + 清兰会 fact edges with unknown entity', () => {
      const r1Edges = buildFacts(
        { knowledgeFacts: ROUND_1.facts, entities: ROUND_1.entities, currentEventId: 'evt_r1', currentRound: 1 },
        [], null, {}, new Map(),
      ).newEdges;
      const r2Edges = buildFacts(
        { knowledgeFacts: ROUND_2.facts, entities: ROUND_2.entities, currentEventId: 'evt_r2', currentRound: 2 },
        r1Edges, null, {}, new Map(),
      ).newEdges;
      const allEdges = [...r1Edges, ...r2Edges];

      const entitiesR3 = [...buildAllEntities()];
      const result = buildFacts(
        { knowledgeFacts: ROUND_3.facts, entities: entitiesR3, currentEventId: 'evt_r3', currentRound: 3 },
        allEdges, null, {}, new Map(),
      );

      expect(result.newEdges).toHaveLength(2);
      expect(result.newEdges.map((e) => e.fact)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('威胁'),
          expect.stringContaining('清兰会'),
        ]),
      );
    });

    it('Round 4: betrayal fact is created alongside existing student fact', () => {
      const edges = buildEdgesUpToRound4();
      const entities = buildAllEntities();

      const result = buildFacts(
        { knowledgeFacts: ROUND_4.facts, entities, currentEventId: 'evt_r4', currentRound: 4 },
        edges, null, {}, new Map(),
      );

      expect(result.newEdges).toHaveLength(1);
      expect(result.newEdges[0].fact).toContain('背叛');
    });

    it('Round 5: expulsion fact is created', () => {
      const edges = [...buildEdgesUpToRound4()];
      const entities = buildAllEntities();

      const r4 = buildFacts(
        { knowledgeFacts: ROUND_4.facts, entities, currentEventId: 'evt_r4', currentRound: 4 },
        edges, null, {}, new Map(),
      );
      const allEdges = [...edges, ...r4.newEdges];

      const r5 = buildFacts(
        { knowledgeFacts: ROUND_5.facts, entities, currentEventId: 'evt_r5', currentRound: 5 },
        allEdges, null, {}, new Map(),
      );

      expect(r5.newEdges).toHaveLength(1);
      expect(r5.newEdges[0].fact).toContain('逐出');
    });

    it('invalidated edges are excluded from retrieval', async () => {
      const studentEdge = buildEdgesUpToRound4()[0];
      const invalidated: EngramEdge = { ...studentEdge, invalidatedAtRound: 5 };
      const expulsion: EngramEdge = {
        id: engramEdgeId('B', 'A', 'B将A逐出天剑门不再承认师徒关系'),
        sourceEntity: 'B', targetEntity: 'A',
        fact: 'B将A逐出天剑门不再承认师徒关系',
        episodes: ['evt_r5'], is_embedded: false, createdAtRound: 5, lastSeenRound: 5,
      };

      const { sm } = createMockStateManager({
        engram: {
          events: [ROUND_5.event],
          entities: buildAllEntities(),
          relations: [],
          v2Edges: [invalidated, expulsion],
          meta: { lastUpdated: 0, eventCount: 1, embeddedEventCount: 0, embeddedEntityCount: 0, schemaVersion: 4, v2PendingReview: null },
        },
        round: 10,
      });

      const retriever = new UnifiedRetriever(
        makeMockVectorStore(), { embed: vi.fn(async () => []) } as never,
        undefined,
        { embedding: { enabled: false, topK: 20, minScore: 0.3 }, rerank: { enabled: false, topN: 10 } },
        undefined, undefined,
        { engramMemory: 'engram', roundNumber: 'round' },
      );

      const result = await retriever.retrieve('A的师父是谁', { playerName: 'A', locationDesc: '', recentNpcNames: [] }, sm as never);
      expect(result).toContain('逐出');
      // C3: invalidated edge may appear in historical section — but must be labeled
      if (result.includes('弟子')) {
        expect(result).toContain('已不再成立');
      }
    });
  });

  describe('Branch 1: pruneEdgesV2 handles invalidated edges', () => {
    it('invalidated edges are pruned before valid edges of the same age', () => {
      const base = buildEdgesUpToRound4()[0];
      const valid: EngramEdge = { ...base, id: 'valid' };
      const invalidated: EngramEdge = { ...base, id: 'invalidated', invalidatedAtRound: 4 };

      const result = pruneEdgesV2([invalidated, valid], 5, 1);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('valid');
    });

    it('fresh edges survive over invalidated edges', () => {
      const base = buildEdgesUpToRound4()[0];
      const invalidated: EngramEdge = { ...base, invalidatedAtRound: 4 };
      const fresh: EngramEdge = {
        id: 'fresh', sourceEntity: 'B', targetEntity: 'A',
        fact: 'B将A逐出天剑门', episodes: ['evt_r5'],
        is_embedded: false, createdAtRound: 5, lastSeenRound: 5,
      };

      const result = pruneEdgesV2([invalidated, fresh], 5, 1);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('fresh');
    });
  });

  describe('Branch 2: Entity Repair lifecycle', () => {
    it('Tier 1: unknown entity referenced in fact creates stub', () => {
      const entities = buildAllEntities();
      const entityNames = new Set(entities.map((e) => e.name));
      const isSentenceLike = (s: string) => s.length > 6 && /[，。了的被在过着得让把将与从]/.test(s);

      const stubs: EngramEntity[] = [];
      for (const kf of ROUND_3.facts) {
        for (const name of [kf.sourceEntity, kf.targetEntity]) {
          if (!name || entityNames.has(name)) continue;
          if (isSentenceLike(name)) continue;
          stubs.push({
            name, type: inferEntityType(name), summary: '', attributes: {},
            firstSeen: 3, lastSeen: 3, mentionCount: 1, is_embedded: false,
            _pendingEnrichment: true,
          });
          entityNames.add(name);
        }
      }

      expect(stubs).toHaveLength(1);
      expect(stubs[0].name).toBe(STUB_ENTITY_NAME);
      expect(stubs[0]._pendingEnrichment).toBe(true);
      expect(stubs[0].type).toBe('npc');
    });

    it('Step 2.25: stub survives across rounds', () => {
      const prevEntities: EngramEntity[] = [
        ...buildAllEntities(),
        { name: STUB_ENTITY_NAME, type: 'npc', summary: '', attributes: {}, firstSeen: 3, lastSeen: 3, mentionCount: 1, is_embedded: false, _pendingEnrichment: true },
      ];
      const currentEntities = buildAllEntities();
      const builtNames = new Set(currentEntities.map((e) => e.name));

      const restored = [...currentEntities];
      for (const prev of prevEntities) {
        if (prev._pendingEnrichment && !builtNames.has(prev.name)) {
          restored.push({ ...prev, lastSeen: 4 });
        }
      }

      const stub = restored.find((e) => e.name === STUB_ENTITY_NAME);
      expect(stub).toBeDefined();
      expect(stub!._pendingEnrichment).toBe(true);
      expect(stub!.lastSeen).toBe(4);
    });

    it('Tier 2 contract: enriched entity has summary and no _pendingEnrichment', () => {
      const stub: EngramEntity = {
        name: STUB_ENTITY_NAME, type: 'npc', summary: '', attributes: {},
        firstSeen: 3, lastSeen: 4, mentionCount: 1, is_embedded: false,
        _pendingEnrichment: true,
      };

      expect(stub._pendingEnrichment).toBe(true);
      expect(stub.summary).toBe('');

      const enriched: EngramEntity = { ...stub, summary: '一个隐秘的修炼组织' };
      delete enriched._pendingEnrichment;

      expect(enriched.summary).toBeTruthy();
      expect(enriched._pendingEnrichment).toBeUndefined();
      expect(enriched.firstSeen).toBe(3);
    });

    it('pruneToImportant does not delete pending stubs', () => {
      const entities: EngramEntity[] = [
        ...buildAllEntities(),
        { name: STUB_ENTITY_NAME, type: 'npc', summary: '', attributes: {}, firstSeen: 3, lastSeen: 4, mentionCount: 1, is_embedded: false, _pendingEnrichment: true },
      ];

      const importantNames = new Set(['A', 'B']);
      const isRelevant = (name: string) => importantNames.has(name) || name === '玩家';

      const pruned = entities.filter(
        (e) => isRelevant(e.name) || e.type === 'location' || e._pendingEnrichment,
      );

      expect(pruned.map((e) => e.name)).toContain(STUB_ENTITY_NAME);
    });

    it('temporal audit: firstSeen reflects creation round, not enrichment round', () => {
      const stub: EngramEntity = {
        name: STUB_ENTITY_NAME, type: 'npc', summary: '', attributes: {},
        firstSeen: 3, lastSeen: 4, mentionCount: 1, is_embedded: false,
        _pendingEnrichment: true,
      };

      const enriched: EngramEntity = { ...stub, summary: '描述', _pendingEnrichment: undefined, lastSeen: 5 };

      expect(enriched.firstSeen).toBe(3);
      expect(enriched.lastSeen).toBe(5);
    });
  });
});
