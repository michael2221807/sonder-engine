// App doc: docs/user-guide/pages/home.md §1.3.1（服务商下拉 / 凭证字段 / 火山方舟接入速查）
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

/**
 * 豆包语音凭证（epic P2/P3）— 单 API Key + Resource ID（PO 指定，2026-08-27）。
 * key 与 resource id 均走 WebSocket URL 的 query（`?api_key=&api_resource_id=`，
 * 浏览器 WS 不能带自定义头；实测 2026-08-27 全链路可用）。Agent Plan 套餐资源：
 * 配音 `seed-tts-2.0`，听写 `volc.seedasr.sauc.duration`。
 * 旧版 appid/access-token 三凭证制不再支持（新版控制台为官方推荐路径）。
 */
const DOUBAO_VOICE_CREDENTIALS: CredentialFieldSpec[] = [
  API_KEY_CREDENTIAL,
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
    // modelsPath deliberately ABSENT (UI hides the fetch-models button):
    // live-tested 2026-08-27 — GET /api/v3/models works via curl, but its
    // OPTIONS preflight 404s without ACAO, so a browser (this app) cannot
    // call it. chat/images preflights ARE allowed; only /models lacks CORS.
    id: 'volcano_ark', category: 'llm',
    urlPreset: 'https://ark.cn-beijing.volces.com',
    defaultPath: '/api/v3/chat/completions',
    credentialFields: [API_KEY_CREDENTIAL],
    capabilities: {},
    // Calibrated 2026-08-27: seed-1.6 was retired from the shelf; 2-1-pro is
    // the current mainline (models move fast — the prefill is just a hint).
    defaultModel: 'doubao-seed-2-1-pro-260628',
  });

  // ── Image backends (URLs from APIPanel IMAGE_BACKEND_STATIC; paths from provider classes) ──
  catalog.register({
    id: 'civitai', category: 'image',
    urlPreset: 'https://orchestration.civitai.com',
    defaultPath: '/v2/consumer/workflows', // civitai.ts:436
    credentialFields: [API_KEY_CREDENTIAL],
    // referenceStrength: Civitai maps 重绘幅度 → sourceImageDenoiseStrenght.
    capabilities: { textToImage: true, imageToImage: true, imageCaptioning: true, imageTagging: true, inpainting: false, referenceStrength: true },
    defaultModel: 'urn:air:sdxl:checkpoint:civitai:101055@128078',
  });
  catalog.register({
    id: 'novelai', category: 'image',
    urlPreset: 'https://image.novelai.net',
    defaultPath: '/ai/generate-image', // novelai.ts:124
    credentialFields: [API_KEY_CREDENTIAL],
    // referenceStrength: NovelAI maps 重绘幅度 → parameters.strength.
    capabilities: { textToImage: true, imageToImage: true, imageCaptioning: false, imageTagging: false, inpainting: false, referenceStrength: true },
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
    // 火山方舟 Seedream — epic P1. Agent Plan 用户注意（实测 2026-08-27）：
    // 套餐路径 /api/plan/v3/images/generations 的 CORS 预检不放行 authorization
    // 头 → 浏览器无法直连套餐端点，需本地代理（把带路径的完整 URL 填进配置，
    // provider 会原样使用）；默认路径为按量端点（浏览器可直连）。
    id: 'volcengine', category: 'image',
    urlPreset: 'https://ark.cn-beijing.volces.com',
    defaultPath: '/api/v3/images/generations', // providers/volcengine.ts
    credentialFields: [API_KEY_CREDENTIAL],
    // referenceStrength 刻意不声明：Seedream 官方参数表（2026-08-27 核对）只有
    // model/prompt/image/size/sequential_image_generation/stream/response_format/
    // watermark 等，**没有任何重绘强度参数** → UI 隐藏「重绘幅度」滑块，改由提示词
    // 表达改动幅度（避免死控件）。
    capabilities: { textToImage: true, imageToImage: true, imageCaptioning: false, imageTagging: false, inpainting: false },
    // Medium 套餐唯一图片模型（PO 指定 2026-08-27，真实出图验证）。
    defaultModel: 'doubao-seedream-5.0-lite',
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
    // 豆包语音 TTS — epic P2, WebSocket 单向流（协议在 tts/providers/doubao.ts）。
    // 默认路径 = Agent Plan 套餐端点（实测 2026-08-27 真实出声）；独立控制台
    // 账号把路径改为 /api/v3/tts/unidirectional/stream 即可（同协议）。
    // ⚠ 套餐的 HTTP chunked 端点会静默返回 0 音频帧 — 勿回退到 HTTP。
    id: 'doubao', category: 'tts',
    urlPreset: 'https://openspeech.bytedance.com',
    defaultPath: '/api/v3/plan/tts/unidirectional/stream',
    credentialFields: DOUBAO_VOICE_CREDENTIALS,
    capabilities: { speakerListing: false, streamUrl: false },
  });
  catalog.register({
    // 豆包流式识别 sauc — epic P3, WebSocket（Agent Plan 网关没有 flash HTTP
    // 端点，实测 2026-08-27 404）。传输是流式的，但产品交互仍是"录完再转"
    // （D6：实时听写 UX 仍在 backlog → sttStreaming:false 继续隐藏实时入口）。
    // 独立控制台账号把路径改为 /api/v3/sauc/bigmodel_nostream。
    id: 'doubao', category: 'stt',
    urlPreset: 'https://openspeech.bytedance.com',
    defaultPath: '/api/v3/plan/sauc/bigmodel_nostream',
    credentialFields: DOUBAO_VOICE_CREDENTIALS,
    capabilities: { sttStreaming: false },
  });
}
