import { describe, it, expect } from 'vitest';
import { RoundOwnership } from './round-ownership';

describe('host round ownership without a board', () => {
  it('rejects slot changes, including an identical slot reloaded with a new revision', () => {
    let slot = { profileId: 'p', slotId: 'a' }, revision = 0;
    const controller = new AbortController();
    const owner = new RoundOwnership(() => slot, () => revision, controller.signal);
    owner.guard(); slot = { ...slot, slotId: 'b' };
    expect(() => owner.guard()).toThrow('存档已切换');
    slot = { ...slot, slotId: 'a' };
    expect(() => owner.guard()).toThrow('存档已切换');
    const next = new RoundOwnership(() => slot, () => revision, controller.signal);
    revision++;
    expect(() => next.guard()).toThrow('存档已切换');
  });
  it('cancellation cannot undo a durable commit, but loading another tree still invalidates it', () => {
    const controller = new AbortController(); let revision = 0;
    const owner = new RoundOwnership(() => null, () => revision, controller.signal);
    controller.abort(); expect(() => owner.guard()).toThrow('Pipeline aborted');
    owner.saved = true; expect(() => owner.guard()).not.toThrow();
    revision++; expect(() => owner.guard()).toThrow('存档已切换');
  });
});
