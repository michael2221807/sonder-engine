/**
 * Image provider registry — Sprint Image-1, generalized in epic P0 (item 9):
 * now a thin subclass of the shared BackendRegistry; the historical
 * `resolve(config)` signature is preserved so call sites don't churn.
 */
import { BackendRegistry } from '../providers/backend-registry';
import type { ImageBackendType, ImageProvider } from './types';

interface ImageFactoryConfig {
  endpoint: string;
  apiKey: string;
  model?: string;
}

export class ImageProviderRegistry extends BackendRegistry<ImageBackendType, ImageFactoryConfig, ImageProvider> {
  constructor() {
    super('ImageProviderRegistry');
  }

  resolve(config: ImageFactoryConfig & { backend: ImageBackendType }): ImageProvider {
    const { backend, ...factoryConfig } = config;
    return this.resolveBackend(backend, factoryConfig);
  }
}
