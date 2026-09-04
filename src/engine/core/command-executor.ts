// App doc: docs/user-guide/pages/game-main.md §3.5 命令按钮说明 / §3.8.2 CommandsViewer（未知根路径归位 / 拒绝）
/**
 * 指令执行器 — 接收 AI 返回的 Command 数组并在 StateManager 上执行
 *
 * 每次 AI 回复中的 commands 作为一个批次执行，
 * 生成统一的 BatchCommandResult（含变更日志和错误信息）。
 *
 * 对应 STEP-02 §3.3、STEP-03 M1.4。
 * 参照 demo: AIBidirectionalSystem 中的 TavernCommand 执行逻辑。
 *
 * 验证链（对齐 demo §24 四步验证）：
 * 1. 结构验证 — action/key 字段必须存在且合法
 * 2. 值清理 — NaN 转 0，字符串 trim
 * 3. 数值修复 — add/set 写入数值时，负值夹至 0，超过 MAX_NUMERIC_VALUE 夹至上限
 * 4. 数组容量限制 — push 时若已达 MAX_ARRAY_CAPACITY，先 pull 最旧元素
 *
 * §11.4 路径根白名单（归位 / 拒绝模式，2026-09-04 起）：
 * 构造时可传入 pathRootWhitelist —— Game Pack state-schema 的顶层 properties 列表。
 * AI 生成的 command 如果写入的路径根段不在白名单（伪根路径，如 `身体.反差体质失控度`），
 * 执行器**不再原样执行**（那会在状态树顶层长出伪键）：
 *   1. 归位 —— 在白名单根下搜索能唯一容纳该路径的位置（如 `角色.身体.反差体质失控度`），
 *      找到唯一且最浅的候选就改写 key 执行，结果带 `relocatedFrom`；
 *   2. 拒绝 —— 找不到或有歧义时返回 `success:false`，命令不落库。
 * 两种情况都 console.warn 一次 + toast（每 session 每个伪根一次）。
 * 传入 null 则禁用校验（测试或向后兼容）。
 */
import type { Command, CommandResult, BatchCommandResult, ChangeLog, StateChange } from '../types';
import type { StateManager } from './state-manager';
import { eventBus } from './event-bus';

/**
 * Optional guard for push operations. Injected at construction time so the
 * executor stays content-agnostic (the caller decides which paths need
 * dedup/merge and how). Verdicts:
 *
 * - `true`  — allow the push to proceed normally
 * - `false` — suppress the push (treated as a no-op success)
 * - `StateChange` — the guard already applied a SUBSTITUTE write (e.g. fused
 *   a duplicate NPC into its existing entry); the push itself is suppressed
 *   but the returned change is recorded as the command's change so the
 *   round's changeLog / delta audit trail reflects what actually happened.
 */
export type PushGuardVerdict = boolean | StateChange;

export type PushDedupGuard = (
  path: string,
  newValue: unknown,
  existingArray: unknown[],
) => PushGuardVerdict;

/**
 * Compose multiple push guards into one. Guards run in order; the first
 * non-`true` verdict (suppress or substitute-change) short-circuits the rest.
 * Guards are expected to self-select by path (return `true` for paths they
 * do not own), so composition order only matters for overlapping paths.
 */
export function composePushGuards(...guards: PushDedupGuard[]): PushDedupGuard {
  return (path, newValue, existingArray) => {
    for (const guard of guards) {
      const verdict = guard(path, newValue, existingArray);
      if (verdict !== true) return verdict;
    }
    return true;
  };
}

/** 单字段数值写入的安全上限（防止 AI 生成极端值破坏 UI 渲染） */
const MAX_NUMERIC_VALUE = 999_999;

/** push 操作下，单个数组字段的最大容量（超出时自动淘汰最旧元素） */
const MAX_ARRAY_CAPACITY = 200;

export class CommandExecutor {
  /**
   * §11.4: 已警告过的未知路径根 — 避免同一 session 重复刷屏
   *
   * 每个 session 第一次遇到某个未知 root 时 console.warn 一次 + 发一个 toast，
   * 之后再遇到同名 root 保持静默（但命令仍执行）。用户刷新页面后重置。
   */
  private warnedUnknownRoots = new Set<string>();

  constructor(
    private stateManager: StateManager,
    /**
     * §11.4: 允许的路径根段白名单（Game Pack state-schema 顶层 properties 名列表）
     *
     * 例如天命 pack = `['元数据', '角色', '世界', '社交', 'NPC列表', '记忆', '系统']`
     *
     * 传入时：写入的 path 根段不在白名单 → 一次性 console.warn + toast，但**仍然执行**
     * 传入 null：禁用验证（测试或向后兼容）
     */
    private pathRootWhitelist: readonly string[] | null = null,
    /**
     * Optional dedup guard for push operations. When provided, called before
     * every `push` with (path, newValue, existingArray). Return `false` to
     * suppress the push (treated as a no-op success, not an error).
     */
    private pushDedupGuard?: PushDedupGuard,
  ) {}

