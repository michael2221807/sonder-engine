/**
 * 效果生命周期模块 — 管理状态效果（buff/debuff）的到期清理
 *
 * 游戏中的临时效果（如"中毒 3 天"、"祝福 10 回合"）存储在状态树的一个数组中。
 * 每个效果有起始时间和持续时长，本模块在 onRoundEnd 钩子中：
 * 1. 读取当前游戏时间
 * 2. 遍历效果数组
 * 3. 比较 (startTime + duration) 与当前时间
 * 4. 移除已过期的效果
 *
 * 永久效果通过特殊的哨兵持续时长值（如 99999）标记，永不过期。
 *
 * 配置示例（EffectLifecycleConfig）：
 * {
 *   "effectsPath": "角色.状态效果",
 *   "effectSchema": {
 *     "nameField": "名称",
 *     "typeField": "类型",
 *     "typeValues": ["buff", "debuff", "neutral"],
 *     "startTimeField": "开始时间",
 *     "durationField": "持续时间",
 *     "permanentSentinel": 99999
 *   }
 * }
 *
 * 对应 STEP-02 §3.10.2。
 */
import type { BehaviorModule } from './types';
import type { StateManager } from '../core/state-manager';
import type { EffectLifecycleConfig, CalendarConfig, ChangeLog } from '../types';

export class EffectLifecycleModule implements BehaviorModule {
  readonly id = 'effect-lifecycle';

  constructor(
    private effectConfig: EffectLifecycleConfig,
    private calendarConfig: CalendarConfig,
  ) {}

  /**
   * onRoundEnd 钩子 — 每轮结束时清理过期效果
   *
   * 在 time-service 归一化时间之后执行（依赖注册顺序），
   * 确保当前时间已经是正确的进位后值。
   */
  onRoundEnd(stateManager: StateManager): void {
    this.deduplicateEffects(stateManager);
    this.removeExpiredEffects(stateManager);
  }

  /**
   * A status written this round starts now on the game clock, whatever start time the model wrote. The model
   * reckons time from the story and can drift from the clock by hours; a status it just wrote must not be
   * expired at the same round end (2026-09-26, PO G1). Runs after TimeService, so the stamp includes this
   * round's time advance (the batch observer stamped it once already, before the clock was normalized).
   */
  afterCommands(stateManager: StateManager, changeLog: ChangeLog): void {
    this.stampWritten(stateManager, changeLog);
  }

  /**
   * Stamp the statuses a batch wrote with the game clock. Written = pushed in the batch, or a name that was not
   * in the list before the batch's first change to it; editing a field of an existing status does not restart
   * it. Only the last copy of a name is stamped (the one the round-end dedup keeps). Wired to every command
   * batch (CommandExecutor.observeBatches) so writes outside the main round are covered too.
   */
  stampWritten(stateManager: StateManager, changeLog: ChangeLog): void {
    const path = this.effectConfig.effectsPath;
    const changes = changeLog.changes.filter((c) => c.path === path);
    if (changes.length === 0) return;
    const effects = stateManager.get<Record<string, unknown>[]>(path);
    if (!Array.isArray(effects) || effects.length === 0) return;
    const now = this.currentTimeObject(stateManager);
    if (!now) return;

    const nameOf = (effect: unknown) => (effect && typeof effect === 'object'
      ? String((effect as Record<string, unknown>)[this.effectConfig.effectSchema.nameField] ?? '').trim() : '');
    const listOf = (value: unknown) => (Array.isArray(value) ? value : []);
    const before = new Set(listOf(changes[0].oldValue).map(nameOf));
    const written = new Set<string>();
    for (const change of changes) if (change.action === 'push') written.add(nameOf(listOf(change.newValue).at(-1)));
    for (const effect of effects) if (!before.has(nameOf(effect))) written.add(nameOf(effect));
    written.delete('');
    if (written.size === 0) return;

    const last = new Map<string, number>();
    effects.forEach((effect, index) => { if (written.has(nameOf(effect))) last.set(nameOf(effect), index); });
    const startField = this.effectConfig.effectSchema.startTimeField;
    const stamped = new Set(last.values());
    stateManager.set(path, effects.map((effect, index) => (stamped.has(index) ? { ...effect, [startField]: { ...now } } : effect)), 'system');
  }

  /** The game clock as a start-time object: the calendar's own fields, nothing else. */
  private currentTimeObject(stateManager: StateManager): Record<string, number> | null {
    const time = stateManager.get<Record<string, unknown>>(this.calendarConfig.timeFieldPath);
    if (!time || typeof time !== 'object') return null;
    return Object.fromEntries(Object.keys(this.calendarConfig.timeFieldFormat).map((key) => [key, Number(time[key] ?? 0)]));
  }

