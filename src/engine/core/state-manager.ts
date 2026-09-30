/**
 * 状态管理器 — 通用 JSON 状态树的响应式读写
 *
 * 核心设计：
 * - 使用 Vue 的 reactive() 包装状态树 → 组件可直接响应式绑定
 * - 通过 lodash-es 的 get/set/unset 做 dot-path 操作
 * - 所有修改都经过变更追踪，生成 StateChange 记录
 *
 * 引擎不关心状态树的具体字段含义（那是 Game Pack 定义的），
 * 只提供 dot-path 的 CRUD 操作。
 *
 * 对应 STEP-02 §3.2、STEP-03 M1.3。
 * 参照 demo: gameStateStore.ts（但去除所有天命特有字段）。
 *
 * ## CR-R1 修复（2026-04-11）：过滤器路径语法支持
 *
 * 所有 public read/write 方法（`get`/`has`/`set`/`delete`/`push`/`pull`/`add`）
 * 在调用底层 lodash 前，会把 **过滤器路径** 解析为 **索引路径**。
 *
 * 过滤器语法：`社交.关系[名称=李明阳].好感度`
 * 解析为：  `社交.关系[3].好感度`（假设 index 3 的对象 `名称==='李明阳'`）
 *
 * 这样 AI 产出的命令（opening.md / core.md / splitGenStep2.md / npcChat.md 等提示词
 * 都使用此语法）能真正命中目标对象，而非被 lodash 当作字面量属性名创建假字段。
 *
 * 解析失败（filter 不匹配任何元素）：
 * - `get` / `has`: 返回 `undefined` / `false`
 * - `set` / `delete` / `push` / `pull` / `add`: console.warn + 无操作（返回空 change）
 *   这比让 lodash 创建"僵尸字段"更安全。
 *
 * 不含过滤器的路径走 fast-path（不做解析），与旧行为一致。
 */
import { reactive, toRaw } from 'vue';
import { get as _get, set as _set, unset as _unset, cloneDeep } from 'lodash-es';
import type { GameStateTree, StatePath, StateChange, ChangeLog } from '../types';
import { eventBus } from './event-bus';

/**
 * CR-R1: 过滤器段识别正则
 *
 * 匹配形如 `arrayName[fieldName=fieldValue]` 的路径段。
 * - 第 1 捕获组：数组 key（支持中文/字母/数字/下划线）
 * - 第 2 捕获组：filter 字段名
 * - 第 3 捕获组：filter 字段值（不含 `]`）
 *
 * 局限：
 * - filter value 不能包含 `]`（真实 NPC 名称不会有）
 * - 只支持单一 `field=value` 条件，不支持 `&`/`|`/`<>` 等复杂表达式
 * - 不支持嵌套引用（如 `[名称=父级.子名]`）
 */
const FILTER_SEGMENT_RE = /^([^\[\]]+)\[([^=\]]+)=([^\]]+)\]$/;

/**
 * CR-R1: 快速检测路径是否包含过滤器语法
 *
 * 仅当路径含有 `[...=...]` 模式时才进入昂贵的 resolver。
 * 纯索引路径如 `角色.效果[0]` 不触发。
 */
function hasFilterSyntax(path: string): boolean {
  // 要求 `[` 和 `=` 同时出现且 `=` 在 `[` 之后、`]` 之前
  const bracketOpen = path.indexOf('[');
  if (bracketOpen === -1) return false;
  const eqAfter = path.indexOf('=', bracketOpen);
  if (eqAfter === -1) return false;
  const bracketClose = path.indexOf(']', eqAfter);
  return bracketClose > eqAfter;
}

export class StateManager {
  /** 响应式状态树 — Vue 组件可直接在 template 中绑定 */
  private state: GameStateTree;
  /** 变更历史（用于调试和回放），上限避免长时间游戏内存泄漏 */
  private changeHistory: ChangeLog[] = [];
  private static readonly MAX_HISTORY = 200;
  /** 标记状态树是否已加载有效数据 */
  private loaded = false;

  /**
   * CR-R1: 过滤器路径解析失败的去重日志
   *
   * 记录已经 warn 过的 "原路径" → 避免同一 session 同一路径反复刷屏
   */
  private warnedUnresolvedFilters = new Set<string>();

  constructor() {
    this.state = reactive({});
  }

