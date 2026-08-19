import { describe, it, expect, beforeEach, vi } from 'vitest';

const memStore = new Map<string, unknown>();
vi.mock('./idb-adapter', () => ({
  idbAdapter: {
    async get<T>(key: string): Promise<T | undefined> {
      return memStore.get(key) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      memStore.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key: string): Promise<void> {
      memStore.delete(key);
    },
  },
}));

const emitted: Array<{ event: string; payload: unknown }> = [];
vi.mock('../core/event-bus', () => ({
  eventBus: {
    emit: (event: string, payload?: unknown) => {
      emitted.push({ event, payload });
    },
  },
}));

vi.mock('./migration-registry', async (importOriginal) => {
  const original = await importOriginal<typeof import('./migration-registry')>();
  return {
    ...original,
    migrationRegistry: new original.MigrationRegistry(),
  };
});

import { SaveManager } from './save-manager';
import { migrationRegistry } from './migration-registry';
import type { ProfileManager } from './profile-manager';
import type { SaveSlotMeta } from '../types';

describe('SaveManager', () => {
  let pm: ProfileManager;
  let slotMeta: Record<string, SaveSlotMeta>;
  let sm: SaveManager;

  beforeEach(() => {
    memStore.clear();
    emitted.length = 0;
    migrationRegistry.clear();

    slotMeta = {};
    pm = {
      updateSlotMeta: vi.fn(async (_pId: string, sId: string, update: Partial<SaveSlotMeta>) => {
        slotMeta[sId] = { ...slotMeta[sId], ...update } as SaveSlotMeta;
      }),
      getSlotMeta: vi.fn((_pId: string, sId: string) => slotMeta[sId]),
    } as unknown as ProfileManager;

    sm = new SaveManager(pm);
  });

  describe('saveGame', () => {
    it('persists state tree to IDB', async () => {
      await sm.saveGame('p1', 's1', { 角色: { 名称: '测试' } });
      const stored = memStore.get('save_p1_s1');
      expect(stored).toBeDefined();
      expect((stored as Record<string, unknown>)['角色']).toBeDefined();
    });

    it('deep clones state tree (no mutation leaking)', async () => {
      const state = { x: { y: 1 } };
      await sm.saveGame('p1', 's1', state);
      state.x.y = 999;
      const stored = memStore.get('save_p1_s1') as Record<string, unknown>;
      expect((stored['x'] as Record<string, unknown>)['y']).toBe(1);
    });

    it('updates profile manager slot meta', async () => {
      await sm.saveGame('p1', 's1', { 角色: {} });
      expect(pm.updateSlotMeta).toHaveBeenCalledWith('p1', 's1', expect.objectContaining({
        lastSavedAt: expect.any(String),
        saveSize: expect.any(Number),
      }));
    });

    it('includes packVersion in meta when set', async () => {
      sm.setCurrentPackVersion('1.2.0');
      await sm.saveGame('p1', 's1', {});
      expect(pm.updateSlotMeta).toHaveBeenCalledWith('p1', 's1', expect.objectContaining({
        packVersion: '1.2.0',
      }));
    });

    it('emits save-complete event', async () => {
      await sm.saveGame('p1', 's1', {});
      expect(emitted.some((e) => e.event === 'engine:save-complete')).toBe(true);
    });

    it('extracts characterStatus from state tree', async () => {
      await sm.saveGame('p1', 's1', {
        角色: { 可变属性: { 地位: { 名称: '侠客' } } },
      });
      expect(pm.updateSlotMeta).toHaveBeenCalledWith('p1', 's1', expect.objectContaining({
        characterStatus: '侠客',
      }));
    });

    it('merges user-provided meta', async () => {
      await sm.saveGame('p1', 's1', {}, { characterStatus: '自定义' });
      expect(pm.updateSlotMeta).toHaveBeenCalledWith('p1', 's1', expect.objectContaining({
        characterStatus: '自定义',
      }));
    });
  });

  describe('loadGame', () => {
    it('returns undefined for missing save', async () => {
      const result = await sm.loadGame('p1', 's1');
      expect(result).toBeUndefined();
    });

    it('returns saved data', async () => {
      memStore.set('save_p1_s1', { 角色: { 名称: '测试' } });
      const result = await sm.loadGame('p1', 's1');
      expect(result).toEqual({ 角色: { 名称: '测试' } });
    });

    it('skips migration when packVersion not set', async () => {
      memStore.set('save_p1_s1', { v: '0.1' });
      const result = await sm.loadGame('p1', 's1');
      expect(result).toEqual({ v: '0.1' });
    });

    it('returns a production-version save by reference without rewriting data or metadata', async () => {
      const original = { data: true, nested: { legacy: 'kept' } };
      sm.setCurrentPackVersion('0.5.0');
      slotMeta['s1'] = { packVersion: '0.5.0' } as SaveSlotMeta;
      memStore.set('save_p1_s1', original);
      const result = await sm.loadGame('p1', 's1');

      expect(result).toBe(original);
      expect(memStore.get('save_p1_s1')).toBe(original);
      expect(memStore.has('save_p1_s1:pre-migration')).toBe(false);
      expect(pm.updateSlotMeta).not.toHaveBeenCalled();
    });

    it('does not rewrite an older save when no complete migration path exists', async () => {
      const original = { character: { name: 'legacy' } };
      sm.setCurrentPackVersion('0.6.0');
      slotMeta['s1'] = { packVersion: '0.5.0' } as SaveSlotMeta;
      memStore.set('save_p1_s1', original);

      const result = await sm.loadGame('p1', 's1');

      expect(result).toBe(original);
      expect(memStore.get('save_p1_s1')).toBe(original);
      expect(memStore.has('save_p1_s1:pre-migration')).toBe(false);
      expect(pm.updateSlotMeta).not.toHaveBeenCalled();
      expect(slotMeta['s1']?.packVersion).toBe('0.5.0');
    });

    it('discards a partial migration chain and leaves the existing save byte-shape intact', async () => {
      migrationRegistry.register({
        fromVersion: '0',
        toVersion: '0.5.0',
        description: 'partial only',
        migrate: (data) => ({ ...data, shouldNotLeak: true }),
      });
      const original = { legacy: { value: 1 } };
      sm.setCurrentPackVersion('0.6.0');
      slotMeta['s1'] = { packVersion: '0' } as SaveSlotMeta;
      memStore.set('save_p1_s1', original);

      const result = await sm.loadGame('p1', 's1');

      expect(result).toBe(original);
      expect(result).not.toHaveProperty('shouldNotLeak');
      expect(memStore.get('save_p1_s1')).toBe(original);
      expect(memStore.has('save_p1_s1:pre-migration')).toBe(false);
      expect(pm.updateSlotMeta).not.toHaveBeenCalled();
    });

    it('applies migration when save version is older', async () => {
      migrationRegistry.register({
        fromVersion: '0.1.0',
        toVersion: '0.2.0',
        description: 'add newField',
        migrate: (data) => ({ ...data, newField: true }),
      });
      sm.setCurrentPackVersion('0.2.0');
      slotMeta['s1'] = { packVersion: '0.1.0' } as SaveSlotMeta;
      memStore.set('save_p1_s1', { oldData: 1 });

      const result = await sm.loadGame('p1', 's1');
      expect(result).toHaveProperty('newField', true);
      expect(result).toHaveProperty('oldData', 1);
    });

    it('updates slotMeta packVersion after successful migration', async () => {
      migrationRegistry.register({
        fromVersion: '0.1.0',
        toVersion: '0.2.0',
        description: 'test',
        migrate: (d) => d,
      });
      sm.setCurrentPackVersion('0.2.0');
      slotMeta['s1'] = { packVersion: '0.1.0' } as SaveSlotMeta;
      memStore.set('save_p1_s1', {});

      await sm.loadGame('p1', 's1');
      expect(pm.updateSlotMeta).toHaveBeenCalledWith('p1', 's1', { packVersion: '0.2.0' });
    });

    it('handles migration error gracefully', async () => {
      migrationRegistry.register({
        fromVersion: '0.1.0',
        toVersion: '0.2.0',
        description: 'first',
        migrate: (d) => ({ ...d, step1: true }),
      });
      migrationRegistry.register({
        fromVersion: '0.2.0',
        toVersion: '0.3.0',
        description: 'fails',
        migrate: () => { throw new Error('broken migration'); },
      });
      sm.setCurrentPackVersion('0.3.0');
      slotMeta['s1'] = { packVersion: '0.1.0' } as SaveSlotMeta;
      memStore.set('save_p1_s1', {});

      const result = await sm.loadGame('p1', 's1');
      expect(result).toHaveProperty('step1', true);
    });
  });

  describe('deleteGame', () => {
    it('removes save from IDB', async () => {
      memStore.set('save_p1_s1', { data: true });
      await sm.deleteGame('p1', 's1');
      expect(memStore.has('save_p1_s1')).toBe(false);
    });
  });

  describe('hasSave', () => {
    it('returns true when save exists', async () => {
      memStore.set('save_p1_s1', {});
      expect(await sm.hasSave('p1', 's1')).toBe(true);
    });

    it('returns false when save does not exist', async () => {
      expect(await sm.hasSave('p1', 'missing')).toBe(false);
    });
  });
});
