import { sha256String as sha256 } from '../../../engine/sync/chunked-bundle-packer';
import type {
  CardGenesisCandidateV1,
  ScriptEffectRequestV1,
  ScriptRoundAcceptedContextV1,
  ScriptRoundAcceptedResultV1,
  ScriptStateV1,
  ScriptVisitContextV1,
  ScriptVisitResultV1,
} from './types';
import type {
  AccountDef,
  CardDef,
  OperationDef,
  ScriptAcceptanceInput,
  ScriptAcceptanceOutput,
  ScriptProgramRef,
  ScriptProgramRuntime,
  ScriptState,
  ScriptVisitInput,
  ScriptVisitOutput,
} from '../../../engine/plot-vector/core/types';
import { SHUTTLE_ACCOUNT, scriptStoreAccountId } from '../../../engine/plot-vector/core/runner';
export { scriptStoreAccountId } from '../../../engine/plot-vector/core/runner';

const EFFECT_KINDS = new Set(['add', 'scale', 'convert', 'store', 'release', 'addVisits', 'scaleRemainingVisits', 'turnShuttle', 'setMode']);
const DENY_TOKENS = [
  'import', 'require', 'async', 'await', 'Promise', 'fetch', 'XMLHttpRequest', 'globalThis',
  'window', 'document', 'localStorage', 'sessionStorage', 'indexedDB', 'eval', 'Function',
  'process', 'Reflect', 'Proxy', 'WebAssembly', 'Worker', 'constructor', '__proto__',
  'prototype', 'while', 'for', 'do', 'function', 'class', '=>',
  'Math.random', 'Date', 'performance', 'crypto',
] as const;
const SHADOWS = [
  'globalThis', 'window', 'document', 'self', 'global', 'process', 'require', 'module',
  'exports', 'fetch', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'indexedDB',
  'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'Promise', 'Function',
  'Reflect', 'Proxy', 'WebAssembly', 'Worker', 'Atomics', 'SharedArrayBuffer', 'importScripts',
  'Deno', 'Bun',
  'Date', 'performance', 'crypto',
] as const;
const STATE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

type Hook = (...args: unknown[]) => unknown;

export interface ScriptRuntimeLimits {
  maxSourceChars: number;
  maxEffectsPerVisit: number;
  maxStateKeys: number;
  maxAbsNumber: number;
  maxVisitDelta: number;
  maxVisitFactor: number;
}

export const DEFAULT_SCRIPT_LIMITS: ScriptRuntimeLimits = {
  maxSourceChars: 4_000,
  maxEffectsPerVisit: 8,
  maxStateKeys: 8,
  maxAbsNumber: 1_000_000,
  maxVisitDelta: 64,
  maxVisitFactor: 8,
};

export interface ScriptValidationCatalog {
  channels: readonly string[];
  modes: readonly string[];
}

export interface ScriptValidationResult {
  ok: boolean;
  issues: string[];
}

export interface ScriptSimulationConfig extends ScriptValidationCatalog {
  topology: 'line' | 'ring';
  cellCount: number;
  initialVisitBudget: number;
  maxVisits: number;
  maxEvents: number;
  startShuttle: Readonly<Record<string, number>>;
  rounds: number;
  seed?: number;
  neighborTags?: readonly string[];
  limits?: Partial<ScriptRuntimeLimits>;
  /** Diagnostic replay only: old experimental responses omitted this required field. */
  tolerateMissingInitialState?: boolean;
}

export interface ScriptSimulationTraceEntry {
  round: number;
  visit: number;
  cellId: string;
  entryPort: 'L' | 'R';
  modeBefore: string;
  modeAfter: string;
  effects: readonly ScriptEffectRequestV1[];
  shuttleAfter: Readonly<Record<string, number>>;
  storeAfter: Readonly<Record<string, number>>;
  visitBudgetAfter: number;
}

export interface ScriptSimulationResult {
  ok: boolean;
  issues: string[];
  trace: ScriptSimulationTraceEntry[];
  finalShuttle: Record<string, number>;
  finalStore: Record<string, number>;
  persistentState: Record<string, number | boolean>;
  visits: number;
  events: number;
}

interface CompiledScriptProgram {
  candidate: CardGenesisCandidateV1;
  visit: Hook;
  accepted: Hook | null;
  persistentKeys: Set<string>;
}

