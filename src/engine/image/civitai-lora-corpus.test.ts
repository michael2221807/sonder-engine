/**
 * Civitai LoRA preparation lock (refactor R3, step 0).
 *
 * Eight shelves are run through every function the generation flow calls: `prepareCivitaiLora` (the warnings in
 * their order, the injected triggers, the snapshot, the merged networks), `buildTriggerInjection` for two base
 * prompts, `validateShelfForGeneration`, `collectActiveLorasForScope` and `mergeAdditionalNetworks`. The warning
 * order is part of the contract (strength and Mature first, then the syntax warnings in the order the injection
 * loop meets them, then AIR conflicts). The result of each call, or the error it throws, is stored byte for byte
 * in `__snapshots__/civitai-lora/<function>.json`; the refactor of the trigger collection must leave them unchanged.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTriggerInjection,
  collectActiveLorasForScope,
  mergeAdditionalNetworks,
  prepareCivitaiLora,
  resolveLoraScope,
  validateShelfForGeneration,
} from './civitai-lora';
import type { CivitaiLoraScope, CivitaiLoraShelfItem, CivitaiLoraTrigger, ImageSubjectType } from './types';

const SNAPSHOT_DIR = '__snapshots__/civitai-lora';
const UNDEFINED_MARK = '__undefined__';

type Outcome = { ok: unknown } | { threw: string };

function record(fn: () => unknown): Outcome {
  try {
    return { ok: fn() };
  } catch (err) {
    return { threw: String(err) };
  }
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v === undefined ? UNDEFINED_MARK : v), 2) + '\n';
}

const trig = (id: string, text: string, enabled = true): CivitaiLoraTrigger => ({
  id, text, enabled, source: 'manual', createdAt: 1, updatedAt: 1,
});

let seq = 0;
function lora(over: Partial<CivitaiLoraShelfItem> & { name: string }): CivitaiLoraShelfItem {
  seq += 1;
  return {
    id: `lora_${seq}`,
    air: `urn:air:sdxl:lora:civitai:${100 + seq}@${200 + seq}`,
    enabled: true,
    strength: 0.8,
    scopes: ['character'],
    triggers: [],
    autoInjectTriggers: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

interface ShelfCase {
  id: string;
  shelf: CivitaiLoraShelfItem[];
  scope: CivitaiLoraScope;
  prompt: string;
  rawJson: string | undefined;
}

function shelves(): ShelfCase[] {
  seq = 0;
  return [
    { id: 'empty-shelf', shelf: [], scope: 'character', prompt: '1girl, smile', rawJson: undefined },
    {
      id: 'single-with-triggers',
      shelf: [lora({ name: 'Ink', triggers: [trig('a', 'ink wash'), trig('b', 'soft edges, 1girl'), trig('c', 'Ink Wash')] })],
      scope: 'character', prompt: '1girl, Smile, ink wash', rawJson: undefined,
    },
    {
      id: 'disabled-and-wrong-scope',
      shelf: [
        lora({ name: 'Off', enabled: false, triggers: [trig('a', 'off trigger')] }),
        lora({ name: 'Scene only', scopes: ['scene'], triggers: [trig('a', 'scene trigger')] }),
        lora({ name: 'Both', scopes: ['scene', 'character'], triggers: [trig('a', 'both trigger'), trig('b', 'disabled one', false), trig('c', '   ')] }),
      ],
      scope: 'character', prompt: '', rawJson: '',
    },
    {
      id: 'six-active-too-many',
      shelf: [1, 2, 3, 4, 5, 6].map((n) => lora({ name: `L${n}`, scopes: ['scene'], triggers: [trig('a', `trigger ${n}`), trig('b', 'shared, trigger')] })),
      scope: 'scene', prompt: 'scenery', rawJson: '{}',
    },
    {
      id: 'strong-and-mature',
      shelf: [
        lora({ name: 'Strong', strength: 2.0, scopes: ['player'], triggers: [trig('a', 'strong trigger')] }),
        lora({ name: 'Negative', strength: -1.6, scopes: ['player'] }),
        lora({ name: 'Mature', mature: true, strength: 1.5, scopes: ['player'], triggers: [trig('a', 'mature trigger')] }),
      ],
      scope: 'player', prompt: 'portrait', rawJson: undefined,
    },
    {
      id: 'lora-syntax-triggers',
      shelf: [
        lora({ name: 'Syntax', scopes: ['secret_part'], triggers: [trig('a', '<lora:ink:0.8>'), trig('b', 'plain'), trig('c', 'x <LoRA:y:1> z')] }),
        lora({ name: 'No inject', scopes: ['secret_part'], autoInjectTriggers: false, triggers: [trig('a', '<lora:skip:1>'), trig('b', 'never injected')] }),
        lora({ name: 'Syntax again', scopes: ['secret_part'], triggers: [trig('a', '<lora:more:1>')] }),
      ],
      scope: 'secret_part', prompt: 'close-up', rawJson: undefined,
    },
    {
      id: 'air-conflict-and-raw-json',
      shelf: [
        lora({ name: 'Conflict', air: 'urn:air:sdxl:lora:civitai:999@1', strength: 0.7, scopes: ['character'] }),
        lora({ name: 'Padded', air: '  urn:air:sdxl:lora:civitai:555@6  ', strength: 0.4, scopes: ['character'] }),
      ],
      scope: 'character', prompt: 'x',
      rawJson: '{"urn:air:sdxl:lora:civitai:999@1":{"strength":0.2},"urn:air:sdxl:other:civitai:1@1":{"strength":1}}',
    },
    {
      id: 'invalid-air-zero-strength-bad-json',
      shelf: [
        lora({ name: 'Bad AIR', air: 'not-an-air', scopes: ['character'] }),
        lora({ name: 'No civitai', air: 'urn:air:sdxl:lora:other:1@2', scopes: ['character'] }),
        lora({ name: 'Checkpoint', air: 'urn:air:sdxl:checkpoint:civitai:1@2', scopes: ['character'] }),
        lora({ name: 'No version', air: 'urn:air:sdxl:lora:civitai:12', scopes: ['character'] }),
        lora({ name: 'Zero', strength: 0.01, scopes: ['character'] }),
        lora({ name: 'Empty AIR', air: '   ', scopes: ['character'] }),
      ],
      scope: 'character', prompt: 'y', rawJson: '{not json',
    },
  ];
}

const BASES = ['', '1girl, ink wash, Soft Edges'];

async function lock(name: string, fn: (c: ShelfCase) => unknown): Promise<void> {
  const table: Record<string, Outcome> = {};
  for (const c of shelves()) table[c.id] = record(() => fn(c));
  await expect(serialize(table)).toMatchFileSnapshot(`${SNAPSHOT_DIR}/${name}.json`);
}

describe('civitai LoRA preparation · eight shelves', () => {
  it('prepareCivitaiLora', async () => {
    await lock('prepare-civitai-lora', (c) => prepareCivitaiLora({
      shelf: c.shelf, scope: c.scope, positivePrompt: c.prompt, rawAdditionalNetworksJson: c.rawJson,
    }));
  });

  it('buildTriggerInjection over the active LoRAs, for two base prompts', async () => {
    await lock('build-trigger-injection', (c) => {
      const active = collectActiveLorasForScope(c.shelf, c.scope);
      return Object.fromEntries(BASES.map((base) => [base === '' ? '(empty base)' : base, buildTriggerInjection(active, base)]));
    });
  });

  it('validateShelfForGeneration', async () => {
    await lock('validate-shelf', (c) => validateShelfForGeneration(c.shelf, c.scope));
  });

  it('collectActiveLorasForScope and mergeAdditionalNetworks', async () => {
    await lock('active-and-merge', (c) => {
      const active = collectActiveLorasForScope(c.shelf, c.scope);
      return { activeIds: active.map((l) => l.id), merge: record(() => mergeAdditionalNetworks(active, c.rawJson)) };
    });
  });

  it('resolveLoraScope', async () => {
    const subjects: ImageSubjectType[] = ['scene', 'character', 'secret_part'];
    const table: Record<string, unknown> = {};
    for (const subject of subjects) {
      for (const target of [undefined, '林暖', '__player__']) table[`${subject}/${String(target)}`] = resolveLoraScope(subject, target);
    }
    await expect(serialize(table)).toMatchFileSnapshot(`${SNAPSHOT_DIR}/resolve-scope.json`);
  });
});
