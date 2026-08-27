import { describe, it, expect } from 'vitest';
import { ImageTokenizer } from './tokenizer';
import type { AIService } from '../ai/ai-service';
import type { PromptAssembler } from '../prompt/prompt-assembler';
import type { TransformerPresetContext } from './transformer-presets';
import type { SceneContext } from './scene-context';

/**
 * Regression pins for the seedream_narrative output mandates (2026-08-27):
 * the tokenizer's hardcoded 【输出要求】/ scene-constraint blocks used to
 * mandate English tags unconditionally, overriding the Doubao ruleset on
 * strong models. The narrative flag swaps ONLY those lines; every other
 * strategy must keep the legacy text byte-identical.
 */

function makeHarness() {
  const captured: Array<{ role: string; content: string }> = [];
  const aiService = {
    generate: async (req: { messages: Array<{ role: string; content: string }> }) => {
      captured.push(...req.messages);
      return '<提示词>ok</提示词>';
    },
  } as unknown as AIService;
  const promptAssembler = {
    renderSingle: (id: string) => `[[${id}]]`,
  } as unknown as PromptAssembler;
  return { tokenizer: new ImageTokenizer(aiService, promptAssembler), captured };
}

const doubaoContext: TransformerPresetContext = {
  aiRolePrompt: 'doubao role',
  taskPrompt: 'doubao task',
  serializationStrategy: 'seedream_narrative',
};

const naiContext: TransformerPresetContext = {
  aiRolePrompt: 'nai role',
  taskPrompt: 'nai task',
  serializationStrategy: 'nai_character_segments',
};

function allText(captured: Array<{ role: string; content: string }>): string {
  return captured.map((m) => m.content).join('\n===\n');
}

describe('tokenizeCharacter output mandates by strategy', () => {
  it('seedream_narrative swaps the 【输出要求】 block to Chinese narrative', async () => {
    const { tokenizer, captured } = makeHarness();
    await tokenizer.tokenizeCharacter({
      characterName: '林婉儿',
      npcDataJson: '{"姓名":"林婉儿"}',
      presetContext: doubaoContext,
    });
    const text = allText(captured);
    expect(text).toContain('输出语言：中文自然语言完整句子');
    expect(text).toContain('组织方式：写成连贯段落');
    expect(text).not.toContain('输出语言：英文 tags');
    expect(text).not.toContain('加权分组');
    expect(text).not.toContain('1girl, long hair, red eyes');
  });

  it('non-narrative strategies keep the legacy English-tags mandates verbatim', async () => {
    const { tokenizer, captured } = makeHarness();
    await tokenizer.tokenizeCharacter({
      characterName: '林婉儿',
      npcDataJson: '{"姓名":"林婉儿"}',
      presetContext: naiContext,
    });
    const text = allText(captured);
    expect(text).toContain('输出语言：英文 tags，使用英文逗号分隔。');
    expect(text).toContain('标签组织：优先整理成 4 到 6 个加权分组，再补少量自然标签。');
    expect(text).not.toContain('中文自然语言完整句子');
  });

  it('no presetContext (legacy fallback) keeps the English mandates', async () => {
    const { tokenizer, captured } = makeHarness();
    await tokenizer.tokenizeCharacter({
      characterName: '林婉儿',
      npcDataJson: '{"姓名":"林婉儿"}',
    });
    const text = allText(captured);
    expect(text).toContain('输出语言：英文 tags，使用英文逗号分隔。');
  });
});

