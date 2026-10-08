/**
 * Prompt-token helper lock (refactor R3, step 0).
 *
 * `splitByComma` / `dedupTokens` exist twice (anchor-injector.ts and output-processor.ts) and
 * `convertBracketWeightSyntax` runs two bounded loops; step 4 merges the copies and the loop skeleton. None of them
 * is exported, so twenty prompt strings are run through every exported function that reaches them and the results
 * are stored byte for byte in `__snapshots__/prompt-tokens/<function>.json` (key order kept, undefined written as a
 * mark, a thrown error written as its text). A refactor must leave every file unchanged.
 */
import { describe, it, expect } from 'vitest';
import { injectAnchorByComposition, type AnchorComposition } from './anchor-injector';
import {
  cleanPromptOutput,
  cleanSubjectPrompt,
  normalizeNaiWeightSyntax,
  normalizeSingleCharacterOutput,
  parseStructuredOutput,
  processTransformerOutput,
  stripThinkingBlocks,
  type SerializationStrategy,
} from './output-processor';
import type { AnchorStructuredFeatures, SecretPartType } from './types';

const SNAPSHOT_DIR = '__snapshots__/prompt-tokens';
const UNDEFINED_MARK = '__undefined__';

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v === undefined ? UNDEFINED_MARK : v), 2) + '\n';
}

type Outcome = { ok: unknown } | { threw: string };

function record(fn: () => unknown): Outcome {
  try {
    return { ok: fn() };
  } catch (err) {
    return { threw: String(err) };
  }
}

/** Twenty strings: tags, duplicates, SD and NAI weights (clean and broken), wrappers, thinking blocks, structure. */
const CORPUS: Array<{ id: string; text: string }> = [
  { id: 'plain-tags', text: 'masterpiece, best quality, 1girl, long hair, red eyes' },
  { id: 'duplicates-bullets-case', text: '1girl,  1GIRL, Long Hair, long hair, - red eyes, * smile, • blush' },
  { id: 'sd-weights', text: '(smile:1.3), (red eyes:1.1), (long hair:0.9)' },
  { id: 'sd-weights-nested', text: '((masterpiece:1.2), best quality:1.1)' },
  { id: 'nai-weights-clean', text: '1.2::anime background, scenic composition::, 1.1::misty courtyard::' },
  { id: 'nai-weights-dirty-left', text: '1.3::1girl, smile, ::1.1::red eyes::' },
  { id: 'nai-weights-dirty-comma', text: '1.2::1girl, black hair, ::, 1.1::blue eyes::, standing' },
  { id: 'paren-wrapped-nai', text: '(1.2::warm light::), (0.8::soft shadow::)' },
  { id: 'thinking-then-prompt', text: '<thinking>plan the tags</thinking><提示词>1girl, long hair, red eyes</提示词>' },
  { id: 'thinking-unclosed', text: '<thinking>I will write <提示词>...</提示词> later\n<提示词>1girl, smile</提示词>' },
  { id: 'think-and-fence', text: '<think>x</think>\n```text\n1girl, solo\n```' },
  { id: 'label-prefix', text: '生图词组：1girl, hanfu, lantern' },
  { id: 'structured-single-role', text: '<提示词结构><基础>palace courtyard, night, lanterns</基础><角色>[1]李明阳|handsome man, black robe, sword in hand</角色></提示词结构>' },
  { id: 'structured-two-roles', text: '<提示词结构><基础>tavern interior, warm light</基础><角色>[1]林暖|1girl, apron\n[2]关宇|1boy, black clothes</角色></提示词结构>' },
  { id: 'artist-case', text: 'Artist: someone, artist:other, 1girl' },
  { id: 'composition-words', text: '1girl, breasts, long hair, standing, full body, portrait, white dress, red eyes, pale skin, close-up' },
  { id: 'breast-weights', text: '1girl, 1.22::big breasts, cleavage::, cowboy shot, young adult, tan skin' },
  { id: 'empty', text: '' },
  { id: 'narrative-chinese', text: '一位十八岁的少女立于庭前，眉目清亮，身着淡青色长衫。' },
  { id: 'messy-lines', text: '<提示词>角色1：1girl, smile</提示词>\n[1] 角色: tag1, tag2,\n- tag3\n\n\n* tag4' },
];

