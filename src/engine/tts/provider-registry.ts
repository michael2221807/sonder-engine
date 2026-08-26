/**
 * TTS provider registry — thin subclass of the shared BackendRegistry
 * (epic P0 item 9 de-duplicated the three copy-pasted registry classes).
 */
import { BackendRegistry } from '../providers/backend-registry';
import type { TtsBackendType, TtsProvider } from './types';

interface TtsFactoryConfig {
  endpoint: string;
  apiKey: string;
  model?: string;
  routingPath?: string;
  /** 多凭证 backend 的附加凭证（豆包语音，epic P2） */
  credentials?: Record<string, string>;
}

export class TtsProviderRegistry extends BackendRegistry<TtsBackendType, TtsFactoryConfig, TtsProvider> {
  constructor() {
    super('TtsProviderRegistry');
  }

  resolve(config: TtsFactoryConfig & { backend: TtsBackendType }): TtsProvider {
    const { backend, ...factoryConfig } = config;
    return this.resolveBackend(backend, factoryConfig);
  }
}
