/**
 * PromptRegistry mock — pre-loaded with test prompt modules.
 */
export function createMockPromptRegistry(
  modules: Array<{ id: string; content: string; enabled?: boolean; alwaysOn?: boolean }> = [],
) {
  const store = new Map<string, { content: string; enabled: boolean; alwaysOn: boolean }>();
  for (const m of modules) {
    store.set(m.id, { content: m.content, enabled: m.enabled ?? true, alwaysOn: m.alwaysOn ?? false });
  }

  return {
    /** As the real registry: '' when switched off, unless the module is always on. */
    getEffectiveContent(id: string): string {
      const entry = store.get(id);
      if (!entry || (!entry.enabled && !entry.alwaysOn)) return '';
      return entry.content;
    },
    has(id: string): boolean {
      return store.has(id);
    },
    register(id: string, content: string, enabled = true): void {
      store.set(id, { content, enabled, alwaysOn: false });
    },
  };
}
