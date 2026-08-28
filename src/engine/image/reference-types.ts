export type ImageReferenceRole =
  | 'source'
  | 'style'
  | 'composition'
  | 'mask'
  | 'control';

export type ImageReferenceSource =
  | 'upload'
  | 'asset'
  | 'url'
  | 'data_url';

export interface ImageReferenceInput {
  id: string;
  role: ImageReferenceRole;
  source: ImageReferenceSource;
  assetId?: string;
  url?: string;
  dataUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  denoiseStrength?: number;
  providerMeta?: Record<string, unknown>;
}

/**
 * Generation mode.
 * MVP uses 'text_to_image' and 'image_to_image' only.
 * @reserved 'inpaint' and 'reference' — not implemented in MVP
 */
export type ImageGenerationMode =
  | 'text_to_image'
  | 'image_to_image'
  | 'inpaint'
  | 'reference';

export interface ImageGenerationReferenceParams {
  mode: ImageGenerationMode;
  references?: ImageReferenceInput[];
}

/**
 * 提炼引擎（图片提炼重建 epic，2026-08-27）：
 * - 'civitai_vlm'  — Civitai chatCompletion 多供应商 VLM 网关（camelCase 图片块）
 * - 'general_llm'  — 复用主对话 LLM 配置（usageType 'main'，OpenAI 兼容多模态，D3B）
 * 旧 wdTagging/JoyCaption 链路已确认上游死亡并拆除（D5），证据见
 * docs/status/image-understanding-api-verification-2026-08-27.md
 */
export type ImageUnderstandingEngine = 'civitai_vlm' | 'general_llm';

export type ImageUnderstandingTask = 'caption' | 'tags' | 'both';

export interface ImageUnderstandingRequest {
  engine: ImageUnderstandingEngine;
  image: ImageReferenceInput;
  task: ImageUnderstandingTask;
  /** 用户附加要求，拼入任务提示词 */
  prompt?: string;
  /** civitai_vlm 路由模型覆盖（缺省用 understanding 设置的默认，硬默认 claude-sonnet-5，D2） */
  model?: string;
  temperature?: number;
  maxNewTokens?: number;
}

export interface ImageUnderstandingTag {
  text: string;
  confidence?: number;
  category?: string;
}

export interface ImageUnderstandingResult {
  provider: ImageUnderstandingEngine;
  task: ImageUnderstandingTask;
  caption?: string;
  tags?: ImageUnderstandingTag[];
  /** Always populated: tags joined for 'tags', caption text for 'caption', both merged for 'both'. Empty string if provider returned nothing. */
  positiveDraft: string;
  negativeDraft?: string;
  raw?: unknown;
  createdAt: number;
}

export interface ReferenceLibraryEntry {
  id: string;
  assetId: string;
  name: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  source: 'upload' | 'gallery' | 'scene' | 'player';
  createdAt: number;
  lastUsedAt?: number;
  tags?: string[];
  notes?: string;
}
