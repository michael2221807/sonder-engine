import type { ConditionValue, EffectCondition } from './types';

export interface ConditionContext {
  read: (value: ConditionValue) => number | undefined;
  neighborCardTags: readonly (readonly string[])[];
}

/** Missing numbers fail closed (even for ne); known empty channels/local values may be zero.
 * Limits count every node, including branches skipped by all/any, before evaluation.
 */
export function evaluateCondition(test: EffectCondition, ctx: ConditionContext): boolean {
  let nodes = 0;
  function check(t: EffectCondition, depth: number): void {
    if (++nodes > 64 || depth > 8) throw new Error('condition budget exceeded');
    if (t.kind === 'all' || t.kind === 'any') {
      if (!t.tests.length) throw new Error('condition group must not be empty');
      t.tests.forEach((child) => check(child, depth + 1));
    } else if (t.kind === 'compare') {
      if (!Number.isFinite(t.threshold)) throw new Error('condition threshold must be finite');
    } else if (t.kind === 'neighborCard') {
      if (!t.tag || !Number.isInteger(t.minCount) || t.minCount < 1) throw new Error('invalid neighbor condition');
    } else throw new Error('unknown condition');
  }
  check(test, 0);
  function evaluate(t: EffectCondition): boolean {
    if (t.kind === 'all') return t.tests.every(evaluate);
    if (t.kind === 'any') return t.tests.some(evaluate);
    if (t.kind === 'neighborCard') return ctx.neighborCardTags.filter((tags) => tags.includes(t.tag)).length >= t.minCount;
    const v = ctx.read(t.value);
    if (v === undefined || !Number.isFinite(v)) return false;
    switch (t.op) {
      case 'eq': return v === t.threshold;
      case 'ne': return v !== t.threshold;
      case 'gt': return v > t.threshold;
      case 'gte': return v >= t.threshold;
      case 'lt': return v < t.threshold;
      case 'lte': return v <= t.threshold;
      default: throw new Error('unknown comparison');
    }
  }
  return evaluate(test);
}
