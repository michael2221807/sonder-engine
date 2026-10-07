/**
 * Pack contract: the tianming pack and the code that reads it must agree on names.
 *
 * Guards against the drift class found by the 2026-10 code-health audit (X02-003):
 * a flow the code asks for that the manifest does not register, a prompt id a flow
 * names that has no file, a rules file the manifest lists that is missing. It checks
 * consistency only and changes no behaviour; known pre-existing gaps are listed in
 * KNOWN_MISSING_FLOWS so the test pins them instead of failing on them.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packRoot = 'public/packs/tianming';

interface FlowModule {
  promptId: string;
}
interface FlowFile {
  id?: string;
  modules?: FlowModule[];
}
interface Manifest {
  promptFlows: Record<string, string>;
  prompts: string[];
  promptSplits?: Array<{ from: string; to: string }>;
  rules?: Record<string, string>;
}

/**
 * Flows production code looks up that the manifest does not register. Each entry is a
 * behaviour question parked on the audit's side list, not something this test fixes.
 * - npcGeneration: the NPC-generation sub-pipeline returns early because the flow is
 *   absent (audit E03-007, side-list).
 */
const KNOWN_MISSING_FLOWS = new Set(['npcGeneration']);

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(packRoot, relativePath), 'utf8')) as T;
}

/** Flow ids production code reads through `promptFlows['x']` or `promptFlows.x`. */
function flowIdsUsedByCode(): Set<string> {
  const ids = new Set<string>();
  const pattern = /promptFlows(?:\.([A-Za-z]\w*)|\[\s*['"]([A-Za-z]\w*)['"]\s*\])/g;
  const files = readdirSync('src', { recursive: true, encoding: 'utf8' }).filter(
    (f) => /\.(ts|vue)$/.test(f) && !/\.(test|spec)\.ts$/.test(f),
  );
  for (const file of files) {
    const text = readFileSync(join('src', file), 'utf8');
    for (const match of text.matchAll(pattern)) ids.add(match[1] ?? match[2]);
  }
  return ids;
}

describe('Tianming pack contract', () => {
  const manifest = readJson<Manifest>('manifest.json');
  const promptIds = new Set(manifest.prompts);

  it('has a prompt file for every prompt the manifest registers', () => {
    const missing = manifest.prompts.filter((id) => !existsSync(join(packRoot, 'prompts', `${id}.md`)));
    expect(missing).toEqual([]);
  });

  it('has every registered flow file, and each flow carries its own id', () => {
    for (const [flowId, file] of Object.entries(manifest.promptFlows)) {
      expect(existsSync(join(packRoot, file)), `flow file for ${flowId}`).toBe(true);
      const flow = readJson<FlowFile>(file);
      expect(flow.id, `id inside ${file}`).toBe(flowId);
    }
  });

  it('only names prompts in its flows that the manifest registers', () => {
    const unknown: string[] = [];
    for (const [flowId, file] of Object.entries(manifest.promptFlows)) {
      for (const mod of readJson<FlowFile>(file).modules ?? []) {
        if (!promptIds.has(mod.promptId)) unknown.push(`${flowId} → ${mod.promptId}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('registers every flow production code looks up (known gaps pinned)', () => {
    const used = flowIdsUsedByCode();
    const missing = [...used].filter((id) => !(id in manifest.promptFlows)).sort();
    expect(missing).toEqual([...KNOWN_MISSING_FLOWS].sort());
  });

  it('has every rules file and prompt split the manifest lists', () => {
    for (const [name, file] of Object.entries(manifest.rules ?? {})) {
      expect(existsSync(join(packRoot, file)), `rules file ${name}`).toBe(true);
    }
    for (const split of manifest.promptSplits ?? []) {
      expect(promptIds.has(split.from), `split source ${split.from}`).toBe(true);
      expect(promptIds.has(split.to), `split target ${split.to}`).toBe(true);
    }
  });
});
