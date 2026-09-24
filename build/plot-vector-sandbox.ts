import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/** Self-contained source for an opaque-origin worker. */
export function plotVectorSandbox(): Plugin {
  const name = 'virtual:plot-vector-runtime';
  return {
    name: 'plot-vector-sandbox',
    resolveId(id) { if (id === name) return '\0' + name; },
    async load(id) {
      if (id !== '\0' + name) return;
      const result = await build({
        entryPoints: [fileURLToPath(new URL('../src/features/plot-vector/runtime.worker.ts', import.meta.url))],
        bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', metafile: true,
        alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
      });
      for (const input of Object.keys(result.metafile!.inputs)) this.addWatchFile(resolve(input));
      return `export default ${JSON.stringify(result.outputFiles[0].text)};`;
    },
  };
}
