import { describe, it, expect, vi } from 'vitest';
import { ImageTaskQueue } from './task-queue';
import type { ImageTask } from './types';

describe('ImageTaskQueue', () => {
  function createQueue(onPersist?: (tasks: ImageTask[]) => void) {
    return new ImageTaskQueue({ onPersist });
  }

  describe('create', () => {
    it('creates a task with pending status', () => {
      const q = createQueue();
      const task = q.create({ subjectType: 'character', width: 1024, height: 1024, backend: 'novelai' });
      expect(task.status).toBe('pending');
      expect(task.id).toMatch(/^img_task_\d+_\d+$/);
      expect(task.width).toBe(1024);
    });

    it('calls onPersist after create', () => {
      const spy = vi.fn();
      const q = createQueue(spy);
      q.create({ subjectType: 'character', width: 512, height: 512, backend: 'openai' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toHaveLength(1);
    });

    it('generates unique IDs', () => {
      const q = createQueue();
      const t1 = q.create({ subjectType: 'character', width: 512, height: 512, backend: 'openai' });
      const t2 = q.create({ subjectType: 'scene', width: 1024, height: 576, backend: 'novelai' });
      expect(t1.id).not.toBe(t2.id);
    });
  });

  describe('updateStatus', () => {
    it('updates task status and updatedAt', () => {
      const q = createQueue();
      const task = q.create({ subjectType: 'character', width: 1024, height: 1024, backend: 'novelai' });
      const before = task.updatedAt;

      q.updateStatus(task.id, 'generating', { positivePrompt: 'test prompt' });
      const updated = q.get(task.id)!;
      expect(updated.status).toBe('generating');
      expect(updated.positivePrompt).toBe('test prompt');
      expect(updated.updatedAt).toBeGreaterThanOrEqual(before);
    });

    it('silently ignores unknown task ID', () => {
      const q = createQueue();
      expect(() => q.updateStatus('nonexistent', 'complete')).not.toThrow();
    });
  });

  describe('getAll / getPending', () => {
    it('returns all tasks', () => {
      const q = createQueue();
      q.create({ subjectType: 'character', width: 512, height: 512, backend: 'openai' });
      q.create({ subjectType: 'scene', width: 1024, height: 576, backend: 'novelai' });
      const all = q.getAll();
      expect(all).toHaveLength(2);
    });

    it('getPending only returns pending tasks', () => {
      const q = createQueue();
      q.create({ subjectType: 'character', width: 512, height: 512, backend: 'openai' });
      const t2 = q.create({ subjectType: 'scene', width: 1024, height: 576, backend: 'novelai' });
      q.updateStatus(t2.id, 'complete');
      expect(q.getPending()).toHaveLength(1);
    });
  });

  describe('remove / clear', () => {
    it('removes a specific task', () => {
      const q = createQueue();
      const task = q.create({ subjectType: 'character', width: 512, height: 512, backend: 'openai' });
      q.remove(task.id);
      expect(q.get(task.id)).toBeUndefined();
      expect(q.getAll()).toHaveLength(0);
    });

    it('clears all tasks', () => {
      const q = createQueue();
      q.create({ subjectType: 'character', width: 512, height: 512, backend: 'openai' });
      q.create({ subjectType: 'scene', width: 1024, height: 576, backend: 'novelai' });
      q.clear();
      expect(q.getAll()).toHaveLength(0);
    });
  });

  describe('restore', () => {
    it('restores tasks from saved data', () => {
      const q = createQueue();
      const saved: ImageTask[] = [
        { id: 'img_task_5_1000', status: 'complete', subjectType: 'character', width: 1024, height: 1024, backend: 'novelai', createdAt: 1000, updatedAt: 1000 },
        { id: 'img_task_3_900', status: 'failed', subjectType: 'scene', width: 1024, height: 576, backend: 'openai', createdAt: 900, updatedAt: 900 },
      ];
      q.restore(saved);
      expect(q.getAll()).toHaveLength(2);
      expect(q.get('img_task_5_1000')?.status).toBe('complete');
    });

    it('does not collide IDs with restored tasks', () => {
      const q = createQueue();
      const saved: ImageTask[] = [
        { id: 'img_task_10_1000', status: 'complete', subjectType: 'character', width: 1024, height: 1024, backend: 'novelai', createdAt: 1000, updatedAt: 1000 },
      ];
      q.restore(saved);
      // New task should have counter > 10
      const newTask = q.create({ subjectType: 'character', width: 512, height: 512, backend: 'openai' });
      const counter = parseInt(newTask.id.split('_')[2], 10);
      expect(counter).toBeGreaterThan(10);
    });

    it('clears existing tasks before restoring', () => {
      const q = createQueue();
      q.create({ subjectType: 'character', width: 512, height: 512, backend: 'openai' });
      q.restore([]);
      expect(q.getAll()).toHaveLength(0);
    });
  });
});

// ─── 50 条上限的淘汰上报（PO 决策 2026-08-29）───────────────────────────
//
// 队列是纯数据结构，拿不到资产缓存/状态树 → 只负责**上报**被淘汰的任务，
// 由 ImageService.cleanupEvictedTaskAssets 决定要不要删参考图。
describe('ImageTaskQueue 淘汰上报', () => {
  function fill(q: ImageTaskQueue, n: number): ImageTask[] {
    const made: ImageTask[] = [];
    for (let i = 0; i < n; i++) {
      const t = q.create({ subjectType: 'character', width: 8, height: 8, backend: 'volcengine' });
      // createdAt 递增，保证"最旧"是先建的那批
      t.createdAt = 1000 + i;
      q.updateStatus(t.id, 'complete');
      made.push(t);
    }
    return made;
  }

  it('未超上限时不触发 onEvict', () => {
    const onEvict = vi.fn();
    const q = new ImageTaskQueue({ onEvict });
    fill(q, ImageTaskQueue.MAX_FINISHED);
    expect(onEvict).not.toHaveBeenCalled();
    expect(q.getAll()).toHaveLength(ImageTaskQueue.MAX_FINISHED);
  });

  it('超出后淘汰最旧的，并把被淘汰任务上报给 onEvict', () => {
    const evicted: ImageTask[] = [];
    const q = new ImageTaskQueue({ onEvict: (list) => evicted.push(...list) });
    const made = fill(q, ImageTaskQueue.MAX_FINISHED + 3);

    expect(q.getAll()).toHaveLength(ImageTaskQueue.MAX_FINISHED);
    // 被淘汰的必须是最早建的那几条
    const evictedIds = new Set(evicted.map((t) => t.id));
    for (const t of made.slice(0, 3)) expect(evictedIds.has(t.id)).toBe(true);
    // 且确实已从队列移除
    for (const t of made.slice(0, 3)) expect(q.getAll().some((x) => x.id === t.id)).toBe(false);
  });

  it('onEvict 在 onPersist 之后触发（清理要按淘汰后的任务集判断引用）', () => {
    const order: string[] = [];
    const q = new ImageTaskQueue({
      onPersist: () => order.push('persist'),
      onEvict: () => order.push('evict'),
    });
    fill(q, ImageTaskQueue.MAX_FINISHED + 1);
    const lastPersist = order.lastIndexOf('persist');
    const lastEvict = order.lastIndexOf('evict');
    expect(lastEvict).toBeGreaterThan(-1);
    expect(lastEvict).toBeGreaterThan(lastPersist - 1);
    expect(order[lastEvict - 1]).toBe('persist');
  });

  it('未完成的任务不参与淘汰（pending 永远保留）', () => {
    const q = new ImageTaskQueue();
    const pending = q.create({ subjectType: 'scene', width: 8, height: 8, backend: 'volcengine' });
    fill(q, ImageTaskQueue.MAX_FINISHED + 5);
    expect(q.getAll().some((t) => t.id === pending.id)).toBe(true);
  });
});
