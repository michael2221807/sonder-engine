// App doc: docs/user-guide/pages/game-image.md §图片提炼 §参考重绘
import { BaseImageProvider, IMAGE_DOWNLOAD_TIMEOUT_MS } from './base';
import type { ImageBackendType } from '../types';
import type { ImageToImageProvider, ImageUnderstandingProvider } from '../provider-capabilities';
import type { ImageReferenceInput, ImageUnderstandingRequest, ImageUnderstandingResult } from '../reference-types';
import { buildUnderstandingPrompt, parseUnderstandingResponse, looksLikeRefusal, minPromptTokensWithImage } from '../understanding-prompt';
import { clamp } from '../utils';

interface CivitaiImage {
  id: string;
  width: number;
  height: number;
  available: boolean;
  url?: string;
  urlExpiresAt?: string;
  previewUrl?: string;
  previewUrlExpiresAt?: string;
  jobId?: string;
  nsfwLevel?: string;
  blockedReason?: string;
}

interface CivitaiRecipeResponse {
  images?: CivitaiImage[];
  cost?: number;
  totalCost?: number;
  id?: string;
  status?: string;
  error?: string;
  message?: string;
}

export class CivitaiBlockedError extends Error {
  constructor(
    public readonly blockedReason?: string,
    public readonly nsfwLevel?: string,
  ) {
    const parts = ['[Civitai] 生成被拦截'];
    if (blockedReason) parts.push(`原因: ${blockedReason}`);
    if (nsfwLevel) parts.push(`内容级别: ${nsfwLevel}`);
    parts.push('提示: 请检查Civitai账号设置、会员状态和Buzz余额');
    super(parts.join(' — '));
    this.name = 'CivitaiBlockedError';
  }
}

function parseJsonOrThrow(json: string | undefined | null, fieldName: string): unknown {
  if (!json || typeof json !== 'string' || !json.trim()) return undefined;
  try { return JSON.parse(json); }
  catch (e) {
    throw new Error(`[Civitai] ${fieldName} JSON 格式错误: ${(e as Error).message}`);
  }
}

