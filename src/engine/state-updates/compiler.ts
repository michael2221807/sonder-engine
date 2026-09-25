import type { Command } from '../types';

/** Opt-in pack contract consumed by the host synchronization pipeline. */
export interface StateUpdateContract {
  inventoryPath: string;
  quantityField: string;
  nameField?: string;
  accounts: Record<string, { path: string; decimals: number }>;
}

export interface StateUpdateBaseline {
  round: number;
  items: Record<string, unknown>;
  balances: Record<string, unknown>;
}

export interface CompiledStateUpdates {
  commands: Command[];
  notices: Array<{ index: number; reason: 'unknown-account' | 'untracked-transfer' | 'legacy-item'
    | 'unknown-quantity' | 'quantity-range' | 'money-unsettled' }>;
}

const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
/** Any rejected round of state updates. Hosts show their own wording; `reason` stays diagnostic. */
export class StateUpdateError extends Error {
  constructor(readonly reason: string) {
    super(`State updates: ${reason}`);
    this.name = 'StateUpdateError';
  }
}
function fail(message: string): never { throw new StateUpdateError(message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('unexpected field');
}
function segment(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[.\[\]]/.test(value) || unsafe.has(value)) {
    fail('invalid reference or path segment');
  }
  return value;
}
function path(value: string): string {
  value.split('.').forEach(segment);
  return value;
}
function quantity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail('quantity must be a positive integer');
  return value;
}
function minorUnits(value: unknown, decimals: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('invalid money amount');
  const scaled = value * 10 ** decimals, rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-7) fail('money precision or range exceeded');
  return rounded;
}
function cloneFields(value: unknown): Record<string, unknown> {
  const result = object(value);
  // State fields may be nested, but cannot smuggle path syntax or prototype keys.
  function check(v: unknown): void {
    if (Array.isArray(v)) { v.forEach(check); return; }
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) { segment(k); check(child); }
    } else if (typeof v === 'number' && !Number.isFinite(v)) fail('non-finite field');
    else if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) fail('non-JSON field');
  }
  check(result);
  return structuredClone(result);
}

/**
 * Compile a complete, explicitly versioned round against an immutable pre-round baseline.
 * No story reading, model calls, persistent writes, name matching or automatic account choice.
 * All validation finishes before any command is returned. Caller must commit at most once.
 */
