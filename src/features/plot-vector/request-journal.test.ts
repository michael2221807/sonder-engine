import { describe, expect, it, vi } from 'vitest';
import { RequestJournal, type RequestStore } from './request-journal';
import type { APIConfig } from '../../engine/ai/types';

class MemoryRequests implements RequestStore {
  rows = new Map<string, {fingerprint: string; owner: string; raw?: string}>();
  async claim(key: string, fingerprint: string, owner: string, guard: () => void) {
    guard(); const old = this.rows.get(key);
    if (!old) this.rows.set(key, { fingerprint, owner });
    return old;
  }
  async complete(key: string, owner: string, raw: string, guard: () => void) {
    guard(); const old = this.rows.get(key)!;
    if (old.owner !== owner) throw new Error('owner');
    this.rows.set(key, { ...old, raw });
  }
}
const config: APIConfig = {id: 'test', name: 'test', apiCategory: 'llm', provider: 'openai',
  url: 'https://test.invalid', apiKey: 'secret', model: 'test', temperature: 0.7, maxTokens: 100, enabled: true};
const request = {config, messages: [{role: 'user' as const, content: 'private prompt'}], stream: false};

describe('paid request recovery', () => {
  it('replays even an unsuccessful repair reply without another paid send', async () => {
    const store = new MemoryRequests(), send = vi.fn(async () => 'still malformed');
    const checkpoint = () => new RequestJournal(store).checkpoint({ round: 8, step: 'repair' }, {}, () => {}, () => {});
    expect(await checkpoint().run(request, send)).toBe('still malformed');
    expect(await checkpoint().run(request, send)).toBe('still malformed');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('reuses a completed Step1 across journal instances and sends Step2 independently', async () => {
    const store = new MemoryRequests(), send = vi.fn(async () => 'story'), reused = vi.fn();
    const checkpoint = (step: string) => new RequestJournal(store).checkpoint(step, {}, () => {}, reused);
    expect(await checkpoint('step1').run(request, send)).toBe('story');
    expect(await checkpoint('step1').run(request, send)).toBe('story');
    await checkpoint('step2').run(request, send);
    expect(send).toHaveBeenCalledTimes(2); expect(reused).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...store.rows])).not.toMatch(/secret|private prompt/);
  });
  it('allows only one claimant during concurrent requests', async () => {
    const checkpoint = new RequestJournal(new MemoryRequests()).checkpoint('same', {}, () => {}, () => {});
    let release!: (s: string) => void;
    const send = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    const first = checkpoint.run(request, send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await expect(checkpoint.run(request, send)).rejects.toThrow('尚不明确');
    release('done'); await first;
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not repeat an unknown outcome', async () => {
    const cp = new RequestJournal(new MemoryRequests()).checkpoint('one', {}, () => {}, () => {});
    const send = vi.fn(async () => { throw new Error('transport'); });
    await expect(cp.run(request, send)).rejects.toThrow('transport');
    await expect(cp.run(request, send)).rejects.toThrow('尚不明确');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('refuses changed configuration or baseline under the same scope', async () => {
    const journal = new RequestJournal(new MemoryRequests()), send = vi.fn(async () => 'ok');
    const cp = (baseline: unknown) => journal.checkpoint('one', baseline, () => {}, () => {});
    await cp({}).run(request, send);
    await expect(cp({}).run({...request, config: {...config, model: 'other'}}, send)).rejects.toThrow('不同');
    await expect(cp({changed: true}).run(request, send)).rejects.toThrow('不同');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not send when claiming fails, or persist after cancellation', async () => {
    const store = new MemoryRequests(), journal = new RequestJournal(store), send = vi.fn(async () => 'ok');
    const claim = vi.spyOn(store, 'claim').mockRejectedValueOnce(new Error('disk'));
    await expect(journal.checkpoint('one', {}, () => {}, () => {}).run(request, send)).rejects.toThrow('disk');
    expect(send).not.toHaveBeenCalled(); claim.mockRestore();
    let active = true;
    const cp = journal.checkpoint('one', {}, () => { if (!active) throw new Error('cancel'); }, () => {});
    await expect(cp.run(request, async () => {active = false; return 'late';})).rejects.toThrow('cancel');
    expect([...store.rows.values()][0].raw).toBeUndefined();
  });
  it('keeps unknown state if storing the completed reply fails', async () => {
    const store = new MemoryRequests(), send = vi.fn(async () => 'ok');
    vi.spyOn(store, 'complete').mockRejectedValue(new Error('disk'));
    const cp = new RequestJournal(store).checkpoint('one', {}, () => {}, () => {});
    await expect(cp.run(request, send)).rejects.toThrow('disk');
    await expect(cp.run(request, send)).rejects.toThrow('尚不明确');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
