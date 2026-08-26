/**
 * Generic backend→factory registry — epic P0 item 9.
 *
 * The image/tts/stt registries were three copy-pasted classes ("Mirrors
 * ImageProviderRegistry"). Each domain now subclasses this base, keeping its
 * existing `resolve(config)` signature so call sites don't churn.
 */
export class BackendRegistry<TB extends string, TConfig, TProvider> {
  private factories = new Map<TB, (config: TConfig) => TProvider>();

  constructor(private readonly domain: string) {}

  register(backend: TB, factory: (config: TConfig) => TProvider): void {
    this.factories.set(backend, factory);
  }

  protected resolveBackend(backend: TB, config: TConfig): TProvider {
    const factory = this.factories.get(backend);
    if (!factory) {
      throw new Error(
        `[${this.domain}] No provider registered for backend "${backend}". ` +
        `Registered: [${[...this.factories.keys()].join(', ')}]`,
      );
    }
    return factory(config);
  }

  has(backend: TB): boolean {
    return this.factories.has(backend);
  }

  get registeredBackends(): TB[] {
    return [...this.factories.keys()];
  }
}
