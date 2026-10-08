/**
 * Temporal Story Fixture — 5-round scripted scenario for regression testing.
 *
 * Branch 1 (Contradiction):
 *   R1: A is B's student → fact edge created
 *   R2: B promises to protect A → new fact edge
 *   R3: C threatens A → new fact edge + new entity C
 *   R4: A betrays B → new fact, semantically conflicts with R1 "student" → pending review
 *   R5: B expels A → new fact, should invalidate "student" relationship
 *
 * Branch 2 (Entity Repair):
 *   R3: fact references "清兰会" (unknown entity) → Tier 1 stub with _pendingEnrichment
 *   R4: stub restored across round (Step 2.25)
 *   R5: Tier 2 enrichment fills description
 */
import type { EngramEdge } from '../../memory/engram/knowledge-edge';
import { engramEdgeId } from '../../memory/engram/knowledge-edge';
import type { EngramEntity } from '../../memory/engram/entity-builder';
import type { EngramEventNode, EngramEventStructuredKV } from '../../memory/engram/event-builder';
import type { KnowledgeFact } from '../../memory/engram/fact-builder';

function makeKV(event: string, roles: string[] = []): EngramEventStructuredKV {
  return { event, role: roles, location: [], time_anchor: '', causality: '承接', logic: [] };
}

function makeEvent(id: string, round: number, text: string, roles: string[]): EngramEventNode {
  return {
    id,
    subject: 'A',
    action: 'narrative',
    tags: ['narrative'],
    text,
    summary: text,
    structured_kv: makeKV(text, roles),
    is_embedded: false,
    roundNumber: round,
  };
}

function makeEntity(name: string, type: EngramEntity['type'], round: number, extra: Partial<EngramEntity> = {}): EngramEntity {
  return {
    name,
    type,
    summary: '',
    attributes: {},
    firstSeen: round,
    lastSeen: round,
    mentionCount: 1,
    is_embedded: false,
    ...extra,
  };
}

// ── Round data ──

export const ROUND_1 = {
  event: makeEvent('evt_r1', 1, 'A正式拜入B门下，成为B的弟子', ['A', 'B']),
  facts: [{ sourceEntity: 'A', targetEntity: 'B', fact: 'A是B的弟子，在天剑门修炼' }] as KnowledgeFact[],
  entities: [makeEntity('A', 'player', 1), makeEntity('B', 'npc', 1, { summary: '天剑门掌门' })],
};

export const ROUND_2 = {
  event: makeEvent('evt_r2', 2, 'B承诺会保护A不受外敌侵害', ['A', 'B']),
  facts: [{ sourceEntity: 'B', targetEntity: 'A', fact: 'B向A承诺会保护A免受外敌侵害' }] as KnowledgeFact[],
  entities: [makeEntity('A', 'player', 1), makeEntity('B', 'npc', 1, { summary: '天剑门掌门' })],
};

export const ROUND_3 = {
  event: makeEvent('evt_r3', 3, 'C威胁A，声称要对A不利，A向清兰会求助', ['A', 'C']),
  facts: [
    { sourceEntity: 'C', targetEntity: 'A', fact: 'C威胁了A并声称要对A不利' },
    { sourceEntity: 'A', targetEntity: '清兰会', fact: 'A向清兰会求助以应对C的威胁' },
  ] as KnowledgeFact[],
};

export const ROUND_4 = {
  event: makeEvent('evt_r4', 4, 'A暗中背叛了B，将B的秘密告诉了C', ['A', 'B', 'C']),
  facts: [{ sourceEntity: 'A', targetEntity: 'B', fact: 'A背叛了B将其门派秘密泄露给C' }] as KnowledgeFact[],
};

export const ROUND_5 = {
  event: makeEvent('evt_r5', 5, 'B发现A的背叛后将A逐出门派', ['A', 'B']),
  facts: [{ sourceEntity: 'B', targetEntity: 'A', fact: 'B将A逐出天剑门不再承认师徒关系' }] as KnowledgeFact[],
};

// ── Pre-built edges for testing contradiction review ──

export function buildEdgesUpToRound4(): EngramEdge[] {
  return [
    {
      id: engramEdgeId('A', 'B', 'A是B的弟子，在天剑门修炼'),
      sourceEntity: 'A',
      targetEntity: 'B',
      fact: 'A是B的弟子，在天剑门修炼',
      episodes: ['evt_r1'],
      is_embedded: false,
      createdAtRound: 1,
      lastSeenRound: 1,
    },
    {
      id: engramEdgeId('B', 'A', 'B向A承诺会保护A免受外敌侵害'),
      sourceEntity: 'B',
      targetEntity: 'A',
      fact: 'B向A承诺会保护A免受外敌侵害',
      episodes: ['evt_r2'],
      is_embedded: false,
      createdAtRound: 2,
      lastSeenRound: 2,
    },
    {
      id: engramEdgeId('C', 'A', 'C威胁了A并声称要对A不利'),
      sourceEntity: 'C',
      targetEntity: 'A',
      fact: 'C威胁了A并声称要对A不利',
      episodes: ['evt_r3'],
      is_embedded: false,
      createdAtRound: 3,
      lastSeenRound: 3,
    },
    {
      id: engramEdgeId('A', '清兰会', 'A向清兰会求助以应对C的威胁'),
      sourceEntity: 'A',
      targetEntity: '清兰会',
      fact: 'A向清兰会求助以应对C的威胁',
      episodes: ['evt_r3'],
      is_embedded: false,
      createdAtRound: 3,
      lastSeenRound: 3,
    },
  ];
}

export function buildAllEntities(): EngramEntity[] {
  return [
    makeEntity('A', 'player', 1),
    makeEntity('B', 'npc', 1, { summary: '天剑门掌门' }),
    makeEntity('C', 'npc', 3, { summary: '一个威胁者' }),
  ];
}

export const STUB_ENTITY_NAME = '清兰会';