/**
 * Precompiled registry used by the real board runner. The board stores only an immutable
 * reference; functions remain outside serializable board and settlement records.
 */
export class ScriptProgramRegistry implements ScriptProgramRuntime {
  private readonly programs = new Map<string, CompiledScriptProgram>();
  private readonly limits: ScriptRuntimeLimits;

  constructor(
    private readonly catalog: ScriptValidationCatalog,
    overrides: Partial<ScriptRuntimeLimits> = {},
  ) {
    this.limits = { ...DEFAULT_SCRIPT_LIMITS, ...overrides };
  }

  async register(candidate: CardGenesisCandidateV1, options: { tolerateMissingInitialState?: boolean } = {}): Promise<ScriptProgramRef> {
    const normalized = candidate.card.initialPersistentState === undefined && options.tolerateMissingInitialState
      ? { ...candidate, card: { ...candidate.card, initialPersistentState: {} } }
      : candidate;
    const validation = validateScriptCandidate(normalized, this.catalog, this.limits);
    if (!validation.ok) throw new Error(validation.issues.join('; '));
    const hash = await sha256(canonical(normalized));
    const ref = { id: `plot-card-${hash.slice(0, 12)}`, hash };
    this.programs.set(hash, {
      candidate: normalized,
      visit: compileHook(normalized.card.hooks.onVisit!),
      accepted: normalized.card.hooks.onRoundAccepted ? compileHook(normalized.card.hooks.onRoundAccepted) : null,
      persistentKeys: new Set(Object.keys(normalized.card.initialPersistentState)),
    });
    return ref;
  }

  initialState(ref: ScriptProgramRef): ScriptState | null {
    const program = this.lookup(ref);
    return program ? cloneState(program.candidate.card.initialPersistentState) : null;
  }

