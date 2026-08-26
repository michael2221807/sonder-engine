/**
 * STT provider registry — thin subclass of the shared BackendRegistry
 * (epic P0 item 9 de-duplicated the three copy-pasted registry classes).
 */
import { BackendRegistry } from '../providers/backend-registry';
import type { SttBackendType, SttProvider } from './types';

interface SttFactoryConfig {
  endpoint: string;
  apiKey: string;
  model?: string;
  routingPath?: string;
  /** 多凭证 backend 的附加凭证（豆包语音，epic P3） */
  credentials?: Record<string, string>;
}

export class SttProviderRegistry extends BackendRegistry<SttBackendType, SttFactoryConfig, SttProvider> {
  constructor() {
    super('SttProviderRegistry');
  }

  resolve(config: SttFactoryConfig & { backend: SttBackendType }): SttProvider {
    const { backend, ...factoryConfig } = config;
    return this.resolveBackend(backend, factoryConfig);
  }
}
