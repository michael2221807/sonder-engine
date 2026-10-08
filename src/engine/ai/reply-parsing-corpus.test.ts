/**
 * Reply-parsing behaviour lock (refactor R2, step 0).
 *
 * Every parser that reads an AI reply is run over the whole reply corpus and what it does is stored byte for byte
 * in `__snapshots__/reply-corpus/<function>.json`: the result with its key order and its undefined-valued keys
 * (written `"__undefined__"`), or the error it throws. A refactor of the parsing code must leave every file
 * unchanged. Snapshots are never rewritten with `-u` during the refactor; a changed snapshot is a failed step.
 *
 * Not covered here, because the function cannot be reached from outside its module: the thinking-block readers in
 * `image/tokenizer.ts` and `pipeline/sub-pipelines/enhanced-opening.ts`, and the `extractJSON` of the latter.
 */
import { describe, it, expect } from 'vitest';
import {
  ResponseParser,
  COT_BLOCKS,
  decodeResidualEscapes,
  escapedTwice,
  liftSidecars,
  repairStoredNarrative,
  rereadStoredNarrative,
  salvageEnvelopeText,
} from './response-parser';
import { extractJsonObjectByKey, findBalancedJsonBlocks, parseLooseJson, stripMarkdownFences } from './json-extract';
import { healUnescapedQuotes, sanitizeJsonEscapes } from './json-escape-sanitize';
import { parseAssistantPayload } from '../services/assistant/payload-parser';
import { PresetAIGenerator } from '../services/preset-ai-generator';
import { FieldRepairPipeline } from '../pipeline/sub-pipelines/field-repair';
import { extractThinkingFromRaw } from '../core/prompt-debug';
import { createJsonTextStreamUnwrapper } from '../pipeline/stages/ai-call';
import type { AIService } from './ai-service';
import type { CustomPresetSchema } from '../types';
import { AI_REPLY_CORPUS, STORED_PAIRS } from '../__test-utils__/fixtures/ai-reply-corpus';

const SNAPSHOT_DIR = '__snapshots__/reply-corpus';
const UNDEFINED_MARK = '__undefined__';

type Outcome = { ok: unknown } | { threw: string };

function record(fn: () => unknown): Outcome {
  try {
    return { ok: fn() };
  } catch (err) {
    return { threw: String(err) };
  }
}

async function recordAsync(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: await fn() };
  } catch (err) {
    return { threw: String(err) };
  }
}

/** Stable text of a snapshot: key order kept, undefined written as a mark so undefined-valued keys are locked. */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v === undefined ? UNDEFINED_MARK : v), 2) + '\n';
}

/** Runs `fn` over every corpus case and compares the whole table with its snapshot file. */
async function lockCorpus(name: string, fn: (raw: string, id: string) => unknown | Promise<unknown>): Promise<void> {
  const table: Record<string, Outcome> = {};
  for (const c of AI_REPLY_CORPUS) table[c.id] = await recordAsync(async () => fn(c.raw, c.id));
  await expect(serialize(table)).toMatchFileSnapshot(`${SNAPSHOT_DIR}/${name}.json`);
}

const SIDECAR_TAGS = [...COT_BLOCKS, 'judge'];
const SCHEMA_BASIC: CustomPresetSchema = {
  fields: [
    { key: 'name', label: '名称', type: 'text', required: true },
    { key: 'description', label: '描述', type: 'textarea', required: true },
    { key: 'talent_cost', label: '天资花费', type: 'number', required: false, min: 0, max: 50 },
  ],
};

/** A second schema, keyed like the reply shapes in the corpus, so the replies that are not preset-shaped are read too. */
const SCHEMA_REPLY: CustomPresetSchema = {
  fields: [
    { key: 'text', label: '正文', type: 'textarea', required: true },
    { key: 'summary', label: '摘要', type: 'text', required: false },
    { key: 'refined', label: '精炼', type: 'text', required: false },
  ],
};