  // ─── CR-R1: 过滤器路径解析 ───

  /**
   * 解析路径中的 `arrayKey[field=value]` 过滤器段为 `arrayKey[index]` 索引段
   *
   * 算法：
   * 1. 如果路径不含过滤器语法 → 直接返回（fast-path，覆盖 99% 调用）
   * 2. 否则按 `.` 分段，逐段检查是否匹配 `FILTER_SEGMENT_RE`
   * 3. 对每个 filter 段：
   *    a. 构建到当前段的父路径
   *    b. 读取父路径对应的数组
   *    c. 在数组中查找匹配项的索引
   *    d. 用 `arrayKey[index]` 替换原 filter 段
   * 4. 任何 filter 段无法解析（非数组 / 元素不存在） → 返回 `null`
   *
   * @param path 原始路径（可能含 `[field=value]`）
   * @returns 解析后的路径（lodash 可直接消费），或 `null` 表示解析失败
   */
  private resolveFilterPath(path: StatePath): string | null {
    // Fast-path: 99% 的路径不含过滤器
    if (!hasFilterSyntax(path)) return path;

    const segments = path.split('.');
    const resolved: string[] = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const match = seg.match(FILTER_SEGMENT_RE);
      if (!match) {
        resolved.push(seg);
        continue;
      }

      const [, arrayKey, filterField, filterValue] = match;

      // 父路径 = 已解析的段 + 当前 arrayKey（不带 filter）
      // e.g. `社交.关系[名称=X].好感度` 在 i=1 时：
      //   parentPath = `社交.关系`
      const parentPath = [...resolved, arrayKey].join('.');
      const parentValue = _get(this.state, parentPath);

      if (!Array.isArray(parentValue)) {
        // 父路径不是数组 — 无法应用 filter
        this.warnUnresolved(path, `${parentPath} 不是数组`);
        return null;
      }

      // 查找第一个满足 filter 的元素
      const idx = parentValue.findIndex(
        (item) =>
          item !== null &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          String((item as Record<string, unknown>)[filterField]) === filterValue,
      );

      if (idx === -1) {
        this.warnUnresolved(path, `未找到 ${arrayKey} 中 ${filterField}='${filterValue}' 的元素`);
        return null;
      }

      // 替换当前段为 `arrayKey[idx]`
      resolved.push(`${arrayKey}[${idx}]`);
    }

