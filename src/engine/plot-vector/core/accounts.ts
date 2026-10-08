import type {
  AccountDef,
  AccountEntry,
  AccountId,
  AccountSnapshot,
  AccountState,
  Cap,
} from './types';

/** Upper bound of any account total, far above every meaningful amount; keeps all sums finite. */
export const ACCOUNT_CEILING = 1e12;

/**
 * Account store: every quantity the runner touches lives in an account
 * (shuttle channels, card stores, cell buffers). Entries are round-stamped so
 * `lifetimeRounds` and `cap` apply uniformly to any `acrossRounds` account (D67).
 */
export class AccountStore {
  private readonly defs = new Map<AccountId, AccountDef>();
  private readonly states = new Map<AccountId, AccountState>();

  constructor(defs: AccountDef[], carried: AccountSnapshot, private readonly round: number) {
    for (const def of defs) {
      validateAccountDef(def);
      this.defs.set(def.id, def);
      const entries = def.persist === 'acrossRounds' && carried[def.id] ? cloneEntries(carried[def.id]) : [];
      this.states.set(def.id, { id: def.id, entries });
    }
  }

  has(id: AccountId): boolean {
    return this.defs.has(id);
  }

  def(id: AccountId): AccountDef {
    const d = this.defs.get(id);
    if (!d) throw new Error(`unknown account ${id}`);
    return d;
  }

  /** Sum of one channel (or the scalar key '$') across entries. */
  amount(id: AccountId, channel: string): number {
    const st = this.state(id);
    let sum = 0;
    for (const e of st.entries) sum += e.amounts[channel] ?? 0;
    return sum;
  }

  /** Sum of every channel. */
  total(id: AccountId): number {
    const st = this.state(id);
    let sum = 0;
    for (const e of st.entries) for (const v of Object.values(e.amounts)) sum += v;
    return sum;
  }

  byChannel(id: AccountId): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.state(id).entries) {
      for (const [k, v] of Object.entries(e.amounts)) out[k] = (out[k] ?? 0) + v;
    }
    return out;
  }

  channelIds(id: AccountId): string[] {
    return Object.keys(this.byChannel(id));
  }

  /**
   * Deposit into an account, honouring `cap`. Returns the amount actually
   * deposited (the remainder is dissipated or left for the caller per `onFull`).
   * No amount fails the run: a non-number deposits nothing, and every account
   * stops at ACCOUNT_CEILING the same way it stops at a full cap.
   */
  deposit(id: AccountId, channel: string, amount: number): { deposited: number; overflow: number } {
    if (!(amount > 0)) return { deposited: 0, overflow: 0 };
    const def = this.def(id);
    const incoming = Math.min(amount, ACCOUNT_CEILING);
    const limit = def.cap !== undefined && def.cap !== 'unbounded' ? Math.min(def.cap, ACCOUNT_CEILING) : ACCOUNT_CEILING;
    const allowed = Math.min(incoming, Math.max(0, limit - this.total(id)));
    if (allowed > 0) {
      const st = this.state(id);
      let entry = st.entries.find((e) => e.round === this.round);
      if (!entry) {
        entry = { round: this.round, amounts: {} };
        st.entries.push(entry);
      }
      entry.amounts[channel] = (entry.amounts[channel] ?? 0) + allowed;
      this.prune(st);
    }
    return { deposited: allowed, overflow: incoming - allowed };
  }

  /** Withdraw up to `amount` of a channel, oldest entries first. Returns the withdrawn amount. */
  withdraw(id: AccountId, channel: string, amount: number): number {
    if (!(amount > 0)) return 0;
    const st = this.state(id);
    let remaining = amount;
    for (const e of st.entries) {
      const have = e.amounts[channel] ?? 0;
      if (have <= 0) continue;
      const take = Math.min(have, remaining);
      e.amounts[channel] = have - take;
      remaining -= take;
      if (remaining <= 1e-12) break;
    }
    this.prune(st);
    return amount - remaining;
  }

  /** Drop floating-point dust and empty entries so repeated fractional operations stay clean. */
  private prune(st: AccountState): void {
    for (const e of st.entries) {
      for (const k of Object.keys(e.amounts)) if (Math.abs(e.amounts[k]) <= 1e-12) delete e.amounts[k];
    }
    st.entries = st.entries.filter((e) => Object.keys(e.amounts).length > 0);
  }

  /** Multiply one channel in place (scale). Returns before/after. */
  scale(id: AccountId, channel: string, factor: number): { before: number; after: number } {
    const before = this.amount(id, channel);
    const after = before * factor;
    const delta = after - before;
    if (delta > 0) this.deposit(id, channel, delta);
    else if (delta < 0) this.withdraw(id, channel, -delta);
    return { before, after: this.amount(id, channel) };
  }

  snapshotAcrossRounds(): AccountSnapshot {
    const out: AccountSnapshot = {};
    for (const [id, def] of this.defs) {
      if (def.persist !== 'acrossRounds') continue;
      out[id] = cloneEntries(this.state(id).entries);
    }
    return out;
  }

  summary(): Record<AccountId, { total: number; byChannel: Record<string, number> }> {
    const out: Record<AccountId, { total: number; byChannel: Record<string, number> }> = {};
    for (const id of this.defs.keys()) out[id] = { total: this.total(id), byChannel: this.byChannel(id) };
    return out;
  }

  private state(id: AccountId): AccountState {
    const st = this.states.get(id);
    if (!st) throw new Error(`unknown account ${id}`);
    return st;
  }
}

function validateAccountDef(def: AccountDef): void {
  if (def.persist === 'acrossRounds') {
    if (def.cap === undefined) throw new Error(`account ${def.id}: acrossRounds accounts must declare cap`);
    if (def.lifetimeRounds === undefined) {
      throw new Error(`account ${def.id}: acrossRounds accounts must declare lifetimeRounds`);
    }
  }
  if (def.encoding === 'scalar' && (!def.allowedIn || !def.allowedOut)) {
    throw new Error(`account ${def.id}: scalar accounts must authorise allowedIn / allowedOut channels`);
  }
}

/** Drop entries older than the account lifetime. Host calls this when a round advances. */
export function ageSnapshot(snapshot: AccountSnapshot, defs: AccountDef[], newRound: number): AccountSnapshot {
  const out: AccountSnapshot = {};
  const byId = new Map(defs.map((d) => [d.id, d] as const));
  for (const [id, entries] of Object.entries(snapshot)) {
    const def = byId.get(id);
    if (!def) continue;
    const life: Cap = def.lifetimeRounds ?? 'unbounded';
    out[id] = cloneEntries(
      life === 'unbounded' ? entries : entries.filter((e) => newRound - e.round < life),
    );
  }
  return out;
}

function cloneEntries(entries: AccountEntry[]): AccountEntry[] {
  return entries.map((e) => ({ round: e.round, amounts: { ...e.amounts } }));
}
