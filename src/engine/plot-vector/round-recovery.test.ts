import { expect, it } from 'vitest';
import { RoundRecovery } from './round-recovery';

it('regenerates the saved original input exactly once, then ordinary retries reuse the new request scope', () => {
  let n = 0; const r = new RoundRecovery(() => String(++n));
  const token = r.offer('原输入', 'slot/epoch', { round: 3 });
  const fresh = r.begin('caller cannot replace input', 'slot/epoch', { round: 3 }, token);
  expect(fresh).toEqual({ input: '原输入', attempt: '2' });
  expect(() => r.begin('', 'slot/epoch', { round: 3 }, token)).toThrow();
  r.offer(fresh.input, 'slot/epoch', { round: 3 }, fresh.attempt);
  expect(r.begin('原输入', 'slot/epoch', { round: 3 })).toEqual(fresh);
});
it('rejects stale tickets after state, slot or feature epoch changes', () => {
  const r = new RoundRecovery(() => 'token');
  const token = r.offer('input', 'slot/epoch', { round: 3 });
  expect(() => r.begin('input', 'other/epoch', { round: 3 }, token)).toThrow();
  expect(() => r.begin('input', 'slot/epoch', { round: 4 }, token)).toThrow();
  expect(r.begin('different input', 'slot/epoch', { round: 3 })).toEqual({ input: 'different input', attempt: undefined });
});
