/**
 * 时间服务模块 — 虚拟日历的进位归一化和年龄更新
 *
 * 问题背景：
 * AI 在修改游戏时间时只做简单加减（如"分钟 + 90"），
 * 不会处理进位逻辑（90 分钟应该进位为 1 小时 30 分钟）。
 * 本模块在 afterCommands 钩子中检测时间字段是否溢出，
 * 并按 CalendarConfig 的进位规则做 cascade 归一化。
 *
 * 归一化流程：
 * 1. 从状态树读取时间对象（由 CalendarConfig.timeFieldPath 定位）
 * 2. 按 分钟→小时→天→月→年 的顺序逐级检查溢出
 * 3. 溢出部分进位到上一级，当前级取余
 * 4. 写回状态树
 *
 * 年龄自动更新：
 * 如果时间对象中存在"年"字段且状态树中有年龄字段（约定路径），
 * 则在年份增长时同步增加年龄。
 *
 * 对应 STEP-02 §3.10.1。
 */
import type { BehaviorModule } from './types';
import type { StateManager } from '../core/state-manager';
import type { ChangeLog, CalendarConfig } from '../types';
import type { EnginePathConfig } from '../pipeline/types';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';

/**
 * 时间字段在状态树中的标准字段名
 * CalendarConfig.timeFieldFormat 的 key 值定义了实际使用的字段名，
 * 但进位逻辑需要知道这些字段的语义角色（哪个是"分钟"级别、哪个是"小时"级别等）。
 * 本模块按 STEP-02 约定的字段顺序处理：从最小单位到最大单位。
 */
interface TimeFields {
  minute: string;
  hour: string;
  day: string;
  month: string;
  year: string;
}

/** Field names used when timeFieldFormat declares fewer than five keys. */
const FALLBACK_FIELDS: TimeFields = { year: 'year', month: 'month', day: 'day', hour: 'hour', minute: 'minute' };

/**
 * The game clock every module reads (TimeService, EffectLifecycle), built from the engine path config so the
 * two can never disagree on which fields exist: 60 minutes, 24 hours, 30 days, 12 months.
 */
export function gameCalendar(paths: Pick<EnginePathConfig, 'gameTime' | 'gameTimeFieldNames'>): CalendarConfig {
  const f = paths.gameTimeFieldNames;
  return {
    minutesPerHour: 60,
    hoursPerDay: 24,
    daysPerMonth: 30,
    monthsPerYear: 12,
    timeFieldPath: paths.gameTime,
    timeFieldFormat: { [f.year]: 'number', [f.month]: 'number', [f.day]: 'number', [f.hour]: 'number', [f.minute]: 'number' },
  };
}

export class TimeService implements BehaviorModule {
  readonly id = 'time-service';

  /** 进位规则 */
  private config: CalendarConfig;
  /** 时间字段语义映射 — 由 timeFieldFormat 的 key 顺序推断 */
  private fieldNames: TimeFields;
  /** 角色年龄路径（由 EnginePathConfig 注入） */
  private characterAgePath: string;

  constructor(config: CalendarConfig, characterAgePath?: string) {
    this.characterAgePath = characterAgePath ?? DEFAULT_ENGINE_PATHS.characterAge;
    this.config = config;
    /*
     * timeFieldFormat 的 key 按照从大到小的约定排列（年、月、日、时、分），
     * 我们需要反转为从小到大以便做进位。
     * 典型配置示例：{ "年": "number", "月": "number", "日": "number", "时": "number", "分": "number" }
     */
    const keys = Object.keys(config.timeFieldFormat);
    this.fieldNames = {
      year: keys[0] ?? FALLBACK_FIELDS.year,
      month: keys[1] ?? FALLBACK_FIELDS.month,
      day: keys[2] ?? FALLBACK_FIELDS.day,
      hour: keys[3] ?? FALLBACK_FIELDS.hour,
      minute: keys[4] ?? FALLBACK_FIELDS.minute,
    };
  }

  /**
   * afterCommands 钩子 — AI 修改时间后做进位归一化
   *
   * 只在 changeLog 中包含时间路径的变更时才执行，
   * 避免每次 AI 回复都做不必要的归一化计算。
   */
  afterCommands(stateManager: StateManager, changeLog: ChangeLog): void {
    const timePath = this.config.timeFieldPath;
    const hasTimeChange = changeLog.changes.some((c) => c.path.startsWith(timePath));
    if (!hasTimeChange) return;

    this.normalizeTime(stateManager);
  }

  /**
   * onGameLoad 钩子 — 读档后确保时间数据合法
   * 防止手动编辑存档导致的非法时间值
   */
  onGameLoad(stateManager: StateManager): void {
    this.repairUncarriedClock(stateManager);
    this.normalizeTime(stateManager);
  }

