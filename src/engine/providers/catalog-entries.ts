/**
 * Built-in provider descriptors — every backend the app ships with today.
 *
 * All values are FACTS lifted from the existing implementations (file refs in
 * comments); adding a vendor here plus its provider class is the whole
 * per-vendor cost after P0 (design doc §3.3).
 *
 * Ids are plain strings on purpose: importing ImageBackendType / TtsBackendType
 * here would create an import cycle (image/types → provider-capabilities →
 * providers → this file). Alignment with those unions is pinned by
 * descriptor.test.ts instead.
 */
import {
  ProviderCatalog,
  API_KEY_CREDENTIAL,
  OPTIONAL_API_KEY_CREDENTIAL,
} from './descriptor';
import type { CredentialFieldSpec } from './descriptor';

/** 豆包语音三凭证（epic P2/P3, decision D3）— appid + access token + resource id */
const DOUBAO_VOICE_CREDENTIALS: CredentialFieldSpec[] = [
  { key: 'appId', i18nKey: 'api.credential.appId', required: true, secret: false },
  { key: 'accessToken', i18nKey: 'api.credential.accessToken', required: true, secret: true },
  { key: 'resourceId', i18nKey: 'api.credential.resourceId', required: true, secret: false },
];

export function registerBuiltinProviders(catalog: ProviderCatalog): void {
  // ── LLM presets (previously API_PROVIDER_PRESETS in ai/types.ts) ──
  catalog.register({
    id: 'openai', category: 'llm',
    urlPreset: 'https://api.openai.com',
    defaultPath: '/v1/chat/completions', modelsPath: '/v1/models',
    credentialFields: [API_KEY_CREDENTIAL],
    capabilities: {}, defaultModel: 'gpt-4o',
  });
  catalog.register({
    id: 'claude', category: 'llm',
    urlPreset: 'https://api.anthropic.com',
    // ClaudeProvider owns its request format; paths recorded for reference.
    defaultPath: '/v1/messages', modelsPath: '/v1/models',
    credentialFields: [API_KEY_CREDENTIAL],
    capabilities: {}, defaultModel: 'claude-sonnet-4-20250514',
  });
  catalog.register({
    id: 'gemini', category: 'llm',
    urlPreset: 'https://generativelanguage.googleapis.com',
    // GeminiProvider builds model-scoped paths itself (/v1beta/models/<m>:…).
    defaultPath: '/v1beta', modelsPath: '/v1beta/models',
    credentialFields: [API_KEY_CREDENTIAL],
    capabilities: {}, defaultModel: 'gemini-2.0-flash',
  });
  catalog.register({
    id: 'deepseek', category: 'llm',
    urlPreset: 'https://api.deepseek.com',
    defaultPath: '/v1/chat/completions', modelsPath: '/v1/models',
    credentialFields: [API_KEY_CREDENTIAL],
    capabilities: {}, defaultModel: 'deepseek-chat',
  });
  catalog.register({
    id: 'custom', category: 'llm',
    urlPreset: '',
    defaultPath: '/v1/chat/completions', modelsPath: '/v1/models',
    credentialFields: [API_KEY_CREDENTIAL],
    capabilities: {},
  });
  catalog.register({
    // 火山方舟 LLM — epic P4, decision D4: an OpenAI-compatible PRESET (the
    // persisted APIProviderType union stays untouched; the config stores
    // provider:'custom' + backend:'volcano_ark', and OpenAIProvider resolves
    // its chat path from this descriptor instead of the /v1 hardcode).
    // modelsPath deliberately omitted until a real key verifies Ark exposes a
    // listing endpoint — the UI hides the fetch-models button without it.
    id: 'volcano_ark', category: 'llm',
    urlPreset: 'https://ark.cn-beijing.volces.com',
    defaultPath: '/api/v3/chat/completions',
    credentialFields: [API_KEY_CREDENTIAL],
    capabilities: {},
    defaultModel: 'doubao-seed-1-6-250615',
  });

  // ── Image backends (URLs from APIPanel IMAGE_BACKEND_STATIC; paths from provider classes) ──
  catalog.register({
    id: 'civitai', category: 'image',
    urlPreset: 'https://orchestration.civitai.com',
    defaultPath: '/v2/consumer/workflows', // civitai.ts:436
    credentialFields: [API_KEY_CREDENTIAL],
    capabilities: { textToImage: true, imageToImage: true, imageCaptioning: true, imageTagging: true, inpainting: false },
    defaultModel: 'urn:air:sdxl:checkpoint:civitai:101055@128078',
  });
  catalog.register({
    id: 'novelai', category: 'image',
    urlPreset: 'https://image.novelai.net',
    defaultPath: '/ai/generate-image', // novelai.ts:124
    credentialFields: [API_KEY_CREDENTIAL],
    capabilities: { textToImage: true, imageToImage: true, imageCaptioning: false, imageTagging: false, inpainting: false },
    defaultModel: 'nai-diffusion-4-5-full',
  });
  catalog.register({
    id: 'openai', category: 'image',
    urlPreset: 'https://api.openai.com',
    defaultPath: '/v1/images/generations', modelsPath: '/v1/models', // openai.ts:41,80
    credentialFields: [API_KEY_CREDENTIAL],
    capabilities: { textToImage: true, imageToImage: false, imageCaptioning: false, imageTagging: false, inpainting: false },
    defaultModel: 'dall-e-3',
  });
  catalog.register({
    id: 'sd_webui', category: 'image',
    urlPreset: 'http://localhost:7860',
    defaultPath: '/sdapi/v1/txt2img', modelsPath: '/sdapi/v1/sd-models', // sd-webui.ts:45,71
    credentialFields: [OPTIONAL_API_KEY_CREDENTIAL],
    capabilities: { textToImage: true, imageToImage: false, imageCaptioning: false, imageTagging: false, inpainting: false },
  });
  catalog.register({
    id: 'comfyui', category: 'image',
    urlPreset: 'http://localhost:8188',
    defaultPath: '/prompt', // comfyui.ts:81
    credentialFields: [OPTIONAL_API_KEY_CREDENTIAL],
    capabilities: { textToImage: true, imageToImage: false, imageCaptioning: false, imageTagging: false, inpainting: false },
  });
  catalog.register({
    id: 'volcengine', category: 'image', // 火山方舟 Seedream — epic P1
    urlPreset: 'https://ark.cn-beijing.volces.com',
    defaultPath: '/api/v3/images/generations', // providers/volcengine.ts
    credentialFields: [API_KEY_CREDENTIAL],
    capabilities: { textToImage: true, imageToImage: true, imageCaptioning: false, imageTagging: false, inpainting: false },
    defaultModel: 'doubao-seedream-4-0-250828',
  });

  // ── Voice backends (CosyVoice contract: tts/providers/cosyvoice.ts, stt/providers/cosyvoice.ts) ──
  catalog.register({
    id: 'cosyvoice', category: 'tts',
    urlPreset: 'http://localhost:9880',
    defaultPath: '/', // GET query synthesis; APIPanel tts preset :539-541
    credentialFields: [OPTIONAL_API_KEY_CREDENTIAL],
    capabilities: { speakerListing: true, streamUrl: true },
    defaultModel: 'cosyvoice', // cosmetic — CosyVoice ignores model; preserves the old form default
  });
  catalog.register({
    id: 'cosyvoice', category: 'stt',
    urlPreset: 'http://localhost:9880',
    defaultPath: '/v1/audio/transcriptions',
    credentialFields: [OPTIONAL_API_KEY_CREDENTIAL],
    capabilities: { sttStreaming: true },
    defaultModel: 'sensevoice', // cosmetic — see tts note
  });
  catalog.register({
    // 豆包语音 TTS — epic P2. Independent product line from Ark (own domain,
    // three-header auth); protocol details in tts/providers/doubao.ts.
    id: 'doubao', category: 'tts',
    urlPreset: 'https://openspeech.bytedance.com',
    defaultPath: '/api/v3/tts/unidirectional',
    credentialFields: DOUBAO_VOICE_CREDENTIALS,
    capabilities: { speakerListing: false, streamUrl: false },
  });
  catalog.register({
    // 豆包录音识别 flash — epic P3, non-streaming only (D6: wss binary
    // streaming stays on the backlog; sttStreaming:false hides the
    // live-dictation entry point for this backend).
    id: 'doubao', category: 'stt',
    urlPreset: 'https://openspeech.bytedance.com',
    defaultPath: '/api/v3/auc/bigmodel/recognize/flash',
    credentialFields: DOUBAO_VOICE_CREDENTIALS,
    capabilities: { sttStreaming: false },
  });
}
