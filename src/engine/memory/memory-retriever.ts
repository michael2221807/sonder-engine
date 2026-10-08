/**
 * 记忆检索器 — 将多层记忆编译为 prompt 注入文本
 *
 * 2026-04-11 重构：
 * - 接收 `playerName` + `recentNpcNames` 参数，隐式中期记忆**按相关角色过滤**
 * - MidTermEntry 结构改为中文字段 (`相关角色/事件时间/记忆主体`) + 可选 `已精炼` 标记
 * - LongTermEntry 继续按 `category` 分组
 *
 * 设计考量：
 * - 按重要性倒序组织（长期 > 中期 > 短期），demo 和我们都遵循（primacy effect）
 * - 每层级用清晰的标题分隔，帮助 AI 区分记忆时效
 * - 空层级静默跳过，减少 token 浪费
 * - **隐式中期按相关角色过滤**：仅注入与当前 context 有交集的条目，参照 demo
 *   `memoryHelpers.ts:filterImplicitMidTermByRelevantCharacters`
 *
 * 对应 STEP-03B M3.5、demo `memoryHelpers.ts`。
 */
import type { StateManager } from '../core/state-manager';
import type {
  MemoryPathConfig,
  ShortTermEntry,
  LongTermEntry,
  MidTermEntry,
  ImplicitMidTermEntry,
} from './memory-manager';
import type { MemoryManager } from './memory-manager';

/** 检索上下文 — 用于隐式中期记忆的相关角色过滤 */
export interface RetrievalContext {
  /** 玩家名称（用于相关角色集合） */
  playerName?: string;
  /** 最近活跃 NPC 名称列表（相关角色过滤的主体） */
  recentNpcNames?: string[];
  /** 跳过短期记忆层（当 chatHistory 已包含相同内容时避免重复） */
  skipShortTerm?: boolean;
}

export class MemoryRetriever {
  constructor(
    private config: MemoryPathConfig,
    /** 2026-04-11: 依赖 MemoryManager 用于隐式中期过滤（需要其 normalizeImplicitEntry + filter 逻辑） */
    private memoryManager?: MemoryManager,
  ) {}

  /**
   * 检索并格式化所有记忆层级
   *
   * @param stateManager 状态管理器
   * @param ctx 可选的检索上下文 —— 影响隐式中期的相关角色过滤。
   *            未提供时隐式中期全量输出
   */
  retrieve(stateManager: StateManager, ctx?: RetrievalContext): string {
    const sections: string[] = [];

    // ── 长期记忆（故事主线 / 世界观进化）放最前 ──
    const longTerm = stateManager.get<LongTermEntry[]>(this.config.longTermPath) ?? [];
    if (longTerm.length > 0) {
      sections.push(
        this.formatSection(
          '长期记忆（世界观与故事主线）',
          longTerm.map((e) => {
            const cat = e.category ? `[${e.category}] ` : '';
            return `${cat}${e.content}`;
          }),
        ),
      );
    }

    // ── 中期记忆（结构化事件） ──
    // 同时展示已精炼和未精炼条目，在前缀标明状态让 AI 感知
    const midTerm = stateManager.get<MidTermEntry[]>(this.config.midTermPath) ?? [];
    if (midTerm.length > 0) {
      sections.push(
        this.formatSection(
          '中期记忆（近期事件摘要）',
          midTerm.map((entry) => this.formatMidTermEntry(entry)),
        ),
      );
    }

    // ── 隐式中期记忆（按相关角色过滤） ──
    // 2026-04-11：与 demo 对齐 —— 仅注入 `相关角色 ∩ (player + recentNPCs)` 的条目。
    // 没有 MemoryManager 或 ctx 时降级为全量注入（保持兼容）。
    let implicitEntries: ImplicitMidTermEntry[] = [];
    if (this.memoryManager && ctx) {
      implicitEntries = this.memoryManager.filterImplicitByRelevantChars(
        ctx.playerName ?? '',
        ctx.recentNpcNames ?? [],
      );
    } else {
      // Fallback 到直接读取全量（旧行为，用于无 ctx 的调用点兼容）
      const raw = stateManager.get<unknown[]>(this.config.implicitMidTermPath) ?? [];
      for (const v of raw) {
        const normalized = this.normalizeImplicitFallback(v);
        if (normalized) implicitEntries.push(normalized);
      }
    }

    if (implicitEntries.length > 0) {
      sections.push(
        this.formatSection(
          '隐式记忆（AI 标记的重要信息，按相关角色过滤）',
          implicitEntries.map((entry) => this.formatImplicitEntry(entry)),
        ),
      );
    }

    // ── 短期记忆（原文叙事）放最后 —— 最近几轮的原始叙事 ──
    // Skip when caller already injects the same content via chatHistory messages
    if (!ctx?.skipShortTerm) {
      const shortTerm = stateManager.get<ShortTermEntry[]>(this.config.shortTermPath) ?? [];
      if (shortTerm.length > 0) {
        sections.push(
          this.formatSection(
            '短期记忆（最近对话）',
            shortTerm.map((e) => e.summary),
          ),
        );
      }
    }

    return sections.join('\n\n');
  }

