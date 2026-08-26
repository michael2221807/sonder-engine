/**
 * AI 服务 — 统一的 AI 调用入口
 *
 * 职责：
 * 1. 管理多个 API 配置（APIConfig）和功能分配（APIAssignment）
 * 2. 根据 UsageType 路由到正确的 API 配置
 * 3. 创建对应的 Provider 实例发送请求
 * 4. 提供重试、取消、超时机制
 *
 * 移植自 demo aiService.ts，关键逻辑保留：
 * - executeWithRetry: 带退避延迟和取消检测的重试
 * - createTimeoutSignal: 合并用户取消和超时的 AbortSignal
 * - 去除酒馆模式（MVP 为独立 Web）
 *
 * 对应 STEP-03B M2.3。
 */
import type { APIConfig, GenerateOptions, UsageType, APIAssignment, APIProviderType, AIMessage } from './types';
import { API_TIMEOUT_MS, requestTimeoutMinutesToMs } from './types';
import type { BaseProvider } from './providers/base-provider';
import { OpenAIProvider } from './providers/openai-provider';
import { ClaudeProvider } from './providers/claude-provider';
import { RateLimiter } from './rate-limiter';
import type { RateLimiterConfig } from './rate-limiter';
import { GeminiProvider } from './providers/gemini-provider';
import { eventBus } from '../core/event-bus';
import { isAiLoggingEnabled } from '../core/debug-flags';

export class AIService {
  /** 所有 API 配置（id → config） */
  private configs = new Map<string, APIConfig>();
  /** 功能分配（usageType → apiId） */
  private assignments = new Map<UsageType, string>();
  /** 当前的 AbortController — 用于取消请求 */
  private abortController: AbortController | null = null;
  /** 取消标志 — 用于在重试延迟期间检测取消 */
  private isAborted = false;
  /** 最大重试次数（0 = 不重试） */
  maxRetries = 1;
  /**
   * 主 generate 请求整体超时（毫秒）。
   * 默认 10 分钟；可由 `aga_ai_settings.requestTimeoutMinutes` 配置，
   * 经 applyPersistedAISettings / APIPanel 同步覆盖。
   */
  requestTimeoutMs = API_TIMEOUT_MS;
  /** Low-load mode rate limiter — throttles LLM generate calls */
  private rateLimiter = new RateLimiter();

  // ─── 配置管理 ───

  /** 设置所有 API 配置 — 由 Pinia store 同步调用 */
  setConfigs(configs: APIConfig[]): void {
    this.configs.clear();
    for (const c of configs) this.configs.set(c.id, c);
  }

  /** 设置功能分配 */
  setAssignments(assignments: APIAssignment[]): void {
    this.assignments.clear();
    for (const a of assignments) this.assignments.set(a.type, a.apiId);
  }

  /**
   * 根据 UsageType 获取对应的 API 配置
   *
   * 查找策略区分 LLM 类和非 LLM 类 usage：
   *
   * - LLM 类 (main / world_generation / memory_summary 等):
   *   分配 → 默认 → 第一个可用 LLM
   *
   * - 非 LLM 类 (embedding / rerank):
   *   **只**在同类 API 中查找，不 fallback 到 LLM。原因：
   *   embedding API 走 /v1/embeddings 端点，rerank 走 /v1/rerank，
   *   把 LLM 代理的 URL 发过去会 404 或返回格式不兼容的响应，
   *   导致 Embedder/Reranker 静默 fallback 到伪实现（pseudoEmbed / scoreSort），
   *   用户看到"已向量化"但实际没调真正的 embedding API。
   *
   * 返回 undefined 时，调用方负责降级（Embedder → pseudoEmbed，Reranker → scoreSort）。
   */
  getConfigForUsage(usageType: UsageType): APIConfig | undefined {
    // 1. 显式分配的 API（最高优先级）
    const assignedId = this.assignments.get(usageType);
    if (assignedId) {
      const config = this.configs.get(assignedId);
      if (config?.enabled) return config;
    }

    // 2. 确定此 usage 需要的 API 类别
    const isImageGen = usageType === 'imageGeneration' || usageType.startsWith('imageGen_');
    const isTts = usageType.startsWith('ttsGen_');
    const isStt = usageType.startsWith('sttGen_');
    const requiredCategory = usageType === 'embedding' ? 'embedding'
      : usageType === 'rerank' ? 'rerank'
      : isImageGen ? 'image'
      : isTts ? 'tts'
      : isStt ? 'stt'
      : 'llm';

    // 3. 非 LLM 类：只在同类 API 中查找，不 fallback 到 LLM
    if (requiredCategory !== 'llm') {
      for (const c of this.configs.values()) {
        if (c.enabled && (c.apiCategory ?? 'llm') === requiredCategory) return c;
      }
      return undefined;
    }

    // 4. LLM 类：分配 → default → 任意可用 LLM
    const defaultConfig = this.configs.get('default');
    if (defaultConfig?.enabled) return defaultConfig;
    for (const c of this.configs.values()) {
      if (c.enabled && (c.apiCategory ?? 'llm') === 'llm') return c;
    }
    return undefined;
  }

