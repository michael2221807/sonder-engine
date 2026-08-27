import { describe, it, expect } from 'vitest';
import {
  getTransformerPresetContext,
  getDefaultPresets,
  getDefaultModelBundles,
} from '@/engine/image/transformer-presets';

describe('getDefaultPresets', () => {
  it('returns 18 default presets', () => {
    expect(getDefaultPresets()).toHaveLength(18);
  });

  it('covers all 3 scopes × 6 backends', () => {
    const presets = getDefaultPresets();
    const npc = presets.filter((p) => p.scope === 'npc');
    const scene = presets.filter((p) => p.scope === 'scene');
    const judge = presets.filter((p) => p.scope === 'scene_judge');
    expect(npc).toHaveLength(6);
    expect(scene).toHaveLength(6);
    expect(judge).toHaveLength(6);
  });

  it('all presets have non-empty prompt', () => {
    for (const p of getDefaultPresets()) {
      expect(p.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it('NPC presets have anchor mode and no-anchor fallback', () => {
    const npcPresets = getDefaultPresets().filter((p) => p.scope === 'npc');
    for (const p of npcPresets) {
      expect(p.anchorModePrompt?.trim().length).toBeGreaterThan(0);
      expect(p.noAnchorFallbackPrompt?.trim().length).toBeGreaterThan(0);
    }
  });

  it('scene presets have scene anchor mode prompt', () => {
    const scenePresets = getDefaultPresets().filter((p) => p.scope === 'scene');
    for (const p of scenePresets) {
      expect(p.sceneAnchorModePrompt?.trim().length).toBeGreaterThan(0);
    }
  });

  it('wuxia terms are generalized (no 武侠/仙侠/境界)', () => {
    for (const p of getDefaultPresets()) {
      const allText = [p.prompt, p.anchorModePrompt, p.noAnchorFallbackPrompt, p.outputFormatPrompt, p.sceneAnchorModePrompt]
        .filter(Boolean).join(' ');
      expect(allText).not.toContain('武侠');
      expect(allText).not.toContain('仙侠');
      expect(allText).not.toContain('境界');
    }
  });
});

describe('getDefaultModelBundles', () => {
  it('returns 6 model bundles', () => {
    expect(getDefaultModelBundles()).toHaveLength(6);
  });

  it('NAI bundle is enabled by default', () => {
    const nai = getDefaultModelBundles().find((b) => b.name === 'NAI');
    expect(nai?.enabled).toBe(true);
  });

  it('Gemini, Grok, Illustrious, Pony, and Doubao bundles are disabled by default', () => {
    const bundles = getDefaultModelBundles();
    expect(bundles.find((b) => b.name === 'Gemini')?.enabled).toBe(false);
    expect(bundles.find((b) => b.name === 'Grok')?.enabled).toBe(false);
    expect(bundles.find((b) => b.name === 'Illustrious')?.enabled).toBe(false);
    expect(bundles.find((b) => b.name === 'Pony')?.enabled).toBe(false);
    expect(bundles.find((b) => b.name === 'Doubao Seedream')?.enabled).toBe(false);
  });

  it('Illustrious and Pony bundles use sd_danbooru strategy', () => {
    const bundles = getDefaultModelBundles();
    expect(bundles.find((b) => b.name === 'Illustrious')?.serializationStrategy).toBe('sd_danbooru');
    expect(bundles.find((b) => b.name === 'Pony')?.serializationStrategy).toBe('sd_danbooru');
  });

  it('Doubao bundle uses the seedream_narrative strategy with Chinese natural-language doctrine', () => {
    const doubao = getDefaultModelBundles().find((b) => b.name === 'Doubao Seedream');
    expect(doubao?.serializationStrategy).toBe('seedream_narrative');
    // Researched doctrine pins (2026-08-27): natural language, no weight
    // syntax, inline exclusions, no vapid quality words.
    expect(doubao?.modelPrompt).toContain('自然语言');
    expect(doubao?.modelPrompt).toContain('权重语法');
    expect(doubao?.modelPrompt).toContain('负面提示词');
    expect(doubao?.modelPrompt).toContain('masterpiece');
  });

  it('each bundle links to valid preset IDs', () => {
    const presetIds = new Set(getDefaultPresets().map((p) => p.id));
    for (const b of getDefaultModelBundles()) {
      expect(presetIds.has(b.npcPresetId)).toBe(true);
      expect(presetIds.has(b.scenePresetId)).toBe(true);
      expect(presetIds.has(b.sceneJudgePresetId)).toBe(true);
    }
  });

  it('wuxia terms are generalized in model bundles', () => {
    for (const b of getDefaultModelBundles()) {
      const allText = [b.modelPrompt, b.anchorModeModelPrompt].join(' ');
      expect(allText).not.toContain('武侠');
      expect(allText).not.toContain('仙侠');
      expect(allText).not.toContain('境界');
    }
  });
});

describe('getTransformerPresetContext', () => {
  it('returns NAI NPC context with correct strategy', () => {
    const ctx = getTransformerPresetContext('npc');
    expect(ctx.serializationStrategy).toBe('nai_character_segments');
    expect(ctx.aiRolePrompt).toContain('NovelAI');
    expect(ctx.taskPrompt).toContain('角色提示词整理器');
  });

  it('default mode includes no-anchor fallback prompt', () => {
    const ctx = getTransformerPresetContext('npc', 'default');
    expect(ctx.taskPrompt).toContain('请根据输入的角色设定完成完整角色生成');
  });

  it('anchor mode uses anchor-specific prompt', () => {
    const ctx = getTransformerPresetContext('npc', 'anchor');
    expect(ctx.taskPrompt).toContain('沿用锚点');
    expect(ctx.aiRolePrompt).toContain('沿用锚点');
  });

  it('scene scope returns scene preset', () => {
    const ctx = getTransformerPresetContext('scene');
    expect(ctx.taskPrompt).toContain('场景提示词整理器');
  });

  it('scene_judge scope returns judge preset', () => {
    const ctx = getTransformerPresetContext('scene_judge');
    expect(ctx.taskPrompt).toContain('风景场景');
    expect(ctx.taskPrompt).toContain('故事快照');
  });

  it('respects activeBundleId override', () => {
    const ctx = getTransformerPresetContext('npc', 'default', {
      activeBundleId: 'transformer_model_bundle_grok',
    });
    expect(ctx.serializationStrategy).toBe('grok_structured');
    expect(ctx.aiRolePrompt).toContain('Grok');
  });

  it('returns empty context when no bundle is active', () => {
    const ctx = getTransformerPresetContext('npc', 'default', {
      customBundles: [{ ...getDefaultModelBundles()[0], enabled: false }],
    });
    expect(ctx.aiRolePrompt).toBe('');
    expect(ctx.taskPrompt).toBe('');
    expect(ctx.serializationStrategy).toBe('flat');
  });

  it('includes output format by default', () => {
    const ctx = getTransformerPresetContext('npc');
    expect(ctx.taskPrompt).toContain('<提示词>');
  });

  it('excludes output format when includeOutputFormat=false', () => {
    const ctx = getTransformerPresetContext('npc', 'default', {
      includeOutputFormat: false,
    });
    expect(ctx.taskPrompt).not.toContain('<提示词>');
  });
});