describe('the reply corpus', () => {
  it('has unique ids and enough cases', () => {
    const ids = [...AI_REPLY_CORPUS.map(c => c.id), ...STORED_PAIRS.map(c => c.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(AI_REPLY_CORPUS.length).toBeGreaterThanOrEqual(45);
  });
});

describe('ResponseParser: what a reply reads as', () => {
  it('parse-default', async () => {
    await lockCorpus('parse-default', raw => new ResponseParser().parse(raw));
  });
  it('parse-cot', async () => {
    await lockCorpus('parse-cot', raw => new ResponseParser().parse(raw, { captureThinking: true }));
  });
  it('parse-cot-sidecars', async () => {
    await lockCorpus('parse-cot-sidecars', raw => new ResponseParser().parse(raw, { captureThinking: true, sidecars: SIDECAR_TAGS }));
  });
  it('parse-sidecars', async () => {
    await lockCorpus('parse-sidecars', raw => new ResponseParser().parse(raw, { sidecars: SIDECAR_TAGS }));
  });
  it('sanitize', async () => {
    await lockCorpus('sanitize', raw => new ResponseParser().sanitize(raw));
  });
  it('extract-and-sanitize', async () => {
    await lockCorpus('extract-and-sanitize', raw => new ResponseParser().extractAndSanitize(raw));
  });
  it('salvage-envelope', async () => {
    await lockCorpus('salvage-envelope', raw => salvageEnvelopeText(raw));
  });
  it('lift-sidecars', async () => {
    await lockCorpus('lift-sidecars', raw => liftSidecars(raw, SIDECAR_TAGS));
  });
  it('residual-escapes', async () => {
    await lockCorpus('residual-escapes', raw => ({ escapedTwice: escapedTwice(raw), decoded: decodeResidualEscapes(raw) }));
  });
  it('json-escape', async () => {
    await lockCorpus('json-escape', raw => {
      const sanitized = sanitizeJsonEscapes(raw);
      return { sanitized, healed: healUnescapedQuotes(sanitized) };
    });
  });
});

describe('stored rounds: healed on every load', () => {
  it('stored-repair', async () => {
    const table: Record<string, Outcome> = {};
    for (const p of STORED_PAIRS) table[p.id] = record(() => repairStoredNarrative(p.stored));
    await expect(serialize(table)).toMatchFileSnapshot(`${SNAPSHOT_DIR}/stored-repair.json`);
  });
  it('stored-reread', async () => {
    const table: Record<string, Outcome> = {};
    for (const p of STORED_PAIRS) table[p.id] = record(() => rereadStoredNarrative(p.stored, p.raw));
    await expect(serialize(table)).toMatchFileSnapshot(`${SNAPSHOT_DIR}/stored-reread.json`);
  });
});

describe('extractJsonObjectByKey', () => {
  for (const key of ['refined', 'long_term_memories', 'vectors']) {
    it(`extract-by-key-${key}`, async () => {
      await lockCorpus(`extract-by-key-${key}`, raw => extractJsonObjectByKey(raw, key));
    });
  }
});

describe('other readers of a reply', () => {
  it('fences-and-blocks', async () => {
    await lockCorpus('fences-and-blocks', raw => {
      const stripped = stripMarkdownFences(raw);
      return { stripped, blocks: findBalancedJsonBlocks(stripped) };
    });
  });
  it('assistant-payload', async () => {
    await lockCorpus('assistant-payload', raw => parseAssistantPayload(raw));
  });
  it('preset-generate', async () => {
    await lockCorpus('preset-generate', async raw => {
      const aiService = { generate: async () => raw } as unknown as AIService;
      const run = (schema: CustomPresetSchema) => recordAsync(() =>
        new PresetAIGenerator(aiService, null).generate({ presetType: 'worlds', stepLabel: '世界', schema, userSeed: '' }));
      return { basic: await run(SCHEMA_BASIC), reply: await run(SCHEMA_REPLY) };
    });
  });
  it('loose-json', async () => {
    await lockCorpus('loose-json', raw => ({
      anyValue: parseLooseJson(raw, (_v): _v is unknown => true),
      knowledgeFacts: parseLooseJson(raw, (v): v is { knowledge_facts: unknown[] } =>
        v !== null && typeof v === 'object' && Array.isArray((v as { knowledge_facts?: unknown }).knowledge_facts)),
    }));
  });
  it('field-repair-combined', async () => {
    // Private method: called through the prototype; it uses nothing of the instance.
    const call = (FieldRepairPipeline.prototype as unknown as {
      parseCombinedResponse(this: unknown, raw: string, extraField?: string): unknown;
    }).parseCombinedResponse;
    await lockCorpus('field-repair-combined', raw => ({
      plain: call.call({}, raw),
      withExtra: call.call({}, raw, 'extra_out'),
    }));
  });
  it('thinking-debug', async () => {
    await lockCorpus('thinking-debug', raw => extractThinkingFromRaw(raw));
  });
});

describe('stream-unwrapper: what the live bubble shows', () => {
  const splits: Array<[string, (raw: string) => string[]]> = [
    ['whole', raw => [raw]],
    ['by-char', raw => raw.match(/[\s\S]{1,1}/g) ?? []],
    ['by-7', raw => raw.match(/[\s\S]{1,7}/g) ?? []],
  ];
  for (const [label, split] of splits) {
    it(`stream-unwrapper-${label}`, async () => {
      await lockCorpus(`stream-unwrapper-${label}`, raw => {
        const chunks: string[] = [];
        const filter = createJsonTextStreamUnwrapper(chunk => { chunks.push(chunk); });
        for (const piece of split(raw)) filter.onChunk(piece);
        const beforeFlush = chunks.length;
        filter.flush();
        return { chunks, flushedChunks: chunks.length - beforeFlush };
      });
    });
  }
});
