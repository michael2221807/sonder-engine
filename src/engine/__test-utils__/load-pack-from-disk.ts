/**
 * Loads a real Game Pack from `public/packs/<id>` with the real `GamePackLoader`.
 *
 * The loader reads its files through `fetch`; here `fetch` is stubbed (for the duration of the load only) to read
 * the same files from disk. Nothing in the pack is mocked or edited, so a test built on this sees the prompts, flows
 * and rules exactly as the browser receives them.
 *
 * Line endings: git stores the pack files with LF and a browser is served those bytes, but a Windows checkout with
 * `core.autocrlf` has CRLF on disk. CRLF is folded to LF on read so a request built from the pack is the same bytes
 * on every machine.
 *
 * Node-only (`node:fs`); never import this from code that ships.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GamePackLoader } from '../core/pack-loader';
import type { GamePack } from '../types';

const PACKS_ROOT = fileURLToPath(new URL('../../../public/packs', import.meta.url));
/** The URL prefix handed to the loader; the stub maps it onto PACKS_ROOT. */
const URL_BASE = '/packs';

export async function loadPackFromDisk(packId = 'tianming'): Promise<GamePack> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    if (!url.startsWith(`${URL_BASE}/`)) return new Response('', { status: 404 });
    try {
      const text = (await readFile(`${PACKS_ROOT}/${url.slice(URL_BASE.length + 1)}`, 'utf8')).replace(/\r\n/g, '\n');
      return new Response(text, { status: 200 });
    } catch {
      return new Response('', { status: 404 });
    }
  }) as typeof fetch;
  try {
    return await new GamePackLoader(URL_BASE).load(packId);
  } finally {
    globalThis.fetch = realFetch;
  }
}
