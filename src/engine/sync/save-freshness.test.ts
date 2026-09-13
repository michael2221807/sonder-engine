/**
 * 存档新鲜度纯函数 — docs/design/cloud-slot-freshness.md §3/§4 全分支。
 */
import { describe, it, expect } from 'vitest';
import { deriveProfileSaveStamp, compareSaveStamps } from './save-freshness';
import type { SaveSlotMeta } from '../types/persistence';

function slot(lastSavedAt: string | null, roundNumber?: number | null): SaveSlotMeta {
  return { slotId: 's', slotName: 's', lastSavedAt, packId: 'p', packVersion: '1', ...(roundNumber === undefined ? {} : { roundNumber }) };
}

describe('deriveProfileSaveStamp', () => {
  it('returns nulls for a profile that was never saved', () => {
    expect(deriveProfileSaveStamp({ slots: {} })).toEqual({ savedAt: null, round: null });
    expect(deriveProfileSaveStamp({ slots: { a: slot(null, 9) } })).toEqual({ savedAt: null, round: null });
  });

  it('picks the most recently saved slot and THAT slot\'s round (not the max round)', () => {
    const stamp = deriveProfileSaveStamp({
      slots: {
        old: slot('2026-09-10T00:00:00.000Z', 120), // 更高回合但更旧（回退前的槽）
        recent: slot('2026-09-12T00:00:00.000Z', 96),
        never: slot(null, 999),
      },
    });
    expect(stamp).toEqual({ savedAt: '2026-09-12T00:00:00.000Z', round: 96 });
  });

  it('round is null when the winning slot has no / non-finite roundNumber (legacy saves)', () => {
    expect(deriveProfileSaveStamp({ slots: { a: slot('2026-09-12T00:00:00.000Z') } }).round).toBeNull();
    expect(deriveProfileSaveStamp({ slots: { a: slot('2026-09-12T00:00:00.000Z', null) } }).round).toBeNull();
    expect(deriveProfileSaveStamp({ slots: { a: slot('2026-09-12T00:00:00.000Z', Number.NaN) } }).round).toBeNull();
  });
});

describe('compareSaveStamps', () => {
  const T1 = '2026-09-12T10:00:00.000Z';
  const T2 = '2026-09-12T12:00:00.000Z';

  it('unknown when either side lacks a parsable time (legacy manifest / never saved / garbage)', () => {
    expect(compareSaveStamps(null, { savedAt: T1, round: 1 })).toBe('unknown');
    expect(compareSaveStamps({ savedAt: T1, round: 1 }, undefined)).toBe('unknown');
    expect(compareSaveStamps({ savedAt: null, round: 5 }, { savedAt: T1, round: 1 })).toBe('unknown');
    expect(compareSaveStamps({ savedAt: T1, round: 5 }, { savedAt: 'not-a-date', round: 1 })).toBe('unknown');
  });

  it('time is primary: the later save wins regardless of round', () => {
    expect(compareSaveStamps({ savedAt: T2, round: 3 }, { savedAt: T1, round: 9 })).toBe('local-newer');
    expect(compareSaveStamps({ savedAt: T1, round: 9 }, { savedAt: T2, round: 3 })).toBe('cloud-newer');
    // 回退再存：本地时间新、回合低 ⇒ 仍是 local-newer（回退是玩家意志）
    expect(compareSaveStamps({ savedAt: T2, round: 95 }, { savedAt: T1, round: 96 })).toBe('local-newer');
  });

  it('round breaks a time tie; missing rounds never break it', () => {
    expect(compareSaveStamps({ savedAt: T1, round: 7 }, { savedAt: T1, round: 6 })).toBe('local-newer');
    expect(compareSaveStamps({ savedAt: T1, round: 6 }, { savedAt: T1, round: 7 })).toBe('cloud-newer');
    expect(compareSaveStamps({ savedAt: T1, round: null }, { savedAt: T1, round: 7 })).toBe('same');
    expect(compareSaveStamps({ savedAt: T1, round: 7 }, { savedAt: T1, round: null })).toBe('same');
  });

  it('same-origin stamps (cloud written from this local profile) compare as same', () => {
    const local = deriveProfileSaveStamp({ slots: { a: slot(T2, 42) } });
    // 上传时 exportProfileForSync 用同一函数推导并写入 manifest —— 字符串完全一致
    const cloud = { savedAt: local.savedAt, round: local.round };
    expect(compareSaveStamps(local, cloud)).toBe('same');
  });

  it('treats different ISO spellings of the same instant as the same time', () => {
    expect(compareSaveStamps({ savedAt: '2026-09-12T10:00:00Z', round: 1 }, { savedAt: '2026-09-12T10:00:00.000Z', round: 1 })).toBe('same');
  });
});
