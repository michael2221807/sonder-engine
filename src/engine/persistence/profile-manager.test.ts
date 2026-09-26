/**
 * ProfileManager — sessionType persistence (Story 9 / D17)
 *
 * Proves the DURABLE contract that the UI's useSessionMode relies on:
 * - sessionType is written via updateSlotMeta and read via getSlotMeta (SC-7)
 * - a slot without sessionType reads as undefined → UI treats as 'play' (SC-8)
 * - sessionType survives serialization to the storage_root (the exact bytes
 *   BackupService.exportAll structuredClones into bundle.profiles) — SC-10.
 *
 * Uses the in-memory idb mock (same pattern as save-manager.test.ts). The
 * ProfileManager itself runs for real — the path under test is NOT mocked.
 */
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
    async clear(): Promise<void> {
      memStore.clear();
    },
  },
}));

import { ProfileManager } from './profile-manager';
import type { ProfileMeta } from '../types';

function makeProfile(): ProfileMeta {
  return {
    profileId: 'p1',
    createdAt: '2026-01-01T00:00:00.000Z',
    packId: 'pack1',
    characterName: 'Hero',
    slots: {
      s1: { slotId: 's1', slotName: 'Slot 1', lastSavedAt: null, packId: 'pack1', packVersion: '1.0' },
    },
    activeSlotId: 's1',
  };
}

describe('ProfileManager — sessionType (Story 9)', () => {
  let pm: ProfileManager;

  beforeEach(async () => {
    memStore.clear();
    pm = new ProfileManager();
    await pm.initialize();
    await pm.createProfile(makeProfile());
  });

  it('SC-8: a slot without sessionType reads as undefined (UI treats as play)', () => {
    expect(pm.getSlotMeta('p1', 's1')?.sessionType).toBeUndefined();
  });

  it('SC-7: persists sessionType via updateSlotMeta', async () => {
    await pm.updateSlotMeta('p1', 's1', { sessionType: 'worldBuilding' });
    expect(pm.getSlotMeta('p1', 's1')?.sessionType).toBe('worldBuilding');
  });

  it('SC-10: sessionType survives a fresh manager reading from storage (= backup structuredClone source)', async () => {
    await pm.updateSlotMeta('p1', 's1', { sessionType: 'worldBuilding' });
    // A new instance reads the persisted storage_root — the same object
    // BackupService.exportAll deep-clones into bundle.profiles and restoreProfiles
    // writes back wholesale, so this proves sessionType rides the backup roundtrip.
    const pm2 = new ProfileManager();
    await pm2.initialize();
    expect(pm2.getSlotMeta('p1', 's1')?.sessionType).toBe('worldBuilding');
  });

  it('updateSlotMeta merges sessionType without clobbering other fields (and vice versa)', async () => {
    await pm.updateSlotMeta('p1', 's1', { sessionType: 'worldBuilding' });
    await pm.updateSlotMeta('p1', 's1', { slotName: 'Renamed', lastSavedAt: '2026-06-12T00:00:00.000Z' });
    const meta = pm.getSlotMeta('p1', 's1');
    expect(meta?.sessionType).toBe('worldBuilding'); // preserved across an unrelated update
    expect(meta?.slotName).toBe('Renamed');
  });

  it('can switch sessionType back to play', async () => {
    await pm.updateSlotMeta('p1', 's1', { sessionType: 'worldBuilding' });
    await pm.updateSlotMeta('p1', 's1', { sessionType: 'play' });
    expect(pm.getSlotMeta('p1', 's1')?.sessionType).toBe('play');
  });
});
