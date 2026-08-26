/**
 * Shared ProviderCatalog singleton, pre-loaded with the built-in providers.
 * Lives in its own module so intra-package helpers (llm-paths.ts) can import
 * it without a circular re-export through index.ts.
 */
import { ProviderCatalog } from './descriptor';
import { registerBuiltinProviders } from './catalog-entries';

export const providerCatalog = new ProviderCatalog();
registerBuiltinProviders(providerCatalog);
