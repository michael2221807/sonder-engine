import { describe, it, expect } from 'vitest';
import {
  buildSecretPartDescription,
  buildSecretPartSystemPrompt,
  buildSecretPartTaskData,
  reinforceSecretPartPrompt,
} from '@/engine/image/secret-part-prompt';

describe('buildSecretPartDescription', () => {
  it('breast: includes macro photography and subsurface scattering', () => {
    const desc = buildSecretPartDescription('breast');
    expect(desc).toContain('Breasts Macro Photography');
    expect(desc).toContain('Subsurface scattering');
    expect(desc).toContain('乳头');
  });

  it('vagina: includes macro focus and wetness', () => {
    const desc = buildSecretPartDescription('vagina');
    expect(desc).toContain('Macro Focus');
    expect(desc).toContain('Wetness');
  });

  it('anus: includes extreme close-up and skin texture', () => {
    const desc = buildSecretPartDescription('anus');
    expect(desc).toContain('Extreme Close-up');
    expect(desc).toContain('Skin texture');
  });
});

describe('buildSecretPartSystemPrompt', () => {
  it('NovelAI: includes NAI-specific instructions', () => {
    const prompt = buildSecretPartSystemPrompt({ part: 'breast', isNovelAI: true, hasAnchor: false });
    expect(prompt).toContain('NovelAI V4/V4.5');
    expect(prompt).toContain('Macro Focus');
    expect(prompt).toContain('subsurface scattering');
    expect(prompt).toContain('<提示词>');
  });

  it('non-NovelAI: includes generic instructions', () => {
    const prompt = buildSecretPartSystemPrompt({ part: 'breast', isNovelAI: false, hasAnchor: false });
    expect(prompt).toContain('微距特写');
    expect(prompt).toContain('90%');
    expect(prompt).not.toContain('NovelAI');
  });

  it('includes anchor alignment when hasAnchor=true', () => {
    const prompt = buildSecretPartSystemPrompt({ part: 'breast', isNovelAI: true, hasAnchor: true });
    expect(prompt).toContain('锚点对齐');
  });

  it('no wuxia terms in prompts', () => {
    const nai = buildSecretPartSystemPrompt({ part: 'breast', isNovelAI: true, hasAnchor: false });
    const generic = buildSecretPartSystemPrompt({ part: 'breast', isNovelAI: false, hasAnchor: false });
    expect(nai).not.toContain('武侠');
    expect(nai).not.toContain('仙侠');
    expect(generic).not.toContain('武侠');
    expect(generic).not.toContain('仙侠');
  });

  it('injects the art style line on both backends when artStyle is set', () => {
    const nai = buildSecretPartSystemPrompt({ part: 'breast', isNovelAI: true, hasAnchor: false, artStyle: '动漫' });
    const generic = buildSecretPartSystemPrompt({ part: 'vagina', isNovelAI: false, hasAnchor: false, artStyle: '写实' });
    expect(nai).toContain('【画风要求】');
    expect(nai).toContain('「动漫」');
    expect(generic).toContain('画风要求');
    expect(generic).toContain('「写实」');
  });

  it('omits the art style line when artStyle is absent', () => {
    const nai = buildSecretPartSystemPrompt({ part: 'breast', isNovelAI: true, hasAnchor: false });
    const generic = buildSecretPartSystemPrompt({ part: 'breast', isNovelAI: false, hasAnchor: false });
    expect(nai).not.toContain('画风要求');
    expect(generic).not.toContain('画风要求');
  });
});

describe('buildSecretPartTaskData', () => {
  it('NovelAI: includes output requirements with macro constraints', () => {
    const data = buildSecretPartTaskData({
      part: 'breast',
      rawDescription: '{"描述":"test"}',
      isNovelAI: true,
    });
    expect(data).toContain('extreme close-up');
    expect(data).toContain('face, portrait');
    expect(data).toContain('胸部');
  });

  it('includes anchor data when provided', () => {
    const data = buildSecretPartTaskData({
      part: 'vagina',
      rawDescription: '{}',
      isNovelAI: true,
      anchorPositive: 'pale skin, young adult',
      anchorInjected: 'pale skin',
    });
    expect(data).toContain('角色稳定视觉锚点');
    expect(data).toContain('部位裁剪锚点');
  });

  it('non-NovelAI: no wuxia world-building reference', () => {
    const data = buildSecretPartTaskData({
      part: 'breast',
      rawDescription: '{}',
      isNovelAI: false,
    });
    expect(data).not.toContain('武侠');
    expect(data).not.toContain('仙侠');
  });

  it('includes 画风 line on both backends when artStyle is set, omits otherwise', () => {
    const nai = buildSecretPartTaskData({ part: 'breast', rawDescription: '{}', isNovelAI: true, artStyle: '古风' });
    const generic = buildSecretPartTaskData({ part: 'anus', rawDescription: '{}', isNovelAI: false, artStyle: '动漫' });
    const none = buildSecretPartTaskData({ part: 'breast', rawDescription: '{}', isNovelAI: true });
    expect(nai).toContain('画风：古风');
    expect(generic).toContain('画风：动漫');
    expect(none).not.toContain('画风：');
  });
});

describe('reinforceSecretPartPrompt', () => {
  it('strips portrait/upper body tags', () => {
    const result = reinforceSecretPartPrompt('large breasts, portrait, upper body, pale skin');
    expect(result).toContain('large breasts');
    expect(result).toContain('pale skin');
    expect(result).not.toContain('portrait');
    expect(result).not.toContain('upper body');
  });

  it('strips scenery/background tags', () => {
    const result = reinforceSecretPartPrompt('nipples, scenery, indoors, subsurface scattering');
    expect(result).toContain('nipples');
    expect(result).toContain('subsurface scattering');
    expect(result).not.toContain('scenery');
    expect(result).not.toContain('indoors');
  });

  it('handles empty input', () => {
    expect(reinforceSecretPartPrompt('')).toBe('');
  });

  it('preserves non-composition tags', () => {
    const result = reinforceSecretPartPrompt('1girl, large breasts, cleavage, pale skin, macro shot');
    expect(result).toContain('1girl');
    expect(result).toContain('large breasts');
    expect(result).toContain('macro shot');
  });
});
