/**
 * Image subsystem type definitions — Sprint Image-1
 *
 * Defines the core interfaces for the pluggable image generation system.
 * All types are engine-generic (no game-specific content — PRINCIPLES §3.3).
 * Provider-specific request/response shapes are encapsulated inside each
 * provider implementation.
 */

/**
 * Supported image backend types. Each member pairs a provider-catalog
 * descriptor (engine/providers/catalog-entries.ts) with a factory registration
 * in main.ts; `APIConfig.backend` persists the user's choice (epic P0).
 */
export type ImageBackendType = 'openai' | 'novelai' | 'sd_webui' | 'comfyui' | 'civitai' | 'volcengine';

/** Image task status lifecycle */
export type ImageTaskStatus = 'pending' | 'tokenizing' | 'generating' | 'complete' | 'failed';

/** What kind of subject is being generated */
export type ImageSubjectType = 'scene' | 'character' | 'secret_part';

/** Secret part sub-type — secret-part body-part types */
export type SecretPartType = 'breast' | 'vagina' | 'anus';

/**
 * Structured feature tags extracted from an anchor by the AI.
 * Each field is an optional array of English image-gen tags.
 * Structured feature tags for character anchor — ported.
 */
export interface AnchorStructuredFeatures {
  appearance?: string[];
  figure?: string[];
  bust?: string[];
  hairstyle?: string[];
  hairColor?: string[];
  eyes?: string[];
  skinTone?: string[];
  ageAppearance?: string[];
  baseOutfit?: string[];
  specialTraits?: string[];
}

/**
 * Character anchor — reusable visual DNA for a character.
 *
 * Per PRINCIPLES §3.16: anchor references an Engram entity (unidirectional);
 * visual DNA lives only in the anchor record; Engram entity schema stays pure.
 */
export interface CharacterAnchor {
  /** Unique anchor ID */
  id: string;
  /** Optional reference to an Engram entity ID (unidirectional per §3.16) */
  entityRef: string | null;
  /** Character name this anchor describes */
  characterName: string;
  /** Tokenized visual description tags (populated by tokenizer CoT in Image-2) */
  tokens: string[];
  /** Artist/style tags to include when generating this character */
  styleTags: string[];
  /** Structured feature tags for composition-aware anchor injection */
  structuredFeatures?: AnchorStructuredFeatures;
  /** Optional seed for reproducibility */
  seed?: number;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
}

/**
 * Style preset — extracted from PNG metadata or user-defined.
 *
 * Contains the "how to render" parameters without the "what to render" content.
 */
export interface StylePreset {
  id: string;
  name: string;
  /** Positive prompt prefix (style, quality, artist) */
  positivePrefix: string;
  /** Positive prompt suffix */
  positiveSuffix: string;
  /** Negative prompt */
  negative: string;
  /** Preferred image dimensions */
  width: number;
  height: number;
  /** Sampler name (provider-specific string) */
  sampler?: string;
  /** Noise schedule (provider-specific) */
  noiseSchedule?: string;
  /** Steps */
  steps?: number;
  /** CFG scale */
  cfgScale?: number;
  /** Source: 'png_import' | 'user_defined' | 'pack_default' */
  source: string;
}

/**
 * Image generation task — represents a single generation request.
 *
 * Lifecycle: pending → tokenizing → generating → complete/failed
 */
export interface ImageTask {
  id: string;
  status: ImageTaskStatus;
  subjectType: ImageSubjectType;
  /** Target character name (for character/secret_part types) */
  targetCharacter?: string;
  /** Anchor ID used for character consistency */
  anchorId?: string;
  /** Style preset ID */
  presetId?: string;
  /** Final composed positive prompt (populated after tokenization) */
  positivePrompt?: string;
  /** Final composed negative prompt */
  negativePrompt?: string;
  /** Image dimensions */
  width: number;
  height: number;
  /** Secret-part sub-type (only for subjectType === 'secret_part') */
  part?: SecretPartType;
  /** Result asset ID (populated on completion) */
  resultAssetId?: string;
  /** Error message (populated on failure) */
  error?: string;
  /** Backend type used */
  backend: ImageBackendType;
  /** Provider-specific metadata snapshot (e.g. Civitai LoRA config used) */
  providerMeta?: {
    civitai?: CivitaiLoraSnapshot;
    reference?: {
      mode: 'image_to_image';
      sourceAssetId?: string;
      denoiseStrength?: number;
      provider: ImageBackendType;
    };
  };
  /** Timestamps */
  createdAt: number;
  updatedAt: number;
}