  // ─── Image per-backend routing ───

  /**
   * Find the image API config for a specific backend.
   * Uses the per-backend usage type (imageGen_novelai, imageGen_civitai, etc.).
   * Falls back to legacy imageGeneration assignment for backward compatibility.
   */
  getImageConfigForBackend(backend: string): APIConfig | undefined {
    const perBackendUsage = `imageGen_${backend}` as UsageType;
    return this.getConfigForUsage(perBackendUsage)
      ?? this.getConfigForUsage('imageGeneration');
  }

  // ─── TTS per-backend routing ───

  /**
   * Find the TTS API config for a specific backend (e.g. 'cosyvoice').
   * Uses the per-backend usage type (ttsGen_cosyvoice). Mirrors
   * {@link getImageConfigForBackend}. Non-LLM category → only matches
   * `apiCategory === 'tts'` configs, never falls back to an LLM config.
   */
  getTtsConfigForBackend(backend: string): APIConfig | undefined {
    const perBackendUsage = `ttsGen_${backend}` as UsageType;
    return this.getConfigForUsage(perBackendUsage);
  }

  // ─── STT per-backend routing ───

  /**
   * Find the STT (speech-to-text) API config for a specific backend (e.g.
   * 'cosyvoice'). Uses the per-backend usage type (sttGen_cosyvoice). Mirrors
   * {@link getTtsConfigForBackend}. Non-LLM category → only matches
   * `apiCategory === 'stt'` configs, never falls back to an LLM config.
   */
  getSttConfigForBackend(backend: string): APIConfig | undefined {
    const perBackendUsage = `sttGen_${backend}` as UsageType;
    return this.getConfigForUsage(perBackendUsage);
  }

  // ─── 主调用方法 ───

  /**
   * 生成 AI 响应 — 带重试和超时
   * 所有 AI 调用都通过此方法
   */
  async generate(options: GenerateOptions): Promise<string> {
    // 在最外层重置取消状态（一次调用只重置一次）
    this.resetAbortState();

    return this.executeWithRetry(
      () => this.doGenerate(options),
      `generate(${options.usageType ?? 'main'})`,
    );
  }

  configureRateLimiter(opts: Partial<RateLimiterConfig>): void {
    this.rateLimiter.configure(opts);
  }

  get rateLimiterEnabled(): boolean {
    return this.rateLimiter.enabled;
  }

  /** 取消当前请求（包括重试中的） */
  cancel(): void {
    this.isAborted = true;
    this.abortController?.abort();
    this.abortController = null;
  }

  // ─── 内部实现 ───

  /** 重置取消状态 — 新请求开始前调用 */
  private resetAbortState(): void {
    this.isAborted = false;
    this.abortController = new AbortController();
  }

