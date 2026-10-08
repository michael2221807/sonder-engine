/**
 * Keeps the injection wiring table (round-injections.ts) equal to the code it describes (refactor R1, step 4).
 *
 * What is checked, and how:
 *  - Builder pieces: the SOURCE of system-prompt-builder.ts is scanned for `push(PIECE_ID.X` calls. Every pushed id must
 *    be named by the table, every id the table names must be pushed, and no `push('literal'` may bring back a piece the
 *    table cannot see. (Source scan, not a run: a run only sees the pieces one fixture happens to switch on.)
 *  - Flow modules: the REAL tianming pack is loaded from disk; for the five round flows the set of
 *    (flow, promptId, condition) triples must equal the table's, in both directions.
 *  - Flow variables: every variable key the round writes (the literal in `buildFlowVariables`, the plot injector, the
 *    Step 2 table) is named by the table, and every variable the table names is defined in those sources. This is a
 *    key-level check on source text: it does not prove the value is right.
 *  - Placeholders: the pack prompt named by the table really contains `{{VARIABLE}}`.
 *  - Sides: an injection with only one side must be declared `knownOneSided` (an audit finding) or `designedOneSided`,
 *    and the declared side must really be the empty one; a declared one-sided injection that gained its other side
 *    must be un-declared.
 * Not covered: the content of any piece or variable, other pack flows (npc-chat, sub-pipelines), and the English pack
 * (it has the same prompt ids; the request matrix runs the Chinese pack).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { PIECE_ID } from './piece-ids';
import {
  ROUND_FLOW_KEYS,
  ROUND_INJECTIONS,
  type FlowSide,
  type BuilderSide,
  type InlineSite,
  type RoundInjection,
} from './round-injections';
import { loadPackFromDisk } from '../__test-utils__/load-pack-from-disk';
import type { GamePack } from '../types';

const ENGINE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const readEngine = (rel: string): string => readFileSync(`${ENGINE_ROOT}${rel}`, 'utf8').replace(/\r\n/g, '\n');

const builderSource = readEngine('prompt/system-prompt-builder.ts');
const inputsSource = readEngine('pipeline/stages/context-assembly-inputs.ts');
const requestsSource = readEngine('pipeline/stages/context-assembly-requests.ts');
const plotInjectorSource = readEngine('plot/plot-injector.ts');
const variableSources = `${inputsSource}\n${requestsSource}\n${plotInjectorSource}`;

const hasBuilderSide = (b: BuilderSide): boolean => b.pieceIds.length > 0 || b.inline !== undefined;
const hasFlowSide = (f: FlowSide): boolean => f.modules.length > 0 || f.inline !== undefined;

describe('round injections: builder pieces', () => {
  const pushedKeys = [...builderSource.matchAll(/(?<![.\w])push\(PIECE_ID\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  const pushedIds = new Set<string>(pushedKeys.map((k) => PIECE_ID[k as keyof typeof PIECE_ID]));
  const tableIds = ROUND_INJECTIONS.flatMap((i) => i.builder.pieceIds);

  it('the scan finds the builder pushes', () => {
    expect(pushedIds.size).toBeGreaterThan(40);
    expect([...pushedIds].every((id) => typeof id === 'string')).toBe(true);
  });

  it('no piece is pushed with a bare string id (it would be invisible to this table)', () => {
    expect(builderSource).not.toMatch(/(?<![.\w])push\(\s*['"`]/);
  });

  it('every piece the builder pushes is named by the table', () => {
    expect([...pushedIds].filter((id) => !tableIds.includes(id))).toEqual([]);
  });

  it('every piece the table names is pushed by the builder, once', () => {
    expect(tableIds.filter((id) => !pushedIds.has(id))).toEqual([]);
    expect(tableIds.filter((id, i) => tableIds.indexOf(id) !== i)).toEqual([]);
  });

  it('PIECE_ID holds no id the builder never pushes', () => {
    expect(Object.values(PIECE_ID).filter((id) => !pushedIds.has(id))).toEqual([]);
  });
});

describe('round injections: inline sites', () => {
  const sites: Array<[string, InlineSite]> = ROUND_INJECTIONS.flatMap((i) =>
    [i.builder.inline, i.flow.inline]
      .filter((s): s is InlineSite => s !== undefined)
      .map((s): [string, InlineSite] => [i.id, s]),
  );

  it('there are inline sites to check', () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it.each(sites)('%s: the named symbol still exists in its file', (_id, site) => {
    expect(readEngine(site.file)).toContain(site.symbol);
  });
});

describe('round injections: pack flows and variables', () => {
  let pack: GamePack;
  beforeAll(async () => {
    pack = await loadPackFromDisk('tianming');
  });

  const tripleKey = (flow: string, promptId: string, condition: string | undefined): string =>
    `${flow} | ${promptId} | ${condition ?? '-'}`;

  it('the flow modules of the round flows equal the table, in both directions', () => {
    const inPack = new Set<string>();
    for (const flowKey of ROUND_FLOW_KEYS) {
      const flow = pack.promptFlows[flowKey];
      expect(flow, `pack flow ${flowKey}`).toBeDefined();
      for (const m of flow.modules) inPack.add(tripleKey(flowKey, m.promptId, m.condition));
    }
    const inTable = new Set<string>();
    for (const inj of ROUND_INJECTIONS) {
      for (const m of inj.flow.modules) {
        for (const flowKey of m.flows) inTable.add(tripleKey(flowKey, m.promptId, m.condition));
      }
    }
    expect([...inPack].filter((t) => !inTable.has(t))).toEqual([]);
    expect([...inTable].filter((t) => !inPack.has(t))).toEqual([]);
  });

  const writtenKeys = (() => {
    const start = inputsSource.indexOf('const variables: Record<string, string> = {');
    const end = inputsSource.indexOf('\n    };', start);
    const body = inputsSource.slice(start, end);
    return [...body.matchAll(/^ {6}([A-Za-z][A-Za-z0-9_]*):/gm)].map((m) => m[1]);
  })();
  const tableVariables = new Set(ROUND_INJECTIONS.flatMap((i) => i.flow.variables));

  it('the scan finds the flow variable table', () => {
    expect(writtenKeys.length).toBeGreaterThan(30);
  });

  it('every variable the round writes is named by the table', () => {
    expect(writtenKeys.filter((k) => !tableVariables.has(k))).toEqual([]);
  });

  it('every variable the table names is defined by the round (flow table, plot injector, Step 2 table)', () => {
    const undefinedVars = [...tableVariables].filter(
      (v) => !new RegExp(`(?<![A-Za-z0-9_])${v}\\s*:`).test(variableSources),
    );
    expect(undefinedVars).toEqual([]);
  });

  it('every module condition is a variable the table names', () => {
    const conditions = ROUND_INJECTIONS.flatMap((i) => i.flow.modules.map((m) => m.condition)).filter(
      (c): c is string => c !== undefined,
    );
    expect(conditions.filter((c) => !tableVariables.has(c))).toEqual([]);
  });

  it('every placeholder the table names is in its pack prompt', () => {
    const missing: string[] = [];
    for (const inj of ROUND_INJECTIONS) {
      for (const ph of inj.flow.placeholders ?? []) {
        const text = pack.prompts[ph.promptId];
        if (typeof text !== 'string' || !text.includes(`{{${ph.variable}}}`)) {
          missing.push(`${inj.id}: {{${ph.variable}}} in ${ph.promptId}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every placeholder names a variable of the same injection', () => {
    for (const inj of ROUND_INJECTIONS) {
      for (const ph of inj.flow.placeholders ?? []) {
        expect(inj.flow.variables, `${inj.id} {{${ph.variable}}}`).toContain(ph.variable);
      }
    }
  });
});

describe('round injections: sides', () => {
  const sideEmpty = (inj: RoundInjection, side: 'builder' | 'flow'): boolean =>
    side === 'builder' ? !hasBuilderSide(inj.builder) : !hasFlowSide(inj.flow);

  it('injection ids are unique', () => {
    const ids = ROUND_INJECTIONS.map((i) => i.id);
    expect(ids.filter((id, n) => ids.indexOf(id) !== n)).toEqual([]);
  });

  it('an injection with exactly one side is declared one-sided, with the right side named', () => {
    const undeclared: string[] = [];
    for (const inj of ROUND_INJECTIONS) {
      const b = hasBuilderSide(inj.builder);
      const f = hasFlowSide(inj.flow);
      const declared = inj.knownOneSided ?? inj.designedOneSided;
      if (b && f) {
        if (declared) undeclared.push(`${inj.id}: declared one-sided but both sides exist`);
      } else if (!b && !f) {
        undeclared.push(`${inj.id}: neither side carries it`);
      } else if (!declared) {
        undeclared.push(`${inj.id}: only the ${b ? 'builder' : 'flow'} side carries it and it is not declared`);
      } else if (!sideEmpty(inj, declared.missing)) {
        undeclared.push(`${inj.id}: declares ${declared.missing} missing but it is wired`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('an injection is known-one-sided or designed-one-sided, not both', () => {
    expect(ROUND_INJECTIONS.filter((i) => i.knownOneSided && i.designedOneSided).map((i) => i.id)).toEqual([]);
  });

  it('every known one-sided entry cites an audit finding', () => {
    for (const inj of ROUND_INJECTIONS.filter((i) => i.knownOneSided)) {
      expect(inj.knownOneSided?.audit, inj.id).toMatch(/^E\d{2}[a-z]?-\d{3}$/);
    }
  });

  it('the registered defects are the ones the audit recorded (E02b-003 NPC tiers, E02b-017 world books)', () => {
    const byAudit = new Map(ROUND_INJECTIONS.filter((i) => i.knownOneSided).map((i) => [i.id, i.knownOneSided]));
    expect(byAudit.get('npcTiers')).toMatchObject({ missing: 'builder', audit: 'E02b-003' });
    expect(byAudit.get('worldBook')).toMatchObject({ missing: 'flow', audit: 'E02b-017' });
  });
});