  /** 执行单条指令 — 返回执行结果 */
  execute(command: Command): CommandResult {
    // ── 步骤 1：结构验证 ──
    if (!command.action || !command.key) {
      return { success: false, command, error: 'Missing action or key' };
    }

    // ── §11.4: 路径根白名单校验（归位 / 拒绝）──
    const resolution = this.resolvePathRoot(command.key);
    if (resolution.kind === 'rejected') {
      return { success: false, command, error: resolution.error };
    }
    const cmd: Command = resolution.kind === 'relocated' ? { ...command, key: resolution.key } : command;
    const relocatedFrom = resolution.kind === 'relocated' ? command.key : undefined;

    try {
      let change;

      switch (cmd.action) {
        case 'set': {
          const sanitized = sanitizeValue(cmd.value);
          const finalVal = typeof sanitized === 'number'
            ? clampNumber(sanitized)
            : sanitized;
          change = this.stateManager.set(cmd.key, finalVal, 'command');
          break;
        }

        case 'add': {
          // ── 步骤 2：值清理（NaN → 0） ──
          const raw = Number(cmd.value ?? 0);
          const numValue = Number.isNaN(raw) ? 0 : raw;
          // ── 步骤 3：数值修复（夹至合法范围） ──
          const clamped = clampNumber(numValue);
          change = this.stateManager.add(cmd.key, clamped, 'command');
          break;
        }

        case 'delete':
          change = this.stateManager.delete(cmd.key, 'command');
          break;

        case 'push': {
          // ── 步骤 4：数组容量限制 ──
          const arr = this.stateManager.get<unknown[]>(cmd.key);

          // ── 步骤 4b：push 去重/融合守卫 ──
          if (this.pushDedupGuard && Array.isArray(arr)) {
            const verdict = this.pushDedupGuard(cmd.key, cmd.value, arr);
            if (verdict === false) {
              // 抑制：视为 no-op 成功
              change = undefined;
              break;
            }
            if (verdict !== true) {
              // 守卫已执行替代写入（如同名 NPC 融合）——push 本身被抑制，
              // 但替代写入的 StateChange 记入命令结果，保证回合 changeLog /
              // Δ 审计能看到真实发生的变更
              change = verdict;
              break;
            }
          }

          if (Array.isArray(arr) && arr.length >= MAX_ARRAY_CAPACITY) {
            this.stateManager.pull(cmd.key, arr[0], 'command');
          }
          change = this.stateManager.push(cmd.key, cmd.value, 'command');
          break;
        }

        case 'pull':
          change = this.stateManager.pull(cmd.key, cmd.value, 'command');
          break;

        default:
          return {
            success: false,
            command,
            error: `Unknown action: ${String(cmd.action)}`,
          };
      }

      return { success: true, command: cmd, change, ...(relocatedFrom ? { relocatedFrom } : {}) };
    } catch (err) {
      return { success: false, command: cmd, error: String(err) };
    }
  }

  /**
   * 批量执行指令 — 一次 AI 回复的所有 commands
   *
   * 当前实现为"尽力执行"：单条失败不影响后续指令。
   * 失败的指令会记录到 results 中并在 console 输出警告。
   */
  executeBatch(commands: Command[]): BatchCommandResult {
    const results: CommandResult[] = [];
    const changes: ChangeLog['changes'] = [];

    for (const cmd of commands) {
      const result = this.execute(cmd);
      results.push(result);
      // 只收集成功执行的变更
      if (result.change) {
        changes.push(result.change);
      }
    }

    const changeLog: ChangeLog = {
      changes,
      source: 'command',
      timestamp: Date.now(),
    };

    const hasErrors = results.some((r) => !r.success);

    if (hasErrors) {
      console.warn(
        '[CommandExecutor] Some commands failed:',
        results.filter((r) => !r.success),
      );
    }

    return { results, changeLog, hasErrors };
  }

  /**
   * §11.4: 路径根解析 —— 白名单内原样放行；伪根路径归位或拒绝。
   *
   * 根段定义：第一个 `.` 或 `[` 之前的字串（`社交.关系[名称=李明阳].好感度` → `社交`）。
   * 归位规则（内容无关，只看当前状态树的形状）：
   *   - 把路径按段拆开（方括号内不拆），依次尝试丢掉前 k 段（k = 0…n-1），
   *     在每个白名单根下、深度 ≤ MAX_RELOCATION_DEPTH 的对象节点里找"拥有剩余路径第一段键"的节点；
   *   - 候选 = 节点路径 + 剩余路径；只取最浅的一层候选；若恰好一个能解析到父级 → 归位；
   *   - 多个同样浅的候选 → 歧义，拒绝；一个都没有 → 拒绝。
   * 数组元素不作为归位目标（`[名称=X]` 之类的过滤段只能出现在剩余路径里，原样保留）。
   */
  private resolvePathRoot(path: string): PathResolution {
    if (!this.pathRootWhitelist) return { kind: 'ok' };
    const root = pathRootSegment(path);
    if (!root) return { kind: 'ok' }; // 畸形路径交给 state-manager 自己报错
    if (this.pathRootWhitelist.includes(root)) return { kind: 'ok' };

    const segments = splitPathSegments(path);
    for (let drop = 0; drop < segments.length; drop++) {
      const remaining = segments.slice(drop);
      const firstKey = segmentKey(remaining[0]);
      if (!firstKey) continue;
      const candidates = this.findRelocationCandidates(firstKey, remaining);
      if (candidates.length === 0) continue;
      const minDepth = Math.min(...candidates.map((c) => c.depth));
      const shallowest = candidates.filter((c) => c.depth === minDepth);
      if (shallowest.length === 1) {
        this.notifyPathRoot(root, path, `已归位到 "${shallowest[0].key}"`);
        return { kind: 'relocated', key: shallowest[0].key };
      }
      this.notifyPathRoot(root, path, `候选位置不唯一（${shallowest.map((c) => c.key).join(' / ')}），已拒绝`);
      return { kind: 'rejected', error: `未知路径根段 "${root}"：候选位置不唯一，命令已拒绝（${path}）` };
    }
    this.notifyPathRoot(root, path, '在状态树中找不到可归位的位置，已拒绝');
    return { kind: 'rejected', error: `未知路径根段 "${root}"：状态树中无对应位置，命令已拒绝（${path}）` };
  }