  /**
   * 格式化单个记忆层级为带标题的文本块
   *
   * 使用 markdown 标题 + 编号列表，便于 AI 解析结构并在生成时引用特定条目。
   */
  private formatSection(title: string, entries: string[]): string {
    const header = `### ${title}`;
    const body = entries
      .map((entry, index) => `${index + 1}. ${entry}`)
      .join('\n');
    return `${header}\n${body}`;
  }

  /**
   * 格式化一条中期记忆为单行文本
   *
   * 参照 demo `memoryHelpers.ts:formatMidTermEntryForPrompt`：
   * - 保留 相关角色、事件时间、记忆主体 三个关键属性
   * - 已精炼的条目加 `[已精炼]` 前缀让 AI 知道这是 permanent 条目
   */
  private formatMidTermEntry(entry: MidTermEntry): string {
    const refinedTag = entry.已精炼 ? '[已精炼] ' : '';
    const roles =
      Array.isArray(entry.相关角色) && entry.相关角色.length > 0
        ? `【相关角色: ${entry.相关角色.join('、')}】`
        : '';
    const time = entry.事件时间 && entry.事件时间.trim() ? `【${entry.事件时间.trim()}】` : '';
    const body = entry.记忆主体 ?? '';
    return `${refinedTag}${roles}${time}${body}`;
  }

  /** 格式化一条隐式中期记忆为单行（时间 + 记忆主体） */
  private formatImplicitEntry(entry: ImplicitMidTermEntry): string {
    const time = entry.事件时间 && entry.事件时间.trim() ? `[${entry.事件时间.trim()}] ` : '';
    return `${time}${entry.记忆主体 ?? ''}`.trim();
  }

  /**
   * Fallback 归一化：委托 MemoryManager 消除重复逻辑（CR S-02）
   *
   * 只在无 MemoryManager 依赖时（兼容旧调用路径）使用极简版。
   * 有 MemoryManager 时不会走这条路径。
   */
  private normalizeImplicitFallback(value: unknown): ImplicitMidTermEntry | null {
    if (this.memoryManager) {
      return this.memoryManager.normalizeImplicitEntry(value as ImplicitMidTermEntry | string | Record<string, unknown>);
    }
    if (typeof value === 'string') {
      return value.trim() ? { 相关角色: [], 事件时间: '', 记忆主体: value.trim() } : null;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if (obj['_占位'] === true) return null;
      const body =
        (typeof obj['记忆主体'] === 'string' && (obj['记忆主体'] as string)) ||
        (typeof obj['content'] === 'string' && (obj['content'] as string)) ||
        '';
      if (!body.trim()) return null;
      return { 相关角色: [], 事件时间: '', 记忆主体: body.trim() };
    }
    return null;
  }
}