  /** 实际发送请求 */
  private async doGenerate(options: GenerateOptions): Promise<string> {
    await this.rateLimiter.acquire(options.signal);

    const config = this.getConfigForUsage(options.usageType ?? 'main');
    if (!config) throw new Error('未配置可用的 API');

    const effectiveConfig = (options.temperature != null || options.maxTokens != null)
      ? {
          ...config,
          ...(options.temperature != null ? { temperature: options.temperature } : {}),
          ...(options.maxTokens != null ? { maxTokens: options.maxTokens } : {}),
        }
      : config;

    let effectiveOptions = options;
    if (effectiveConfig.strictMessageFormat && options.messages.length > 0) {
      // 严格模式已保证 user 结尾，涵盖 disablePrefill 的诉求 → 二选一，strict 优先。
      effectiveOptions = { ...options, messages: applyStrictMessageFormat(options.messages) };
    } else if (effectiveConfig.disablePrefill && options.messages.length > 0) {
      effectiveOptions = { ...options, messages: this.convertPrefillToSystem(options.messages) };
    }

    // forceStreaming: some providers/proxies expose ONLY a streaming endpoint.
    // Override `stream` to true for every call routed here — even background/non-narrative
    // ones that never pass `onStreamChunk`. The provider still returns the full assembled
    // text (chunks are simply not rendered). See APIConfig.forceStreaming.
    if (effectiveConfig.forceStreaming) {
      effectiveOptions = { ...effectiveOptions, stream: true };
    }

    const provider = this.createProvider(effectiveConfig);
    const { signal, cleanup } = this.createTimeoutSignal(options.signal);

    // 设置 → 高级设置 → "AI API 完整记录" 的消费点（2026-08-26 死控件修复）。
    // 记录实际发送的最终消息数组（strict/prefill 变换后）；绝不记录 apiKey。
    const aiLogging = isAiLoggingEnabled();
    if (aiLogging) {
      console.log('[AI-LOG] request', {
        usageType: options.usageType ?? 'main',
        provider: effectiveConfig.provider,
        model: effectiveConfig.model,
        url: effectiveConfig.url,
        stream: effectiveOptions.stream === true,
        messages: effectiveOptions.messages,
      });
    }

    eventBus.emit('ai:request-start', {
      usageType: options.usageType,
      model: config.model,
    });

    try {
      const result = await provider.generate({ ...effectiveOptions, signal });
      if (aiLogging) {
        console.log('[AI-LOG] response', {
          usageType: options.usageType ?? 'main',
          model: effectiveConfig.model,
          length: result.length,
          text: result,
        });
      }
      eventBus.emit('ai:response-complete', {
        usageType: options.usageType,
        length: result.length,
      });
      return result;
    } catch (err) {
      if (aiLogging) {
        console.log('[AI-LOG] error', {
          usageType: options.usageType ?? 'main',
          model: effectiveConfig.model,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    } finally {
      cleanup();
    }
  }

  /**
   * 当 disablePrefill 启用时，将末尾的 assistant prefill 转为 system 消息
   * 插到最后一条 user 消息之前，保留格式引导内容且不触发 prefill 限制。
   */
  private convertPrefillToSystem(messages: AIMessage[]): AIMessage[] {
    const result = [...messages];
    const collectedPrefill: string[] = [];

    while (result.length > 0 && result[result.length - 1].role === 'assistant') {
      collectedPrefill.unshift(result.pop()!.content);
    }

    if (collectedPrefill.length === 0) return messages;

    const systemMsg: AIMessage = {
      role: 'system',
      content: collectedPrefill.join('\n'),
    };

    let lastUserIdx = -1;
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role === 'user') { lastUserIdx = i; break; }
    }

    if (lastUserIdx >= 0) {
      result.splice(lastUserIdx, 0, systemMsg);
    } else {
      result.push(systemMsg);
    }

    return result;
  }

  /**
   * 带重试的执行
   *
   * 移植自 demo 的 executeWithRetry，关键行为：
   * 1. 每次重试前检查取消状态
   * 2. 重试延迟期间也检查取消（每 100ms 一次）
   * 3. 取消信号或 abort 关键字立即停止
   * 4. 非取消错误才会重试
   * 5. 401（API Key 无效）立即停止重试，不等待退避
   * 6. 指数退避 + jitter：min(1000×2^(attempt-1) + random(0,500), 10000)ms
   */
  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    label: string,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // 取消检查
      if (this.isAborted) throw new Error('请求已被取消');

      if (attempt > 0) {
        console.log(`[AIService] ${label} 重试 ${attempt}/${this.maxRetries}`);
        eventBus.emit('ai:retrying', { attempt, maxRetries: this.maxRetries, label });

        // 指数退避 + jitter，最长 10 秒
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1) + Math.random() * 500, 10000);
        for (let waited = 0; waited < delayMs; waited += 100) {
          if (this.isAborted) throw new Error('请求已被取消');
          await new Promise((r) => setTimeout(r, Math.min(100, delayMs - waited)));
        }
      }

      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
        // 取消信号 → 立即停止，不重试
        if (
          this.isAborted ||
          (lastError instanceof DOMException && lastError.name === 'AbortError') ||
          lastError.message?.includes('取消') ||
          lastError.message?.includes('abort')
        ) {
          throw lastError;
        }
        // 401 认证失败 → 立即停止，不重试（重试无意义且延误用户发现配置错误）
        if (
          lastError.message?.includes('401') ||
          lastError.message?.toLowerCase().includes('unauthorized') ||
          lastError.message?.toLowerCase().includes('invalid api key')
        ) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new Error(`${label} 失败`);
  }

  /**
   * 创建兼顾用户取消和超时的 AbortSignal
   *
   * 返回 signal + cleanup 函数，调用方必须在 finally 中调用 cleanup()
   * 以释放定时器和事件监听器，避免长达 5 分钟的内存泄漏。
   */
  private createTimeoutSignal(callerSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    const onAbort = () => {
      clearTimeout(timeoutId);
      controller.abort();
    };

    this.abortController?.signal.addEventListener('abort', onAbort);
    callerSignal?.addEventListener('abort', onAbort);

    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timeoutId);
        this.abortController?.signal.removeEventListener('abort', onAbort);
        callerSignal?.removeEventListener('abort', onAbort);
      },
    };
  }

  // ─── 连通测试 & 模型列表 ───

  /**
   * 真实 API 连通测试 — 发送最小测试请求，验证响应有效
   *
   * 超时：10s。不使用现有 config/assignment，直接用传入参数。
   *
   * §11.3: 按 apiCategory 发送不同的测试请求：
   * - 'llm'（或未指定）: POST /v1/chat/completions，验证 choices[0].message.content
   * - 'embedding':       POST /v1/embeddings，验证 data[0].embedding 是数组
   * - 'rerank':          POST /v1/rerank，验证 results 是数组
   *
   * 这使得用户在 APIPanel 中为不同类别的 API 测试连接时，
   * 真的命中它们实际会被调用的端点，而不是只测试 chat completion。
   */
  async testConnection(config: {
    url: string;
    apiKey: string;
    model: string;
    apiCategory?: 'llm' | 'embedding' | 'rerank' | 'image' | 'tts' | 'stt';
    /** 可选：自定义路径覆盖（embedding/rerank 走 body 端点；tts 走查询路径） */
    customRoutingPath?: string;
    /** 可选：tts 连测用的 speaker（默认空，服务端取首个音色） */
    ttsSpeaker?: string;
  }): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const category = config.apiCategory ?? 'llm';
    const start = Date.now();
    const baseUrl = config.url.replace(/\/+$/, '');

    // TTS: 响应是二进制音频（非 JSON），单独短路处理，不走下面的 res.json() 校验。
    if (category === 'tts') {
      const path = config.customRoutingPath?.trim() || '/';
      // Neutral ASCII probe text — engine code must not hardcode locale content,
      // and a Chinese payload can false-negative against an English-only voice.
      const params = new URLSearchParams({
        text: 'test',
        speaker: config.ttsSpeaker ?? '',
      });
      const endpoint = `${baseUrl}${path.startsWith('/') ? path : '/' + path}?${params.toString()}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(endpoint, { method: 'GET', signal: controller.signal });
        clearTimeout(timeout);
        const latencyMs = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => `HTTP ${res.status}`);
          return { ok: false, latencyMs, error: `${res.status}: ${errText.slice(0, 120)}` };
        }
        const ct = res.headers.get('content-type') ?? '';
        const ok = ct.toLowerCase().includes('audio');
        return { ok, latencyMs, error: ok ? undefined : `响应非音频（Content-Type: ${ct || '空'}）` };
      } catch (err) {
        clearTimeout(timeout);
        const latencyMs = Date.now() - start;
        const msg = (err as Error).message ?? String(err);
        if (msg.includes('abort') || msg.includes('signal')) {
          return { ok: false, latencyMs, error: '连接超时（10s）' };
        }
        return { ok: false, latencyMs, error: msg.slice(0, 100) };
      }
    }

    // STT: 转写端点是 POST multipart（需真实音频），连测改探健康端点 GET / → JSON status:'ok'。
    // 与 TTS 共用同一 CosyVoice 服务；健康端点判活即可，避免连测时空录音。
    if (category === 'stt') {
      const endpoint = `${baseUrl}/`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(endpoint, { method: 'GET', signal: controller.signal });
        clearTimeout(timeout);
        const latencyMs = Date.now() - start;
        if (!res.ok) {
          const errText = await res.text().catch(() => `HTTP ${res.status}`);
          return { ok: false, latencyMs, error: `${res.status}: ${errText.slice(0, 120)}` };
        }
        const data = (await res.json().catch(() => null)) as { status?: string } | null;
        const ok = data?.status === 'ok';
        return { ok, latencyMs, error: ok ? undefined : '健康探测未返回 status:ok' };
      } catch (err) {
        clearTimeout(timeout);
        const latencyMs = Date.now() - start;
        const msg = (err as Error).message ?? String(err);
        if (msg.includes('abort') || msg.includes('signal')) {
          return { ok: false, latencyMs, error: '连接超时（10s）' };
        }
        return { ok: false, latencyMs, error: msg.slice(0, 100) };
      }
    }

    // 按类别确定端点、请求体、响应校验
    let endpoint: string;
    let method: 'GET' | 'POST' = 'POST';
    let body: Record<string, unknown> | null;
    let validate: (data: unknown) => boolean;
    let invalidMsg: string;

    if (category === 'image') {
      endpoint = `${baseUrl}/v2/consumer/workflows?take=1`;
      method = 'GET';
      body = null;
      validate = (d) => d != null && typeof d === 'object';
      invalidMsg = '响应格式异常';
    } else if (category === 'embedding') {
      const defaultPath = '/v1/embeddings';
      const path = config.customRoutingPath?.trim() || defaultPath;
      endpoint = `${baseUrl}${path.startsWith('/') ? path : '/' + path}`;
      body = { model: config.model, input: '连接测试' };
      validate = (d) => {
        const obj = d as { data?: Array<{ embedding?: unknown }> } | null;
        return !!(obj?.data?.[0]?.embedding && Array.isArray(obj.data[0].embedding));
      };
      invalidMsg = '响应格式异常（无 data[0].embedding 数组）';
    } else if (category === 'rerank') {
      const defaultPath = '/v1/rerank';
      const path = config.customRoutingPath?.trim() || defaultPath;
      endpoint = `${baseUrl}${path.startsWith('/') ? path : '/' + path}`;
      body = {
        model: config.model,
        query: '连接测试',
        documents: ['foo', 'bar'],
        top_n: 2,
      };
      validate = (d) => {
        const obj = d as { results?: unknown } | null;
        return Array.isArray(obj?.results);
      };
      invalidMsg = '响应格式异常（无 results 数组）';
    } else {
      // LLM 类别（默认）
      // max_tokens 设为 10000：thinking model（如 Gemini 2.5 Pro）会消耗部分 output
      // token 做内部推理（reasoning_tokens），少量 token 不够输出文本。
      endpoint = `${baseUrl}/v1/chat/completions`;
      body = {
        model: config.model,
        messages: [{ role: 'user', content: '请仅输出数字 1' }],
        max_tokens: 10000,
        stream: false,
      };
      validate = (d) => {
        const obj = d as { choices?: Array<{ message?: { content?: unknown } }> } | null;
        // 检测到 choices 结构即视为连通成功；content 可能为空字符串
        // （thinking model 的 reasoning 消耗完 token 后 content 可能为 ""）
        return !!(obj?.choices?.[0]?.message);
      };
      invalidMsg = '响应格式异常（无 choices[0].message）';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const fetchInit: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: controller.signal,
      };
      if (body) fetchInit.body = JSON.stringify(body);
      const res = await fetch(endpoint, fetchInit);
      clearTimeout(timeout);
      const latencyMs = Date.now() - start;

      if (!res.ok) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        return { ok: false, latencyMs, error: `${res.status}: ${errText.slice(0, 120)}` };
      }

      const data = await res.json().catch(() => null);
      const isValid = validate(data);
      return {
        ok: isValid,
        latencyMs,
        error: isValid ? undefined : invalidMsg,
      };
    } catch (err) {
      clearTimeout(timeout);
      const latencyMs = Date.now() - start;
      const msg = (err as Error).message ?? String(err);
      if (msg.includes('abort') || msg.includes('signal')) {
        return { ok: false, latencyMs, error: '连接超时（10s）' };
      }
      return { ok: false, latencyMs, error: msg.slice(0, 100) };
    }
  }

  /**
   * 拉取指定 API 支持的模型列表。
   * 超时：15s。不依赖现有配置，直接用传入参数。
   * 根据 provider 类型使用不同的端点和认证方式。
   */
  async fetchModels(config: { url: string; apiKey: string; provider?: APIProviderType }): Promise<string[]> {
    const baseUrl = config.url.replace(/\/(v1beta|v1)\/?$/, '').replace(/\/+$/, '');
    const provider = config.provider ?? 'openai';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      let endpoint: string;
      let headers: Record<string, string>;

      switch (provider) {
        case 'gemini':
          endpoint = `${baseUrl}/v1beta/models?key=${config.apiKey}`;
          headers = {};
          break;
        case 'claude':
          endpoint = `${baseUrl}/v1/models`;
          headers = {
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
          };
          break;
        default:
          endpoint = `${baseUrl}/v1/models`;
          headers = { Authorization: `Bearer ${config.apiKey}` };
          break;
      }

      const res = await fetch(endpoint, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = await res.json();

      let ids: string[];
      if (provider === 'gemini') {
        const models = (data?.models ?? []) as Array<{ name?: string }>;
        ids = models
          .map((m) => m.name?.replace(/^models\//, '') ?? '')
          .filter((id) => id.length > 0);
      } else {
        const raw = (data?.data ?? data?.models ?? data ?? []) as Array<{ id: string } | string>;
        ids = raw
          .map((m) => (typeof m === 'string' ? m : m?.id))
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
      }

      return [...new Set(ids)].sort();
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  /** 根据 provider 类型创建对应的 Provider 实例 */
  private createProvider(config: APIConfig): BaseProvider {
    switch (config.provider) {
      case 'claude':
        return new ClaudeProvider(config);
      case 'gemini':
        return new GeminiProvider(config);
      case 'openai':
      case 'deepseek':
      case 'custom':
      default:
        return new OpenAIProvider(config);
    }
  }
}

/**
 * Infer image backend type from an API config's URL.
 * Used by both engine (per-backend routing) and UI (preset selection).
 */
export function inferImageBackendFromUrl(url: string): string {
  if (url.includes('orchestration.civitai.com')) return 'civitai';
  if (url.includes('api.openai.com')) return 'openai';
  if (url.includes('image.novelai.net')) return 'novelai';
  try {
    const hostname = new URL(url).hostname;
    if (hostname.endsWith('.novelai.net')) return 'novelai';
  } catch { /* invalid URL — fall through */ }
  if (url.includes(':8188')) return 'comfyui';
  if (url.includes(':7860')) return 'sd_webui';
  return '';
}

/**
 * 严格消息格式兼容变换 — 消除会被严格模型/反代拒绝的两类结构：
 *   1. 对话中途的 system 消息（转 Anthropic 后成为 `mid_conv_system` 块，
 *      若非所在 turn 的末块会被 400 拒绝）。
 *   2. 以 assistant 结尾（prefill）—— 部分模型（如 claude-opus-4-8）要求
 *      对话必须以 user 消息结尾。
 *
 * 规则（仅改 role，不改内容、不改相对顺序）：
 *   - 开头连续的 system 保留（转为顶层 system，天然合法）。
 *   - 首个非 system 消息之后出现的任何 system → 转为 user。
 *   - 末尾连续的 assistant → 转为 user，保证以 user 结尾。
 * 相邻同角色消息由后端自动合并，无需在此处拼接。纯函数，供 doGenerate 与单测调用。
 *
 * 两条已由真实 gproxy→Claude Opus 往返（2026-07-19，返回 200，见 bugfix-changelog）
 * 验证过的关键假设，改动前务必回看，勿"顺手修"导致回归：
 *   1. **开头 system 块之后紧跟的 assistant 不强转 user**（首个非 system 若是 assistant，
 *      保持 assistant）。此路径经 OpenAI provider → gproxy，"首条须为 user"由 gproxy 侧
 *      兜底（不同于原生 ClaudeProvider.convertMessages 会 unshift 占位 user）。真实 payload
 *      正是 assistant 开头，单测 strict-message-format.test.ts 第 1 例已固化。
 *   2. **依赖后端合并相邻同角色**（中途 system→user 紧邻既有 user、末尾 assistant→user
 *      落在 user 旁等），本函数不做拼接。合并行为由 gproxy 的 OpenAI→Anthropic 转换保证。
 */
export function applyStrictMessageFormat(messages: AIMessage[]): AIMessage[] {
  const result = messages.map((m) => ({ ...m }));

  const firstNonSystem = result.findIndex((m) => m.role !== 'system');
  if (firstNonSystem === -1) return result; // 全是 system：无中途 system、无 assistant 结尾

  // 中途 system → user（消除 mid_conv_system）
  for (let i = firstNonSystem; i < result.length; i++) {
    if (result[i].role === 'system') result[i] = { ...result[i], role: 'user' };
  }

  // 末尾 assistant（prefill）→ user，确保对话以 user 结尾
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'assistant') {
      result[i] = { ...result[i], role: 'user' };
    } else {
      break;
    }
  }

  return result;
}

/** localStorage key holding AI-generation settings (shared by APIPanel + SettingsPanel). */
export const AI_SETTINGS_STORAGE_KEY = 'aga_ai_settings';

/**
 * Apply the persisted `aga_ai_settings` values that live in AIService memory
 * (maxRetries + requestTimeoutMinutes + low-load rate limiter) to a given AIService instance.
 *
 * Shared by cold start (main.ts) and post full-backup import (ManagementView) so
 * the two paths can never drift. The rate limiter is configured unconditionally —
 * `enabled` follows `lowLoadMode`, so importing a backup with low-load OFF will
 * explicitly disable a limiter that an earlier session had turned on.
 *
 * `streaming` / `splitGen` / `privacyRepairRetries` are intentionally NOT applied
 * here: they are read live from localStorage per-call (game-orchestrator,
 * privacy-profile-repair), so they need no in-memory sync.
 */
export function applyPersistedAISettings(service: AIService): void {
  try {
    const saved = JSON.parse(localStorage.getItem(AI_SETTINGS_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    if (typeof saved.maxRetries === 'number') {
      service.maxRetries = saved.maxRetries;
    }
    if (typeof saved.requestTimeoutMinutes === 'number') {
      service.requestTimeoutMs = requestTimeoutMinutesToMs(saved.requestTimeoutMinutes);
    }
    service.configureRateLimiter({
      enabled: saved.lowLoadMode === true,
      maxRequests: typeof saved.lowLoadMaxRequests === 'number' ? saved.lowLoadMaxRequests : 3,
      windowMs: 60_000,
    });
  } catch { /* localStorage 不可用时静默忽略 */ }
}
