import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTripWalk } from './use-trip-walk';
import type { TripWalk } from '@/features/plot-vector/table-model';

// The composable registers a cleanup with the component around it; these tests run it bare.
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const trip: TripWalk = {
  departure: [],
  steps: [
    { cell: '01', back: false, acted: [{ card: 'a', sign: 'push' }] },
    { cell: '02', back: false, acted: [] },
    { cell: '01', back: true, acted: [] },
  ],
  tendency: { s: 0.3, y: 0.2, j: 0.1 },
};

describe('the shuttle walk', () => {
  it('walks every step, lights the cards it passes, and settles on the tendency', async () => {
    const walk = useTripWalk();
    const done = walk.play(trip, 100);
    expect(walk.playing.value).toBe(true);
    await vi.advanceTimersByTimeAsync(0); // departure: no weather here
    expect(walk.at.value).toBe('01');
    expect(walk.acting.value.has('a')).toBe(true);
    expect(walk.floats.value).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(walk.at.value).toBe('02');
    await vi.advanceTimersByTimeAsync(100);
    expect(walk.back.value).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    await expect(done).resolves.toBe(true);
    expect(walk.tendency.value).toEqual(trip.tendency);
    expect(walk.playing.value).toBe(false);
  });
  it('a walk replaced by another reports that it did not finish; stopping clears the signs', async () => {
    const walk = useTripWalk();
    const first = walk.play(trip, 100);
    await vi.advanceTimersByTimeAsync(0);
    const second = walk.play(trip, 100);
    await expect(first).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(walk.floats.value.length).toBeGreaterThan(0);
    walk.stop();
    await expect(second).resolves.toBe(false);
    expect(walk.floats.value).toEqual([]);
    expect(walk.acting.value.size).toBe(0);
  });
});
