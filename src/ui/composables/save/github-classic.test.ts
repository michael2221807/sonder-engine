// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncStatus } from '@/engine/sync/github-sync';
import { buildPreUploadSlotMeta, copyTextWithTextarea, isGhBusyStage, isGhClassicVisible } from './github-classic';

describe('isGhClassicVisible', () => {
  it('shows the whole-bundle rows on v2 and while the format is unknown only', () => {
    expect(isGhClassicVisible('v2')).toBe(true);
    expect(isGhClassicVisible('unknown')).toBe(true);
    expect(isGhClassicVisible('v3')).toBe(false);
    expect(isGhClassicVisible('empty')).toBe(false);
  });
});

describe('isGhBusyStage', () => {
  it('is busy while checking, uploading or downloading', () => {
    const stages: SyncStatus['stage'][] = ['idle', 'checking', 'uploading', 'downloading', 'error', 'done'];
    const busy = stages.filter((s) => isGhBusyStage(s));
    expect(busy).toEqual(['checking', 'uploading', 'downloading']);
  });
});

describe('buildPreUploadSlotMeta', () => {
  afterEach(() => vi.useRealTimers());

  it('names the slot after its id, stamps it now and carries the store summary, as an auto save', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
    const meta = buildPreUploadSlotMeta('slot_a', 'tianming', { characterName: '沈青', currentLocation: '酒肆', gameTime: '1年2月3日' });
    expect(meta).toEqual({
      slotId: 'slot_a', slotName: 'slot_a', lastSavedAt: '2026-10-08T12:00:00.000Z', packId: 'tianming',
      characterName: '沈青', currentLocation: '酒肆', gameTime: '1年2月3日', saveType: 'auto',
    });
    expect(Object.keys(meta)).toEqual(['slotId', 'slotName', 'lastSavedAt', 'packId', 'characterName', 'currentLocation', 'gameTime', 'saveType']);
  });

  it('reads the store when called, not before', () => {
    const store = { characterName: 'a', currentLocation: 'b', gameTime: 'c' };
    store.characterName = 'later';
    expect(buildPreUploadSlotMeta('s', 'p', store).characterName).toBe('later');
  });
});

describe('copyTextWithTextarea', () => {
  it('selects the text in a hidden fixed textarea, copies, and removes the textarea again', () => {
    const calls: string[] = [];
    const exec = vi.fn((cmd: string) => {
      const ta = document.body.querySelector('textarea');
      calls.push(`${cmd}:${ta?.value}:${ta?.style.position}:${ta?.style.opacity}`);
      return true;
    });
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    copyTextWithTextarea('ghp_secret');
    expect(calls).toEqual(['copy:ghp_secret:fixed:0']);
    expect(document.body.querySelector('textarea')).toBeNull();
  });
});
