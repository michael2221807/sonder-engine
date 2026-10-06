import { describe, it, expect, vi } from 'vitest';
import { BehaviorRunner } from './behavior-runner';
import type { BehaviorModule } from './types';
import type { ChangeLog } from '../types';

describe('BehaviorRunner', () => {
  const emptyCL: ChangeLog = { changes: [], source: 'command', timestamp: 0 };

  function makeMockModule(id: string, hooks: Partial<BehaviorModule> = {}): BehaviorModule {
    return { id, ...hooks };
  }

  describe('register / unregister', () => {
    it('registers a module', () => {
      const runner = new BehaviorRunner();
      runner.register(makeMockModule('test'));
      expect(runner.getModules()).toHaveLength(1);
    });

    it('skips duplicate registration', () => {
      const runner = new BehaviorRunner();
      runner.register(makeMockModule('test'));
      runner.register(makeMockModule('test'));
      expect(runner.getModules()).toHaveLength(1);
    });

    it('unregisters by id', () => {
      const runner = new BehaviorRunner();
      runner.register(makeMockModule('a'));
      runner.register(makeMockModule('b'));
      runner.unregister('a');
      expect(runner.getModules()).toHaveLength(1);
      expect(runner.getModules()[0].id).toBe('b');
    });

    it('unregister for nonexistent id is a no-op', () => {
      const runner = new BehaviorRunner();
      runner.register(makeMockModule('a'));
      runner.unregister('nonexistent');
      expect(runner.getModules()).toHaveLength(1);
    });
  });

  describe('clear', () => {
    it('removes all modules', () => {
      const runner = new BehaviorRunner();
      runner.register(makeMockModule('a'));
      runner.register(makeMockModule('b'));
      runner.clear();
      expect(runner.getModules()).toHaveLength(0);
    });
  });

  describe('hook dispatch', () => {
    it('calls afterCommands on all modules in order', () => {
      const runner = new BehaviorRunner();
      const order: string[] = [];
      runner.register(makeMockModule('a', {
        afterCommands: () => { order.push('a'); },
      }));
      runner.register(makeMockModule('b', {
        afterCommands: () => { order.push('b'); },
      }));
      runner.runAfterCommands(null as never, emptyCL);
      expect(order).toEqual(['a', 'b']);
    });

    it('calls onRoundEnd on all modules', () => {
      const runner = new BehaviorRunner();
      const fn = vi.fn();
      runner.register(makeMockModule('a', { onRoundEnd: fn }));
      runner.runOnRoundEnd(null as never);
      expect(fn).toHaveBeenCalledOnce();
    });

    it('calls onGameLoad on all modules', () => {
      const runner = new BehaviorRunner();
      const fn = vi.fn();
      runner.register(makeMockModule('a', { onGameLoad: fn }));
      runner.runOnGameLoad(null as never);
      expect(fn).toHaveBeenCalledOnce();
    });

    it('calls onCreation on all modules', () => {
      const runner = new BehaviorRunner();
      const fn = vi.fn();
      runner.register(makeMockModule('a', { onCreation: fn }));
      runner.runOnCreation(null as never);
      expect(fn).toHaveBeenCalledOnce();
    });

    it('calls onContextAssembly with variables object', () => {
      const runner = new BehaviorRunner();
      const vars: Record<string, string> = {};
      runner.register(makeMockModule('a', {
        onContextAssembly: (_sm, v) => { v['test'] = 'value'; },
      }));
      runner.runOnContextAssembly(null as never, vars);
      expect(vars).toHaveProperty('test', 'value');
    });

    it('skips modules that do not implement the hook', () => {
      const runner = new BehaviorRunner();
      const fn = vi.fn();
      runner.register(makeMockModule('no-hook'));
      runner.register(makeMockModule('has-hook', { onRoundEnd: fn }));
      runner.runOnRoundEnd(null as never);
      expect(fn).toHaveBeenCalledOnce();
    });
  });

  describe('error isolation', () => {
    it('continues dispatching after a module throws', () => {
      const runner = new BehaviorRunner();
      const fn = vi.fn();
      runner.register(makeMockModule('thrower', {
        onRoundEnd: () => { throw new Error('boom'); },
      }));
      runner.register(makeMockModule('survivor', { onRoundEnd: fn }));
      runner.runOnRoundEnd(null as never);
      expect(fn).toHaveBeenCalledOnce();
    });

    it('error in afterCommands does not block other modules', () => {
      const runner = new BehaviorRunner();
      const fn = vi.fn();
      runner.register(makeMockModule('bad', {
        afterCommands: () => { throw new Error('fail'); },
      }));
      runner.register(makeMockModule('good', { afterCommands: fn }));
      runner.runAfterCommands(null as never, emptyCL);
      expect(fn).toHaveBeenCalledOnce();
    });
  });
});
