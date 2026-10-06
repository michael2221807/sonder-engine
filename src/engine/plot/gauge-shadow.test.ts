/**
 * Gauge shadows (PO 2026-10-05; docs/research/numeric-status-lines-2026-10-05.md §1.3): Step 2 wrote plot gauges as
 * commands to other places in the save (系统.人性锚点 26 while the gauge was 30 …) and the model read them back.
 * A round may no longer write one, and the ones a save already holds are never shown to the model; the save keeps
 * them. A declared field that shares a gauge's name is left alone.
 */
import { describe, it, expect, vi } from 'vitest';
import { plotGaugeNames, isGaugeShadowPath, findGaugeShadowPaths, withoutStatePaths } from './gauge-shadow';
import { StateManager } from '../core/state-manager';
import { CommandExecutor, schemaDeclaresPath } from '../core/command-executor';
import { CommandExecutionStage } from '../pipeline/stages/command-execution';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import type { IBehaviorRunner, PipelineContext } from '../pipeline/types';
import type { Command } from '../types';

const PLOT = DEFAULT_ENGINE_PATHS.plotDirection;

/** A schema in the pack's shape: 系统 and 角色.身体 declare a few fields; NPCs declare 好感度. */
const SCHEMA = {
  type: 'object',
  properties: {
    系统: { type: 'object', properties: { nsfwMode: { type: 'boolean' }, 设置: { type: 'object' } } },
    角色: { type: 'object', properties: { 身体: { type: 'object', properties: { 身高: { type: 'string' } } } } },
    社交: { type: 'object', properties: { 关系: { type: 'array', items: { type: 'object', properties: { 名称: { type: 'string' }, 好感度: { type: 'number' } } } } } },
    元数据: { type: 'object', properties: { 剧情导向: { type: 'object' } } },
  },
};
const declares = (path: string): boolean => schemaDeclaresPath(SCHEMA, path);

function gauge(name: string, current: number) {
  return { id: name, name, description: '', min: 0, max: 100, current, initialValue: 0, unit: '', showInMainPanel: true, aiUpdatable: true };
}

function tree(): Record<string, unknown> {
  return {
    元数据: { 剧情导向: { activeArcIndex: 0, arcs: [
      { id: 'a', title: '主线', status: 'active', gauges: [gauge('人性锚点', 30), gauge('好感度', 10)], nodes: [] },
      { id: 'b', title: '旧线', status: 'completed', gauges: [gauge('档案评级热度', 312)], nodes: [] },
    ] } },
    系统: { nsfwMode: false, 人性锚点: 26, 档案评级热度: 315, 设置: { 人性锚点: 1 } },
    角色: { 身体: { 身高: '170', 人性锚点: 25 } },
    社交: { 关系: [{ 名称: '林月', 好感度: 40, 人性锚点: 3 }] },
    人性锚点: 0,
  };
}

describe('gauge shadows', () => {
  it('names every gauge of every thread', () => {
    const sm = new StateManager();
    sm.loadTree(tree());
    expect([...plotGaugeNames(sm, PLOT)].sort()).toEqual(['人性锚点', '好感度', '档案评级热度'].sort());
  });

  it('a write is a shadow when its last field is a gauge name the schema does not declare there', () => {
    const names = new Set(['人性锚点', '好感度']);
    expect(isGaugeShadowPath('系统.人性锚点', names, declares, PLOT)).toBe(true);
    expect(isGaugeShadowPath('人性锚点', names, declares, PLOT)).toBe(true);
    expect(isGaugeShadowPath('角色.身体.人性锚点', names, declares, PLOT)).toBe(true);
    // A declared field that shares a gauge's name is a real field.
    expect(isGaugeShadowPath('社交.关系[名称=林月].好感度', names, declares, PLOT)).toBe(false);
    // The plot state itself, and fields that are no gauge, are not shadows.
    expect(isGaugeShadowPath(`${PLOT}.arcs[0].gauges[0].current`, names, declares, PLOT)).toBe(false);
    expect(isGaugeShadowPath('角色.身体.身高', names, declares, PLOT)).toBe(false);
    expect(isGaugeShadowPath('系统.人性锚点', new Set(), declares, PLOT)).toBe(false);
  });

  it('finds the shadows a save holds in objects, not in lists, not in the plot state, not declared fields', () => {
    const names = new Set(['人性锚点', '好感度', '档案评级热度']);
    expect(findGaugeShadowPaths(tree(), names, declares, PLOT).sort()).toEqual(
      ['人性锚点', '系统.人性锚点', '系统.档案评级热度', '系统.设置.人性锚点', '角色.身体.人性锚点'].sort());
  });

  it('leaves the shadows under a value out of a copy; the value itself is untouched', () => {
    const body = { 身高: '170', 人性锚点: 25 };
    expect(withoutStatePaths(body, '角色.身体', ['角色.身体.人性锚点', '系统.人性锚点'])).toEqual({ 身高: '170' });
    expect(body).toEqual({ 身高: '170', 人性锚点: 25 });
    expect(withoutStatePaths(body, '角色.身体', ['系统.人性锚点'])).toBe(body);
  });
});

describe('CommandExecutionStage · a gauge changes only through gauge_updates', () => {
  async function run(commands: Command[], withSchema = true) {
    const sm = new StateManager();
    sm.loadTree(tree());
    const executor = new CommandExecutor(sm, ['元数据', '系统', '角色', '社交'], undefined, undefined, undefined,
      withSchema ? declares : undefined);
    const behaviorRunner = { runAfterCommands: vi.fn() } as unknown as IBehaviorRunner;
    const stage = new CommandExecutionStage(executor, behaviorRunner, sm, DEFAULT_ENGINE_PATHS);
    const out = await stage.execute({ parsedResponse: { commands }, meta: {} } as unknown as PipelineContext);
    return { sm, results: out.commandResults?.results ?? [] };
  }

  it('refuses gauge writes outside the plot state; a declared field of the same name and the rest apply', async () => {
    const { sm, results } = await run([
      { action: 'set', key: '系统.人性锚点', value: 31 },
      { action: 'set', key: '角色.身体.人性锚点', value: 31 },
      { action: 'set', key: '人性锚点', value: 31 },
      { action: 'add', key: '社交.关系[名称=林月].好感度', value: 5 },
      { action: 'set', key: '角色.身体.身高', value: '171' },
    ]);
    expect(results.filter((r) => !r.success).map((r) => r.command.key)).toEqual(['系统.人性锚点', '角色.身体.人性锚点', '人性锚点']);
    expect(results.find((r) => !r.success)?.error).toContain('gauge_updates');
    expect(sm.get('系统.人性锚点')).toBe(26);
    expect(sm.get('角色.身体.人性锚点')).toBe(25);
    expect(sm.get('社交.关系[名称=林月].好感度')).toBe(45);
    expect(sm.get('角色.身体.身高')).toBe('171');
  });

  it('without the pack schema nothing is refused (a real field could not be told apart)', async () => {
    const { results } = await run([{ action: 'set', key: '系统.人性锚点', value: 31 }], false);
    expect(results.every((r) => r.success)).toBe(true);
  });
});
