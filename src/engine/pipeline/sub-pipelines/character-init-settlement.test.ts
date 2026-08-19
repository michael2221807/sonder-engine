import { describe, expect, it, vi } from 'vitest';
import { get as lodashGet } from 'lodash-es';
import { StateManager } from '@/engine/core/state-manager';
import { CommandExecutor } from '@/engine/core/command-executor';
import { ResponseParser } from '@/engine/ai/response-parser';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import type { GamePack } from '@/engine/types/game-pack';
import { CharacterInitPipeline } from './character-init';

describe('CharacterInitPipeline deterministic settlement', () => {
  it('reasserts local attributes after AI commands and onGameLoad before saving', async () => {
    const stateManager = new StateManager();
    const commandExecutor = new CommandExecutor(stateManager, null);
    const aiResponses = [
      'A generated world.',
      JSON.stringify({
        text: 'Opening scene.',
        commands: [{ action: 'set', path: '角色.属性.STR', value: 19 }],
        action_options: [],
      }),
    ];
    const aiService = { generate: vi.fn(async () => {
      expect(stateManager.get('角色.属性.STR')).toBe(7);
      return aiResponses.shift() ?? '';
    }) };
    const promptAssembler = { assemble: vi.fn(() => ({ messages: [], messageSources: [] })) };
    const saveManager = { saveGame: vi.fn(async () => undefined) };
    const profileManager = {
      createProfile: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
    };
    const behaviorRunner = {
      runOnCreation: vi.fn(),
      runOnGameLoad: vi.fn(() => stateManager.set('角色.属性.STR', 18, 'system')),
    };
    const gamePack = {
      manifest: { id: 'test', version: '1.0.0' },
      stateSchema: {
        type: 'object',
        properties: {
          角色: {
            type: 'object',
            properties: {
              属性: {
                type: 'object',
                properties: {
                  STR: { type: 'number', default: 5, minimum: 1, maximum: 20, 'x-display': 'stat-bar', 'x-max': 20 },
                },
              },
            },
          },
        },
      },
      creationFlow: {
        steps: [
          { id: 'origin', label: 'Origin', type: 'select-one', dataSource: 'presets.origins' },
          { id: 'attributes', label: 'Stats', type: 'attribute-allocation', attributes: ['STR'], statePath: '角色.身份.先天六维' },
        ],
      },
      promptFlows: {
        worldGeneration: { id: 'worldGeneration', modules: [] },
        openingScene: { id: 'openingScene', modules: [] },
      },
      prompts: {}, presets: {}, rules: {},
    } as unknown as GamePack;

    const pipeline = new CharacterInitPipeline(
      stateManager,
      commandExecutor,
      aiService as never,
      new ResponseParser(),
      promptAssembler as never,
      saveManager as never,
      profileManager as never,
      behaviorRunner as never,
      gamePack,
      DEFAULT_ENGINE_PATHS,
    );

    const result = await pipeline.execute({
      selections: { origin: { name: 'Runner', attribute_modifiers: { STR: 2 } } },
      attributes: { STR: 5 },
      formValues: { '角色.基础信息.姓名': 'Mira' },
    });

    expect(result.success).toBe(true);
    expect(stateManager.get('角色.属性.STR')).toBe(7);
    const saveCalls = saveManager.saveGame.mock.calls as unknown as unknown[][];
    const savedSnapshot = saveCalls[0]?.[2];
    expect(lodashGet(savedSnapshot, '角色.属性.STR')).toBe(7);
    expect(behaviorRunner.runOnGameLoad).toHaveBeenCalledOnce();
  });

  it('uses and restores the same local settlement on the enhanced-opening branch', async () => {
    const stateManager = new StateManager();
    const saveManager = { saveGame: vi.fn(async () => undefined) };
    const profileManager = {
      createProfile: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
    };
    const behaviorRunner = {
      runOnCreation: vi.fn(),
      runOnGameLoad: vi.fn(() => stateManager.set('角色.属性.STR', 18, 'system')),
    };
    const enhancedOpeningPipeline = {
      execute: vi.fn(async () => {
        expect(stateManager.get('角色.属性.STR')).toBe(7);
        stateManager.set('角色.属性.STR', 19, 'system');
        return { success: true };
      }),
    };
    const gamePack = {
      manifest: { id: 'test', version: '1.0.0' },
      stateSchema: {
        type: 'object',
        properties: {
          角色: {
            type: 'object',
            properties: {
              属性: {
                type: 'object',
                properties: {
                  STR: { type: 'number', default: 5, 'x-creation-min': 1, 'x-display': 'stat-bar', 'x-max': 20 },
                },
              },
            },
          },
        },
      },
      creationFlow: {
        steps: [
          { id: 'origin', label: 'Origin', type: 'select-one', dataSource: 'presets.origins' },
          { id: 'attributes', label: 'Stats', type: 'attribute-allocation', attributes: ['STR'], statePath: '角色.身份.先天六维' },
        ],
      },
      promptFlows: {}, prompts: {}, presets: {}, rules: {},
    } as unknown as GamePack;
    const pipeline = new CharacterInitPipeline(
      stateManager,
      new CommandExecutor(stateManager, null),
      { generate: vi.fn() } as never,
      new ResponseParser(),
      { assemble: vi.fn() } as never,
      saveManager as never,
      profileManager as never,
      behaviorRunner as never,
      gamePack,
      DEFAULT_ENGINE_PATHS,
      undefined,
      enhancedOpeningPipeline as never,
    );

    const result = await pipeline.execute({
      selections: { origin: { name: 'Runner', attribute_modifiers: { STR: 2 } } },
      attributes: { STR: 5 },
      formValues: { '角色.基础信息.姓名': 'Mira' },
    }, { enhancedOpening: true });

    expect(result.success).toBe(true);
    expect(enhancedOpeningPipeline.execute).toHaveBeenCalledOnce();
    expect(stateManager.get('角色.属性.STR')).toBe(7);
    const savedSnapshot = (saveManager.saveGame.mock.calls as unknown as unknown[][])[0]?.[2];
    expect(lodashGet(savedSnapshot, '角色.属性.STR')).toBe(7);
  });

  it('routes identity names and descriptions through the real production pipeline', async () => {
    const stateManager = new StateManager();
    const saveManager = { saveGame: vi.fn(async () => undefined) };
    const profileManager = {
      createProfile: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
    };
    const gamePack = {
      manifest: { id: 'test', version: '1.0.0' },
      stateSchema: {
        type: 'object',
        properties: {
          角色: {
            type: 'object',
            properties: {
              基础信息: {
                type: 'object',
                properties: {
                  姓名: { type: 'string', default: '' },
                  特质: { type: 'object', default: {} },
                },
              },
              身份: {
                type: 'object',
                properties: {
                  出身: { type: 'object', default: {} },
                  天赋档次: { type: 'string', default: '' },
                  天赋: { type: 'array', default: [] },
                },
              },
            },
          },
        },
      },
      creationFlow: {
        steps: [
          { id: 'tier', label: 'Tier', type: 'select-one', statePath: '角色.身份.天赋档次', valueField: 'name' },
          { id: 'origin', label: 'Origin', type: 'select-one', statePath: '角色.身份.出身', valueField: 'name', descriptionField: 'description', outputNameKey: '名称', outputDescKey: '描述' },
          { id: 'trait', label: 'Trait', type: 'select-one', statePath: '角色.基础信息.特质', valueField: 'name', descriptionField: 'description', outputNameKey: '名称', outputDescKey: '描述' },
          { id: 'talents', label: 'Talents', type: 'select-many', statePath: '角色.身份.天赋', valueField: 'name', descriptionField: 'description', outputNameKey: '名称', outputDescKey: '描述' },
        ],
      },
      promptFlows: {}, prompts: {}, presets: {}, rules: {},
    } as unknown as GamePack;
    const pipeline = new CharacterInitPipeline(
      stateManager,
      new CommandExecutor(stateManager, null),
      { generate: vi.fn() } as never,
      new ResponseParser(),
      { assemble: vi.fn() } as never,
      saveManager as never,
      profileManager as never,
      { runOnCreation: vi.fn(), runOnGameLoad: vi.fn() } as never,
      gamePack,
      DEFAULT_ENGINE_PATHS,
    );

    const result = await pipeline.execute({
      selections: {
        tier: { name: 'Twenty', total_points: 20 },
        origin: { name: 'Courier', description: 'Knows every road', talent_cost: 7, genres: ['modern'] },
        trait: { name: 'Calm', description: 'Keeps focus', talent_cost: 5, adultOnly: false },
        talents: [{ name: 'Alert', description: 'Notices danger', talent_cost: 3 }],
      },
      formValues: { '角色.基础信息.姓名': 'Mira' },
    });

    expect(result.success).toBe(true);
    expect(stateManager.get('角色.身份.天赋档次')).toBe('Twenty');
    expect(stateManager.get('角色.身份.出身')).toEqual({ 名称: 'Courier', 描述: 'Knows every road' });
    expect(stateManager.get('角色.基础信息.特质')).toEqual({ 名称: 'Calm', 描述: 'Keeps focus' });
    expect(stateManager.get('角色.身份.天赋')).toEqual([{ 名称: 'Alert', 描述: 'Notices danger' }]);
    const savedSnapshot = (saveManager.saveGame.mock.calls as unknown as unknown[][])[0]?.[2];
    expect(savedSnapshot).not.toHaveProperty('origin');
    expect(JSON.stringify(savedSnapshot)).not.toMatch(/talent_cost|genres|adultOnly|total_points/);
  });

  it('rejects an over-budget build before state, profile, AI, or save mutation', async () => {
    const stateManager = new StateManager();
    const aiService = { generate: vi.fn() };
    const saveManager = { saveGame: vi.fn() };
    const profileManager = { createProfile: vi.fn(), setActiveProfile: vi.fn() };
    const behaviorRunner = { runOnCreation: vi.fn(), runOnGameLoad: vi.fn() };
    const gamePack = {
      manifest: { id: 'test', version: '1.0.0' },
      stateSchema: { type: 'object', properties: {} },
      creationFlow: {
        steps: [
          { id: 'tier', label: 'Tier', type: 'select-one', required: true, affects: { points: '$.total' } },
          { id: 'origin', label: 'Origin', type: 'select-one', required: true, costField: 'cost', costSource: 'points' },
          { id: 'trait', label: 'Trait', type: 'select-one', required: true, costField: 'cost', costSource: 'points' },
          { id: 'talents', label: 'Talents', type: 'select-many', costField: 'cost', costSource: 'points' },
        ],
      },
      promptFlows: {}, prompts: {}, presets: {}, rules: {},
    } as unknown as GamePack;
    const pipeline = new CharacterInitPipeline(
      stateManager,
      new CommandExecutor(stateManager, null),
      aiService as never,
      new ResponseParser(),
      { assemble: vi.fn() } as never,
      saveManager as never,
      profileManager as never,
      behaviorRunner as never,
      gamePack,
      DEFAULT_ENGINE_PATHS,
    );

    const result = await pipeline.execute({
      selections: {
        tier: { total: 10 },
        origin: { cost: 7 },
        trait: { cost: 5 },
        talents: [],
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('budget:points:overspent');
    expect(stateManager.toSnapshot()).toEqual({});
    expect(aiService.generate).not.toHaveBeenCalled();
    expect(profileManager.createProfile).not.toHaveBeenCalled();
    expect(saveManager.saveGame).not.toHaveBeenCalled();
  });
});
