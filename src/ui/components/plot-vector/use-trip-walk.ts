/**
 * The shuttle's walk as the player sees it (phase 7, PO animation A): one step at a time, the cards it passes
 * light up and leave a small sign, and the tendencies settle when it is done. Motion only; the trip itself was
 * already computed by the engine.
 */
import { onBeforeUnmount, ref, shallowRef } from 'vue';
import type { PassSign, TripWalk } from '@/features/plot-vector/table-model';

export interface WalkFloat { id: number; cell: string; sign: PassSign }
const WALK_STEP_MS = 190;

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useTripWalk() {
  /** The cell the shuttle is at (it rests at 01). */
  const at = ref('01');
  /** Whether the shuttle is going back (the line folding, or a turn). */
  const back = ref(false);
  const passing = ref<string | null>(null);
  const acting = shallowRef<ReadonlySet<string>>(new Set());
  const floats = ref<WalkFloat[]>([]);
  /** Shown once a walk has settled; null while walking or before the first trip. */
  const tendency = ref<TripWalk['tendency'] | null>(null);
  const playing = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let token = 0, seq = 0;
  /** The walk in progress: stopping it (or starting another) settles its promise as not finished. */
  let pending: ((finished: boolean) => void) | null = null;

  function stop(): void {
    clearTimeout(timer);
    token++;
    pending?.(false);
    pending = null;
    playing.value = false;
    passing.value = null;
    acting.value = new Set();
    floats.value = [];
  }
  /** Show where a trip leaned without walking it (animation off, reduced motion, or a first look). */
  function settle(walk: TripWalk | null): void {
    stop();
    at.value = '01';
    back.value = false;
    tendency.value = walk?.tendency ?? null;
  }
  /** Walk a trip; resolves true when it settled, false when another walk (or a stop) replaced it. */
  function play(walk: TripWalk, stepMs = WALK_STEP_MS): Promise<boolean> {
    stop();
    if (prefersReducedMotion()) { settle(walk); return Promise.resolve(true); }
    const mine = ++token;
    playing.value = true;
    tendency.value = null;
    return new Promise(resolve => {
      pending = resolve;
      let i = -1;
      const tick = () => {
        if (mine !== token) return;
        if (i === -1) {
          // Departure: the weather acts once, before the first step.
          i = 0;
          acting.value = new Set(walk.departure.map(a => a.card));
          timer = setTimeout(tick, walk.departure.length ? stepMs * 1.6 : 0);
          return;
        }
        if (i >= walk.steps.length) {
          passing.value = null;
          acting.value = new Set();
          at.value = '01';
          back.value = false;
          tendency.value = walk.tendency;
          playing.value = false;
          pending = null;
          resolve(true);
          return;
        }
        const step = walk.steps[i++];
        at.value = step.cell;
        back.value = step.back;
        passing.value = step.cell;
        acting.value = new Set(step.acted.map(a => a.card));
        for (const act of step.acted) {
          const id = ++seq;
          floats.value = [...floats.value, { id, cell: step.cell, sign: act.sign }];
          setTimeout(() => { floats.value = floats.value.filter(f => f.id !== id); }, 900);
        }
        timer = setTimeout(tick, stepMs);
      };
      tick();
    });
  }
  onBeforeUnmount(stop);
  return { at, back, passing, acting, floats, tendency, playing, play, settle, stop };
}
