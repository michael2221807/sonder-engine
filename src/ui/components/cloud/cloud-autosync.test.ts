import { describe, it, expect } from 'vitest';
import { shouldAttemptAutoUpload, type AutoSyncGuardState } from './cloud-autosync';

// The "all clear" baseline: every condition set so an auto-upload IS allowed.
const OK: AutoSyncGuardState = {
  enabled: true,
  configured: true,
  syncing: false,
  busy: false,
  conflictOpen: false,
  degradedActive: false,
  saveDamaged: false,
  dirty: true,
};

describe('shouldAttemptAutoUpload', () => {
  it('allows when every guard passes', () => {
    expect(shouldAttemptAutoUpload(OK)).toBe(true);
  });

  it('blocks when the toggle is off', () => {
    expect(shouldAttemptAutoUpload({ ...OK, enabled: false })).toBe(false);
  });

  it('blocks when GitHub is not connected', () => {
    expect(shouldAttemptAutoUpload({ ...OK, configured: false })).toBe(false);
  });

  it('blocks when a sync is already running (shared lock held)', () => {
    expect(shouldAttemptAutoUpload({ ...OK, syncing: true })).toBe(false);
  });

  it('blocks when our own check is already in flight', () => {
    expect(shouldAttemptAutoUpload({ ...OK, busy: true })).toBe(false);
  });

  it('blocks while the conflict modal is open (awaiting user decision)', () => {
    expect(shouldAttemptAutoUpload({ ...OK, conflictOpen: true })).toBe(false);
  });

  it('blocks while soft-suspended after a degraded skip', () => {
    expect(shouldAttemptAutoUpload({ ...OK, degradedActive: true })).toBe(false);
    expect(shouldAttemptAutoUpload({ ...OK, saveDamaged: true })).toBe(false);
  });

  it('blocks when there is nothing new to upload (not dirty)', () => {
    expect(shouldAttemptAutoUpload({ ...OK, dirty: false })).toBe(false);
  });

  it('any single blocker is sufficient to block (exhaustive single-flip)', () => {
    const blockers: Array<Partial<AutoSyncGuardState>> = [
      { enabled: false },
      { configured: false },
      { syncing: true },
      { busy: true },
      { conflictOpen: true },
      { degradedActive: true },
      { saveDamaged: true },
      { dirty: false },
    ];
    for (const b of blockers) {
      expect(shouldAttemptAutoUpload({ ...OK, ...b })).toBe(false);
    }
  });
});
