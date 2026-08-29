// App doc: docs/user-guide/pages/game-image.md §参考重绘（多图 / 重绘幅度能力门）
import type { ImageProvider, ImageBackendType } from './types';
import type { ImageReferenceInput, ImageUnderstandingRequest, ImageUnderstandingResult } from './reference-types';
import { providerCatalog } from '../providers';

export interface ImageToImageProvider {
  /**
   * @param references 参考图**有序**列表，至少一张。顺序有语义：Seedream 的
   *   官方多图用法要求提示词里用「图1/图2」按下标指代（UI 的拖拽排序即此序）。
   *   只支持单图的后端（NovelAI / Civitai，见
   *   docs/design/seedream-multi-reference-implementation.md §1）必须显式取
   *   `references[0]` 并对多余项告警——契约层面用数组，就是为了逼每个 provider
   *   对「多给了怎么办」做出明示决定，而不是让调用方以为都送到了。
   */
  imageToImage(
    prompt: string,
    negative: string,
    width: number,
    height: number,
    references: ImageReferenceInput[],
    options?: Record<string, unknown>,
  ): Promise<Blob>;
}

export interface ImageUnderstandingProvider {
  describeImage(
    request: ImageUnderstandingRequest,
    options?: Record<string, unknown>,
  ): Promise<ImageUnderstandingResult>;
}

export interface ImageProviderCapabilities {
  textToImage: boolean;
  imageToImage: boolean;
  imageCaptioning: boolean;
  imageTagging: boolean;
  inpainting: boolean;
  /**
   * Backend accepts a numeric reference-strength ("重绘幅度") alongside the
   * reference image. NovelAI maps it to `strength`, Civitai to
   * `sourceImageDenoiseStrenght`. Seedream/Doubao has NO such parameter in its
   * official API (verified 2026-08-27 against the vendor parameter table), so
   * it declares false and the UI hides the slider instead of shipping a dead
   * control — the redraw magnitude goes into the prompt text there.
   */
  referenceStrength: boolean;
  /**
   * Backend accepts MORE THAN ONE reference image in a single image-to-image
   * call. Only Seedream/Doubao does (official `image` field is
   * `anyOf: string | array`, ≤14 for 5.0-lite/4.5/4.0). NovelAI img2img takes a
   * single base64 string, and Civitai's SD recipe documents `image` as "a plain
   * string URL (not a { url: ... } wrapper)" with no array-valued image field —
   * their multi-image features (NAI Vibe Transfer / Civitai
   * imageStyleReferences) are DIFFERENT features on different routes, not this
   * one. The UI renders the multi-picker only where this is true, so no backend
   * ever shows a control whose extra images would be dropped.
   * 查证记录：docs/design/seedream-multi-reference-implementation.md §1
   */
  multiReference: boolean;
}

/**
 * 按后端能力把参考图列表收敛到它真正能消费的张数（多图参考重绘 epic S2）。
 *
 * 抽成纯函数是刻意的：`ImageService` 编排层历史上没有单测，把这条判断埋在
 * 里面等于不可测；这里可以被直接打点，编排层只负责调用与告警。
 * 只处理「多图 vs 单图」这一层，Seedream 自己的 14 张上限属机型细节，留在
 * `volcengine.ts` 的 `SEEDREAM_MAX_REFERENCE_IMAGES`。
 *
 * @returns `effective` 实际下发的有序列表；`dropped` 被丢弃的张数（>0 时调用方
 *   必须给出可观测告警，不许静默）。
 */
export function clampReferencesForBackend<T>(
  backend: ImageBackendType,
  references: readonly T[],
): { effective: T[]; dropped: number } {
  if (references.length <= 1 || PROVIDER_CAPABILITIES[backend]?.multiReference) {
    return { effective: [...references], dropped: 0 };
  }
  return { effective: [references[0]], dropped: references.length - 1 };
}

export function supportsImageToImage(
  provider: ImageProvider,
): provider is ImageProvider & ImageToImageProvider {
  return 'imageToImage' in provider
    && typeof (provider as Record<string, unknown>)['imageToImage'] === 'function';
}

export function supportsImageUnderstanding(
  provider: ImageProvider,
): provider is ImageProvider & ImageUnderstandingProvider {
  return 'describeImage' in provider
    && typeof (provider as Record<string, unknown>)['describeImage'] === 'function';
}

/**
 * Derived from the provider catalog (single source of truth — epic P0).
 * The export keeps its historical name/shape so existing consumers are
 * untouched; descriptor.test.ts pins the derived values.
 */
export const PROVIDER_CAPABILITIES: Record<ImageBackendType, ImageProviderCapabilities> =
  Object.fromEntries(
    providerCatalog.byCategory('image').map((d) => [d.id, {
      textToImage: d.capabilities.textToImage === true,
      imageToImage: d.capabilities.imageToImage === true,
      imageCaptioning: d.capabilities.imageCaptioning === true,
      imageTagging: d.capabilities.imageTagging === true,
      inpainting: d.capabilities.inpainting === true,
      referenceStrength: d.capabilities.referenceStrength === true,
      multiReference: d.capabilities.multiReference === true,
    }]),
    // Object.fromEntries widens keys to string; the catalog's image ids are
    // pinned 1:1 against ImageBackendType by descriptor.test.ts.
  ) as Record<ImageBackendType, ImageProviderCapabilities>;