  /** 在白名单根下搜索拥有 `firstKey` 的对象节点，返回能解析到父级的完整候选路径。 */
  private findRelocationCandidates(firstKey: string, remaining: string[]): Array<{ key: string; depth: number }> {
    const out: Array<{ key: string; depth: number }> = [];
    const tail = remaining.slice(1);
    const visit = (node: unknown, nodePath: string, depth: number): void => {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
      const obj = node as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(obj, firstKey)) {
        const key = [nodePath + '.' + remaining[0], ...tail].join('.');
        const parentKey = tail.length === 0 ? nodePath : [nodePath + '.' + remaining[0], ...tail.slice(0, -1)].join('.');
        const parent = this.stateManager.get<unknown>(parentKey);
        if (parent !== null && typeof parent === 'object') out.push({ key, depth });
      }
      if (depth >= MAX_RELOCATION_DEPTH) return;
      for (const [k, v] of Object.entries(obj)) visit(v, nodePath + '.' + k, depth + 1);
    };
    for (const root of this.pathRootWhitelist ?? []) visit(this.stateManager.get<unknown>(root), root, 1);
    return out;
  }

  /** 每 session 每个伪根只提示一次（console.warn + toast）。 */
  private notifyPathRoot(root: string, path: string, outcome: string): void {
    if (this.warnedUnknownRoots.has(root)) return;
    this.warnedUnknownRoots.add(root);
    const msg =
      `[CommandExecutor] AI 写入未知路径根段 "${root}"（完整路径: "${path}"）：${outcome}。` +
      `若这是合法字段，请添加到 state-schema.json 的顶层 properties。本 session 内该根段不再重复提示。`;
    console.warn(msg);
    eventBus.emit('ui:toast', {
      type: 'warning',
      i18nKey: 'engine.toast.unknownPathRoot',
      i18nParams: { root, outcome },
      message: `AI 写入未知路径根段 "${root}"：${outcome}`,
      duration: 3000,
    });
  }
}

// ─── Path-root resolution helpers ───

/** 归位搜索的最大深度（根 = 1）：`角色.身体.部位` 的 `部位` 节点深度为 3。 */
const MAX_RELOCATION_DEPTH = 3;

type PathResolution =
  | { kind: 'ok' }
  | { kind: 'relocated'; key: string }
  | { kind: 'rejected'; error: string };

/** 第一个 `.` 或 `[` 之前的根段。 */
function pathRootSegment(path: string): string {
  const firstDot = path.indexOf('.');
  const firstBracket = path.indexOf('[');
  let endIdx: number;
  if (firstDot === -1 && firstBracket === -1) endIdx = path.length;
  else if (firstDot === -1) endIdx = firstBracket;
  else if (firstBracket === -1) endIdx = firstDot;
  else endIdx = Math.min(firstDot, firstBracket);
  return path.slice(0, endIdx).trim();
}

/** 按 `.` 拆段，方括号内的 `.` 不拆（`社交.关系[名称=张.三].好感度` → 3 段）。 */
function splitPathSegments(path: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (const ch of path) {
    if (ch === '[') depth++;
    if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === '.' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.filter((seg) => seg.length > 0);
}

/** 段的键名（去掉过滤/索引后缀）：`部位[名称=X]` → `部位`。 */
function segmentKey(segment: string): string {
  const b = segment.indexOf('[');
  return (b === -1 ? segment : segment.slice(0, b)).trim();
}

// ─── Helpers ───

/** 将数值夹至 [0, MAX_NUMERIC_VALUE]（负值夹至 0，极端值夹至上限） */
function clampNumber(n: number): number {
  return Math.max(0, Math.min(MAX_NUMERIC_VALUE, n));
}

/**
 * 清理 AI 生成的值：
 * - 字符串 → trim
 * - NaN 数字 → 0
 * - 其他类型原样返回
 */
function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return Number.isNaN(value) ? 0 : value;
  return value;
}
