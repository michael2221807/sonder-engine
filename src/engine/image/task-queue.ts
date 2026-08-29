// App doc: docs/user-guide/pages/game-image.md §队列（50 条上限与淘汰清理）
/**
 * Image Task Queue — Sprint Image-4
 *
 * Manages pending image generation tasks. Serial execution by default;
 * parallelism classification per PRINCIPLES §3.14 deferred to Image-5.
 *
 * Supports optional persistence callback: when provided, every mutation
 * triggers onPersist with the full task list, allowing the caller
 * to write to state tree + auto-save.
 */
import type { ImageTask, ImageTaskStatus } from './types';

let taskIdCounter = 1;

export class ImageTaskQueue {
  /** 已完成/失败任务的保留上限（PO 2026-08-29 确认沿用 50）。 */
  static readonly MAX_FINISHED = 50;

  private tasks = new Map<string, ImageTask>();
  private onPersist?: (tasks: ImageTask[]) => void;
  private onEvict?: (evicted: ImageTask[]) => void;

  constructor(options?: {
    onPersist?: (tasks: ImageTask[]) => void;
    /**
     * 超出 {@link MAX_FINISHED} 被永久淘汰的已完成任务。队列本身是纯数据结构
     * （拿不到资产缓存/状态树），所以只上报，由编排层决定怎么收尾——参考图的
     * 孤儿清理就挂在这里（PO 决策 2026-08-29：「超出就删最旧，该删的也删」）。
     */
    onEvict?: (evicted: ImageTask[]) => void;
  }) {
    this.onPersist = options?.onPersist;
    this.onEvict = options?.onEvict;
  }

  /** Restore tasks from persisted data (called on game load) */
  restore(saved: ImageTask[]): void {
    this.tasks.clear();
    let maxSeen = 0;
    for (const t of saved) {
      this.tasks.set(t.id, t);
      // Extract counter from ID format: img_task_<N>_<timestamp>
      const n = parseInt(t.id.split('_')[2] ?? '0', 10);
      if (n > maxSeen) maxSeen = n;
    }
    if (maxSeen >= taskIdCounter) taskIdCounter = maxSeen + 1;
  }

  create(params: Omit<ImageTask, 'id' | 'status' | 'createdAt' | 'updatedAt'>): ImageTask {
    const now = Date.now();
    const task: ImageTask = {
      id: `img_task_${taskIdCounter++}_${now}`,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      ...params,
    };
    this.tasks.set(task.id, task);
    this.persist();
    return task;
  }

  updateStatus(taskId: string, status: ImageTaskStatus, extra?: Partial<ImageTask>): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.tasks.set(taskId, { ...task, status, updatedAt: Date.now(), ...extra });
    this.persist();
  }

  get(taskId: string): ImageTask | undefined {
    return this.tasks.get(taskId);
  }

  getPending(): ImageTask[] {
    return [...this.tasks.values()].filter((t) => t.status === 'pending');
  }

  getAll(): ImageTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  remove(taskId: string): void {
    this.tasks.delete(taskId);
    this.persist();
  }

  clear(): void {
    this.tasks.clear();
    this.persist();
  }

  private persist(): void {
    // Auto-evict oldest completed/failed tasks beyond cap to prevent unbounded growth
    const finished = [...this.tasks.values()]
      .filter((t) => t.status === 'complete' || t.status === 'failed')
      .sort((a, b) => b.createdAt - a.createdAt);
    let evicted: ImageTask[] = [];
    if (finished.length > ImageTaskQueue.MAX_FINISHED) {
      evicted = finished.slice(ImageTaskQueue.MAX_FINISHED);
      for (const t of evicted) {
        this.tasks.delete(t.id);
      }
    }
    this.onPersist?.(this.getAll());
    // 先 persist 再上报：清理回调要按「淘汰之后」的任务集判断还有谁在引用。
    if (evicted.length > 0) this.onEvict?.(evicted);
  }
}
