// App doc: docs/user-guide/pages/home.md §1.3.1 (API 管理 · 测试连接 / 功能分配路由)
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
import type { ConnectionTester, ConnectionTestResult } from '../providers/connection-test';
import { perBackendUsageType } from '../providers/usage-keys';
import { resolveLlmChatPath, resolveLlmModelsPath } from '../providers/llm-paths';

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
  /**
   * Per-category connection testers (epic P0 §3.4) — categories whose probes
   * live in provider classes (image/tts/stt) register here from main.ts, so
   * AIService carries zero backend-specific knowledge. llm/embedding/rerank
   * keep the inline request-style probes below.
   */
  private connectionTesters = new Map<string, ConnectionTester>();

  registerConnectionTester(category: 'image' | 'tts' | 'stt', tester: ConnectionTester): void {
    this.connectionTesters.set(category, tester);
  }

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
    // 1. 确定此 usage 需要的类别与 backend（per-backend usage 才有 backend 维度）
    const isImageGen = usageType === 'imageGeneration' || usageType.startsWith('imageGen_');
    const isTts = usageType.startsWith('ttsGen_');
    const isStt = usageType.startsWith('sttGen_');
    const requiredCategory = usageType === 'embedding' ? 'embedding'
      : usageType === 'rerank' ? 'rerank'
      : isImageGen ? 'image'
      : isTts ? 'tts'
      : isStt ? 'stt'
      : 'llm';
    const requiredBackend = usageType.startsWith('imageGen_') ? usageType.slice('imageGen_'.length)
      : isTts ? usageType.slice('ttsGen_'.length)
      : isStt ? usageType.slice('sttGen_'.length)
      : null;

    // 2. 显式分配的 API（最高优先级）
    const assignedId = this.assignments.get(usageType);
    if (assignedId) {
      const config = this.configs.get(assignedId);
      if (config?.enabled) {
        // 种子分配守卫（2026-08-26 review Critical）：每个 usage 行初始化时都指向
        // 'default'（LLM 种子配置）——对非 llm 类 usage 这是初始化噪音而非用户意图，
        // 曾导致 voice/embedding 行"看似已配置"实则拿到 LLM 配置去打错误端点。
        // 仅当类别真实匹配时才承认 'default' 指派；任何其他 id 都是用户显式指派，
        // 原样尊重（含"显示全部 API"逃生舱的故意跨类别强制分配, CR-R11）。
        if (assignedId !== 'default' || (config.apiCategory ?? 'llm') === requiredCategory) {
          return config;
        }
      }
    }

    // 3. 非 LLM 类：只在同类 API 中查找，不 fallback 到 LLM；
    //    per-backend usage 进一步要求 backend 同源（2026-08-26 review Critical：
    //    禁止"豆包行借走 CosyVoice 配置"式跨 backend 借用——那会用 A 家的
    //    URL/凭证去造 B 家的 provider）。legacy 'imageGeneration' 无 backend
    //    维度，保持类别级兜底语义不变。
    if (requiredCategory !== 'llm') {
      for (const c of this.configs.values()) {
        if (!c.enabled || (c.apiCategory ?? 'llm') !== requiredCategory) continue;
        if (requiredBackend !== null && (c.backend ?? '') !== requiredBackend) continue;
        return c;
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
    return this.getConfigForUsage(perBackendUsageType('image', backend))
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
    return this.getConfigForUsage(perBackendUsageType('tts', backend));
  }

  // ─── STT per-backend routing ───

  /**
   * Find the STT (speech-to-text) API config for a specific backend (e.g.
   * 'cosyvoice'). Uses the per-backend usage type (sttGen_cosyvoice). Mirrors
   * {@link getTtsConfigForBackend}. Non-LLM category → only matches
   * `apiCategory === 'stt'` configs, never falls back to an LLM config.
   */
  getSttConfigForBackend(backend: string): APIConfig | undefined {
    return this.getConfigForUsage(perBackendUsageType('stt', backend));
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
   * §11.3 + epic P0 §3.4: 按 apiCategory 路由测试：
   * - 'image' / 'tts' / 'stt': 委托 main.ts 注册的 per-category tester —
   *   经 registry 造出该 backend 的 provider 实例、调它自己的 testConnection()，
   *   连测才真正命中该 backend 的契约（修复旧版 image 分支硬编码 Civitai 端点、
   *   对其他图片后端一律测错地址的缺陷）。
   * - 'llm'（或未指定）: POST /v1/chat/completions，验证 choices[0].message
   * - 'embedding':       POST /v1/embeddings，验证 data[0].embedding 是数组
   * - 'rerank':          POST /v1/rerank，验证 results 是数组
   */
  async testConnection(config: {
    url: string;
    apiKey: string;
    model: string;
    apiCategory?: 'llm' | 'embedding' | 'rerank' | 'image' | 'tts' | 'stt';
    /** 非 llm 类别的 backend id（目录描述符 id）——委托类别必传 */
    backend?: string;
    /** 可选：自定义路径覆盖（embedding/rerank 走 body 端点；tts 走查询路径） */
    customRoutingPath?: string;
    /** 多凭证 backend 的附加凭证（epic P2 起消费） */
    credentials?: Record<string, string>;
    /** 可选：tts 连测用的 speaker（默认空，服务端取首个音色） */
    ttsSpeaker?: string;
  }): Promise<ConnectionTestResult> {
    const category = config.apiCategory ?? 'llm';
    const start = Date.now();
    const baseUrl = config.url.replace(/\/+$/, '');

    // 委托类别：image / tts / stt → per-category tester（main.ts 注册）
    if (category === 'image' || category === 'tts' || category === 'stt') {
      const tester = this.connectionTesters.get(category);
      if (!tester) {
        return { ok: false, latencyMs: 0, error: `该类别（${category}）的连测器未注册` };
      }
      return tester({
        url: config.url,
        apiKey: config.apiKey,
        model: config.model,
        backend: config.backend,
        customRoutingPath: config.customRoutingPath,
        credentials: config.credentials,
        ttsSpeaker: config.ttsSpeaker,
      });
    }

    // 按类别确定端点、请求体、响应校验
    let endpoint: string;
    const method: 'GET' | 'POST' = 'POST';
    let body: Record<string, unknown> | null;
    let validate: (data: unknown) => boolean;
    let invalidMsg: string;

    if (category === 'embedding') {
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
      // 路径经 resolveLlmChatPath 解析（epic P4）：自定义路径 → 目录预设
      // （volcano_ark → /api/v3/chat/completions）→ /v1/chat/completions。
      endpoint = `${baseUrl}${resolveLlmChatPath(config.backend, config.customRoutingPath)}`;
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
  async fetchModels(config: { url: string; apiKey: string; provider?: APIProviderType; backend?: string }): Promise<string[]> {
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
        default: {
          // epic P4：目录预设可声明专属 models 路径；声明为"无"的预设
          // （resolveLlmModelsPath → null，如 volcano_ark）UI 已隐藏按钮，
          // 此处兜底直接报明确错误而不是打错误端点。
          const modelsPath = resolveLlmModelsPath(config.backend);
          if (modelsPath === null) {
            throw new Error('该服务商未提供模型列表端点');
          }
          endpoint = `${baseUrl}${modelsPath}`;
          headers = { Authorization: `Bearer ${config.apiKey}` };
          break;
        }
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