describe('tokenizeScene output mandates by strategy', () => {
  const sceneContext: SceneContext = {
    location: { broad: '青云城', mid: '', specific: '城南长街', fullPath: '青云城·城南长街' },
    compositionMode: 'auto',
    timeDescription: '黄昏',
    weather: '小雨',
    festivalName: '',
    environmentSummary: '',
    presentNpcs: ['林婉儿'],
    npcDetails: [],
    narrativeText: '雨中的长街上，林婉儿撑伞走过石桥。',
    extraRequirements: '',
  } as unknown as SceneContext;

  it('seedream_narrative removes every English-tags mandate from the scene prompt', async () => {
    const { tokenizer, captured } = makeHarness();
    await tokenizer.tokenizeScene({ sceneContext, presetContext: doubaoContext });
    const text = allText(captured);
    expect(text).toContain('中文自然语言');
    expect(text).toContain('输出格式要求：');
    expect(text).not.toContain('英文 tags');
    expect(text).not.toContain('palace night, lanterns');
    expect(text).not.toContain('质量与介质');
    expect(text).toContain('描述顺序：地点与天气');
  });

  it('non-narrative strategies keep the legacy scene mandates verbatim', async () => {
    const { tokenizer, captured } = makeHarness();
    await tokenizer.tokenizeScene({ sceneContext, presetContext: naiContext });
    const text = allText(captured);
    expect(text).toContain('标签格式要求：');
    expect(text).toContain('要求：词组应以英文 tags 为主');
    expect(text).toContain('输出顺序：质量与介质');
    expect(text).not.toContain('输出格式要求：');
  });

  it('narrative swaps the npcDetails hint from 标签 to 描写 in both scene branches', async () => {
    const withNpc = {
      ...sceneContext,
      npcDetails: [{ name: '林婉儿', appearance: '眉目清亮', bodyDescription: '', outfitStyle: '淡青长衫', description: '' }],
    } as unknown as SceneContext;
    const auto = makeHarness();
    await auto.tokenizer.tokenizeScene({ sceneContext: withNpc, presetContext: doubaoContext });
    expect(allText(auto.captured)).toContain('人物外观描写');
    expect(allText(auto.captured)).not.toContain('人物外观标签');
    const forced = makeHarness();
    await forced.tokenizer.tokenizeScene({
      sceneContext: { ...withNpc, compositionMode: 'story_snapshot' } as unknown as SceneContext,
      presetContext: naiContext,
    });
    expect(allText(forced.captured)).toContain('人物外观标签');
  });

  it('forced pure-landscape mode honors the narrative flag too', async () => {
    const { tokenizer, captured } = makeHarness();
    await tokenizer.tokenizeScene({
      sceneContext: { ...sceneContext, compositionMode: 'pure_landscape' } as unknown as SceneContext,
      presetContext: doubaoContext,
    });
    const text = allText(captured);
    expect(text).toContain('中文自然语言');
    expect(text).not.toContain('英文 tags');
    expect(text).not.toContain('ancient temple, misty mountain');
    expect(text).toContain('晨曦中的古寺');
  });
});

describe('tokenizeSecretPart output mandates by strategy', () => {
  const base = {
    characterName: '林婉儿',
    part: 'breast' as const,
    partDescription: '描述',
    npcDataJson: '{"姓名":"林婉儿"}',
  };

  it('doubao presetContext swaps the English mandates for Chinese narrative', async () => {
    const { tokenizer, captured } = makeHarness();
    await tokenizer.tokenizeSecretPart({ ...base, presetContext: doubaoContext });
    const text = allText(captured);
    expect(text).toContain('中文自然语言特写描述');
    expect(text).toContain('输出格式：使用中文自然语言完整句子');
    expect(text).not.toContain('英文 tags');
    expect(text).not.toContain('输出格式：使用英文逗号分隔的短语串。');
    // Doubao bundle system prompt reaches this flow now
    expect(text).toContain('doubao role');
  });

  it('no presetContext (every legacy strategy) keeps the historical chain verbatim', async () => {
    const { tokenizer, captured } = makeHarness();
    await tokenizer.tokenizeSecretPart({ ...base });
    const text = allText(captured);
    expect(text).toContain('任务：将角色资料、角色锚点与部位描述转化为稳定、可画的生图短语（英文 tags）。');
    expect(text).toContain('输出格式：使用英文逗号分隔的短语串。');
    expect(text).not.toContain('中文自然语言');
    expect(text).not.toContain('doubao role');
  });
});