export function compileStateUpdates(
  raw: unknown, baseline: StateUpdateBaseline, contract: StateUpdateContract,
): CompiledStateUpdates {
  const envelope = object(raw);
  keys(envelope, ['version', 'actions']);
  if (envelope.version !== 1 || !Array.isArray(envelope.actions) || envelope.actions.length > 100) fail('invalid envelope');
  if (!Number.isSafeInteger(baseline.round) || baseline.round < 0) fail('invalid round');
  const root = path(contract.inventoryPath), qty = segment(contract.quantityField);
  if (contract.nameField !== undefined) segment(contract.nameField);
  const accounts = new Map(Object.entries(contract.accounts));
  const protectedPaths = [root];
  for (const [name, account] of accounts) {
    segment(name); path(account.path);
    if (!Number.isInteger(account.decimals) || account.decimals < 0 || account.decimals > 6) fail('invalid account precision');
    if (protectedPaths.some(p => p === account.path || p.startsWith(account.path + '.') || account.path.startsWith(p + '.'))) {
      fail('overlapping account/inventory paths');
    }
    protectedPaths.push(account.path);
  }
  // Untouched legacy entries are opaque. Their shape must not block unrelated turns.
  const items = new Map(Object.entries(baseline.items));
  const reserved = new Set(items.keys()), aliases = new Map<string, string>();
  const touched = new Set<string>(), balances = new Map<string, number>(), paid = new Set<string>();
  const exhausted = new Set<string>();
  const notices: CompiledStateUpdates['notices'] = [];
  // Array order identifies actions without IDs. Keep validating explicit IDs from older replies.
  const actionIds = new Set<string>();
  function existing(ref: unknown): string {
    const key = segment(ref), id = aliases.get(key) ?? key;
    if (!items.has(id)) fail('unknown item reference');
    return id;
  }
  function itemAt(id: string, index: number): Record<string, unknown> | undefined {
    const value = items.get(id);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      notices.push({ index, reason: 'legacy-item' }); return;
    }
    return value as Record<string, unknown>;
  }
  function changeQuantity(id: string, amount: number, index: number) {
    const item = itemAt(id, index);
    if (!item) return;
    const current = item[qty];
    if (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 0) {
      notices.push({ index, reason: 'unknown-quantity' }); return;
    }
    const next = current + amount;
    if (!Number.isSafeInteger(next) || next < 0) {
      notices.push({ index, reason: 'quantity-range' }); return;
    }
    // Keep zero until the round is compiled: a later replenish may reuse this ID.
    items.set(id, { ...item, [qty]: next }); touched.add(id);
    if (next === 0) exhausted.add(id); else exhausted.delete(id);
  }
  for (const [index, entry] of envelope.actions.entries()) {
    const a = object(entry);
    if (Object.hasOwn(a, 'id')) {
      const id = segment(a.id);
      if (actionIds.has(id)) fail('duplicate action ID');
      actionIds.add(id);
    }
    switch (a.op) {
      case 'acquire':
      case 'register_held': {
        keys(a, ['id', 'op', 'ref', 'item']);
        // A temporary ref exists only so later actions of this round can point at the new entry.
        // Without one, the host names the entry from the round and the action position; nothing is
        // bound as an alias, so an unbound `__new_N` elsewhere still fails as an unknown reference.
        const ref = a.ref === undefined ? undefined : segment(a.ref);
        if (ref !== undefined && (!/^__new_[1-9][0-9]{0,2}$/.test(ref) || aliases.has(ref) || reserved.has(ref))) fail('creation requires a fresh __new_N alias');
        const item = cloneFields(a.item);
        quantity(item[qty]);
        if (contract.nameField) {
          const name = item[segment(contract.nameField)];
          if (typeof name !== 'string' || !name.trim()) fail('new item requires a name');
        }
        // The `a` prefix keeps position-named IDs apart from `__new_N` ones, whose suffix is always digits.
        const base = ref === undefined ? `pv_${baseline.round}_a${index + 1}` : `pv_${baseline.round}_${ref.slice(6)}`;
        let next = base;
        for (let n = 1; reserved.has(next); n++) next = `${base}_${n}`;
        if (ref !== undefined) aliases.set(ref, next);
        reserved.add(next); items.set(next, item); touched.add(next);
        break;
      }
      case 'update': {
        keys(a, ['id', 'op', 'ref', 'fields']);
        const id = existing(a.ref), fields = cloneFields(a.fields);
        if (Object.hasOwn(fields, qty)) fail('use replenish/consume for quantity changes');
        const item = itemAt(id, index);
        if (item) { items.set(id, { ...item, ...fields }); touched.add(id); }
        break;
      }
      case 'replenish':
      case 'consume': {
        keys(a, ['id', 'op', 'ref', 'amount']);
        const id = existing(a.ref), amount = quantity(a.amount);
        changeQuantity(id, a.op === 'consume' ? -amount : amount, index);
        break;
      }
      case 'transfer': {
        keys(a, ['id', 'op', 'ref', 'amount']);
        const amount = a.amount === undefined ? undefined : quantity(a.amount);
        if (a.ref === null) { notices.push({ index, reason: 'untracked-transfer' }); break; }
        const id = existing(a.ref);
        if (amount !== undefined) changeQuantity(id, -amount, index);
        else { items.delete(id); touched.add(id); }
        break;
      }
      case 'pay':
      case 'receive': {
        keys(a, ['id', 'op', 'account', 'amount']);
        const amountValue = typeof a.amount === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(a.amount.trim())
          ? Number(a.amount.trim()) : a.amount;
        if (typeof amountValue !== 'number' || !Number.isFinite(amountValue) || amountValue <= 0) fail('payment must be positive');
        if (a.account === null) { notices.push({ index, reason: 'unknown-account' }); break; }
        const name = segment(a.account), account = accounts.get(name);
        if (!account) fail('undeclared account; use null when unknown');
        try {
          const current = balances.get(name) ?? minorUnits(baseline.balances[name], account.decimals);
          const amount = minorUnits(amountValue, account.decimals);
          const next = current + (a.op === 'pay' ? -amount : amount);
          // No guessed balances, overdraft, rounding or silent host clamping.
          if (!amount || next < 0 || !Number.isSafeInteger(next) || next / 10 ** account.decimals > 999_999) fail('money range');
          balances.set(name, next); paid.add(name);
        } catch {
          notices.push({ index, reason: 'money-unsettled' });
        }
        break;
      }
      default: fail('unknown operation');
    }
  }
  const commands: Command[] = [];
  for (const id of touched) {
    const item = items.get(id) as Record<string, unknown> | undefined;
    if (item && !exhausted.has(id)) commands.push({ action: 'set', key: `${root}.${id}`, value: structuredClone(item) });
    else if (Object.hasOwn(baseline.items, id)) commands.push({ action: 'delete', key: `${root}.${id}` });
  }
  for (const name of paid) {
    const account = accounts.get(name)!;
    commands.push({ action: 'set', key: account.path, value: balances.get(name)! / 10 ** account.decimals });
  }
  return { commands, notices };
}
