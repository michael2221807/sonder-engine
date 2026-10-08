/**
 * 文本向量化器 — 直接调用 Embedding API 端点
 *
 * E.1 重写：将原来通过 aiService.generate()（chat completion）冒充 embedding 的方式
 * 替换为直接调用各 provider 的原生 /v1/embeddings（或等效端点）。
 *
 * 支持的 Provider：
 * - OpenAI / DeepSeek / vLLM / 自定义 OpenAI 兼容：POST {url}/v1/embeddings
 * - Ollama：POST {url}/v1/embeddings（v0.3+ OpenAI 兼容模式）
 * - Cohere：POST {url}/v1/embed（不同请求/响应格式）
 * - Jina / Voyage：POST {url}/v1/embeddings（OpenAI 兼容）
 *
 * 降级策略（PseudoEmbed Fallback）：
 * - 当 embedding API 不可用、未配置、或调用失败时，
 *   自动切换到基于 FNV-1a hash 的确定性词袋向量。
 * - PseudoEmbed 的向量质量低于真实 embedding，但保证游戏不中断，
 *   仍可用于粗略的语义相似度比较。
 *
 * 对应 Phase E.1 — see docs/history/parity-impl-plan-addendum.md
 */
import type { AIService } from '../../ai/ai-service';
import type { APIConfig } from '../../ai/types';
import { buildRemoteEndpoint, postJsonWithTimeout } from './remote-endpoint';

// ─── 常量 ───

const EMBEDDING_TIMEOUT_MS = 15_000;
const PSEUDO_EMBED_DIM = 384;
const CACHE_MAX_SIZE = 500;

// ─── 缓存类型 ───

interface EmbeddingCacheEntry {
  text: string;
  vector: number[];
  timestamp: number;
}

// ─── Provider 检测 ───

type EmbeddingProviderFormat = 'openai' | 'cohere' | 'ollama';

/**
 * 从 APIConfig 推断向量化 provider 格式
 *
 * 检测顺序：URL 特征 > provider 字段 > 默认 OpenAI 兼容
 */
function detectEmbeddingFormat(config: APIConfig): EmbeddingProviderFormat {
  const url = config.url.toLowerCase();
  if (url.includes('cohere.ai') || url.includes('cohere.com')) return 'cohere';
  if (url.includes('ollama') || url.includes(':11434')) return 'ollama';
  // OpenAI, DeepSeek, Jina, Voyage, vLLM, custom — all use OpenAI-compatible format
  return 'openai';
}

/**
 * 构建向量化请求的端点 URL
 *
 * 优先级：
 * 1. `config.useCustomRouting=true + customRoutingPath` — 用户手动覆盖路径（高级）
 * 2. Provider format 自动检测 — cohere → /v1/embed，其他 → /v1/embeddings
 *
 * 自定义覆盖用于极少数非标准 embedding 服务（未来若接入其他 provider 时用）。
 * SiliconFlow / OpenAI / DeepSeek / Jina / Voyage / vLLM / Ollama 全部走 format 检测。
 */
function buildEmbeddingEndpoint(config: APIConfig, format: EmbeddingProviderFormat): string {
  // 1. customRoutingPath override and 2. the per-format default path, both in the shared helper
  switch (format) {
    case 'cohere': return buildRemoteEndpoint(config, '/v1/embed', false);
    case 'ollama':
    case 'openai':
    default:      return buildRemoteEndpoint(config, '/v1/embeddings', false);
  }
}

/**
 * 构建向量化请求的请求体
 */
function buildEmbeddingBody(
  texts: string[],
  model: string,
  format: EmbeddingProviderFormat,
): Record<string, unknown> {
  switch (format) {
    case 'cohere':
      return {
        model,
        texts,
        input_type: 'search_document',
        truncate: 'END',
      };
    case 'ollama':
    case 'openai':
    default:
      return { model, input: texts };
  }
}

/**
 * 从各 provider 的响应体中提取向量数组
 *
 * 支持格式：
 * - OpenAI: `{ data: [{ embedding: [...] }] }`
 * - Cohere: `{ embeddings: [[...]] }`
 * - 直接数组: `[[...], [...]]`
 * - 旧版包装: `{ embeddings: [[...]] }`
 */
function extractVectorsFromResponse(body: unknown, expectedCount: number): number[][] {
  if (!body || typeof body !== 'object') return [];
  const obj = body as Record<string, unknown>;

  // OpenAI format: data[].embedding
  if (Array.isArray(obj.data) && obj.data.length > 0) {
    const first = obj.data[0] as Record<string, unknown>;
    if (Array.isArray(first?.embedding)) {
      return (obj.data as Array<Record<string, unknown>>)
        .slice(0, expectedCount)
        .map((item) => item.embedding as number[]);
    }
  }

  // Cohere / generic: embeddings[][]
  if (Array.isArray(obj.embeddings) && obj.embeddings.length > 0) {
    if (Array.isArray(obj.embeddings[0])) {
      return (obj.embeddings as number[][]).slice(0, expectedCount);
    }
  }

  // Direct array of vectors
  if (Array.isArray(body) && Array.isArray((body as unknown[])[0])) {
    return (body as number[][]).slice(0, expectedCount);
  }

  return [];
}

// ─── PseudoEmbed Fallback ───

/**
 * FNV-1a hash 词袋向量（deterministic, L2-normalized）
 *
 * 算法：将文本拆分为词元，对每个词元计算 FNV-1a hash，
 * 将 hash % dim 的位置累加，最终做 L2 归一化。
 *
 * 优点：
 * - 零依赖，零网络，同一文本永远产生相同向量
 * - 语义上有一定的词汇覆盖性（同词同位置）
 * 缺点：
 * - 无法捕获同义词/上下文语义，质量远低于真实 embedding
 */