/**
 * Stored image asset — the actual generated image reference.
 */
export interface ImageAsset {
  id: string;
  /** The task that produced this asset */
  taskId: string;
  /** Storage key (IndexedDB key or URL) */
  storageKey: string;
  /** MIME type (image/png, image/webp, etc.) */
  mimeType: string;
  /** Image dimensions */
  width: number;
  height: number;
  /** File size in bytes */
  sizeBytes: number;
  /** Backend that generated it */
  backend: ImageBackendType;
  /** Generation timestamp */
  createdAt: number;
  /** Asset origin — distinguishes generated images from uploaded references */
  origin?: 'generated' | 'reference' | 'upload';
}

/**
 * Image provider interface — each backend implements this.
 *
 * Implementations live in `providers/{backend}.ts`. Sprint Image-1 provides
 * stubs that throw; real implementations land in Sprint Image-5.
 */
export interface ImageProvider {
  /** Backend identifier */
  readonly backend: ImageBackendType;

  /**
   * Generate an image from a composed prompt.
   *
   * @param prompt Positive prompt (fully composed — tokens + style + artist tags)
   * @param negative Negative prompt
   * @param width Image width in pixels
   * @param height Image height in pixels
   * @param options Provider-specific options (model, sampler, steps, seed, etc.)
   * @returns Raw image data as a Blob
   */
  generate(
    prompt: string,
    negative: string,
    width: number,
    height: number,
    options?: Record<string, unknown>,
  ): Promise<Blob>;

  /**
   * Test connectivity to this provider's endpoint.
   * @returns true if reachable and authenticated
   */
  testConnection(): Promise<boolean>;
}

/**
 * Provider constructor signature — used by the provider registry.
 */
export type ImageProviderFactory = (config: {
  endpoint: string;
  apiKey: string;
  model?: string;
}) => ImageProvider;

// ── Civitai LoRA Shelf types ──

/** Intentionally distinct from ImageSubjectType — 'player' is a LoRA scope concept that maps from subjectType='character' + characterName='__player__' */
export type CivitaiLoraScope = 'player' | 'character' | 'scene' | 'secret_part';

export interface CivitaiLoraTrigger {
  id: string;
  text: string;
  enabled: boolean;
  source: 'manual' | 'metadata';
  createdAt: number;
  updatedAt: number;
}

export interface CivitaiLoraShelfItem {
  id: string;
  name: string;
  air: string;
  enabled: boolean;
  strength: number;
  scopes: CivitaiLoraScope[];
  triggers: CivitaiLoraTrigger[];
  autoInjectTriggers: boolean;
  notes?: string;
  modelName?: string;
  versionName?: string;
  baseModel?: string;
  modelVersionId?: number;
  sourceUrl?: string;
  mature?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CivitaiLoraSnapshot {
  loras: Array<{
    id: string;
    name: string;
    air: string;
    strength: number;
    scopes: CivitaiLoraScope[];
    injectedTriggers: string[];
  }>;
  /** Post-parse merged networks object (NOT the raw JSON string from config) */
  additionalNetworks: Record<string, unknown>;
}

// ── Artist Preset types (promoted from ImagePanel.vue) ──

export interface PngMeta {
  source?: string;
  originalPrompt?: string;
  rawText?: string;
  parsedParams?: Record<string, unknown>;
  replicateParams?: boolean;
  coverDataUrl?: string;
}

export interface ArtistPreset {
  id: string;
  name: string;
  scope: 'npc' | 'scene';
  artistString: string;
  positive: string;
  negative: string;
  pngMeta?: PngMeta;
}

// ── Re-exports from reference-types and provider-capabilities ──

export type {
  ImageReferenceRole,
  ImageReferenceSource,
  ImageReferenceInput,
  ImageGenerationMode,
  ImageGenerationReferenceParams,
  ImageUnderstandingEngine,
  ImageUnderstandingTask,
  ImageUnderstandingRequest,
  ImageUnderstandingTag,
  ImageUnderstandingResult,
  ReferenceLibraryEntry,
} from './reference-types';

export type {
  ImageToImageProvider,
  ImageUnderstandingProvider,
  ImageProviderCapabilities,
} from './provider-capabilities';

export {
  supportsImageToImage,
  supportsImageUnderstanding,
  PROVIDER_CAPABILITIES,
} from './provider-capabilities';