const STRATEGIES: SerializationStrategy[] = ['flat', 'nai_character_segments', 'gemini_structured', 'grok_structured', 'sd_danbooru', 'seedream_narrative'];

const COMPOSITIONS: Array<{ id: string; composition: AnchorComposition; secretPartType?: SecretPartType }> = [
  { id: 'portrait', composition: 'portrait' },
  { id: 'half-body', composition: 'half-body' },
  { id: 'full-length', composition: 'full-length' },
  { id: 'scene', composition: 'scene' },
  { id: 'custom', composition: 'custom' },
  { id: 'secret_part-none', composition: 'secret_part' },
  { id: 'secret_part-breast', composition: 'secret_part', secretPartType: 'breast' },
  { id: 'secret_part-vagina', composition: 'secret_part', secretPartType: 'vagina' },
  { id: 'secret_part-anus', composition: 'secret_part', secretPartType: 'anus' },
];

const FEATURES: AnchorStructuredFeatures = {
  appearance: ['1girl', 'young adult', 'portrait'],
  hairstyle: ['long hair', 'Long Hair'],
  hairColor: ['black hair'],
  eyes: ['red eyes'],
  skinTone: ['pale skin', 'standing'],
  ageAppearance: ['young adult'],
  bust: ['large breasts', 'face'],
  specialTraits: ['beauty mark', '- scar'],
};

async function lock(name: string, fn: (text: string) => unknown): Promise<void> {
  const table: Record<string, Outcome> = {};
  for (const c of CORPUS) table[c.id] = record(() => fn(c.text));
  await expect(serialize(table)).toMatchFileSnapshot(`${SNAPSHOT_DIR}/${name}.json`);
}

describe('prompt-token helpers · twenty strings', () => {
  it('injectAnchorByComposition: nine composition variants, with and without structured features', async () => {
    await lock('inject-anchor-by-composition', (text) => Object.fromEntries(COMPOSITIONS.map((c) => [
      c.id,
      {
        positiveOnly: injectAnchorByComposition({ positive: text }, { composition: c.composition, secretPartType: c.secretPartType }),
        withFeatures: injectAnchorByComposition({ positive: text, structuredFeatures: FEATURES }, { composition: c.composition, secretPartType: c.secretPartType }),
      },
    ])));
  });

  it('normalizeSingleCharacterOutput for NovelAI and other backends', async () => {
    await lock('normalize-single-character-output', (text) => ({
      novelai: normalizeSingleCharacterOutput(text, { isNovelAI: true }),
      other: normalizeSingleCharacterOutput(text, { isNovelAI: false }),
      noOptions: normalizeSingleCharacterOutput(text),
    }));
  });

  it('processTransformerOutput for six strategies, NovelAI and other backends', async () => {
    await lock('process-transformer-output', (text) => Object.fromEntries(STRATEGIES.map((strategy) => [
      strategy,
      {
        novelai: processTransformerOutput(text, { strategy, isNovelAI: true }),
        other: processTransformerOutput(text, { strategy, isNovelAI: false }),
      },
    ])));
  });

  it('cleanSubjectPrompt and normalizeNaiWeightSyntax', async () => {
    await lock('clean-and-normalize', (text) => ({
      cleanSubjectNovelAI: cleanSubjectPrompt(text, { isNovelAI: true }),
      cleanSubjectOther: cleanSubjectPrompt(text),
      normalizeNaiWeightSyntax: normalizeNaiWeightSyntax(text),
    }));
  });

  it('stripThinkingBlocks, cleanPromptOutput and parseStructuredOutput', async () => {
    await lock('strip-clean-parse', (text) => ({
      stripThinkingBlocks: stripThinkingBlocks(text),
      cleanPromptOutput: cleanPromptOutput(text),
      parseStructuredOutput: parseStructuredOutput(text),
    }));
  });
});
