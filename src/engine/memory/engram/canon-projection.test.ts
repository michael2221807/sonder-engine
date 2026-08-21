import { describe, it, expect } from 'vitest';
import {
  buildCanonFacts,
  findCanonEdges,
  invalidateEdgesForEntries,
  isProjectableRelationship,
  type CanonMutationInput,
} from './canon-projection';
import { buildFacts } from './fact-builder';
import type { EngramEdge } from './knowledge-edge';
import { isEdgeCurrentlyValid } from './knowledge-edge';
import type { EngramEntity } from './entity-builder';

function mutation(over: Partial<CanonMutationInput> = {}): CanonMutationInput {
  return {
    entryId: 'cap_1',
    kind: 'relationship',
    statement: '林月是玩家的妹妹。',
    entities: ['林月', '玩家'],
    op: 'add',
    ...over,
  };
}

function entity(name: string): EngramEntity {
  return {
    name, type: 'npc', summary: '', attributes: {},
    firstSeen: 1, lastSeen: 1, mentionCount: 1, is_embedded: false,
  };
}

describe('what may be projected at all', () => {
  it('projects a relationship between two distinct entities', () => {
    expect(isProjectableRelationship(mutation())).toBe(true);
  });

  it('refuses a character trait — inventing a second entity would put a fake node in the graph', () => {
    // "林月怕水" is about ONE entity. The design explicitly forbids conjuring
    // "林月的性格" to satisfy the edge shape.
    expect(isProjectableRelationship(mutation({
      kind: 'character', statement: '林月从小怕水。', entities: ['林月'],
    }))).toBe(false);
  });

  it('refuses a world fact and a self-referential pair', () => {
    expect(isProjectableRelationship(mutation({ kind: 'world_fact', entities: ['月亮', '天空'] }))).toBe(false);
    expect(isProjectableRelationship(mutation({ entities: ['林月', '林月'] }))).toBe(false);
    expect(isProjectableRelationship(mutation({ entities: ['林月'] }))).toBe(false);
    expect(isProjectableRelationship(mutation({ entities: [] }))).toBe(false);
  });
});

describe('buildCanonFacts', () => {
  it('carries per-fact provenance instead of relying on batch defaults', () => {
    const [fact] = buildCanonFacts([mutation()]);
    expect(fact).toMatchObject({
      fact: '林月是玩家的妹妹。',
      sourceEntity: '林月',
      targetEntity: '玩家',
    });
    expect(fact.provenance).toMatchObject({
      source: 'user-canon',
      core: true,
      canonEntryId: 'cap_1',
      exemptFromLengthFilter: true,
    });
  });

  it('skips retractions and unprojectable kinds', () => {
    expect(buildCanonFacts([mutation({ op: 'retract' })])).toHaveLength(0);
    expect(buildCanonFacts([mutation({ kind: 'character', entities: ['林月'] })])).toHaveLength(0);
    expect(buildCanonFacts([])).toHaveLength(0);
    expect(buildCanonFacts(undefined)).toHaveLength(0);
  });

  it('skips an empty statement rather than writing a blank edge', () => {
    expect(buildCanonFacts([mutation({ statement: '   ' })])).toHaveLength(0);
  });
});

describe('the length filter must not eat canon facts', () => {
  const entities = [entity('林月'), entity('玩家')];

  it('a SHORT canon relationship still becomes an edge', () => {
    // "林月是玩家的妹妹" is 8 characters — under the `fact.length < 10` pre-filter that
    // exists to drop model-guessed fragments. Applying it here would silently discard
    // precisely the facts with the strongest evidence behind them.
    const facts = buildCanonFacts([mutation({ statement: '林月是玩家的妹妹' })]);
    expect(facts[0].fact.length).toBeLessThan(10);

    const result = buildFacts(
      { knowledgeFacts: facts, entities, currentEventId: null, currentRound: 3 },
      [], null, {}, new Map(),
    );
    expect(result.newEdges).toHaveLength(1);
    expect(result.newEdges[0]).toMatchObject({
      source: 'user-canon',
      core: true,
      canonEntryId: 'cap_1',
    });
  });

  it('a short AI fact is still filtered out (the exemption is not a global loosening)', () => {
    const result = buildFacts(
      {
        knowledgeFacts: [{ fact: '短事实', sourceEntity: '林月', targetEntity: '玩家' }],
        entities, currentEventId: null, currentRound: 3,
      },
      [], null, {}, new Map(),
    );
    expect(result.newEdges).toHaveLength(0);
  });
});