  /**
   * onGameLoad 钩子 — 读档后也做一次清理
   * 玩家可能存档后过了很久再读档，期间效果应该已经过期
   */
  onGameLoad(stateManager: StateManager): void {
    this.deduplicateEffects(stateManager);
    this.removeExpiredEffects(stateManager);
  }

  /**
   * 同名效果去重 — 保留最后出现的（即 AI 最新推入的版本）
   *
   * AI 模型有时会 push 与现有效果同名的新条目。
   * 从数组尾部向前扫描，首次出现的名称保留，重复的丢弃。
   */
  private deduplicateEffects(stateManager: StateManager): void {
    const effects = stateManager.get<Record<string, unknown>[]>(this.effectConfig.effectsPath);
    if (!Array.isArray(effects) || effects.length <= 1) return;

    const nameField = this.effectConfig.effectSchema.nameField;
    const seen = new Set<string>();
    const deduped: Record<string, unknown>[] = [];

    for (let i = effects.length - 1; i >= 0; i--) {
      const name = String(effects[i][nameField] ?? '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      deduped.push(effects[i]);
    }

    deduped.reverse();

    if (deduped.length < effects.length) {
      const removed = effects.length - deduped.length;
      console.log(`[EffectLifecycle] Deduplicated ${removed} same-name effect(s)`);
      stateManager.set(this.effectConfig.effectsPath, deduped, 'system');
    }
  }

  /**
   * 核心清理逻辑 — 遍历效果数组，移除过期项
   *
   * 时间比较策略：
   * 将时间对象转换为"总分钟数"（标量）进行比较，
   * 避免在多维时间结构上做复杂的逐字段比较。
   */
  private removeExpiredEffects(stateManager: StateManager): void {
    const effects = stateManager.get<Record<string, unknown>[]>(this.effectConfig.effectsPath);
    if (!Array.isArray(effects) || effects.length === 0) return;

    const currentTimeScalar = this.getCurrentTimeScalar(stateManager);
    const schema = this.effectConfig.effectSchema;

    const surviving = effects.filter((effect) => {
      const duration = Number(effect[schema.durationField] ?? 0);

      // 永久效果 — 永不过期
      if (duration >= schema.permanentSentinel) return true;

      const startTimeRaw = effect[schema.startTimeField];
      const startScalar = this.timeObjectToScalar(startTimeRaw);

      // 无法解析的起始时间保留效果（安全默认行为）
      if (startScalar === null) return true;

      return (startScalar + duration) > currentTimeScalar;
    });

    // 仅在有效果被移除时才写回，避免不必要的状态变更
    if (surviving.length < effects.length) {
      const removed = effects.length - surviving.length;
      console.log(`[EffectLifecycle] Removed ${removed} expired effect(s)`);
      stateManager.set(this.effectConfig.effectsPath, surviving, 'system');
    }
  }

  /**
   * 读取当前游戏时间并转换为标量
   * 使用 CalendarConfig 的进位规则做线性映射
   */
  private getCurrentTimeScalar(stateManager: StateManager): number {
    const timeObj = stateManager.get<Record<string, unknown>>(this.calendarConfig.timeFieldPath);
    return this.timeObjectToScalar(timeObj) ?? 0;
  }

  /**
   * 将时间对象转换为"总分钟数"标量
   *
   * 转换公式（从最大单位到最小单位逐级展开）：
   *   total = ((year * monthsPerYear + month) * daysPerMonth + day) * hoursPerDay + hour) * minutesPerHour + minute
   *
   * 这确保了任何两个时间点都能通过简单的数值比较判断先后。
   */
  private timeObjectToScalar(timeObj: unknown): number | null {
    if (timeObj === null || timeObj === undefined || typeof timeObj !== 'object') return null;

    const obj = timeObj as Record<string, unknown>;
    const keys = Object.keys(this.calendarConfig.timeFieldFormat);
    // keys 约定顺序：年、月、日、时、分
    const year = Number(obj[keys[0]] ?? 0);
    const month = Number(obj[keys[1]] ?? 0);
    const day = Number(obj[keys[2]] ?? 0);
    const hour = Number(obj[keys[3]] ?? 0);
    const minute = Number(obj[keys[4]] ?? 0);

    if ([year, month, day, hour, minute].some(Number.isNaN)) return null;

    const { monthsPerYear, daysPerMonth, hoursPerDay, minutesPerHour } = this.calendarConfig;
    return (
      (((year * monthsPerYear + month) * daysPerMonth + day) * hoursPerDay + hour) *
        minutesPerHour +
      minute
    );
  }
}
