/**
 * A feature task that is complete on its own (`standalone`) rides step 3 without the game state, memory or
 * recent narrative when nothing else needs repairing; with other tasks present, the request keeps its usual
 * context. Its reply field reaches `settle`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldRepairPipeline, type ExtraRepairTask } from './field-repair';
import { StateManager } from '../../core/state-manager';
import { CommandExecutor } from '../../core/command-executor';
import { ResponseParser } from '../../ai/response-parser';
import { DEFAULT_ENGINE_PATHS as P } from '../types';
import type { AIService } from '../../ai/ai-service';
import type { GenerateOptions } from '../../ai/types';
import type { GamePack } from '../../types';
import type { PromptAssembler } from '../../prompt/prompt-assembler';
import { ENGRAM_CONFIG_KEY } from '../../memory/engram/engram-config';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) });
});
afterEach(() => { vi.unstubAllGlobals(); });

function run(task: ExtraRepairTask, pendingEntity: boolean) {
  const state = new StateManager();
  state.loadTree({});
  state.set(P.narrativeHistory, [{ role: 'user', content: 'player-input' }, { role: 'assistant', content: 'story-text' }]);
  state.set('world.secret', 'state-value');
  if (pendingEntity) state.set(`${P.engramMemory}.entities`, [{ name: 'someone', _pendingEnrichment: true }]);
  if (pendingEntity) localStorage.setItem(ENGRAM_CONFIG_KEY, JSON.stringify({ knowledgeEdgeMode: 'active' }));
  const requests: GenerateOptions[] = [];
  const ai = { generate: async (o: GenerateOptions) => { requests.push(o); return JSON.stringify({ abilities: [{ id: 'x' }], entity_descriptions: [] }); } } as unknown as AIService;
  const pipeline = new FieldRepairPipeline(state, new CommandExecutor(state), ai, new ResponseParser(), {} as PromptAssembler, null,
    { rules: {}, promptFlows: {}, prompts: {} } as unknown as GamePack, P, async () => task);
  return { requests, result: pipeline.execute() };
}

describe('a standalone feature task in step 3', () => {
  it('alone: the request is just the task, and its reply field is settled', async () => {
    const settle = vi.fn(async () => true);
    const { requests, result } = run({ block: 'TASK-BLOCK', field: 'abilities', commands: false, standalone: true, settle }, false);
    expect((await result).extra).toEqual({ resolved: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].messages).toHaveLength(1);
    const only = String(requests[0].messages[0].content);
    expect(only).toContain('TASK-BLOCK');
    expect(only).not.toMatch(/state-value|story-text|player-input/);
    expect(settle).toHaveBeenCalledWith([{ id: 'x' }]);
  });
  it('without the flag, the same task still gets the usual context', async () => {
    const { requests, result } = run({ block: 'TASK-BLOCK', field: 'abilities', commands: false, settle: async () => true }, false);
    await result;
    expect(requests[0].messages.map(m => String(m.content)).join('\n')).toMatch(/state-value/);
  });
  it('with another task in the same request, the context stays', async () => {
    const { requests, result } = run({ block: 'TASK-BLOCK', field: 'abilities', commands: false, standalone: true, settle: async () => true }, true);
    await result;
    const all = requests[0].messages.map(m => String(m.content)).join('\n');
    expect(all).toContain('TASK-BLOCK');
    expect(all).toMatch(/state-value/);
  });
});
