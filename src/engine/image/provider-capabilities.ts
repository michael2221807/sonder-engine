import type { ImageProvider, ImageBackendType } from './types';
import type { ImageReferenceInput, ImageUnderstandingRequest, ImageUnderstandingResult } from './reference-types';
import { providerCatalog } from '../providers';

export interface ImageToImageProvider {
  imageToImage(
    prompt: string,
    negative: string,
    width: number,
    height: number,
    reference: ImageReferenceInput,
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
    }]),
    // Object.fromEntries widens keys to string; the catalog's image ids are
    // pinned 1:1 against ImageBackendType by descriptor.test.ts.
  ) as Record<ImageBackendType, ImageProviderCapabilities>;
