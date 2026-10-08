/**
 * Engram 配置持久化 — localStorage 读写工具
 *
 * 职责：
 * 1. `loadEngramConfig()` — 从 localStorage 读取并 normalize 配置
 * 2. `saveEngramConfig()` — 将配置序列化写入 localStorage
 * 3. `normalizeEngramConfig()` — 对任意外来对象做类型安全的字段归一化
 *
 * 设计要点：
 * - 任何字段缺失或类型错误都回退到 DEFAULT_ENGRAM_CONFIG 中对应的默认值
 * - 数值字段都做范围约束，防止注入非法值
 * - 所有函数都在 try/catch 内处理 localStorage 不可用的场景（隐私模式等）
 *
 * 对应 Phase E.4.2 — see docs/history/parity-impl-plan-addendum.md
 */
// CR-8: 从 engram-types.ts 导入（不再依赖 engram-manager.ts，消除循环导入）
import { DEFAULT_ENGRAM_CONFIG } from './engram-types';
import type { EngramConfig } from './engram-types';
import { eventBus } from '../../core/event-bus';

export const ENGRAM_CONFIG_KEY = 'aga_engram_config';

/**
 * 从 localStorage 加载 EngramConfig
 *
 * 若不存在或解析失败，返回 DEFAULT_ENGRAM_CONFIG 的浅拷贝。
 * 调用者获得的始终是经过 normalizeEngramConfig 处理的合法配置。
 */
export function loadEngramConfig(): EngramConfig {
  try {
    const raw = localStorage.getItem(ENGRAM_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_ENGRAM_CONFIG };
    return normalizeEngramConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_ENGRAM_CONFIG };
  }
}

/**
 * 将 EngramConfig 保存到 localStorage
 *
 * 失败时静默处理（隐私模式下 localStorage 不可用属正常情况）。
 */
export function saveEngramConfig(config: EngramConfig): void {
  try {
    localStorage.setItem(ENGRAM_CONFIG_KEY, JSON.stringify(config));
    // 通知 UI（如 LeftSidebar）Engram 配置已变更，以便同步可见性开关
    eventBus.emit('engram:config-changed', { debug: config.debug, enabled: config.enabled });
  } catch (err) {
    console.warn('[EngramConfig] 保存失败（localStorage 不可用）:', err);
  }
}

/**
 * 将任意外来对象归一化为合法的 EngramConfig
 *
 * 对每个字段：
 * - 类型正确 → 使用原值（数值字段额外做范围约束）
 * - 类型错误或缺失 → 回退到 DEFAULT_ENGRAM_CONFIG 中的默认值
 *
 * 不使用 `any`：通过局部类型断言 (`as unknown as Record<string, unknown>`)
 * 安全提取嵌套字段。
 */
function normalizeEngramConfig(raw: unknown): EngramConfig {
  const d = DEFAULT_ENGRAM_CONFIG;
  if (!raw || typeof raw !== 'object') return { ...d };

  const r = raw as Record<string, unknown>;

  // ── 嵌套字段提取辅助 ──
  const emb = (r.embedding && typeof r.embedding === 'object')
    ? r.embedding as Record<string, unknown>
    : {};
  const rnk = (r.rerank && typeof r.rerank === 'object')
    ? r.rerank as Record<string, unknown>
    : {};
  const trm = (r.trim && typeof r.trim === 'object')
    ? r.trim as Record<string, unknown>
    : {};

  return {
    enabled:
      typeof r.enabled === 'boolean' ? r.enabled : d.enabled,

    retrievalMode:
      r.retrievalMode === 'legacy' ? 'legacy' : 'hybrid',

    embedding: {
      enabled:
        typeof emb.enabled === 'boolean' ? emb.enabled : d.embedding.enabled,
      topK:
        clamp(toNumber(emb.topK, d.embedding.topK), 1, 200),
      minScore:
        clamp(toNumber(emb.minScore, d.embedding.minScore), 0, 1),
    },

    rerank: {
      enabled:
        typeof rnk.enabled === 'boolean' ? rnk.enabled : d.rerank.enabled,
      topN:
        clamp(toNumber(rnk.topN, d.rerank.topN), 1, 50),
    },

    trim: {
      trigger:
        trm.trigger === 'token' ? 'token' : 'count',
      tokenLimit:
        clamp(toNumber(trm.tokenLimit, d.trim.tokenLimit), 500, 50_000),
      countLimit:
        clamp(toNumber(trm.countLimit, d.trim.countLimit), 10, 500),
      keepRecent:
        clamp(toNumber(trm.keepRecent, d.trim.keepRecent), 1, 100),
    },

    maxEvents:
      clamp(toNumber(r.maxEvents, d.maxEvents), 10, 500),
    maxEntities:
      clamp(toNumber(r.maxEntities, d.maxEntities), 5, 200),

    pruneToImportantNpcs:
      typeof r.pruneToImportantNpcs === 'boolean'
        ? r.pruneToImportantNpcs
        : d.pruneToImportantNpcs,

    embeddingProvider:
      typeof r.embeddingProvider === 'string' ? r.embeddingProvider : undefined,
    embeddingModel:
      typeof r.embeddingModel === 'string' ? r.embeddingModel : undefined,

    debug:
      typeof r.debug === 'boolean' ? r.debug : d.debug,

    // V1 'shadow' mode removed in V2 — migrate persisted configs to 'active'
    knowledgeEdgeMode:
      r.knowledgeEdgeMode === 'active' || r.knowledgeEdgeMode === 'shadow'
        ? 'active'
        : r.knowledgeEdgeMode === 'off' ? 'off' : d.knowledgeEdgeMode,
    recencyDecayBase:
      clamp(toNumber(r.recencyDecayBase, d.recencyDecayBase!), 0.9, 0.9999),
    recencyDecayFloor:
      clamp(toNumber(r.recencyDecayFloor, d.recencyDecayFloor!), 0, 0.5),
    edgeCapacity:
      clamp(toNumber(r.edgeCapacity, d.edgeCapacity!), 100, 5000),
    shortTermWindow:
      clamp(toNumber(r.shortTermWindow, d.shortTermWindow!), 0, 20),
    maxCandidates:
      clamp(toNumber(r.maxCandidates, d.maxCandidates!), 5, 100),
    edgeReviewThreshold:
      clamp(toNumber(r.edgeReviewThreshold, d.edgeReviewThreshold!), 0.5, 0.9),
    edgeReviewPerFactCap:
      clamp(toNumber(r.edgeReviewPerFactCap, d.edgeReviewPerFactCap!), 1, 20),
    edgeReviewGlobalCap:
      clamp(toNumber(r.edgeReviewGlobalCap, d.edgeReviewGlobalCap!), 10, 200),
  };
}

// ─── Helpers ───

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
