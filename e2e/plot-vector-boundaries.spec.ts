import { test, expect, seedSave } from './fixtures/base';

test('UI stalls do not spend the Worker computation budget or lose an accepted result',
  {tag: ['@plot-vector', '@story-d152']}, async ({page}) => {
    await seedSave(page);
    const result = await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { VectorWorkerClient } = await load('/src/features/plot-vector/worker-client.ts');
      const { initialVectorState } = await load('/src/features/plot-vector/runtime.ts');
      const block = () => {
        // Representative 26 MB snapshot work, followed by deterministic UI
        // congestion longer than this test's 500ms calculation budget.
        const snapshot = { history: 'x'.repeat(26 * 1024 * 1024) };
        JSON.parse(JSON.stringify(snapshot));
        const until = performance.now() + 900;
        while (performance.now() < until) { /* deliberate main-thread load */ }
      };
      const client = new VectorWorkerClient(undefined, 500);
      const state = initialVectorState();
      const pending = client.execute({kind:'prepare', state, entries:[], id:'busy-save'});
      block(); // Before iframe ready; must not consume the execution deadline.
      const prepared = await pending;
      let runningBlocked = false;
      const onRunning = (event: MessageEvent) => {
        if (!event.data?.running || runningBlocked) return;
        runningBlocked = true; block(); // After dispatch; reply may already be queued.
      };
      window.addEventListener('message', onRunning);
      try {
        const accepted = await client.execute({kind:'accept', state, prepared});
        const twice = await client.execute({kind:'accept', state:accepted, prepared});
        return {runningBlocked, accepted:accepted.last?.id === 'busy-save', once:JSON.stringify(accepted) === JSON.stringify(twice)};
      } finally { window.removeEventListener('message', onRunning); client.cancelAll(); }
    });
    expect(result).toEqual({runningBlocked:true, accepted:true, once:true});
    await expect(page.locator('iframe[sandbox]')).toHaveCount(0);
  });

test('opaque Worker blocks storage and network without relying on global deletion', {tag: ['@plot-vector', '@story-d145']}, async ({page}) => {
  await seedSave(page);
  let requests = 0;
  await page.route('**/__sandbox_probe__', route => { requests++; return route.fulfill({body: 'unexpected'}); });
  const result = await page.evaluate(async () => {
    const path = '/src/features/plot-vector/worker-client.ts';
    const { VectorWorkerClient } = await import(/* @vite-ignore */ path);
    const probe = `onmessage = async ({data}) => {
      let storage = false, network = false;
      try { indexedDB.open('aga-saves'); storage = true; } catch {}
      try { await fetch(${JSON.stringify(location.origin + '/__sandbox_probe__')}); network = true; } catch {}
      postMessage({id: data.id, result: {storage, network, parentDOM: typeof document !== 'undefined'}});
    }`;
    return new VectorWorkerClient(probe).execute({});
  });
  expect(result).toEqual({storage: false, network: false, parentDOM: false});
  expect(requests).toBe(0);
  await expect(page.locator('iframe[sandbox]')).toHaveCount(0);
});

test('infinite Worker can be timed out and cancelled without leaving frames', {tag: ['@plot-vector', '@story-d145']}, async ({page}) => {
  await seedSave(page);
  const result = await page.evaluate(async () => {
    const path = '/src/features/plot-vector/worker-client.ts';
    const { VectorWorkerClient } = await import(/* @vite-ignore */ path);
    const spin = 'onmessage = () => { while (true) {} };';
    const timed = await new VectorWorkerClient(spin, 500).execute({}).catch((e: Error) => e.message);
    const worker = new VectorWorkerClient(spin);
    const pending = worker.execute({}).catch((e: Error) => e.message);
    worker.cancelAll();
    return {timed, cancelled: await pending};
  });
  expect(result.timed).toContain('超时'); expect(result.cancelled).toContain('取消');
  await expect(page.locator('iframe[sandbox]')).toHaveCount(0);
});
