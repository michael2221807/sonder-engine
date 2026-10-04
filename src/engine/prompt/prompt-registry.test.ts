import { describe, it, expect, beforeEach } from 'vitest';
import { PromptRegistry } from '@/engine/prompt/prompt-registry';

describe('PromptRegistry', () => {
  let registry: PromptRegistry;

  beforeEach(() => {
    registry = new PromptRegistry();
  });

  it('registers and retrieves a module', () => {
    registry.register({ id: 'core', content: 'Core rules.', enabled: true });
    expect(registry.get('core')?.content).toBe('Core rules.');
  });

  it('returns undefined for unknown ID', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('getEffectiveContent returns default content', () => {
    registry.register({ id: 'a', content: 'default', enabled: true });
    expect(registry.getEffectiveContent('a')).toBe('default');
  });

  it('getEffectiveContent prefers userContent', () => {
    registry.register({ id: 'a', content: 'default', userContent: 'custom', enabled: true });
    expect(registry.getEffectiveContent('a')).toBe('custom');
  });

  it('getEffectiveContent returns empty for disabled module', () => {
    registry.register({ id: 'a', content: 'yes', enabled: false });
    expect(registry.getEffectiveContent('a')).toBe('');
  });

  it('getEffectiveContent returns empty for unknown module', () => {
    expect(registry.getEffectiveContent('missing')).toBe('');
  });

  it('getRequiredContent keeps the text of a module switched off: the edit, else the default', () => {
    registry.register({ id: 'format', content: 'default', enabled: false });
    expect(registry.getEffectiveContent('format')).toBe('');
    expect(registry.getRequiredContent('format')).toBe('default');
    registry.setUserContent('format', 'edited');
    expect(registry.getRequiredContent('format')).toBe('edited');
    expect(registry.getRequiredContent('missing')).toBe('');
  });

  it('lists all registered module IDs', () => {
    registry.register({ id: 'a', content: '', enabled: true });
    registry.register({ id: 'b', content: '', enabled: true });
    const all = registry.getAll();
    expect(all.map((m) => m.id).sort()).toEqual(['a', 'b']);
  });

  it('overwrites on re-register same ID', () => {
    registry.register({ id: 'a', content: 'v1', enabled: true });
    registry.register({ id: 'a', content: 'v2', enabled: true });
    expect(registry.getEffectiveContent('a')).toBe('v2');
  });

  it('setUserContent overrides default', () => {
    registry.register({ id: 'a', content: 'default', enabled: true });
    registry.setUserContent('a', 'user version');
    expect(registry.getEffectiveContent('a')).toBe('user version');
  });

  it('setEnabled toggles module', () => {
    registry.register({ id: 'a', content: 'yes', enabled: true });
    registry.setEnabled('a', false);
    expect(registry.getEffectiveContent('a')).toBe('');
    registry.setEnabled('a', true);
    expect(registry.getEffectiveContent('a')).toBe('yes');
  });

  it('setUserContent on non-existent ID is silent no-op', () => {
    expect(() => registry.setUserContent('nonexistent', 'x')).not.toThrow();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('getAll count unchanged after re-register same ID', () => {
    registry.register({ id: 'a', content: 'v1', enabled: true });
    registry.register({ id: 'a', content: 'v2', enabled: true });
    expect(registry.getAll()).toHaveLength(1);
  });
});
