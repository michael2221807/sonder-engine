import { executeVectorOperation, type VectorOperation } from './runtime';
import { hardenIntrinsics } from './realm-hardening';
const reply = globalThis.postMessage.bind(globalThis);
for (const key of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'indexedDB', 'caches', 'navigator', 'Worker', 'SharedWorker', 'BroadcastChannel', 'importScripts', 'postMessage']) {
  Object.defineProperty(globalThis, key, { value: undefined, writable: false, configurable: false });
}
globalThis.onmessage = async ({ data }: MessageEvent<{ id: string; op: VectorOperation }>) => {
  if (hardening.failed.length) { reply({ id: data.id, error: `能力隔离环境加固失败：${hardening.failed[0]}` }); return; }
  try { reply({ id: data.id, result: await executeVectorOperation(data.op) }); }
  catch (error) { reply({ id: data.id, error: error instanceof Error ? error.message : String(error) }); }
};
// Last step of the prelude: after this, no card code can rewrite Math/Object/Array/… or any
// prototype it can reach (see realm-hardening.ts); the message handler above is already installed.
const hardening = hardenIntrinsics(globalThis);
