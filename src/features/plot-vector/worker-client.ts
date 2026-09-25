import source from 'virtual:plot-vector-runtime';
import type { VectorOperation, VectorResult } from './runtime';
import { randomId } from '../../engine/plot-vector/feature-control';

/** Browser-enforced opaque origin and CSP; snippets never execute on the UI thread. */
export class VectorWorkerClient {
  private jobs = new Set<() => void>();
  constructor(private workerSource = source, private timeoutMs = 12000) {}
  execute<T extends VectorResult>(op: VectorOperation): Promise<T> {
    return new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('aria-hidden', 'true');
      const id = randomId(), nonce = randomId();
      let settled = false;
      const stop = (error?: Error, result?: T) => {
        if (settled) return;
        settled = true;
        clearInterval(startupTimer);
        frame.contentWindow?.postMessage({ id, cancel: true }, '*');
        frame.remove(); window.removeEventListener('message', receive); this.jobs.delete(cancel);
        if (error) reject(error); else resolve(result!);
      };
      const cancel = () => stop(new Error('剧情动能已关闭或计算取消'));
      let started = false;
      const receive = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow || event.data?.id !== id) return;
        const data = event.data;
        if (data.ready) {
          if (started) return;
          started = true;
          clearInterval(startupTimer);
          try { frame.contentWindow!.postMessage({ id, op }, '*'); }
          catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
        } else if (data.running) return;
        else if (data.error) stop(new Error(String(data.error)));
        else stop(undefined, data.result as T);
      };
      // Startup depends on the UI event loop. Charge only responsive polling
      // time, not a long synchronous save/history task that delayed both queues.
      let startupElapsed = 0, lastTick = performance.now();
      const startupTimer = setInterval(() => {
        const now = performance.now();
        startupElapsed += Math.min(now - lastTick, 250); lastTick = now;
        if (startupElapsed >= 12000) stop(new Error('能力隔离环境启动超时；保留上一步'));
      }, 250);
      this.jobs.add(cancel); window.addEventListener('message', receive);
      // Only trusted build output is embedded; card code travels via structured clone.
      // A trusted supervisor has its own event loop. Neither UI stalls nor an
      // infinite snippet can block its deadline. Only the child runs card code.
      const supervisor = `
        let child, timer, settled = false;
        const finish = data => {
          if (settled) return;
          settled = true; clearTimeout(timer); child?.terminate(); postMessage(data);
        };
        onmessage = event => {
          if (child || settled) return;
          try {
            const url = URL.createObjectURL(new Blob([${JSON.stringify(this.workerSource)}], {type:'text/javascript'}));
            child = new Worker(url); URL.revokeObjectURL(url);
            child.onmessage = e => finish(e.data);
            child.onerror = e => { e.preventDefault(); finish({error:'能力计算失败'}); };
            child.onmessageerror = () => finish({error:'能力计算结果无法读取'});
            timer = setTimeout(() => finish({error:'能力计算超时；保留上一步'}), ${this.timeoutMs});
            child.postMessage(event.data);
            postMessage({running:true});
          } catch { finish({error:'能力计算无法启动'}); }
        };
      `;
      const literal = JSON.stringify(supervisor).replace(/</g, '\\u003c');
      frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' 'unsafe-eval'; worker-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'"><script nonce="${nonce}">
        const id = ${JSON.stringify(id)};
        let worker;
        const reply = data => parent.postMessage({id, ...data}, '*');
        try {
          const url = URL.createObjectURL(new Blob([${literal}], {type:'text/javascript'}));
          worker = new Worker(url); URL.revokeObjectURL(url);
          worker.onmessage = event => { if (!event.data.running) worker.terminate(); reply(event.data); };
          worker.onerror = event => { event.preventDefault(); worker.terminate(); reply({error:'能力计算失败'}); };
          worker.onmessageerror = () => { worker.terminate(); reply({error:'能力计算结果无法读取'}); };
          let started = false;
          onmessage = event => {
            if (event.source !== parent || event.data?.id !== id) return;
            if (event.data.cancel) { worker.terminate(); return; }
            if (!started) { started = true; worker.postMessage(event.data); }
          };
          reply({ready:true});
        } catch { worker?.terminate(); reply({error:'能力隔离环境无法启动'}); }
      </script>`;
      try { document.body.appendChild(frame); }
      catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  cancelAll() { for (const cancel of [...this.jobs]) cancel(); }
}
