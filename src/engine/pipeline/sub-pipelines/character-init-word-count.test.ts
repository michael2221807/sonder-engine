/**
 * The opening narrative states the player's word-count setting, as every round does (PO 2026-10-03: a setting of
 * 2500 must not be contradicted by a hard-coded "500-1500" in the narrative module).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../creation/creation-prompt-formatter', () => ({ formatCreationPromptContext: () => '' }));

import { CharacterInitPipeline } from './character-init';
import { StateManager } from '../../core/state-manager';
import { ResponseParser } from '../../ai/response-parser';
import { TemplateEngine } from '../../prompt/template-engine';
import { DEFAULT_ENGINE_PATHS } from '../types';
import type { PromptFlowConfig } from '../../types';

const STEP1: PromptFlowConfig = { id: 'openingSceneStep1', modules: [] };
const STEP2: PromptFlowConfig = { id: 'openingSceneStep2', modules: [] };
type Internals = {
  generateOpeningScene: (choices: unknown, world: string | null, split: boolean) => Promise<string | null>;
  generateOpeningSceneSplit: (variables: Record<string, string>, f1: PromptFlowConfig, f2: PromptFlowConfig) => Promise<string | null>;
};

async function openingVariables(prompt: Record<string, unknown> | undefined): Promise<Record<string, string>> {
  const state = new StateManager();
  state.loadTree({});
  if (prompt) state.set('系统.设置.prompt', prompt);
  const pipe = new CharacterInitPipeline(state, {} as never, {} as never, new ResponseParser(), {} as never, {} as never,
    {} as never, {} as never, { promptFlows: { openingSceneStep1: STEP1, openingSceneStep2: STEP2 } } as never, DEFAULT_ENGINE_PATHS);
  const internals = pipe as unknown as Internals;
  const split = vi.spyOn(internals, 'generateOpeningSceneSplit').mockResolvedValue('正文');
  await internals.generateOpeningScene({ attributes: {}, formValues: {}, selections: {} }, null, true);
  return split.mock.calls[0][0];
}

describe('the opening states the word-count setting', () => {
  it('passes the setting (or its default) to the narrative step', async () => {
    expect((await openingVariables({ wordCountRequirement: 2500 })).wordCount).toBe('2500');
    expect((await openingVariables(undefined)).wordCount).toBe('650');
  });
  it('the real narrative module then asks for that length, with nothing left unfilled', async () => {
    const variables = await openingVariables({ wordCountRequirement: 2500 });
    for (const dir of ['prompts', 'prompts-en']) {
      const text = new TemplateEngine().render(readFileSync(resolve('public/packs/tianming', dir, 'splitGenStep1.md'), 'utf8'), variables);
      expect(text).toContain('2500');
      expect(text).not.toMatch(/500-1500|\{\{wordCount\}\}/);
    }
  });
});
