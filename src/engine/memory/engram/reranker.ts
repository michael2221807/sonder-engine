/**
 * 可选重排序服务 — 对检索结果做二次精排
 *
 * 在 UnifiedRetriever 的混合检索流程中，初步召回（向量近邻 + 图遍历）
 * 可能包含与查询不太相关的结果。Reranker 使用专用 AI 模型对候选结果
 * 做二次排序，显著提高检索质量。
 *
 * 双路径实现（§11.3 更新）：
 * - 如果分配给 rerank 的 API 类别是 'rerank'（如 SiliconFlow、Cohere、Jina）：
 *   直接 fetch `{url}/v1/rerank`（或 customRoutingPath 覆盖路径），
 *   body 和响应用 Cohere/SiliconFlow 格式，获得真正的 rerank 能力。
 * - 如果分配的是 'llm' 类 API（向后兼容）：
 *   退化到"让 LLM 假装 rerank"模式，把任务包装成 JSON prompt 走 chat completion。
 *   这种模式效果差且费 token，但不崩溃。
 * - 没有任何 rerank API 配置时：
 *   直接降级到按原始 vector/graph score 排序（fallbackSort）。
 *
 * 对应 STEP-03B M3.6 Engram 数据流（可选 Rerank 阶段）+ SiliconFlow 接入。
 */
import type { AIService } from '../../ai/ai-service';
import type { APIConfig } from '../../ai/types';
import { buildRemoteEndpoint, postJsonWithTimeout } from './remote-endpoint';

/** Rerank 默认端点路径（Cohere / SiliconFlow / Jina 都用这个） */
const DEFAULT_RERANK_PATH = '/v1/rerank';

/** Rerank API 超时（15 秒，独立于主回合 AI 超时） */
const RERANK_TIMEOUT_MS = 15_000;

/**
 * 构建 rerank 请求的完整端点 URL
 *
 * - 默认用 `{url}/v1/rerank`（SiliconFlow / Cohere / Jina 通用）
 * - 如果 config.useCustomRouting=true 且 customRoutingPath 非空，则用自定义路径覆盖默认
 * - 自动处理 url 尾部斜杠和 path 首部斜杠，保证结果合法
 */
function buildRerankEndpoint(config: APIConfig): string {
  return buildRemoteEndpoint(config, DEFAULT_RERANK_PATH, true);
}

// ─── 类型定义 ───

/** 待重排序的候选项 */
export interface RerankCandidate {
  /** 候选文本内容 */
  text: string;
  /** 初始得分（来自 RRF 融合） */
  score: number;
  /** 候选项来源标识（如 "edge", "entity", "event"），用于调试 */
  source: string;
  /** 附加的元数据（透传给下游，不参与排序） */
  metadata?: Record<string, unknown>;
}

/** 重排序后的结果（在候选项基础上增加 rerankScore） */
export interface RerankResult extends RerankCandidate {
  /** Reranker 给出的相关性分数（0-1，1 最相关） */
  rerankScore: number;
}

export interface RerankOutput {
  results: RerankResult[];
  actuallyReranked: boolean;
}

export class Reranker {
  constructor(private aiService: AIService) {}

  isAvailable(): boolean {
    return this.aiService.getConfigForUsage('rerank') != null;
  }

  /**
   * 对候选列表做重排序
   *
   * @param query 用户查询或当前场景描述
   * @param candidates 初步召回的候选列表
   * @param topK 返回前 K 个最相关的结果
   * @returns 按 rerankScore 降序排列的结果，如果 rerank 不可用则按原始分数排序
   */
  async rerank(
    query: string,
    candidates: RerankCandidate[],
    topK: number,
  ): Promise<RerankOutput> {
    if (candidates.length === 0) return { results: [], actuallyReranked: false };

    const config = this.aiService.getConfigForUsage('rerank');
    if (!config) {
      return { results: this.fallbackSort(candidates, topK), actuallyReranked: false };
    }

    try {
      const category = config.apiCategory ?? 'llm';
      if (category === 'rerank') {
        return { results: await this.callNativeRerankAPI(config, query, candidates, topK), actuallyReranked: true };
      }
      return { results: await this.callLLMRerankAPI(query, candidates, topK), actuallyReranked: false };
    } catch (err) {
      console.warn('[Reranker] Rerank failed, falling back to score sort:', err);
      return { results: this.fallbackSort(candidates, topK), actuallyReranked: false };
    }
  }

  /**
   * 调用真正的 rerank 端点（Cohere / SiliconFlow / Jina 格式）
   *
   * 直接 fetch `{url}/v1/rerank`（或 customRoutingPath 覆盖），不经过 aiService.generate。
   *
   * 请求体（Cohere-compatible，SiliconFlow 完全兼容）：
   * ```json
   * {
   *   "model": "BAAI/bge-reranker-v2-m3",
   *   "query": "...",
   *   "documents": ["...", "..."],
   *   "top_n": 10,
   *   "return_documents": false
   * }
   * ```
   *
   * 响应体：
   * ```json
   * {
   *   "id": "...",
   *   "results": [
   *     { "index": 2, "relevance_score": 0.95 },
   *     { "index": 0, "relevance_score": 0.87 }
   *   ]
   * }
   * ```
   *
   * 注意：API 返回的 results 已经是按 relevance_score 降序排列且已应用 top_n 的，
   * 我们只需按 index 映射回原始 candidate 并附加分数。
   */
  private async callNativeRerankAPI(
    config: APIConfig,
    query: string,
    candidates: RerankCandidate[],
    topK: number,
  ): Promise<RerankResult[]> {
    const endpoint = buildRerankEndpoint(config);
    const body = {
      model: config.model,
      query,
      documents: candidates.map((c) => c.text),
      top_n: topK,
      return_documents: false, // 我们本地已有 text，不需要 API 回传
    };

    const responseBody = await postJsonWithTimeout(
      endpoint, config.apiKey, body, RERANK_TIMEOUT_MS, '[Reranker]',
    );

    return this.parseNativeRerankResponse(responseBody, candidates, topK);
  }