export function pseudoEmbed(text: string, dim = PSEUDO_EMBED_DIM): number[] {
  const tokens = text.toLowerCase().split(/[\s\u4e00-\u9fff]+/).filter(Boolean);
  const vec = new Float32Array(dim);

  for (const token of tokens) {
    // FNV-1a hash (32-bit)
    let hash = 2_166_136_261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    vec[hash % dim] += 1;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= norm;
  }

  return Array.from(vec);
}

// ─── Embedder 类 ───

export class Embedder {
  private cache = new Map<string, EmbeddingCacheEntry>();

  constructor(private aiService: AIService) {}

  /**
   * 批量向量化文本
   *
   * 优先使用缓存，未命中部分调用 API。API 不可用时降级到 pseudoEmbed。
   * 输入输出按索引一一对应。
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    // 命中缓存的直接填充
    for (let i = 0; i < texts.length; i++) {
      const cached = this.cache.get(texts[i]);
      if (cached) {
        results[i] = cached.vector;
      } else if (texts[i].trim().length > 0) {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]);
      }
    }

    // API 调用处理未缓存文本
    if (uncachedTexts.length > 0) {
      let newVectors: number[][];
      try {
        newVectors = await this.callEmbeddingAPI(uncachedTexts);
      } catch (err) {
        console.warn('[Embedder] Embedding API failed, falling back to pseudoEmbed:', err);
        newVectors = uncachedTexts.map((t) => pseudoEmbed(t));
      }

      // pseudoEmbed fallback 兜底（callEmbeddingAPI 返回空数组时）
      if (newVectors.length === 0) {
        newVectors = uncachedTexts.map((t) => pseudoEmbed(t));
      }

      for (let j = 0; j < uncachedIndices.length; j++) {
        const idx = uncachedIndices[j];
        const vector = newVectors[j];
        if (vector && vector.length > 0) {
          results[idx] = vector;
          this.addToCache(uncachedTexts[j], vector);
        }
      }
    }

    // 填充剩余空位（空文本 / API 返回不足）
    const dim = this.inferDimension(results) || PSEUDO_EMBED_DIM;
    return results.map((v, i) => {
      if (v) return v;
      // 空文本 → pseudoEmbed（保持维度一致）
      const t = texts[i] ?? '';
      return t.trim().length > 0 ? pseudoEmbed(t, dim) : new Array(dim).fill(0);
    });
  }

  /**
   * 直接调用 Embedding API（/v1/embeddings 或等效端点）
   *
   * 使用 aiService.getConfigForUsage('embedding') 获取 API 配置，
   * 不可用时抛出错误（由 embed() 捕获并降级到 pseudoEmbed）。
   *
   * 超时：15 秒（独立于主回合的 AI 调用超时）
   */
  private async callEmbeddingAPI(texts: string[]): Promise<number[][]> {
    const config = this.aiService.getConfigForUsage('embedding');
    if (!config) {
      throw new Error('[Embedder] No embedding API config available');
    }

    const format = detectEmbeddingFormat(config);
    const endpoint = buildEmbeddingEndpoint(config, format);

    // Split into batches to respect API limits (most providers cap at 64)
    const MAX_BATCH = 48;
    if (texts.length <= MAX_BATCH) {
      return this.callEmbeddingBatch(texts, config, format, endpoint);
    }

    const allVectors: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH);
      const batchVectors = await this.callEmbeddingBatch(batch, config, format, endpoint);
      allVectors.push(...batchVectors);
    }
    return allVectors;
  }

  private async callEmbeddingBatch(
    texts: string[],
    config: { apiKey: string; model: string },
    format: ReturnType<typeof detectEmbeddingFormat>,
    endpoint: string,
  ): Promise<number[][]> {
    const body = buildEmbeddingBody(texts, config.model, format);

    const responseBody = await postJsonWithTimeout(
      endpoint, config.apiKey, body, EMBEDDING_TIMEOUT_MS, '[Embedder]',
    );

    const vectors = extractVectorsFromResponse(responseBody, texts.length);
    return this.validateVectors(vectors, texts.length);
  }

  /**
   * 校验向量数据的基本合法性
   *
   * 确保每个向量都是 number[]，且维度一致。
   * 不合法的向量返回空数组（让 embed() 用 pseudoEmbed 填充）。
   */
  private validateVectors(vectors: number[][], expectedCount: number): number[][] {
    if (vectors.length === 0) return [];

    const dim = vectors[0]?.length ?? 0;
    if (dim === 0) return [];

    const validated: number[][] = [];

    for (let i = 0; i < Math.min(vectors.length, expectedCount); i++) {
      const v = vectors[i];
      if (Array.isArray(v) && v.length === dim && v.every((n) => typeof n === 'number' && isFinite(n))) {
        validated.push(v);
      } else {
        // 维度不匹配或包含非法值 — 让 embed() 用 pseudoEmbed 补充
        break;
      }
    }

    return validated;
  }

  private addToCache(text: string, vector: number[]): void {
    if (this.cache.size >= CACHE_MAX_SIZE) {
      // 清除最旧的 10%
      const entriesToRemove = Math.ceil(CACHE_MAX_SIZE * 0.1);
      const sorted = Array.from(this.cache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      for (let i = 0; i < entriesToRemove && i < sorted.length; i++) {
        this.cache.delete(sorted[i][0]);
      }
    }
    this.cache.set(text, { text, vector, timestamp: Date.now() });
  }

  private inferDimension(results: (number[] | null)[]): number {
    for (const r of results) {
      if (r && r.length > 0) return r.length;
    }
    return 0;
  }
}
