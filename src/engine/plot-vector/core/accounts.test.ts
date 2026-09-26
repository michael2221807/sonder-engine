import { describe, expect, it } from 'vitest';
import { ACCOUNT_CEILING, AccountStore } from './accounts';
import type { AccountDef } from './types';

const shuttle: AccountDef = { id: 'shuttle', owner: { kind: 'shuttle', id: 'shuttle' }, encoding: 'channelVector', persist: 'run' };
const store: AccountDef = { id: 'store', owner: { kind: 'card', id: 'c' }, encoding: 'channelVector', persist: 'acrossRounds', cap: 40, lifetimeRounds: 2 };
const fresh = () => new AccountStore([shuttle, store], {}, 1);

describe('account amounts never fail a run (rebuild plan §7: overflow is clamped)', () => {
  it('a non-number deposits or withdraws nothing', () => {
    const a = fresh();
    a.deposit('shuttle', 'S+', 5);
    expect(a.deposit('shuttle', 'S+', Number.NaN)).toEqual({ deposited: 0, overflow: 0 });
    expect(a.withdraw('shuttle', 'S+', Number.NaN)).toBe(0);
    expect(a.amount('shuttle', 'S+')).toBe(5);
  });

  it('an infinite or huge deposit stops at the ceiling and reports a finite overflow', () => {
    const a = fresh();
    a.deposit('shuttle', 'S+', 10);
    const result = a.deposit('shuttle', 'S+', Number.POSITIVE_INFINITY);
    expect(result.deposited).toBe(ACCOUNT_CEILING - 10);
    expect(Number.isFinite(result.overflow)).toBe(true);
    expect(a.total('shuttle')).toBe(ACCOUNT_CEILING);
    expect(a.deposit('shuttle', 'J', 1e300)).toEqual({ deposited: 0, overflow: ACCOUNT_CEILING });
    expect(a.total('shuttle')).toBe(ACCOUNT_CEILING);
  });

  it('repeated scaling saturates instead of reaching Infinity', () => {
    const a = fresh();
    a.deposit('shuttle', 'S+', 3);
    for (let i = 0; i < 400; i++) a.scale('shuttle', 'S+', 8);
    expect(a.amount('shuttle', 'S+')).toBe(ACCOUNT_CEILING);
    expect(Number.isFinite(a.total('shuttle'))).toBe(true);
  });

  it('a declared cap below the ceiling still applies', () => {
    const a = fresh();
    expect(a.deposit('store', 'S+', Number.POSITIVE_INFINITY)).toEqual({ deposited: 40, overflow: ACCOUNT_CEILING - 40 });
    expect(a.total('store')).toBe(40);
  });
});