  /**
   * 调用 LLM 假装 rerank（向后兼容路径）
   *
   * 将查询和候选文本打包为 JSON 发送给 chat completion 模型。
   * 这是 apiCategory='llm' 分配给 rerank usage 时的降级路径。
   * 效果远不如真 rerank，且每次都要把候选列表塞进 prompt 费 token。
   */
  private async callLLMRerankAPI(
    query: string,
    candidates: RerankCandidate[],
    topK: number,
  ): Promise<RerankResult[]> {
    const prompt = JSON.stringify({
      task: 'rerank',
      query,
      documents: candidates.map((c) => c.text),
      top_k: topK,
    });

    const raw = await this.aiService.generate({
      messages: [{ role: 'user', content: prompt }],
      usageType: 'rerank',
    });

    return this.parseLLMRerankResponse(raw, candidates, topK);
  }

  /**
   * 解析 Cohere/SiliconFlow 原生 rerank 响应
   *
   * 期望结构：`{ results: [{ index: number, relevance_score: number }] }`
   *
   * 特别处理：
   * - 未知 index（超出 candidates.length）跳过
   * - 缺失 relevance_score 跳过
   * - API 可能已按降序返回，但我们重新排一次以防万一
   */
  private parseNativeRerankResponse(
    data: unknown,
    candidates: RerankCandidate[],
    topK: number,
  ): RerankResult[] {
    if (data === null || typeof data !== 'object') {
      console.warn('[Reranker] Native rerank response is not an object, falling back');
      return this.fallbackSort(candidates, topK);
    }

    const obj = data as Record<string, unknown>;
    const results = obj.results;
    if (!Array.isArray(results)) {
      console.warn('[Reranker] Native rerank response missing "results" array, falling back');
      return this.fallbackSort(candidates, topK);
    }

    const scored: RerankResult[] = [];
    for (const item of results) {
      if (item === null || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const idx = typeof r.index === 'number' ? r.index : -1;
      const score = typeof r.relevance_score === 'number' ? r.relevance_score : NaN;
      if (idx < 0 || idx >= candidates.length) continue;
      if (!Number.isFinite(score)) continue;
      scored.push({ ...candidates[idx], rerankScore: score });
    }

    if (scored.length === 0) {
      console.warn('[Reranker] Native rerank returned no valid results, falling back');
      return this.fallbackSort(candidates, topK);
    }

    return scored
      .sort((a, b) => b.rerankScore - a.rerankScore)
      .slice(0, topK);
  }

  /**
   * 解析 LLM 假装 rerank 的响应（向后兼容路径）
   *
   * 支持 LLM 可能返回的几种格式：
   * 1. 分数数组: [0.95, 0.3, 0.8, ...] — 按候选顺序
   * 2. 对象数组: [{ index: 0, relevance_score: 0.95 }, ...] — Cohere 风格
   * 3. 包装对象: { results: [...] }
   */
  private parseLLMRerankResponse(
    raw: string,
    candidates: RerankCandidate[],
    topK: number,
  ): RerankResult[] {
    try {
      const parsed: unknown = JSON.parse(raw.trim());

      let scores: number[];

      if (Array.isArray(parsed)) {
        if (parsed.length > 0 && typeof parsed[0] === 'number') {
          // 格式1：纯分数数组
          scores = parsed as number[];
        } else if (parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) {
          // 格式2：对象数组（Cohere 风格）
          const indexed = parsed as Array<Record<string, unknown>>;
          scores = new Array(candidates.length).fill(0);
          for (const item of indexed) {
            const idx = typeof item.index === 'number' ? item.index : -1;
            const score = typeof item.relevance_score === 'number'
              ? item.relevance_score
              : typeof item.score === 'number'
                ? item.score
                : 0;
            if (idx >= 0 && idx < scores.length) {
              scores[idx] = score;
            }
          }
        } else {
          return this.fallbackSort(candidates, topK);
        }
      } else if (parsed !== null && typeof parsed === 'object') {
        // 包装在对象中: { results: [...] }
        const obj = parsed as Record<string, unknown>;
        const results = obj.results ?? obj.data;
        if (Array.isArray(results)) {
          return this.parseLLMRerankResponse(JSON.stringify(results), candidates, topK);
        }
        return this.fallbackSort(candidates, topK);
      } else {
        return this.fallbackSort(candidates, topK);
      }

      // 将分数附加到候选项上
      const resultsWithScores: RerankResult[] = candidates.map((c, i) => ({
        ...c,
        rerankScore: scores[i] ?? 0,
      }));

      return resultsWithScores
        .sort((a, b) => b.rerankScore - a.rerankScore)
        .slice(0, topK);
    } catch {
      console.warn('[Reranker] Failed to parse LLM rerank response');
      return this.fallbackSort(candidates, topK);
    }
  }

  /**
   * 降级排序 — 当 rerank 不可用时使用原始分数排序
   *
   * rerankScore 设为与原始 score 相同，让下游代码无需区分
   * "经过 rerank" 和 "未经过 rerank" 的结果。
   */
  private fallbackSort(candidates: RerankCandidate[], topK: number): RerankResult[] {
    return candidates
      .map((c) => ({ ...c, rerankScore: c.score }))
      .sort((a, b) => b.rerankScore - a.rerankScore)
      .slice(0, topK);
  }
}