  /**
   * A save written while this service was wired without the hour/minute fields carries the fallback fields
   * (`hour`, `minute`) next to the configured ones, and its real minute and hour were never carried (a minute
   * value in the thousands). Keep the date the save shows, fold the minute and hour into range, and drop the
   * fallback fields (2026-09-26, PO D1: the story's date stays where the player left it).
   */
  private repairUncarriedClock(stateManager: StateManager): void {
    const basePath = this.config.timeFieldPath;
    const time = stateManager.get<unknown>(basePath);
    if (!time || typeof time !== 'object' || Array.isArray(time)) return;
    const configured = new Set(Object.values(this.fieldNames));
    const stray = Object.values(FALLBACK_FIELDS).filter((name) => !configured.has(name) && name in time);
    if (stray.length === 0) return;
    const fn = this.fieldNames;
    const fold = (value: number, limit: number) => (limit > 0 ? ((value % limit) + limit) % limit : value);
    this.writeTimeField(stateManager, basePath, fn.minute, fold(this.readTimeField(stateManager, basePath, fn.minute), this.config.minutesPerHour));
    this.writeTimeField(stateManager, basePath, fn.hour, fold(this.readTimeField(stateManager, basePath, fn.hour), this.config.hoursPerDay));
    for (const name of stray) stateManager.delete(`${basePath}.${name}`, 'system');
  }

  /**
   * 核心归一化逻辑 — 按从小到大的顺序逐级进位
   *
   * 每一级的进位规则：
   *   carry = Math.floor(value / limit)
   *   remainder = value - carry * limit  (使用减法而非模运算，正确处理负数)
   *
   * 负数处理：当值为负时向下借位（如 -1 分钟 → 上一小时借 1，分钟变为 limit-1）
   */
  private normalizeTime(stateManager: StateManager): void {
    const basePath = this.config.timeFieldPath;
    const fn = this.fieldNames;
    const time = stateManager.get<unknown>(basePath);
    if (!time || typeof time !== 'object' || Array.isArray(time)) return;

    const minute = this.readTimeField(stateManager, basePath, fn.minute);
    const hour = this.readTimeField(stateManager, basePath, fn.hour);
    const day = this.readTimeField(stateManager, basePath, fn.day);
    const month = this.readTimeField(stateManager, basePath, fn.month);
    const year = this.readTimeField(stateManager, basePath, fn.year);

    const oldYear = year;
    // Day and month count from 1 (day 30 is still this month; day 31 carries). A field the clock does not
    // have keeps the old zero-based arithmetic, so normalizing never invents a date.
    const carryFor = (field: string) => (field in time ? this.carryOverFromOne.bind(this) : this.carryOver.bind(this));

    // 分钟 → 小时
    const [normMinute, carryToHour] = this.carryOver(minute, this.config.minutesPerHour);
    // 小时 → 天
    const [normHour, carryToDay] = this.carryOver(hour + carryToHour, this.config.hoursPerDay);
    // 天 → 月
    const [normDay, carryToMonth] = carryFor(fn.day)(day + carryToDay, this.config.daysPerMonth);
    // 月 → 年
    const [normMonth, carryToYear] = carryFor(fn.month)(month + carryToMonth, this.config.monthsPerYear);
    const normYear = year + carryToYear;

    this.writeTimeField(stateManager, basePath, fn.minute, normMinute);
    this.writeTimeField(stateManager, basePath, fn.hour, normHour);
    this.writeTimeField(stateManager, basePath, fn.day, normDay);
    this.writeTimeField(stateManager, basePath, fn.month, normMonth);
    this.writeTimeField(stateManager, basePath, fn.year, normYear);

    // 年份变动时同步更新年龄
    const yearDelta = normYear - oldYear;
    if (yearDelta !== 0) {
      this.updateAge(stateManager, yearDelta);
    }
  }

  /**
   * 进位计算 — 返回 [归一化后的值, 进位数]
   *
   * 使用 Math.floor 而非整除，使得负数也能正确处理：
   * 例如 value=-1, limit=60 → carry=-1, remainder=59（即借位1，得到59分钟）
   */
  private carryOver(value: number, limit: number): [remainder: number, carry: number] {
    if (limit <= 0) return [value, 0];
    const carry = Math.floor(value / limit);
    const remainder = value - carry * limit;
    return [remainder, carry];
  }

  /** Carry for a field counted from 1 (day, month): 1..limit stay, limit+1 → 1 with a carry, 0 → limit with a borrow. */
  private carryOverFromOne(value: number, limit: number): [remainder: number, carry: number] {
    if (limit <= 0) return [value, 0];
    const carry = Math.floor((value - 1) / limit);
    return [value - carry * limit, carry];
  }

  /** 从状态树读取时间子字段，缺失时默认为 0 */
  private readTimeField(stateManager: StateManager, basePath: string, field: string): number {
    const raw = stateManager.get<unknown>(`${basePath}.${field}`);
    const num = Number(raw);
    return Number.isNaN(num) ? 0 : num;
  }

  /** 写回时间子字段 */
  private writeTimeField(stateManager: StateManager, basePath: string, field: string, value: number): void {
    stateManager.set(`${basePath}.${field}`, value, 'system');
  }

  /**
   * 年龄同步更新
   *
   * 在状态树中查找常见的年龄路径（Game Pack 约定），
   * 找到后加上年份变化量。
   * 路径搜索顺序：角色.年龄 → 角色.属性.年龄（覆盖中文 Game Pack 常用布局）
   */
  private updateAge(stateManager: StateManager, yearDelta: number): void {
    const currentAge = stateManager.get<number>(this.characterAgePath);
    if (typeof currentAge === 'number') {
      stateManager.set(this.characterAgePath, currentAge + yearDelta, 'system');
    }
  }
}
