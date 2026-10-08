import type { AIService } from '../engine/ai/ai-service';
import type { StateManager } from '../engine/core/state-manager';
import { ImageService } from '../engine/image/image-service';
import { ImageProviderRegistry } from '../engine/image/provider-registry';
import { CivitaiImageProvider } from '../engine/image/providers/civitai';
import { ComfyUIImageProvider } from '../engine/image/providers/comfyui';
import { NovelAIImageProvider } from '../engine/image/providers/novelai';
import { OpenAIImageProvider } from '../engine/image/providers/openai';
import { SDWebUIImageProvider } from '../engine/image/providers/sd-webui';
import { VolcengineImageProvider } from '../engine/image/providers/volcengine';
import { migrateImageState } from '../engine/image/save-migration';
import { DEFAULT_ENGINE_PATHS } from '../engine/pipeline/types';
import type { PromptAssembler } from '../engine/prompt/prompt-assembler';
import { measureConnectionTest, providerCatalog } from '../engine/providers';
import { SttProviderRegistry } from '../engine/stt/provider-registry';
import { CosyVoiceSttProvider } from '../engine/stt/providers/cosyvoice';
import { DoubaoSttProvider } from '../engine/stt/providers/doubao';
import { SttService } from '../engine/stt/stt-service';
import { TtsProviderRegistry } from '../engine/tts/provider-registry';
import { CosyVoiceProvider } from '../engine/tts/providers/cosyvoice';
import { DoubaoTtsProvider } from '../engine/tts/providers/doubao';
import { TtsService } from '../engine/tts/tts-service';
import type { GamePack } from '../engine/types';

/** Moved verbatim out of main.ts bootstrap() (R5 step 5). Statement order inside is behavior. */
export function createMediaServices(deps: {
  pack: GamePack | null;
  aiService: AIService;
  promptAssembler: PromptAssembler;
  stateManager: StateManager;
}) {
  const { pack, aiService, promptAssembler, stateManager } = deps;
  // ── Image subsystem bootstrap (must be before orchestrator which references imageService) ──
  const imageProviderRegistry = new ImageProviderRegistry();
  imageProviderRegistry.register('novelai', (c) => new NovelAIImageProvider(c.endpoint, c.apiKey, c.model));
  imageProviderRegistry.register('openai', (c) => new OpenAIImageProvider(c.endpoint, c.apiKey, c.model));
  imageProviderRegistry.register('sd_webui', (c) => new SDWebUIImageProvider(c.endpoint, c.apiKey, c.model));
  imageProviderRegistry.register('comfyui', (c) => new ComfyUIImageProvider(c.endpoint, c.apiKey, c.model));
  imageProviderRegistry.register('civitai', (c) => new CivitaiImageProvider(c.endpoint, c.apiKey, c.model));
  imageProviderRegistry.register('volcengine', (c) => new VolcengineImageProvider(c.endpoint, c.apiKey, c.model));

  const imageService = new ImageService(
    stateManager,
    aiService,
    promptAssembler,
    imageProviderRegistry,
    DEFAULT_ENGINE_PATHS,
  );

  // Pass pack-level transformer defaults to ImageService for i18n-aware prompt text
  if (pack?.transformerDefaults) {
    imageService.setTransformerDefaults(
      pack.transformerDefaults as import('../engine/image/transformer-presets').TransformerDefaultsData,
    );
  }

  migrateImageState(stateManager);

  // ── TTS subsystem bootstrap (before orchestrator which references ttsService) ──
  const ttsProviderRegistry = new TtsProviderRegistry();
  ttsProviderRegistry.register('cosyvoice', (c) => new CosyVoiceProvider(c.endpoint, c.apiKey, c.routingPath));
  ttsProviderRegistry.register('doubao', (c) => new DoubaoTtsProvider(c.endpoint, c.apiKey, c.routingPath, c.credentials));
  const ttsService = new TtsService(aiService, ttsProviderRegistry);

  // ── STT subsystem bootstrap (语音输入;用户触发,不进 orchestrator subPipelines) ──
  const sttProviderRegistry = new SttProviderRegistry();
  sttProviderRegistry.register('cosyvoice', (c) => new CosyVoiceSttProvider(c.endpoint, c.apiKey, c.routingPath));
  sttProviderRegistry.register('doubao', (c) => new DoubaoSttProvider(c.endpoint, c.apiKey, c.routingPath, c.credentials));
  const sttService = new SttService(aiService, sttProviderRegistry);

  // ── Provider catalog wiring (epic P0) ──
  // 1. Fail-fast pairing check: every image/tts/stt descriptor must have a
  //    registered factory and vice versa — a mismatch is a wiring bug caught at boot.
  for (const [category, registry] of [
    ['image', imageProviderRegistry],
    ['tts', ttsProviderRegistry],
    ['stt', sttProviderRegistry],
  ] as const) {
    const catalogIds = providerCatalog.byCategory(category).map((d) => d.id).sort();
    const factoryIds = [...registry.registeredBackends].sort();
    if (JSON.stringify(catalogIds) !== JSON.stringify(factoryIds)) {
      throw new Error(
        `[bootstrap] provider catalog/registry mismatch for "${category}": ` +
        `catalog=[${catalogIds.join(',')}] factories=[${factoryIds.join(',')}]`,
      );
    }
  }
  // 2. Connection-test delegation (epic P0 §3.4): the APIPanel test button now
  //    exercises each backend's own testConnection() instead of AIService's
  //    former hardcoded branches (which probed Civitai's endpoint for every
  //    image backend).
  aiService.registerConnectionTester('image', (cfg) => measureConnectionTest(async () => {
    const backend = (cfg.backend ?? '') as import('../engine/image/types').ImageBackendType;
    if (!imageProviderRegistry.has(backend)) {
      return { ok: false, error: `未知图片后端 "${cfg.backend ?? ''}"（自定义后端暂不支持连测）` };
    }
    const provider = imageProviderRegistry.resolve({ backend, endpoint: cfg.url, apiKey: cfg.apiKey, model: cfg.model });
    return { ok: await provider.testConnection() };
  }));
  aiService.registerConnectionTester('tts', (cfg) => measureConnectionTest(async () => {
    const backend = (cfg.backend ?? 'cosyvoice') as import('../engine/tts/types').TtsBackendType;
    if (!ttsProviderRegistry.has(backend)) return { ok: false, error: `未知配音后端 "${backend}"` };
    const provider = ttsProviderRegistry.resolve({ backend, endpoint: cfg.url, apiKey: cfg.apiKey, model: cfg.model, routingPath: cfg.customRoutingPath, credentials: cfg.credentials });
    return provider.testConnection({ speaker: cfg.ttsSpeaker });
  }));
  aiService.registerConnectionTester('stt', (cfg) => measureConnectionTest(async () => {
    const backend = (cfg.backend ?? 'cosyvoice') as import('../engine/stt/types').SttBackendType;
    if (!sttProviderRegistry.has(backend)) return { ok: false, error: `未知语音输入后端 "${backend}"` };
    const provider = sttProviderRegistry.resolve({ backend, endpoint: cfg.url, apiKey: cfg.apiKey, model: cfg.model, routingPath: cfg.customRoutingPath, credentials: cfg.credentials });
    return provider.testConnection();
  }));

  return { imageService, ttsService, sttService };
}
