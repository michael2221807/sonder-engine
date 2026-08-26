/**
 * Provider catalog — public entry point.
 * See descriptor.ts for the design contract.
 */
export * from './descriptor';
export * from './backend-registry';
export * from './connection-test';
export * from './usage-keys';
export * from './llm-paths';
export { registerBuiltinProviders } from './catalog-entries';
export { providerCatalog } from './catalog-instance';