    return resolved.join('.');
  }

  /**
   * CR-R1: 去重的过滤器解析失败告警
   *
   * 每个原始路径每 session 只 warn 一次，避免刷屏。
   */
  private warnUnresolved(originalPath: string, reason: string): void {
    if (this.warnedUnresolvedFilters.has(originalPath)) return;
    this.warnedUnresolvedFilters.add(originalPath);
    console.warn(
      `[StateManager] 过滤器路径解析失败："${originalPath}" — ${reason}。命令被跳过，不会创建假字段。`,
    );
  }

  // ─── 读取操作 ───

  /** 获取整棵响应式状态树引用 — Vue 组件可直接绑定 */
  getTree(): GameStateTree {
    return this.state;
  }

  /** 按 dot-path 获取值 — 支持 `arrayKey[field=value]` 过滤器语法（CR-R1） */
  get<T = unknown>(path: StatePath): T | undefined {
    const resolved = this.resolveFilterPath(path);
    if (resolved === null) return undefined;
    return _get(this.state, resolved) as T | undefined;
  }

  /** 检查 dot-path 是否存在 — 支持过滤器语法（CR-R1） */
  has(path: StatePath): boolean {
    const resolved = this.resolveFilterPath(path);
    if (resolved === null) return false;
    return _get(this.state, resolved) !== undefined;
  }

  /** 状态树是否已加载 */
  isLoaded(): boolean {
    return this.loaded;
  }

  // ─── 写入操作（单操作，每个都生成 StateChange） ───

  /** 设置值 — 对应 command action "set"。支持过滤器路径（CR-R1） */
  set(path: StatePath, value: unknown, source: ChangeLog['source'] = 'system'): StateChange {
    const resolved = this.resolveFilterPath(path);
    if (resolved === null) {
      // 过滤器解析失败：no-op change，不破坏状态树
      return this.buildNoopChange(path, 'set');
    }
    const oldValue = cloneDeep(_get(this.state, resolved));
    // cloneDeep 写入值，避免外部引用污染状态树
    _set(this.state, resolved, cloneDeep(value));
    const change: StateChange = {
      path, action: 'set', oldValue, newValue: cloneDeep(value), timestamp: Date.now(),
    };
    this.recordChange(change, source);
    return change;
  }

  /** 删除路径 — 对应 command action "delete"。支持过滤器路径（CR-R1） */
  delete(path: StatePath, source: ChangeLog['source'] = 'system'): StateChange {
    const resolved = this.resolveFilterPath(path);
    if (resolved === null) {
      return this.buildNoopChange(path, 'delete');
    }
    const oldValue = cloneDeep(_get(this.state, resolved));
    _unset(this.state, resolved);
    const change: StateChange = {
      path, action: 'delete', oldValue, newValue: undefined, timestamp: Date.now(),
    };
    this.recordChange(change, source);
    return change;
  }

  /** 数值加减 — 对应 command action "add"（value 可为负数表示减少）。支持过滤器（CR-R1） */
  add(path: StatePath, value: number, source: ChangeLog['source'] = 'system'): StateChange {
    const resolved = this.resolveFilterPath(path);
    if (resolved === null) {
      return this.buildNoopChange(path, 'add');
    }
    const raw = _get(this.state, resolved) ?? 0;
    const current = Number(raw);
    if (Number.isNaN(current)) {
      throw new Error(`Cannot add to non-numeric value at "${path}": ${String(raw)}`);
    }
    if (Number.isNaN(value)) {
      throw new Error(`Cannot add NaN value to "${path}"`);
    }
    // 注意：递归调用 set 时传入已解析的 resolved path（省一次解析）
    return this.set(resolved, current + value, source);
  }

  /** 向数组追加元素 — 对应 command action "push"。支持过滤器路径（CR-R1） */
  push(path: StatePath, value: unknown, source: ChangeLog['source'] = 'system'): StateChange {
    const resolved = this.resolveFilterPath(path);
    if (resolved === null) {
      return this.buildNoopChange(path, 'push');
    }
    const arr = _get(this.state, resolved);
    const oldValue = cloneDeep(arr);

    if (Array.isArray(arr)) {
      // 已有数组 → 追加
      arr.push(cloneDeep(value));
    } else {
      // 路径不存在或非数组 → 创建新数组
      _set(this.state, resolved, [cloneDeep(value)]);
    }

    const change: StateChange = {
      path, action: 'push', oldValue, newValue: cloneDeep(_get(this.state, resolved)),
      timestamp: Date.now(),
    };
    this.recordChange(change, source);
    return change;
  }

  /**
   * 从数组移除匹配项 — 对应 command action "pull"
   *
   * 匹配策略（按优先级）：
   * 1. 原始值 → === 严格比较
   * 2. 对象且有 id 字段 → 按 id 匹配
   * 3. 对象无 id → JSON 深度比较（回退方案）
   *
   * 支持过滤器路径（CR-R1）。
   */
  pull(path: StatePath, value: unknown, source: ChangeLog['source'] = 'system'): StateChange {
    const resolved = this.resolveFilterPath(path);
    if (resolved === null) {
      return this.buildNoopChange(path, 'pull');
    }
    const arr = _get(this.state, resolved);
    const oldValue = cloneDeep(arr);

    if (Array.isArray(arr)) {
      const idx = this.findMatchIndex(arr, value);
      if (idx !== -1) arr.splice(idx, 1);
    }

    const change: StateChange = {
      path, action: 'pull', oldValue, newValue: cloneDeep(_get(this.state, resolved)),
      timestamp: Date.now(),
    };
    this.recordChange(change, source);
    return change;
  }

  /**
   * CR-R1: 构建空变更记录 — 当过滤器路径解析失败时返回
   *
   * 与真实 change 的区别：`oldValue === newValue === undefined`，且**不进入**
   * changeHistory（避免污染调试日志）。调用方通常把返回值当 StateChange 使用，
   * 所以结构必须完整。
   */
  private buildNoopChange(path: StatePath, action: StateChange['action']): StateChange {
    return {
      path,
      action,
      oldValue: undefined,
      newValue: undefined,
      timestamp: Date.now(),
    };
  }

  /** pull 操作的匹配逻辑 — 分三级策略查找目标元素 */
  private findMatchIndex(arr: unknown[], value: unknown): number {
    // 策略1：原始值用严格相等
    if (value === null || typeof value !== 'object') {
      return arr.indexOf(value);
    }
    // 策略2：对象且有 id 字段 → 按 id 匹配
    const valId = (value as Record<string, unknown>).id;
    if (valId !== undefined) {
      return arr.findIndex(
        (item) => item !== null && typeof item === 'object' && (item as Record<string, unknown>).id === valId,
      );
    }
    // 策略3：JSON 序列化深度比较（性能较差，仅作回退）
    const valJson = JSON.stringify(value);
    return arr.findIndex((item) => JSON.stringify(item) === valJson);
  }

  // ─── 批量操作 ───

  /**
   * 加载完整状态树 — 读档或创角初始化时调用
   * 清空现有状态后填入新数据，保持 reactive 引用不变
   */
  loadTree(data: Record<string, unknown>): void {
    const cloned = cloneDeep(data);
    // 清空当前 reactive 对象的所有 key
    for (const key of Object.keys(this.state)) {
      delete this.state[key];
    }
    // 填入新数据
    Object.assign(this.state, cloned);
    this.loaded = true;
    this.changeHistory = [];
    eventBus.emit('engine:state-changed', { type: 'load' });
  }

  /** 导出状态树的深拷贝快照 — 存档时使用，与 reactive 脱钩 */
  toSnapshot(): Record<string, unknown> {
    return cloneDeep(toRaw(this.state));
  }

  /**
   * The tree as plain data with one plain dot-path replaced, sharing every other branch with the live tree
   * instead of copying it. For a writer that copies before it yields (SaveManager.saveGame clones first), so
   * saving one small branch of a large tree costs one copy instead of three. Never keep or mutate the result.
   * Filter segments and paths through arrays are not supported.
   */
  snapshotWith(path: StatePath, value: unknown): Record<string, unknown> {
    if (hasFilterSyntax(path)) throw new Error(`snapshotWith does not take filter paths: "${path}"`);
    const keys = path.split('.');
    const root = toRaw(this.state) as Record<string, unknown>;
    const out: Record<string, unknown> = { ...root };
    let from: unknown = root;
    let to = out;
    for (const key of keys.slice(0, -1)) {
      const child = from && typeof from === 'object' ? (from as Record<string, unknown>)[key] : undefined;
      if (Array.isArray(child)) throw new Error(`snapshotWith cannot pass through an array at "${key}" in "${path}"`);
      const copy: Record<string, unknown> = child && typeof child === 'object' ? { ...(toRaw(child) as Record<string, unknown>) } : {};
      to[key] = copy;
      to = copy;
      from = child;
    }
    to[keys[keys.length - 1]] = value;
    return out;
  }

  /**
   * 将状态树回滚到快照 — Rollback 功能使用
   *
   * 与 loadTree 的区别：不重置 loaded 标志，也不重置变更历史，
   * 因为回滚是游戏进行中的操作，而非"重新开始加载"。
   * 保留 reactive 引用，确保 Vue 组件自动响应回滚后的状态。
   */
  rollbackTo(snapshot: Record<string, unknown>): void {
    const cloned = cloneDeep(snapshot);
    for (const key of Object.keys(this.state)) {
      delete this.state[key];
    }
    Object.assign(this.state, cloned);
    eventBus.emit('engine:state-changed', { type: 'rollback' });
  }

  /** 清空状态树 — 退出游戏或切换角色时调用 */
  clear(): void {
    for (const key of Object.keys(this.state)) {
      delete this.state[key];
    }
    this.loaded = false;
    this.changeHistory = [];
  }

  // ─── 变更追踪 ───

  /** 记录单次变更并通过事件总线通知 */
  private recordChange(change: StateChange, source: ChangeLog['source']): void {
    const log: ChangeLog = { changes: [change], source, timestamp: Date.now() };
    this.changeHistory.push(log);
    // 超出上限时丢弃最旧的记录
    if (this.changeHistory.length > StateManager.MAX_HISTORY) {
      this.changeHistory.splice(0, this.changeHistory.length - StateManager.MAX_HISTORY);
    }
    eventBus.emit('engine:state-changed', { change, source });
  }

  /** 获取变更历史（只读） — 用于调试面板 */
  getChangeHistory(): readonly ChangeLog[] {
    return this.changeHistory;
  }
}