describe('same-round merge with an AI fact — the SINGLE-call path production uses', () => {
  const entities = [entity('林月'), entity('玩家')];
  const FACT = '林月是玩家的妹妹，从小一起长大。';

  /**
   * `EngramManager` concatenates canon facts and the model's `knowledge_facts` into ONE
   * `buildFacts()` call. That path goes through the intra-round dedup branch (Step 4.5),
   * which is a DIFFERENT branch from the cross-call exact/semantic dedup — and it was
   * the one branch that forgot to carry canon provenance, leaving the edge with no
   * `canonEntryId` and therefore no way to ever retract it.
   */
  function singleCall(facts: ReturnType<typeof buildCanonFacts>, vectors: Map<string, number[]>) {
    const vectorStore = {
      cosineSimilarity: (a: number[], b: number[]) => {
        const dot = a.reduce((n, v, i) => n + v * (b[i] ?? 0), 0);
        const ma = Math.sqrt(a.reduce((n, v) => n + v * v, 0));
        const mb = Math.sqrt(b.reduce((n, v) => n + v * v, 0));
        return ma && mb ? dot / (ma * mb) : 0;
      },
    } as unknown as Parameters<typeof buildFacts>[2];
    return buildFacts(
      { knowledgeFacts: facts, entities, currentEventId: null, currentRound: 1 },
      [], vectorStore, {}, vectors,
      { defaultSource: 'ai' },
    );
  }

  it('carries canonEntryId when a canon fact and an AI fact merge inside ONE call', () => {
    const canonStatement = '林月是玩家的妹妹，从小一起长大。';
    const aiStatement = '林月和玩家是从小一起长大的兄妹。';
    const canon = buildCanonFacts([mutation({ statement: canonStatement })]);
    const all = [
      ...canon,
      { fact: aiStatement, sourceEntity: '林月', targetEntity: '玩家' },
    ];
    // Near-identical vectors → the second fact takes the intra-round dedup branch.
    const vectors = new Map<string, number[]>([
      [canonStatement, [1, 0, 0]],
      [aiStatement, [0.99, 0.14, 0]],
    ]);

    const result = singleCall(all, vectors);

    expect(result.newEdges).toHaveLength(1);
    expect(result.reinforcedIds).toHaveLength(1);
    const edge = result.newEdges[0];
    expect(edge.canonEntryId).toBe('cap_1');
    expect(edge.source).toBe('user-canon');
    expect(edge.core).toBe(true);
  });

  it('still carries it when the AI fact is processed first', () => {
    // Guards the fix independently of `combinedFacts` ordering, so a future reorder
    // cannot silently reintroduce the data loss.
    const canonStatement = '林月是玩家的妹妹。';
    const aiStatement = '林月和玩家是兄妹关系，从小一起长大的。';
    const all = [
      { fact: aiStatement, sourceEntity: '林月', targetEntity: '玩家' },
      ...buildCanonFacts([mutation({ statement: canonStatement })]),
    ];
    const vectors = new Map<string, number[]>([
      [aiStatement, [1, 0, 0]],
      [canonStatement, [0.99, 0.14, 0]],
    ]);

    const result = singleCall(all, vectors);

    expect(result.newEdges).toHaveLength(1);
    expect(result.newEdges[0].canonEntryId).toBe('cap_1');
    expect(result.newEdges[0].source).toBe('user-canon');
  });

  it('never lets a second captured entry steal the first one\'s ownership', () => {
    const a = '林月是玩家的妹妹。';
    const b = '林月是玩家的亲妹妹。';
    const all = [
      ...buildCanonFacts([mutation({ entryId: 'cap_a', statement: a })]),
      ...buildCanonFacts([mutation({ entryId: 'cap_b', statement: b })]),
    ];
    const vectors = new Map<string, number[]>([[a, [1, 0, 0]], [b, [0.99, 0.14, 0]]]);

    const result = singleCall(all, vectors);
    expect(result.newEdges).toHaveLength(1);
    // First claim wins; cap_b simply has no edge, which is honest for a duplicate.
    expect(result.newEdges[0].canonEntryId).toBe('cap_a');
  });

  it('does not create a second edge, and promotes the existing one to canon', () => {
    // The main model can notice the same relationship the player just marked. Two edges
    // would double-count it in retrieval; leaving the AI one alone would strand the
    // world-book entry with no edge to invalidate on undo.
    const first = buildFacts(
      {
        knowledgeFacts: [{ fact: FACT, sourceEntity: '林月', targetEntity: '玩家' }],
        entities, currentEventId: null, currentRound: 1,
      },
      [], null, {}, new Map(),
      { defaultSource: 'ai' },
    );
    expect(first.newEdges).toHaveLength(1);
    const edges = [...first.newEdges];

    const canon = buildCanonFacts([mutation({ statement: FACT })]);
    const second = buildFacts(
      { knowledgeFacts: canon, entities, currentEventId: null, currentRound: 2 },
      edges, null, {}, new Map(),
    );

    expect(second.newEdges).toHaveLength(0);
    expect(second.reinforcedIds).toHaveLength(1);
    expect(edges[0].source).toBe('user-canon');
    expect(edges[0].core).toBe(true);
    expect(edges[0].canonEntryId).toBe('cap_1');
  });

  it('an ordinary AI re-mention never downgrades a canon edge', () => {
    const canon = buildCanonFacts([mutation({ statement: FACT })]);
    const built = buildFacts(
      { knowledgeFacts: canon, entities, currentEventId: null, currentRound: 1 },
      [], null, {}, new Map(),
    );
    const edges = [...built.newEdges];

    buildFacts(
      {
        knowledgeFacts: [{ fact: FACT, sourceEntity: '林月', targetEntity: '玩家' }],
        entities, currentEventId: null, currentRound: 2,
      },
      edges, null, {}, new Map(),
      { defaultSource: 'ai', defaultCore: false },
    );

    expect(edges[0].source).toBe('user-canon');
    expect(edges[0].core).toBe(true);
  });
});

