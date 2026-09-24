import type {
  BoardDef,
  CardDef,
  CellDef,
  ChannelMeta,
  CompileOptions,
  CompiledBoard,
  CompiledEffect,
  EdgeDef,
  EffectDef,
  TriggerPolicy,
} from './types';

/** Trigger default for effects that omit a policy (plan §3.2; framework D47 / D53). */
export function defaultPolicy(kind: CompileOptions['triggerDefault']): TriggerPolicy {
  switch (kind) {
    case 'a':
      return { limitScope: 'run', maxTriggers: 'unlimited' };
    case 'b':
      return { limitScope: 'run', maxTriggers: 1 };
    case 'c':
      return { limitScope: 'run', maxTriggers: 'unlimited', repeatRule: { kind: 'deltaFraction', r: 0.5 } };
  }
}

function compileEffect(e: EffectDef, options: CompileOptions): CompiledEffect {
  return { ...e, triggerPolicy: e.triggerPolicy ?? defaultPolicy(options.triggerDefault) };
}

function compileCell(c: CellDef, options: CompileOptions) {
  return { ...c, effects: c.effects.map((e) => compileEffect(e, options)) };
}

function compileCard(c: CardDef, options: CompileOptions) {
  return { ...c, effects: c.effects.map((e) => compileEffect(e, options)) };
}

function compileEdge(e: EdgeDef, options: CompileOptions) {
  return { ...e, effects: (e.effects ?? []).map((x) => compileEffect(x, options)) };
}

export function channelsOf(board: Pick<BoardDef, 'dimensions'>): ChannelMeta[] {
  const out: ChannelMeta[] = [];
  for (const d of board.dimensions) {
    if (d.polarity === 'bipolar') {
      out.push({ id: `${d.id}+`, dimension: d.id, pole: 'positive' });
      out.push({ id: `${d.id}-`, dimension: d.id, pole: 'negative' });
    } else {
      out.push({ id: d.id, dimension: d.id, pole: 'positive' });
    }
  }
  return out;
}

/**
 * Compile a fixture board: every effect ends up with an explicit trigger policy
 * (v0.3 section C: explicit after compile). Nothing else is invented here.
 */
export function compileBoard(def: BoardDef, options: CompileOptions): CompiledBoard {
  return {
    ...def,
    cells: def.cells.map((c) => compileCell(c, options)),
    cards: def.cards.map((c) => compileCard(c, options)),
    edges: def.edges.map((e) => compileEdge(e, options)),
    channels: channelsOf(def),
    compileOptions: options,
  };
}

/** Per-run trigger counter honouring limitScope / maxTriggers / repeatRule. */
export class TriggerCounter {
  private readonly runCounts = new Map<string, number>();
  private visitCounts = new Map<string, number>();

  newVisit(): void {
    this.visitCounts = new Map();
  }

  /**
   * Register an attempt. Returns whether it may fire and the delta multiplier
   * (1 for first trigger, `repeatRule.r` afterwards when declared).
   */
  attempt(effectId: string, policy: TriggerPolicy): { allowed: boolean; ordinal: number; deltaFactor: number } {
    const map = policy.limitScope === 'visit' ? this.visitCounts : this.runCounts;
    const ordinal = (map.get(effectId) ?? 0) + 1;
    map.set(effectId, ordinal);
    if (policy.maxTriggers !== 'unlimited' && ordinal > policy.maxTriggers) {
      return { allowed: false, ordinal, deltaFactor: 0 };
    }
    const deltaFactor = ordinal >= 2 && policy.repeatRule ? policy.repeatRule.r : 1;
    return { allowed: true, ordinal, deltaFactor };
  }
}