  visit(input: ScriptVisitInput): ScriptVisitOutput {
    const program = this.lookup(input.ref);
    if (!program) return { ok: false, reason: 'program hash is not registered' };
    if (input.entryPort !== 'L' && input.entryPort !== 'R') return { ok: false, reason: `unsupported entry port ${input.entryPort}` };
    const entryPort: 'L' | 'R' = input.entryPort;
    const issues: string[] = [];
    try {
      validatePinnedState(input.persistentState as Record<string, number | boolean>, program.persistentKeys, 'persistentState', this.limits, issues);
      if (issues.length) return { ok: false, reason: issues.join('; ') };
      const makeContext = (): ScriptVisitContextV1 => Object.freeze({
          contractVersion: 'plot-card-js-v1', cardId: input.cardId, cellId: input.cellId,
          entryPort, visitOrdinal: input.visitOrdinal, directionVisitOrdinal: input.directionVisitOrdinal ?? input.visitOrdinal,
          totalVisitsSoFar: input.totalVisitsSoFar, remainingVisits: input.remainingVisits,
          mode: input.mode, shuttle: Object.freeze({ ...input.shuttle }),
          selfStore: Object.freeze({ ...(input.selfStore ?? {}) }),
          neighbors: Object.freeze(input.neighbors.map((neighbor) => Object.freeze({
            cellId: neighbor.cellId, occupied: neighbor.occupied,
            publicTags: Object.freeze([...neighbor.publicTags]),
          }))),
          runState: Object.freeze({ ...input.runState }),
          persistentState: Object.freeze({ ...input.persistentState }),
          rng: rngFor(stringSeed(input.seed)),
        });
      const first = callHook(program.visit, makeContext());
      const second = callHook(program.visit, makeContext());
      if (canonical(first) !== canonical(second)) return { ok: false, reason: 'onVisit is non-deterministic for the same input and seed' };
      const result = validateVisitResult(first, program.candidate, this.catalog, this.limits, issues);
      if (!result) return { ok: false, reason: issues.at(-1) ?? 'invalid visit result' };
      const runState = cloneState(result.runState ?? input.runState);
      validatePinnedState(runState, input.runStateKeys ? new Set(input.runStateKeys) : null, 'runState', this.limits, issues);
      if (issues.length) return { ok: false, reason: issues.join('; ') };
      const effects = [...(result.effects ?? [])];
      return {
        ok: true,
        operations: effectsToOperations(effects, input.cardId, input.ref),
        runState,
        runStateKeys: input.runStateKeys ?? Object.keys(runState).sort(),
        effectSummary: effects.map((effect) => canonical(effect)),
      };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }

  accept(input: ScriptAcceptanceInput): ScriptAcceptanceOutput {
    const program = this.lookup(input.ref);
    if (!program) return { ok: false, reason: 'program hash is not registered' };
    if (!program.accepted) return { ok: true, persistentState: { ...input.persistentState } };
    const issues: string[] = [];
    try {
      validatePinnedState(input.persistentState as Record<string, number | boolean>, program.persistentKeys, 'persistentState', this.limits, issues);
      if (issues.length) return { ok: false, reason: issues.join('; ') };
      const makeContext = (): ScriptRoundAcceptedContextV1 => Object.freeze({
          contractVersion: 'plot-card-js-v1', cardId: input.cardId,
          wasEquipped: input.wasEquipped, wasTriggered: input.wasTriggered,
          triggerCount: input.triggerCount, visitCount: input.visitCount,
          finalShuttle: Object.freeze({ ...input.finalShuttle }),
          selfStore: Object.freeze({ ...(input.selfStore ?? {}) }),
          peakShuttle: Object.freeze({ ...input.peakShuttle }),
          minShuttle: Object.freeze({ ...input.minShuttle }),
          runState: Object.freeze({ ...input.runState }),
          persistentState: Object.freeze({ ...input.persistentState }),
          rng: rngFor(stringSeed(input.seed)),
        });
      const first = callHook(program.accepted, makeContext());
      const second = callHook(program.accepted, makeContext());
      if (canonical(first) !== canonical(second)) return { ok: false, reason: 'onRoundAccepted is non-deterministic for the same input and seed' };
      const result = validateAcceptedResult(first, this.limits, issues);
      if (!result) return { ok: false, reason: issues.at(-1) ?? 'invalid accepted result' };
      const persistentState = cloneState(result.persistentState ?? input.persistentState);
      validatePinnedState(persistentState, program.persistentKeys, 'persistentState', this.limits, issues);
      return issues.length ? { ok: false, reason: issues.join('; ') } : { ok: true, persistentState };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }

  private lookup(ref: ScriptProgramRef): CompiledScriptProgram | null {
    const program = this.programs.get(ref.hash);
    return program && ref.id === `plot-card-${ref.hash.slice(0, 12)}` ? program : null;
  }
}

/** Build the serializable card shell that can be placed on an ordinary lab board. */
export function createScriptCardDef(
  candidate: CardGenesisCandidateV1,
  ref: ScriptProgramRef,
  options: Pick<CardDef, 'id' | 'tags' | 'source'> & Partial<Pick<CardDef, 'usage' | 'growth' | 'origin' | 'provenance' | 'removable'>>,
): CardDef {
  const accounts: AccountDef[] = candidate.card.selfStore ? [{
    id: scriptStoreAccountId(options.id, ref), owner: { kind: 'card', id: options.id },
    encoding: 'channelVector', persist: 'acrossRounds', cap: candidate.card.selfStore.cap,
    lifetimeRounds: candidate.card.selfStore.lifetimeRounds, onFull: 'stayAtSource',
    label: { zh: `${candidate.card.name}的储存`, en: `${candidate.card.name} store` },
  }] : [];
  return {
    ...options,
    label: { zh: candidate.card.name, en: candidate.card.name },
    originalText: { zh: candidate.card.description, en: candidate.card.description },
    effects: [], accounts, scriptProgram: ref,
  };
}

export function validateScriptCandidate(
  candidate: CardGenesisCandidateV1,
  catalog: ScriptValidationCatalog,
  overrides: Partial<ScriptRuntimeLimits> = {},
  tolerateMissingInitialState = false,
): ScriptValidationResult {
  const limits = { ...DEFAULT_SCRIPT_LIMITS, ...overrides };
  const issues: string[] = [];
  if (candidate.version !== 1) issues.push('version must be 1');
  if (!candidate.card || typeof candidate.card !== 'object') return { ok: false, issues: ['card is missing'] };
  for (const field of ['name', 'description', 'behaviorSummary'] as const) {
    if (typeof candidate.card[field] !== 'string' || !candidate.card[field].trim()) issues.push(`card.${field} is missing`);
  }
  const initial = candidate.card.initialPersistentState;
  if (initial === undefined && !tolerateMissingInitialState) issues.push('card.initialPersistentState is required');
  else validateState(initial ?? {}, 'card.initialPersistentState', limits, issues);

  const hooks = candidate.card.hooks;
  if (!hooks || typeof hooks !== 'object') return { ok: false, issues: [...issues, 'card.hooks is missing'] };
  if (typeof hooks.onVisit !== 'string' || !hooks.onVisit.trim()) issues.push('card.hooks.onVisit is required');
  for (const [name, source] of Object.entries(hooks)) {
    if (source === null) continue;
    if (typeof source !== 'string') { issues.push(`${name} must be a string or null`); continue; }
    if (source.length > limits.maxSourceChars) issues.push(`${name} exceeds ${limits.maxSourceChars} characters`);
    for (const token of DENY_TOKENS) {
      const pattern = /^[A-Za-z]+$/.test(token) ? new RegExp(`\\b${token}\\b`) : null;
      if (pattern ? pattern.test(source) : source.includes(token)) issues.push(`${name} uses forbidden token ${token}`);
    }
    try { compileHook(source); } catch (error) { issues.push(`${name} does not compile: ${errorMessage(error)}`); }
  }

  const store = candidate.card.selfStore;
  if (store) {
    if (!finiteInRange(store.cap, 0, limits.maxAbsNumber, false)) issues.push('selfStore.cap must be positive and bounded');
    if (!Number.isSafeInteger(store.lifetimeRounds) || store.lifetimeRounds < 1) issues.push('selfStore.lifetimeRounds must be a positive integer');
    for (const field of ['allowedIn', 'allowedOut'] as const) {
      if (!Array.isArray(store[field]) || !store[field].every((channel) => catalog.channels.includes(channel))) {
        issues.push(`selfStore.${field} must contain catalog channels`);
      }
    }
    if (JSON.stringify([...store.allowedIn].sort()) !== JSON.stringify([...store.allowedOut].sort())) {
      issues.push('selfStore.allowedIn and allowedOut must be the same channel set');
    }
  }
  return { ok: issues.length === 0, issues };
}

export function simulateScriptCandidate(candidate: CardGenesisCandidateV1, config: ScriptSimulationConfig): ScriptSimulationResult {
  const limits = { ...DEFAULT_SCRIPT_LIMITS, ...(config.limits ?? {}) };
  const validated = validateScriptCandidate(candidate, config, limits, config.tolerateMissingInitialState === true);
  if (!validated.ok) return failure(validated.issues, config);
  if (!Number.isSafeInteger(config.cellCount) || config.cellCount < 2) return failure(['cellCount must be at least 2'], config);
  if (!Number.isSafeInteger(config.initialVisitBudget) || config.initialVisitBudget < 0 || config.initialVisitBudget > config.maxVisits) {
    return failure(['initialVisitBudget is outside the visit guard'], config);
  }
  if (!Number.isSafeInteger(config.rounds) || config.rounds < 1) return failure(['rounds must be a positive integer'], config);

  const visitHook = compileHook(candidate.card.hooks.onVisit!);
  const acceptedHook = candidate.card.hooks.onRoundAccepted ? compileHook(candidate.card.hooks.onRoundAccepted) : null;
  const initialState = candidate.card.initialPersistentState ?? {};
  const persistentKeys = new Set(Object.keys(initialState));
  let persistent = cloneState(initialState);
  let storeEntries: Array<{ round: number; channel: string; amount: number }> = [];
  const trace: ScriptSimulationTraceEntry[] = [];
  const issues: string[] = [];
  let totalVisits = 0;
  let events = 0;
  let lastShuttle = zeroed(config.channels, config.startShuttle);

  try {
    for (let round = 1; round <= config.rounds; round += 1) {
      const life = candidate.card.selfStore?.lifetimeRounds;
      if (life) storeEntries = storeEntries.filter((entry) => round - entry.round < life);
      const shuttle = zeroed(config.channels, config.startShuttle);
      const peak = { ...shuttle };
      const minimum = { ...shuttle };
      let runState: Record<string, number | boolean> = {};
      let runKeys: Set<string> | null = null;
      let mode = config.modes[0] ?? 'normal';
      let tripLength = config.initialVisitBudget;
      let index = 0;
      let direction: 1 | -1 = 1;
      const ordinalByCell = new Map<number, number>();
      const directionOrdinals = new Map<string, number>();
      let roundVisits = 0;
      let triggerCount = 0;

      while (roundVisits < tripLength) {
        if (roundVisits + 1 > config.maxVisits) throw new Error(`visit budget ${config.maxVisits} exceeded`);
        roundVisits += 1;
        totalVisits += 1;
        events = countEvent(events, config.maxEvents);
        const ordinal = (ordinalByCell.get(index) ?? 0) + 1;
        ordinalByCell.set(index, ordinal);
        const entryPort: 'L' | 'R' = direction === 1 ? 'L' : 'R';
        const directionKey = `${index}:${entryPort}`;
        const directionVisitOrdinal = (directionOrdinals.get(directionKey) ?? 0) + 1;
        directionOrdinals.set(directionKey, directionVisitOrdinal);
        const modeBefore = mode;
        const ctx: ScriptVisitContextV1 = Object.freeze({
          contractVersion: 'plot-card-js-v1', cardId: 'candidate', cellId: cellId(index), entryPort,
          visitOrdinal: ordinal, directionVisitOrdinal, totalVisitsSoFar: roundVisits,
          remainingVisits: Math.max(0, tripLength - roundVisits), mode,
          shuttle: Object.freeze({ ...shuttle }),
          selfStore: Object.freeze(storeSummary(storeEntries)),
          neighbors: Object.freeze(neighbors(index, config.cellCount, config.neighborTags ?? [])),
          runState: Object.freeze({ ...runState }), persistentState: Object.freeze({ ...persistent }),
          rng: rngFor((config.seed ?? 1) + round * 10_000 + roundVisits),
        });
        const raw = callHook(visitHook, ctx);
        const result = validateVisitResult(raw, candidate, config, limits, issues);
        if (!result) throw new Error(issues.at(-1) ?? 'invalid visit result');
        if (result.runState !== undefined) {
          const next = cloneState(result.runState);
          validatePinnedState(next, runKeys, 'runState', limits, issues);
          if (issues.length) throw new Error(issues.at(-1)!);
          runKeys ??= new Set(Object.keys(next));
          runState = next;
        }

        const effects = [...(result.effects ?? [])];
        if (effects.length) triggerCount += 1;
        let turn = false;
        for (const effect of effects) {
          events = countEvent(events, config.maxEvents);
          if (effect.kind === 'turnShuttle') { turn = true; continue; }
          const changed = applyEffect(effect, {
            shuttle, storeEntries, storeCap: candidate.card.selfStore?.cap,
            round, channels: config.channels, modes: config.modes, mode, tripLength,
            visits: roundVisits, maxVisits: config.maxVisits,
          });
          mode = changed.mode;
          tripLength = changed.tripLength;
          storeEntries = changed.storeEntries;
          updateExtremes(shuttle, peak, minimum);
        }
        trace.push({
          round, visit: roundVisits, cellId: cellId(index), entryPort, modeBefore, modeAfter: mode,
          effects, shuttleAfter: { ...shuttle }, storeAfter: storeSummary(storeEntries), visitBudgetAfter: tripLength,
        });

        if (roundVisits >= tripLength) break;
        if (turn) direction = direction === 1 ? -1 : 1;
        let next = index + direction;
        if (config.topology === 'ring') next = (next + config.cellCount) % config.cellCount;
        else if (next < 0 || next >= config.cellCount) {
          direction = direction === 1 ? -1 : 1;
          next = index + direction;
        }
        index = next;
      }

      if (acceptedHook) {
        const acceptedCtx: ScriptRoundAcceptedContextV1 = Object.freeze({
          contractVersion: 'plot-card-js-v1', cardId: 'candidate', wasEquipped: true,
          wasTriggered: triggerCount > 0, triggerCount, visitCount: roundVisits,
          runState: Object.freeze({ ...runState }),
          finalShuttle: Object.freeze({ ...shuttle }), peakShuttle: Object.freeze({ ...peak }),
          selfStore: Object.freeze(storeSummary(storeEntries)),
          minShuttle: Object.freeze({ ...minimum }), persistentState: Object.freeze({ ...persistent }),
          rng: rngFor((config.seed ?? 1) + round),
        });
        const accepted = validateAcceptedResult(callHook(acceptedHook, acceptedCtx), limits, issues);
        if (!accepted) throw new Error(issues.at(-1) ?? 'invalid accepted result');
        if (accepted.persistentState !== undefined) {
          const next = cloneState(accepted.persistentState);
          validatePinnedState(next, persistentKeys, 'persistentState', limits, issues);
          if (issues.length) throw new Error(issues.at(-1)!);
          persistent = next;
        }
      }
      lastShuttle = shuttle;
    }
  } catch (error) {
    if (!issues.length) issues.push(errorMessage(error));
  }

  return {
    ok: issues.length === 0, issues, trace, finalShuttle: lastShuttle,
    finalStore: storeSummary(storeEntries), persistentState: persistent,
    visits: totalVisits, events,
  };
}

interface ApplyContext {
  shuttle: Record<string, number>;
  storeEntries: Array<{ round: number; channel: string; amount: number }>;
  storeCap?: number;
  round: number;
  channels: readonly string[];
  modes: readonly string[];
  mode: string;
  tripLength: number;
  visits: number;
  maxVisits: number;
}

function applyEffect(effect: ScriptEffectRequestV1, ctx: ApplyContext): Pick<ApplyContext, 'mode' | 'tripLength' | 'storeEntries'> {
  let { mode, tripLength, storeEntries } = ctx;
  switch (effect.kind) {
    case 'add':
      ctx.shuttle[effect.channel] = Math.max(0, ctx.shuttle[effect.channel] + effect.amount);
      break;
    case 'scale':
      ctx.shuttle[effect.channel] = Math.max(0, ctx.shuttle[effect.channel] * effect.factor);
      break;
    case 'convert': {
      const taken = Math.min(ctx.shuttle[effect.from], effect.amount);
      ctx.shuttle[effect.from] -= taken;
      ctx.shuttle[effect.to] += taken * effect.efficiency;
      break;
    }
    case 'store': {
      const total = storeEntries.reduce((sum, entry) => sum + entry.amount, 0);
      const amount = Math.min(effect.amount, ctx.shuttle[effect.channel], Math.max(0, (ctx.storeCap ?? 0) - total));
      ctx.shuttle[effect.channel] -= amount;
      if (amount > 0) storeEntries = [...storeEntries, { round: ctx.round, channel: effect.channel, amount }];
      break;
    }
    case 'release': {
      let remaining = effect.amount;
      let released = 0;
      storeEntries = storeEntries.map((entry) => {
        if (entry.channel !== effect.channel || remaining <= 0) return entry;
        const take = Math.min(entry.amount, remaining);
        remaining -= take;
        released += take;
        return { ...entry, amount: entry.amount - take };
      }).filter((entry) => entry.amount > 1e-12);
      ctx.shuttle[effect.channel] += released * (1 + (effect.gainAsExtra ?? 0));
      break;
    }
    case 'addVisits':
      tripLength += effect.amount;
      if (tripLength > ctx.maxVisits) throw new Error(`step effect exceeds visit guard ${ctx.maxVisits}`);
      break;
    case 'scaleRemainingVisits': {
      const remaining = Math.max(0, tripLength - ctx.visits);
      tripLength = ctx.visits + Math.floor(remaining * effect.factor);
      if (tripLength > ctx.maxVisits) throw new Error(`step effect exceeds visit guard ${ctx.maxVisits}`);
      break;
    }
    case 'setMode':
      mode = effect.mode;
      break;
    case 'turnShuttle':
      break;
  }
  return { mode, tripLength, storeEntries };
}

function effectsToOperations(
  effects: readonly ScriptEffectRequestV1[],
  cardId: string,
  ref: ScriptProgramRef,
): OperationDef[] {
  const numeric: OperationDef[] = [];
  let turn = false;
  for (const effect of effects) {
    switch (effect.kind) {
      case 'add':
        numeric.push({ op: 'add', target: SHUTTLE_ACCOUNT, channel: effect.channel, amount: effect.amount });
        break;
      case 'scale':
        numeric.push({ op: 'scale', target: SHUTTLE_ACCOUNT, channel: effect.channel, factor: effect.factor });
        break;
      case 'convert':
        numeric.push({ op: 'convert', target: SHUTTLE_ACCOUNT, from: effect.from, to: effect.to, amount: effect.amount, efficiency: effect.efficiency });
        break;
      case 'store':
        numeric.push({
          op: 'transfer', from: SHUTTLE_ACCOUNT, to: scriptStoreAccountId(cardId, ref),
          fromChannel: effect.channel, toChannel: effect.channel, amount: { kind: 'fixed', value: effect.amount },
        });
        break;
      case 'release':
        numeric.push({
          op: 'transfer', from: scriptStoreAccountId(cardId, ref), to: SHUTTLE_ACCOUNT,
          fromChannel: effect.channel, toChannel: effect.channel, amount: { kind: 'fixed', value: effect.amount },
          gainAsExtra: effect.gainAsExtra,
        });
        break;
      case 'addVisits':
        numeric.push({ op: 'addVisits', amount: effect.amount });
        break;
      case 'scaleRemainingVisits':
        numeric.push({ op: 'scaleRemainingVisits', factor: effect.factor });
        break;
      case 'setMode':
        numeric.push({ op: 'setMode', mode: effect.mode });
        break;
      case 'turnShuttle':
        turn = true;
        break;
    }
  }
  if (turn) numeric.push({ op: 'turnShuttle' });
  return numeric;
}

function validateVisitResult(
  value: unknown,
  candidate: CardGenesisCandidateV1,
  catalog: ScriptValidationCatalog,
  limits: ScriptRuntimeLimits,
  issues: string[],
): ScriptVisitResultV1 | null {
  if (!isRecord(value)) { issues.push('onVisit must return an object'); return null; }
  if (value.runState !== undefined) validateState(value.runState, 'onVisit.runState', limits, issues);
  if (value.effects !== undefined) {
    if (!Array.isArray(value.effects)) issues.push('onVisit.effects must be an array');
    else {
      if (value.effects.length > limits.maxEffectsPerVisit) issues.push('onVisit returned too many effects');
      let turns = 0;
      for (const raw of value.effects) {
        validateEffect(raw, candidate, catalog, limits, issues);
        if (isRecord(raw) && raw.kind === 'turnShuttle') turns += 1;
      }
      if (turns > 1) issues.push('only one turnShuttle is allowed per visit');
    }
  }
  return issues.length ? null : value as unknown as ScriptVisitResultV1;
}

function validateAcceptedResult(value: unknown, limits: ScriptRuntimeLimits, issues: string[]): ScriptRoundAcceptedResultV1 | null {
  if (!isRecord(value)) { issues.push('onRoundAccepted must return an object'); return null; }
  if (value.persistentState !== undefined) validateState(value.persistentState, 'onRoundAccepted.persistentState', limits, issues);
  return issues.length ? null : value as unknown as ScriptRoundAcceptedResultV1;
}

function validateEffect(
  raw: unknown,
  candidate: CardGenesisCandidateV1,
  catalog: ScriptValidationCatalog,
  limits: ScriptRuntimeLimits,
  issues: string[],
): void {
  if (!isRecord(raw) || typeof raw.kind !== 'string' || !EFFECT_KINDS.has(raw.kind)) {
    issues.push('effect has an unknown kind'); return;
  }
  const channel = (field: string): boolean => {
    if (typeof raw[field] !== 'string' || !catalog.channels.includes(raw[field] as string)) {
      issues.push(`${raw.kind}.${field} must be a catalog channel`); return false;
    }
    return true;
  };
  const number = (field: string, min: number, max = limits.maxAbsNumber, integer = false): boolean => {
    const value = raw[field];
    if (!finiteInRange(value, min, max, true) || (integer && !Number.isSafeInteger(value))) {
      issues.push(`${raw.kind}.${field} is missing or outside [${min}, ${max}]`); return false;
    }
    return true;
  };
  switch (raw.kind) {
    case 'add':
      channel('channel'); number('amount', -limits.maxAbsNumber); break;
    case 'scale':
      channel('channel'); number('factor', 0); break;
    case 'convert':
      channel('from'); channel('to'); number('amount', 0); number('efficiency', 0);
      if (raw.from === raw.to) issues.push('convert.from and convert.to must differ');
      break;
    case 'store':
    case 'release': {
      channel('channel'); number('amount', 0);
      if (raw.store !== 'self') issues.push(`${raw.kind}.store must be self`);
      const store = candidate.card.selfStore;
      if (!store) issues.push(`${raw.kind} requires card.selfStore`);
      else if (typeof raw.channel === 'string' && !store.allowedIn.includes(raw.channel)) issues.push(`${raw.kind}.channel is not authorised by selfStore`);
      if (raw.kind === 'release' && raw.gainAsExtra !== undefined) number('gainAsExtra', 0);
      break;
    }
    case 'addVisits':
      number('amount', 0, limits.maxVisitDelta, true); break;
    case 'scaleRemainingVisits':
      number('factor', 1, limits.maxVisitFactor); break;
    case 'turnShuttle':
      break;
    case 'setMode':
      if (typeof raw.mode !== 'string' || !catalog.modes.includes(raw.mode)) issues.push('setMode.mode must be in ModeCatalog');
      break;
  }
}

function validateState(value: unknown, where: string, limits: ScriptRuntimeLimits, issues: string[]): void {
  if (!isRecord(value)) { issues.push(`${where} must be a flat object`); return; }
  const keys = Object.keys(value);
  if (keys.length > limits.maxStateKeys) issues.push(`${where} has more than ${limits.maxStateKeys} keys`);
  for (const [key, item] of Object.entries(value)) {
    if (!STATE_KEY.test(key)) issues.push(`${where}.${key} has an invalid key`);
    if (typeof item === 'boolean') continue;
    if (!finiteInRange(item, -limits.maxAbsNumber, limits.maxAbsNumber, true)) issues.push(`${where}.${key} must be a bounded number or boolean`);
  }
}

function validatePinnedState(
  state: Record<string, number | boolean>,
  pinned: Set<string> | null,
  where: string,
  limits: ScriptRuntimeLimits,
  issues: string[],
): void {
  validateState(state, where, limits, issues);
  if (pinned && JSON.stringify([...Object.keys(state)].sort()) !== JSON.stringify([...pinned].sort())) {
    issues.push(`${where} must fully replace the same pinned key set`);
  }
}

function compileHook(source: string): Hook {
  const ctor = Function as unknown as new (...args: string[]) => Hook;
  return new ctor(...SHADOWS, 'ctx', `"use strict";\n${source}`);
}

function callHook(hook: Hook, ctx: object): unknown {
  return hook(...SHADOWS.map(() => undefined), ctx);
}

function finiteInRange(value: unknown, min: number, max: number, inclusiveMin = true): value is number {
  return typeof value === 'number' && Number.isFinite(value) && (inclusiveMin ? value >= min : value > min) && value <= max;
}

function cloneState(state: ScriptStateV1): Record<string, number | boolean> {
  return { ...state };
}

function zeroed(channels: readonly string[], source: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(channels.map((channel) => [channel, Math.max(0, source[channel] ?? 0)]));
}

function updateExtremes(shuttle: Record<string, number>, peak: Record<string, number>, minimum: Record<string, number>): void {
  for (const [channel, value] of Object.entries(shuttle)) {
    peak[channel] = Math.max(peak[channel] ?? value, value);
    minimum[channel] = Math.min(minimum[channel] ?? value, value);
  }
}

function storeSummary(entries: Array<{ channel: string; amount: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of entries) out[entry.channel] = (out[entry.channel] ?? 0) + entry.amount;
  return out;
}

function neighbors(index: number, count: number, tags: readonly string[]): ScriptVisitContextV1['neighbors'] {
  const ids = [index - 1, index + 1].filter((value) => value >= 0 && value < count);
  return ids.map((value) => Object.freeze({ cellId: cellId(value), occupied: value % 2 === 0, publicTags: Object.freeze([...tags]) }));
}

function cellId(index: number): string {
  return String(index + 1).padStart(2, '0');
}

function countEvent(current: number, max: number): number {
  const next = current + 1;
  if (next > max) throw new Error(`event budget ${max} exceeded`);
  return next;
}

function rngFor(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function stringSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function failure(issues: string[], config: ScriptSimulationConfig): ScriptSimulationResult {
  return {
    ok: false, issues, trace: [], finalShuttle: zeroed(config.channels, config.startShuttle),
    finalStore: {}, persistentState: {}, visits: 0, events: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
