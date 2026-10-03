/**
 * The opening keeps its own length (PO 2026-10-03, 3C). The narrative-only module it shares with split rounds states
 * no round length — a round's length comes from the length module (a target, PO 2B), which openings do not load — so
 * a player's setting can never contradict the opening's own 1200–2500 / 800–1500 in the same request.
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
const pack = (path: string) => readFileSync(resolve('public/packs/tianming', path), 'utf8');

async function openingVariables(prompt: Record<string, unknown>): Promise<Record<string, string>> {
  const state = new StateManager();
  state.loadTree({});
  state.set('系统.设置.prompt', prompt);
  const pipe = new CharacterInitPipeline(state, {} as never, {} as never, new ResponseParser(), {} as never, {} as never,
    {} as never, {} as never, { promptFlows: { openingSceneStep1: STEP1, openingSceneStep2: STEP2 } } as never, DEFAULT_ENGINE_PATHS);
  const internals = pipe as unknown as Internals;
  const split = vi.spyOn(internals, 'generateOpeningSceneSplit').mockResolvedValue('正文');
  await internals.generateOpeningScene({ attributes: {}, formValues: {}, selections: {} }, null, true);
  return split.mock.calls[0][0];
}

describe('the opening keeps its own length', () => {
  it('the narrative module it shares with rounds asks for no round length and leaves nothing unfilled', async () => {
    const variables = await openingVariables({ wordCountRequirement: 2500 });
    for (const [dir, rule] of [['prompts', '按本次请求给出的字数要求写'], ['prompts-en', 'follow the length requirement given in this request']]) {
      const text = new TemplateEngine().render(pack(`${dir}/splitGenStep1.md`), variables);
      expect(text).toContain(rule);
      expect(text).not.toMatch(/2500|500-1500|字以上|\{\{\w+\}\}/);
    }
  });
  it('the opening flows load no length module; their own prompts state the opening length', () => {
    for (const flow of ['opening-scene-step1.json', 'opening-enhanced-step1.json']) {
      const modules = (JSON.parse(pack(`prompt-flows/${flow}`)) as PromptFlowConfig).modules.map(m => m.promptId);
      expect(modules).not.toContain('wordCountReq');
    }
    expect(pack('prompts/opening.md')).toContain('1200-2500');
    expect(pack('prompts/openingEnhancedStep1.md')).toContain('800-1500');
  });
});