export class CivitaiImageProvider
  extends BaseImageProvider
  implements ImageToImageProvider, ImageUnderstandingProvider {

  readonly backend: ImageBackendType = 'civitai';

  // ── Shared helpers ──

  private buildQueryParams(options?: Record<string, unknown>): URLSearchParams {
    const params = new URLSearchParams();
    if (options?.allowMatureContent === true) params.set('allowMatureContent', 'true');
    if (options?.whatif === true) params.set('whatif', 'true');
    if (options?.experimental === true) params.set('experimental', 'true');
    return params;
  }

  private buildRecipeUrl(recipePath: string, options?: Record<string, unknown>): string {
    const endpoint = this.endpoint.replace(/\/+$/, '');
    const qs = this.buildQueryParams(options).toString();
    return `${endpoint}${recipePath}${qs ? '?' + qs : ''}`;
  }

  private buildTextToImageBody(
    prompt: string,
    negative: string,
    width: number,
    height: number,
    options?: Record<string, unknown>,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      prompt,
      width: Number.isFinite(width) ? width : 1024,
      height: Number.isFinite(height) ? height : 1024,
      quantity: 1,
      batchSize: 1,
    };
    if (this.model) body.model = this.model;
    if (negative) body.negativePrompt = negative;
    if (options?.scheduler) body.scheduler = options.scheduler;
    if (options?.steps != null) body.steps = options.steps;
    if (options?.cfgScale != null) body.cfgScale = options.cfgScale;
    if (options?.clipSkip != null) body.clipSkip = options.clipSkip;
    if (options?.outputFormat) body.outputFormat = options.outputFormat;
    const seed = typeof options?.seed === 'number' ? options.seed : undefined;
    if (seed !== undefined && seed >= 0) body.seed = seed;

    const networks = parseJsonOrThrow(
      options?.additionalNetworksJson as string | undefined,
      '附加网络 (additionalNetworks)',
    );
    if (networks) body.additionalNetworks = networks;

    const controlNets = parseJsonOrThrow(
      options?.controlNetsJson as string | undefined,
      'ControlNet',
    );
    if (controlNets) body.controlNets = controlNets;

    return body;
  }

  private async executeTextToImageRecipe(
    url: string,
    body: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<Blob> {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      if (response.status === 401) throw new Error('[Civitai] API Key 无效或已过期');
      if (response.status === 400) throw new Error(`[Civitai] 请求参数错误 — ${errBody.slice(0, 200)}`);
      if (response.status === 402) throw new Error('[Civitai] Buzz 余额不足');
      if (response.status === 429) throw new Error('[Civitai] 请求过于频繁，请稍后再试');
      throw new Error(`[Civitai] 生成失败: ${response.status} — ${errBody.slice(0, 200)}`);
    }

    let data: CivitaiRecipeResponse;
    const rawText = await response.text();
    try {
      data = JSON.parse(rawText) as CivitaiRecipeResponse;
    } catch {
      throw new Error(`[Civitai] 响应解析失败 (非 JSON) — ${rawText.slice(0, 200)}`);
    }

    if (options?.whatif === true) {
      const cost = data.cost ?? data.totalCost ?? '未知';
      throw new Error(`[Civitai] 预览模式 — 预计消耗 ${cost} Buzz，未实际生成`);
    }

    let image = data.images?.[0];
    if (!image) {
      throw new Error(`[Civitai] 响应中无图片数据 — ${JSON.stringify(data).slice(0, 200)}`);
    }
    if (image.blockedReason) {
      throw new CivitaiBlockedError(image.blockedReason, image.nsfwLevel);
    }

    if (!image.available || !image.url) {
      image = await this.pollUntilAvailable(this.endpoint.replace(/\/+$/, ''), data, image);
    }

    const imageUrl = new URL(image.url!);
    if (imageUrl.protocol !== 'https:') {
      throw new Error(`[Civitai] 图片 URL 必须为 HTTPS (实际: ${imageUrl.protocol})`);
    }
    const blobResponse = await fetch(image.url!, { signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS) });
    if (!blobResponse.ok) {
      throw new Error(`[Civitai] 下载图片失败: ${blobResponse.status}`);
    }
    return blobResponse.blob();
  }

  // ── text-to-image (existing) ──

  async generate(
    prompt: string,
    negative: string,
    width: number,
    height: number,
    options?: Record<string, unknown>,
  ): Promise<Blob> {
    const body = this.buildTextToImageBody(prompt, negative, width, height, options);
    const url = this.buildRecipeUrl('/v2/consumer/recipes/textToImage', options);
    return this.executeTextToImageRecipe(url, body, options);
  }

  // ── Media URL resolution ──

  /**
   * For textToImage sourceImage: pass through directly (accepts data URL per
   * swagger — no format constraint). chatCompletion image blocks also accept
   * data URLs directly (verified 2026-08-27), so no upload hop is needed
   * anywhere anymore.
   */
  private ensureSourceImage(dataUrlOrUrl: string): string {
    return dataUrlOrUrl;
  }

  // ── image-to-image ──

  /**
   * Civitai 的 SD 系配方只吃**单图**：官方文档原文「`image` is a plain string
   * URL (not a `{ url: ... }` wrapper)」，整个配方没有数组型图片字段。其
   * `imageStyleReferences`（≤10 张）属于 MAI / Krea / Grok 等闭源模型的其它
   * 配方，不在我们这条路线上。故取首张并对多余项告警；UI 侧不声明
   * `multiReference`（查证见
   * docs/design/seedream-multi-reference-implementation.md §1）。
   */
  async imageToImage(
    prompt: string,
    negative: string,
    width: number,
    height: number,
    references: ImageReferenceInput[],
    options?: Record<string, unknown>,
  ): Promise<Blob> {
    const body = this.buildTextToImageBody(prompt, negative, width, height, options);

    const reference = references[0];
    if (!reference) throw new Error('[Civitai] 参考图列表为空');
    if (references.length > 1) {
      console.warn(`[Civitai] 收到 ${references.length} 张参考图，SD 配方只支持单图，已取第 1 张`);
    }

    const rawSource = reference.dataUrl ?? reference.url;
    if (!rawSource) {
      throw new Error('[Civitai] 参考图缺少 dataUrl 或 url');
    }
    body.sourceImage = this.ensureSourceImage(rawSource);
    // Civitai official API typo: "Strenght" not "Strength"
    body.sourceImageDenoiseStrenght = clamp(reference.denoiseStrength ?? 0.65, 0, 1);

    const url = this.buildRecipeUrl('/v2/consumer/recipes/textToImage', options);
    return this.executeTextToImageRecipe(url, body, options);
  }

  // ── image understanding (chatCompletion VLM) ──

  /** 图片提炼默认模型（epic D2）：anthropic 路由 token 计量远低于 openai 路由且
   * 自发输出 Danbooru 词汇。可被 request.model / understanding 设置覆盖。 */
  static readonly DEFAULT_UNDERSTANDING_MODEL = 'claude-sonnet-5';

  /**
   * Image understanding via the multi-provider chatCompletion recipe.
   *
   * 旧 wdTagging / mediaCaptioning recipe 已确认上游死亡（路由在、算力无，
   * 四种输入组合全灭）并于本 epic 拆除（D5）。实测证据与本实现的三条硬约束：
   * docs/status/image-understanding-api-verification-2026-08-27.md
   *
   * 1. 图片块**必须** camelCase `{type:'imageUrl', imageUrl:{url}}` ——
   *    OpenAI 标准 snake_case `image_url` 会被网关静默丢图，模型凭空幻觉
   *    （200 + 合法 JSON，promptTokens 却只有纯文本量级）。
   * 2. 204 / 空 body = 失败（模型名无效、路由拒绝均不走 4xx）。
   * 3. usage.promptTokens 防幻觉断言（仅 openai/ 路由，真实校准后下限=文本估算+500）
   *    ⇒ 图片未送达则报错。详见 minPromptTokensWithImage 的校准记录。
   */
  async describeImage(
    request: ImageUnderstandingRequest,
    options?: Record<string, unknown>,
  ): Promise<ImageUnderstandingResult> {
    const dataUrl = request.image.dataUrl ?? request.image.url;
    if (!dataUrl) {
      throw new Error('[Civitai] 提炼图片缺少 dataUrl 或 url');
    }

    const { system, taskText } = buildUnderstandingPrompt(request.task, request.prompt);
    const model = request.model?.trim() || CivitaiImageProvider.DEFAULT_UNDERSTANDING_MODEL;

    const body = {
      model,
      maxTokens: request.maxNewTokens ?? 600,
      temperature: request.temperature ?? 0.2,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            // CRITICAL: camelCase — snake_case image_url is silently dropped (见上方注释 1)
            { type: 'imageUrl', imageUrl: { url: dataUrl } },
            { type: 'text', text: taskText },
          ],
        },
      ],
    };

    const url = this.buildRecipeUrl('/v2/consumer/recipes/chatCompletion', options);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      if (response.status === 401) throw new Error('[Civitai] API Key 无效或已过期');
      if (response.status === 402) throw new Error('[Civitai] Buzz 余额不足');
      if (response.status === 429) throw new Error('[Civitai] 请求过于频繁，请稍后再试');
      throw new Error(`[Civitai] 图片提炼失败: ${response.status} — ${errText.slice(0, 200)}`);
    }

    const rawText = await response.text();
    if (response.status === 204 || !rawText.trim()) {
      throw new Error('[Civitai] 图片提炼返回空响应（204）— 模型名无效或该路由拒绝了请求。请在设置中检查 Civitai 视觉模型名。');
    }

    let data: {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { promptTokens?: number };
    };
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error(`[Civitai] 图片提炼响应解析失败 (非 JSON) — ${rawText.slice(0, 200)}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('[Civitai] 图片提炼响应中无文本内容');
    }

    // 防幻觉断言（硬约束 3）：仅对 openai/ 路由生效——静默丢图只在该路由以
    // 200+幻觉形态出现（真实校准 2026-08-27，详见 minPromptTokensWithImage docs）
    const promptTokens = data.usage?.promptTokens;
    const minTokens = minPromptTokensWithImage(taskText, system, data.model ?? '');
    if (minTokens !== null && typeof promptTokens === 'number' && promptTokens < minTokens) {
      throw new Error(`[Civitai] 网关未将图片送达模型（promptTokens=${promptTokens} 过低），提炼结果会是幻觉，已拦截。请报告此问题。`);
    }

    const parsed = parseUnderstandingResponse(content, request.task);
    if (parsed.degraded && looksLikeRefusal(content)) {
      throw new Error('[Civitai] 模型拒绝分析该图片（可能因内容审核）。可尝试更换视觉模型或切换到通用 LLM 提炼引擎。');
    }

    return {
      provider: 'civitai_vlm',
      task: request.task,
      caption: parsed.caption,
      tags: parsed.tags,
      positiveDraft: parsed.positiveDraft,
      raw: data,
      createdAt: Date.now(),
    };
  }

  // ── Polling ──

  private async pollUntilAvailable(
    endpoint: string,
    initialData: CivitaiRecipeResponse,
    initialImage: CivitaiImage,
  ): Promise<CivitaiImage> {
    const jobToken = initialData.id ?? initialImage.jobId;
    if (!jobToken) {
      throw new Error('[Civitai] 图片尚未就绪且无法获取任务 ID 用于轮询');
    }

    const maxAttempts = 60;
    const pollInterval = 3000;
    const pollUrl = `${endpoint}/v2/consumer/jobs/${jobToken}`;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, pollInterval));

      let pollRes: Response;
      try {
        pollRes = await fetch(pollUrl, {
          headers: { 'Authorization': `Bearer ${this.apiKey}` },
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        continue;
      }
      if (!pollRes.ok) continue;

      let pollData: CivitaiRecipeResponse;
      try {
        pollData = await pollRes.json() as CivitaiRecipeResponse;
      } catch { continue; }

      const img = pollData.images?.[0];
      if (!img) continue;
      if (img.blockedReason) {
        throw new CivitaiBlockedError(img.blockedReason, img.nsfwLevel);
      }
      if (img.available && img.url) return img;
    }

    throw new Error(`[Civitai] 等待图片就绪超时 (${maxAttempts * pollInterval / 1000}s)`);
  }

  async testConnection(): Promise<boolean> {
    const endpoint = this.endpoint.replace(/\/+$/, '');
    try {
      const res = await fetch(`${endpoint}/v2/consumer/workflows?take=1`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch { return false; }
  }
}