describe('retraction invalidates, never deletes', () => {
  function seedEdges(): EngramEdge[] {
    const facts = buildCanonFacts([
      mutation({ entryId: 'cap_a', statement: '林月是玩家的妹妹。' }),
      mutation({ entryId: 'cap_b', statement: '张三是玩家的师父。', entities: ['张三', '玩家'] }),
    ]);
    return buildFacts(
      {
        knowledgeFacts: facts,
        entities: [entity('林月'), entity('玩家'), entity('张三')],
        currentEventId: null, currentRound: 1,
      },
      [], null, {}, new Map(),
    ).newEdges;
  }

  it('invalidates only the retracted entry\'s edges, and keeps the rows', () => {
    const edges = seedEdges();
    expect(edges).toHaveLength(2);

    const touched = invalidateEdgesForEntries(edges, ['cap_a'], 9);

    expect(touched).toHaveLength(1);
    expect(edges).toHaveLength(2); // nothing deleted
    const a = edges.find((e) => e.canonEntryId === 'cap_a')!;
    const b = edges.find((e) => e.canonEntryId === 'cap_b')!;
    expect(isEdgeCurrentlyValid(a)).toBe(false);
    expect(a.invalidAtRound).toBe(9);
    expect(isEdgeCurrentlyValid(b)).toBe(true);
  });

  it('is a no-op when nothing was retracted', () => {
    const edges = seedEdges();
    expect(invalidateEdgesForEntries(edges, [], 9)).toHaveLength(0);
    expect(invalidateEdgesForEntries(edges, ['unknown_entry'], 9)).toHaveLength(0);
    expect(edges.every(isEdgeCurrentlyValid)).toBe(true);
  });

  it('invalidating twice does not re-stamp an already-dead edge', () => {
    const edges = seedEdges();
    invalidateEdgesForEntries(edges, ['cap_a'], 5);
    const second = invalidateEdgesForEntries(edges, ['cap_a'], 20);
    expect(second).toHaveLength(0);
    expect(edges.find((e) => e.canonEntryId === 'cap_a')?.invalidAtRound).toBe(5);
  });

  it('findCanonEdges returns only the live ones', () => {
    const edges = seedEdges();
    expect(findCanonEdges(edges, 'cap_a')).toHaveLength(1);
    invalidateEdgesForEntries(edges, ['cap_a'], 5);
    expect(findCanonEdges(edges, 'cap_a')).toHaveLength(0);
    expect(findCanonEdges(edges, 'cap_b')).toHaveLength(1);
  });

  it('at most ONE live edge exists per captured entry', () => {
    // The design's headline invariant for the bridge.
    const edges = seedEdges();
    const facts = buildCanonFacts([mutation({ entryId: 'cap_a', statement: '林月是玩家的妹妹。' })]);
    buildFacts(
      { knowledgeFacts: facts, entities: [entity('林月'), entity('玩家')], currentEventId: null, currentRound: 4 },
      edges, null, {}, new Map(),
    );
    expect(findCanonEdges(edges, 'cap_a')).toHaveLength(1);
  });
});
