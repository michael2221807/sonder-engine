/**
 * One pass of one card: run its `onPass` with the values the engine feeds in, read and bound what it
 * returns, and add its growth when it triggers. Never throws; an error means this pass did not act.
 */
import { compiledPass, runPass } from './compile';
import { readReturn, triggers, withGrowth } from './returns';
import type { CardReturn, CardSpec, PassValues } from './types';

export interface PassResult {
  ret: CardReturn;
  triggered: boolean;
  /** Why the card did not act this time because of its own code (absent when it simply chose not to). */
  error?: string;
}

export function passCard(spec: CardSpec, values: PassValues, seed: string): PassResult {
  const compiled = compiledPass(spec.onPass);
  if ('error' in compiled) return { ret: {}, triggered: false, error: compiled.error };
  const out = runPass(compiled.compiled, values, seed);
  if (!out.ok) return { ret: {}, triggered: false, error: out.error };
  const own = readReturn(out.value);
  if (!triggers(own)) return { ret: {}, triggered: false };
  const ret = withGrowth(own, spec.growth?.add, values.level);
  return { ret, triggered: triggers(ret) };
}

/** A growth burst, read like any return (the model writes it in the same shape). */
export function burstOf(spec: CardSpec): CardReturn {
  return spec.growth?.burst ? readReturn(spec.growth.burst) : {};
}
