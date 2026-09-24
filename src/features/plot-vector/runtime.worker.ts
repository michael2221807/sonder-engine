import { executeVectorOperation, type VectorOperation } from './runtime';
const reply = globalThis.postMessage.bind(globalThis);
for (const key of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'indexedDB', 'caches', 'navigator', 'Worker', 'SharedWorker', 'BroadcastChannel', 'importScripts', 'postMessage']) {
  Object.defineProperty(globalThis, key, { value: undefined, writable: false, configurable: false });
}
globalThis.onmessage = async ({ data }: MessageEvent<{ id: string; op: VectorOperation }>) => {
  try { reply({ id: data.id, result: await executeVectorOperation(data.op) }); }
  catch (error) { reply({ id: data.id, error: error instanceof Error ? error.message : String(error) }); }
};
