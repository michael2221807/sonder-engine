import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isProxy, toRaw } from 'vue';

// Mock eventBus to isolate from real singleton
vi.mock('@/engine/core/event-bus', () => {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    eventBus: {
      emit: (event: string, payload?: unknown) => emitted.push({ event, payload }),
      on: () => () => {},
      _emitted: emitted,
      _clear: () => { emitted.length = 0; },
    },
  };
});

const { StateManager } = await import('@/engine/core/state-manager');
const { eventBus } = await import('@/engine/core/event-bus');

function clearEmitted() {
  (eventBus as unknown as { _clear: () => void })._clear();
}
function getEmitted() {
  return (eventBus as unknown as { _emitted: Array<{ event: string }> })._emitted;
}

describe('StateManager', () => {
  let sm: InstanceType<typeof StateManager>;

  beforeEach(() => {
    sm = new StateManager();
    clearEmitted();
  });

  describe('basic CRUD', () => {
    it('set then get round-trips', () => {
      sm.set('a.b', 42, 'system');
      expect(sm.get<number>('a.b')).toBe(42);
    });

    it('creates nested paths on set', () => {
      sm.set('角色.属性.体力.当前', 100, 'system');
      expect(sm.get('角色.属性.体力.当前')).toBe(100);
    });

    it('get returns undefined for missing path', () => {
      expect(sm.get('nonexistent.path')).toBeUndefined();
    });

    it('has returns true for existing path', () => {
      sm.set('x', 1, 'system');
      expect(sm.has('x')).toBe(true);
    });

    it('has returns false for missing path', () => {
      expect(sm.has('missing')).toBe(false);
    });

    it('delete removes value', () => {
      sm.set('a.b', 1, 'system');
      sm.delete('a.b', 'system');
      expect(sm.has('a.b')).toBe(false);
    });

    it('add increments number', () => {
      sm.set('count', 10, 'system');
      sm.add('count', 5, 'system');
      expect(sm.get('count')).toBe(15);
    });

    it('add to missing path treats as 0 + value', () => {
      sm.add('new.count', 7, 'system');
      expect(sm.get('new.count')).toBe(7);
    });

    it('push to existing array appends', () => {
      sm.set('arr', [1, 2], 'system');
      sm.push('arr', 3, 'system');
      expect(sm.get('arr')).toEqual([1, 2, 3]);
    });

    it('push to non-existent path creates array', () => {
      sm.push('new.arr', 'item', 'system');
      expect(sm.get('new.arr')).toEqual(['item']);
    });

    it('pull removes matching primitive', () => {
      sm.set('arr', ['a', 'b', 'c'], 'system');
      sm.pull('arr', 'b', 'system');
      expect(sm.get('arr')).toEqual(['a', 'c']);
    });
  });

  describe('filter path syntax', () => {
    beforeEach(() => {
      sm.loadTree({
        社交: {
          关系: [
            { 名称: '张三', 好感度: 50 },
            { 名称: '李四', 好感度: 70 },
            { 名称: '王五', 好感度: 30 },
          ],
        },
      });
      clearEmitted();
    });

    it('resolves filter path for get', () => {
      expect(sm.get('社交.关系[名称=李四].好感度')).toBe(70);
    });

    it('resolves filter path for set', () => {
      sm.set('社交.关系[名称=张三].好感度', 80, 'command');
      expect(sm.get('社交.关系[名称=张三].好感度')).toBe(80);
    });

    it('returns undefined for non-matching filter', () => {
      expect(sm.get('社交.关系[名称=不存在].好感度')).toBeUndefined();
    });

    it('handles regular dot-path without filter (fast path)', () => {
      expect(sm.get('社交.关系')).toHaveLength(3);
    });

    it('set with non-matching filter does NOT create zombie field', () => {
      sm.set('社交.关系[名称=不存在].好感度', 99, 'command');
      // Should be a no-op — no zombie key created
      const rel = sm.get<Array<Record<string, unknown>>>('社交.关系')!;
      expect(rel).toHaveLength(3); // unchanged
      expect(rel.every((r) => r['好感度'] !== 99 || r['名称'] === '不存在')).toBe(true);
    });
  });

  describe('bulk operations', () => {
    it('loadTree replaces state', () => {
      sm.set('old', 1, 'system');
      sm.loadTree({ new: 2 } as never);
      expect(sm.get('old')).toBeUndefined();
      expect(sm.get('new')).toBe(2);
    });

    it('toSnapshot returns deep clone', () => {
      sm.set('a.b', [1, 2], 'system');
      const snap = sm.toSnapshot();
      (snap as Record<string, unknown>)['a'] = 'modified';
      expect(sm.get('a.b')).toEqual([1, 2]); // original unchanged
    });

    it('snapshotWith replaces one path and shares every other branch, leaving the live tree untouched', () => {
      sm.set('big.list', [1, 2, 3], 'system');
      sm.set('sys.ext.board', { layout: 'old' }, 'system');
      sm.set('sys.ext.other', { keep: true }, 'system');
      sm.set('sys.top', 'x', 'system');
      const out = sm.snapshotWith('sys.ext.board', { layout: 'new' }) as Record<string, Record<string, Record<string, unknown>>>;
      expect(out.sys.ext.board).toEqual({ layout: 'new' });
      expect(out.sys.ext.other).toEqual({ keep: true });
      expect(out.sys.top).toBe('x');
      expect(sm.get('sys.ext.board')).toEqual({ layout: 'old' }); // live tree unchanged
      // Branches off the path are the live (raw) objects, not copies.
      const raw = sm.toSnapshot();
      expect(out.big).toEqual(raw.big);
      expect(out.big).toBe(toRaw((sm.getTree() as unknown as { big: object }).big));
      expect(JSON.stringify(out)).toBe(JSON.stringify({ ...raw, sys: { ...(raw.sys as object), ext: { board: { layout: 'new' }, other: { keep: true } } } }));
    });

    // P1 存档写入提速: the database takes these as they are, and it cannot clone a reactive proxy.
    it('snapshotWith of a value read through the state, and liveTree, hold no proxy: the browser can clone them', () => {
      sm.set('sys.ext.board', { layout: { a: [1, 2] } }, 'system');
      sm.set('story.text', '正文', 'system');
      const board = sm.get('sys.ext.board');
      expect(isProxy(board)).toBe(true);
      const out = sm.snapshotWith('sys.ext.board', board) as { sys: { ext: { board: unknown } } };
      expect(isProxy(out.sys.ext.board)).toBe(false);
      expect(structuredClone(out)).toEqual({ sys: { ext: { board: { layout: { a: [1, 2] } } } }, story: { text: '正文' } });
      const live = sm.liveTree();
      expect(isProxy(live)).toBe(false);
      expect(structuredClone(live)).toEqual(sm.toSnapshot());
      // Not a copy: the next change shows in it (a writer must take it at once).
      sm.set('story.text', '改了', 'system');
      expect((live.story as { text: string }).text).toBe('改了');
    });

    it('snapshotWith creates a missing path and refuses filters and arrays on the way', () => {
      const out = sm.snapshotWith('a.b.c', 1) as { a: { b: { c: number } } };
      expect(out.a.b.c).toBe(1);
      expect(sm.get('a')).toBeUndefined();
      expect(() => sm.snapshotWith('list[name=x].v', 1)).toThrow('filter');
      sm.set('arr', [{ v: 1 }], 'system');
      expect(() => sm.snapshotWith('arr.0', 1)).toThrow('array');
    });

    it('rollbackTo restores previous state', () => {
      sm.set('x', 1, 'system');
      const snap = sm.toSnapshot();
      sm.set('x', 999, 'system');
      sm.rollbackTo(snap);
      expect(sm.get('x')).toBe(1);
    });

    it('clear empties state', () => {
      sm.set('x', 1, 'system');
      sm.clear();
      expect(sm.get('x')).toBeUndefined();
    });
  });

  describe('isLoaded', () => {
    it('is false initially', () => {
      expect(sm.isLoaded()).toBe(false);
    });

    it('is true after loadTree', () => {
      sm.loadTree({ x: 1 } as never);
      expect(sm.isLoaded()).toBe(true);
    });

    it('is false after clear', () => {
      sm.loadTree({ x: 1 } as never);
      sm.clear();
      expect(sm.isLoaded()).toBe(false);
    });
  });

  describe('change tracking', () => {
    it('records change on set', () => {
      sm.set('a', 1, 'system');
      const history = sm.getChangeHistory();
      expect(history.length).toBeGreaterThan(0);
    });

    it('emits engine:state-changed event', () => {
      sm.set('a', 1, 'system');
      expect(getEmitted().some((e) => e.event === 'engine:state-changed')).toBe(true);
    });
  });
});
