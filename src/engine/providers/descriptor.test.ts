import { describe, it, expect } from 'vitest';
import { ProviderCatalog, API_KEY_CREDENTIAL } from './descriptor';
import { registerBuiltinProviders } from './catalog-entries';
import { providerCatalog } from './index';
import { API_PROVIDER_PRESETS } from '../ai/types';
import type { UsageType } from '../ai/types';
import type { ImageBackendType } from '../image/types';
import { PROVIDER_CAPABILITIES } from '../image/provider-capabilities';
import { perBackendUsageType } from './usage-keys';

describe('ProviderCatalog', () => {
  it('registers and resolves descriptors by (category, id)', () => {
    const catalog = new ProviderCatalog();
    catalog.register({
      id: 'x', category: 'image', urlPreset: 'https://x.test', defaultPath: '/gen',
      credentialFields: [API_KEY_CREDENTIAL], capabilities: { textToImage: true },
    });
    expect(catalog.has('image', 'x')).toBe(true);
    expect(catalog.get('image', 'x')?.defaultPath).toBe('/gen');
    expect(catalog.get('tts', 'x')).toBeUndefined();
    expect(catalog.byCategory('image').map((d) => d.id)).toEqual(['x']);
    expect(catalog.byCategory('llm')).toEqual([]);
  });

  it('same id may exist in different categories (multi-modal vendors)', () => {
    const catalog = new ProviderCatalog();
    catalog.register({ id: 'v', category: 'tts', urlPreset: '', defaultPath: '/', credentialFields: [], capabilities: {} });
    catalog.register({ id: 'v', category: 'stt', urlPreset: '', defaultPath: '/', credentialFields: [], capabilities: {} });
    expect(catalog.has('tts', 'v')).toBe(true);
    expect(catalog.has('stt', 'v')).toBe(true);
  });

  it('throws on duplicate (category, id) — fail-fast wiring guard', () => {
    const catalog = new ProviderCatalog();
    const d = { id: 'dup', category: 'llm' as const, urlPreset: '', defaultPath: '/', credentialFields: [], capabilities: {} };
    catalog.register(d);
    expect(() => catalog.register({ ...d })).toThrow(/duplicate/);
  });
});

describe('built-in catalog entries', () => {
  it('image ids align 1:1 with ImageBackendType (cycle-avoidance pin)', () => {
    // catalog-entries.ts uses plain strings to avoid an import cycle with
    // image/types; this pin is the compensating guarantee.
    const expected: ImageBackendType[] = ['openai', 'novelai', 'sd_webui', 'comfyui', 'civitai', 'volcengine'];
    const ids = providerCatalog.byCategory('image').map((d) => d.id).sort();
    expect(ids).toEqual([...expected].sort());
  });

  it('llm entries mirror API_PROVIDER_PRESETS (url + default model)', () => {
    for (const [id, preset] of Object.entries(API_PROVIDER_PRESETS)) {
      const d = providerCatalog.get('llm', id);
      expect(d, `llm descriptor missing for "${id}"`).toBeDefined();
      expect(d!.urlPreset).toBe(preset.url);
      expect(d!.defaultModel ?? '').toBe(preset.defaultModel);
    }
  });

  it('voice backends registered for both tts and stt', () => {
    expect(providerCatalog.get('tts', 'cosyvoice')?.capabilities.speakerListing).toBe(true);
    expect(providerCatalog.get('stt', 'cosyvoice')?.capabilities.sttStreaming).toBe(true);
    // CosyVoice needs no key — the credential must not be marked required.
    expect(providerCatalog.get('tts', 'cosyvoice')?.credentialFields[0]?.required).toBe(false);
  });

  it('PROVIDER_CAPABILITIES derivation matches the pre-P0 hand-written map (+ P1 volcengine)', () => {
    // Regression pin: first five verbatim from provider-capabilities.ts@8899da8;
    // referenceStrength added 2026-08-27 (numeric 重绘幅度 support, see below).
    expect(PROVIDER_CAPABILITIES).toEqual({
      civitai: { textToImage: true, imageToImage: true, imageCaptioning: true, imageTagging: true, inpainting: false, referenceStrength: true },
      novelai: { textToImage: true, imageToImage: true, imageCaptioning: false, imageTagging: false, inpainting: false, referenceStrength: true },
      openai: { textToImage: true, imageToImage: false, imageCaptioning: false, imageTagging: false, inpainting: false, referenceStrength: false },
      sd_webui: { textToImage: true, imageToImage: false, imageCaptioning: false, imageTagging: false, inpainting: false, referenceStrength: false },
      comfyui: { textToImage: true, imageToImage: false, imageCaptioning: false, imageTagging: false, inpainting: false, referenceStrength: false },
      volcengine: { textToImage: true, imageToImage: true, imageCaptioning: false, imageTagging: false, inpainting: false, referenceStrength: false },
    });
  });

  it('referenceStrength is declared only where the vendor API actually has a strength param', () => {
    // The 重绘幅度 slider is capability-gated on this flag (4 UI surfaces).
    // NovelAI → parameters.strength; Civitai → sourceImageDenoiseStrenght.
    // Seedream/Doubao's official parameter table has NO strength/denoise field
    // (verified 2026-08-27), so it must stay false or the slider becomes a
    // dead control again.
    const strengthCapable = providerCatalog.byCategory('image')
      .filter((d) => d.capabilities.referenceStrength === true)
      .map((d) => d.id)
      .sort();
    expect(strengthCapable).toEqual(['civitai', 'novelai']);
    // Every img2img backend WITHOUT the flag must render the hint instead.
    const img2imgNoStrength = providerCatalog.byCategory('image')
      .filter((d) => d.capabilities.imageToImage === true && d.capabilities.referenceStrength !== true)
      .map((d) => d.id);
    expect(img2imgNoStrength).toEqual(['volcengine']);
  });

  it('registerBuiltinProviders is single-shot (re-registration throws)', () => {
    expect(() => registerBuiltinProviders(providerCatalog)).toThrow(/duplicate/);
  });

  it('every catalog-derived per-backend usage key is a declared UsageType member', () => {
    // `declared` is typed UsageType[] — adding a catalog entry without its
    // 1-line union member in ai/types.ts fails compilation right here; the
    // runtime equality below catches the reverse drift (union member whose
    // catalog entry was forgotten). This is the compensating guarantee for
    // the single cast inside perBackendUsageType (usage-keys.ts).
    const declared: UsageType[] = [
      'imageGen_civitai', 'imageGen_novelai', 'imageGen_openai',
      'imageGen_sd_webui', 'imageGen_comfyui', 'imageGen_volcengine',
      'ttsGen_cosyvoice', 'ttsGen_doubao',
      'sttGen_cosyvoice', 'sttGen_doubao',
    ];
    const derived = [
      ...providerCatalog.byCategory('image').map((d) => perBackendUsageType('image', d.id)),
      ...providerCatalog.byCategory('tts').map((d) => perBackendUsageType('tts', d.id)),
      ...providerCatalog.byCategory('stt').map((d) => perBackendUsageType('stt', d.id)),
    ];
    expect([...derived].sort()).toEqual([...declared].sort());
  });
});
