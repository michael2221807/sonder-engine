// App doc: docs/user-guide/pages/home.md §1.3.1 (添加/编辑 API 弹窗 · 图像后端)
/**
 * Volcano Ark (火山方舟) Seedream image provider — epic P1.
 *
 * Endpoint: POST {endpoint}/api/v3/images/generations (OpenAI-images style;
 * catalog descriptor records the same path). Auth: Bearer ARK API key.
 * Contract refs: docs/research/volcano-ark-integration-research.md §2.2 and
 * https://www.volcengine.com/docs/82379 (Seedream 3.0/4.0 image generation).
 *
 * Notes:
 * - Seedream has NO negative-prompt parameter — `negative` is accepted and
 *   ignored (same precedent as OpenAIImageProvider's `_negative`).
 * - `watermark` defaults to false (epic decision: game-facing art must not
 *   carry the AI watermark unless the user opts in via options).
 * - Image-to-image (Seedream 4.0): the resolved reference data URL is passed
 *   via the `image` parameter; Seedream has no denoise-strength equivalent,
 *   so `reference.denoiseStrength` is ignored.
 * - Size mapping rules follow the official docs as of 2026-08; they are
 *   centralized in {@link resolveSeedreamSize} and MUST be re-verified against
 *   a real key (P1 acceptance) before this backend is declared done.
 */
import { BaseImageProvider, IMAGE_GENERATE_TIMEOUT_MS, IMAGE_DOWNLOAD_TIMEOUT_MS } from './base';
import type { ImageBackendType } from '../types';
import type { ImageReferenceInput } from '../reference-types';
import type { ImageToImageProvider } from '../provider-capabilities';

/** Generation path relative to the configured base URL (catalog defaultPath). */
const GENERATION_PATH = '/api/v3/images/generations';

/** seedream-5.x pixel-AREA bounds — live-verified 2026-08-27 via the API's own
 * validation messages ("image size must be at least 3686400 pixels" /
 * "at most 16777216 pixels"). 3,686,400 = 1920², 16,777,216 = 4096². */
const SEEDREAM5_MIN_PIXELS = 3_686_400;
const SEEDREAM5_MAX_PIXELS = 16_777_216;

/**
 * 参考图张数上限（官方规格：doubao-seedream-5.0-lite / 4.5 / 4.0
 * 「最多支持传入 14 张参考图」；另有「参考图 + 生成图 ≤ 15」的总量约束，本期
 * 不做组图故生成图恒为 1，14 即有效上限）。UI 与 provider 共用此常量。
 */
export const SEEDREAM_MAX_REFERENCE_IMAGES = 14;

/**
 * Map a requested width/height onto Seedream's allowed range, keeping aspect
 * ratio and rounding to multiples of 8:
 * - seedream-5.x: total PIXEL COUNT within [3686400, 16777216] (per-dimension
 *   limits none observed — the API validates area, live-verified 2026-08-27)
 * - seedream-4.x: both sides within [1280, 4096]
 * - seedream-3.x: both sides within [512, 2048]
 * - unknown models: conservative [512, 4096] clamp (no upscale below 512)
 */
export function resolveSeedreamSize(model: string, width: number, height: number): string {
  const m = model.toLowerCase();

  // Non-finite/zero guards: fall back to a square request rather than emitting
  // "NaNxNaN" at the API (review Minor 2026-08-26).
  const safeW = Number.isFinite(width) && width > 0 ? width : 1024;
  const safeH = Number.isFinite(height) && height > 0 ? height : 1024;

  let w = Math.max(1, Math.round(safeW));
  let h = Math.max(1, Math.round(safeH));

  if (m.includes('seedream-5')) {
    // Area-based scaling: grow (ceil to /8 so rounding never dips back under
    // the minimum) or shrink (floor to /8) aspect-preserving.
    const area = w * h;
    if (area < SEEDREAM5_MIN_PIXELS) {
      const s = Math.sqrt(SEEDREAM5_MIN_PIXELS / area);
      w = Math.ceil((w * s) / 8) * 8;
      h = Math.ceil((h * s) / 8) * 8;
    } else if (area > SEEDREAM5_MAX_PIXELS) {
      const s = Math.sqrt(SEEDREAM5_MAX_PIXELS / area);
      w = Math.floor((w * s) / 8) * 8;
      h = Math.floor((h * s) / 8) * 8;
    } else {
      w = Math.round(w / 8) * 8;
      h = Math.round(h / 8) * 8;
    }
    // Per-side floor: extreme aspect ratios (free-text manual-size inputs)
    // can round a side to 0 — never emit a zero dimension (review Important
    // 2026-08-27).
    w = Math.max(8, w); h = Math.max(8, h);
    // /8 rounding (or the floor above) can cross an area bound — re-fit by
    // resizing the LARGER side only, in one step. No lockstep ±8 loops: they
    // walk tiny sides through zero and crawl on extreme ratios.
    if (w * h > SEEDREAM5_MAX_PIXELS) {
      if (w >= h) w = Math.max(8, Math.floor(SEEDREAM5_MAX_PIXELS / h / 8) * 8);
      else h = Math.max(8, Math.floor(SEEDREAM5_MAX_PIXELS / w / 8) * 8);
    }
    if (w * h < SEEDREAM5_MIN_PIXELS) {
      if (w >= h) w = Math.ceil(SEEDREAM5_MIN_PIXELS / h / 8) * 8;
      else h = Math.ceil(SEEDREAM5_MIN_PIXELS / w / 8) * 8;
    }
    return `${w}x${h}`;
  }

  const [min, max] = m.includes('seedream-4') ? [1280, 4096]
    : m.includes('seedream-3') ? [512, 2048]
    : [512, 4096];

  // Scale up so the smaller side reaches min, then down so the larger side
  // fits max (down-scale wins if the aspect ratio cannot satisfy both).
  const upScale = Math.max(min / w, min / h, 1);
  w *= upScale; h *= upScale;
  const downScale = Math.min(max / w, max / h, 1);
  w *= downScale; h *= downScale;

  const roundTo8 = (v: number) => Math.min(max, Math.max(min, Math.round(v / 8) * 8));
  return `${roundTo8(w)}x${roundTo8(h)}`;
}

/**
 * `seed` 的机型门控（官方参数表 2026-08-28）：
 * 「仅 doubao-seedream-3.0-t2i / doubao-seededit-3.0-i2i 支持该参数」。
 * 我们的默认机型 doubao-seedream-5.0-lite（以及 4.x）不支持——此前无条件转发
 * 等于对网关发无效字段（最好情况被忽略，最坏未来变 400）。
 */
export function seedreamSupportsSeed(model: string): boolean {
  // 机型 ID 两种写法都要认：文档里的 `doubao-seedream-3.0-t2i` 与实际
  // endpoint 里的 `doubao-seedream-3-0-t2i-250415`（点/连字符 + 日期后缀）。
  const m = model.toLowerCase();
  return /seedream-3[.-]0-t2i/.test(m) || /seededit-3[.-]0-i2i/.test(m);
}

export class VolcengineImageProvider extends BaseImageProvider implements ImageToImageProvider {
  readonly backend: ImageBackendType = 'volcengine';

  async generate(
    prompt: string,
    _negative: string,
    width: number,
    height: number,
    options?: Record<string, unknown>,
  ): Promise<Blob> {
    return this.request(this.buildBody(prompt, width, height, options));
  }

  /**
   * 多图参考重绘：`image` 收整组来源。官方 `anyOf: string | array`，
   * 5.0-lite/4.5/4.0 上限 14 张（3.x / seededit 只吃单图，由上层能力门控与
   * 机型选择保证；这里只做长度兜底，不按机型分叉——超限截断永远是安全的）。
   * 顺序即语义：提示词里的「图1/图2」按本数组下标对应。
   */
  async imageToImage(
    prompt: string,
    _negative: string,
    width: number,
    height: number,
    references: ImageReferenceInput[],
    options?: Record<string, unknown>,
  ): Promise<Blob> {
    const sources = references
      .map((r) => r.dataUrl ?? r.url)
      .filter((s): s is string => !!s);
    if (sources.length === 0) throw new Error('[Volcengine] 参考图缺少 dataUrl/url');
    if (sources.length < references.length) {
      // 剔除会让后面的「图N」整体前移——绝不能静默（本文件的一贯约定）。
      // 正常链路不会走到：ImageService.resolveReferenceAsset 已保证每项有源。
      console.warn(
        `[Volcengine] ${references.length - sources.length} 张参考图缺少 dataUrl/url 已剔除，`
        + '其后各图的「图N」编号相应前移',
      );
    }

    let effective = sources;
    if (sources.length > SEEDREAM_MAX_REFERENCE_IMAGES) {
      // 兜底截断：UI 侧已按 multiReference 能力把上限卡在 14，走到这里说明有
      // 非 UI 调用方越界——截断而不是整单失败，但必须留下可观测痕迹。
      console.warn(
        `[Volcengine] 参考图 ${sources.length} 张超过上限 ${SEEDREAM_MAX_REFERENCE_IMAGES}，`
        + `已截断为前 ${SEEDREAM_MAX_REFERENCE_IMAGES} 张（提示词里的「图N」编号随之改变）`,
      );
      effective = sources.slice(0, SEEDREAM_MAX_REFERENCE_IMAGES);
    }

    const body = this.buildBody(prompt, width, height, options);
    body.image = effective;
    return this.request(body);
  }

  /**
   * Generation URL: a configured endpoint that already carries a path (e.g.
   * the Agent Plan `/api/plan/v3/images/generations`, or a local proxy route)
   * is used verbatim; a bare origin gets the standard pay-as-you-go path
   * appended. NOTE (live-verified 2026-08-27): the `/api/plan/*` gateway does
   * NOT allow the `authorization` header in its CORS preflight — browsers can
   * only reach the plan path through a proxy; direct browser calls must use
   * the default `/api/v3` path.
   */
  private generationUrl(): string {
    const endpoint = this.endpoint.replace(/\/+$/, '');
    try {
      const u = new URL(endpoint);
      if (u.pathname && u.pathname !== '/') return endpoint;
    } catch { /* not an absolute URL — fall through to append */ }
    return `${endpoint}${GENERATION_PATH}`;
  }

  private buildBody(
    prompt: string,
    width: number,
    height: number,
    options?: Record<string, unknown>,
  ): Record<string, unknown> {
    const model = this.model || 'doubao-seedream-5.0-lite';
    const body: Record<string, unknown> = {
      model,
      prompt,
      size: resolveSeedreamSize(model, width, height),
      response_format: 'b64_json',
      // Off by default — game art must not carry the provider watermark.
      watermark: options?.watermark === true,
    };
    if (typeof options?.seed === 'number' && options.seed >= 0 && seedreamSupportsSeed(model)) {
      body.seed = options.seed;
    }
    // guidance_scale：官方参数表明确 "doubao-seedream-5.0-lite/4.5/4.0 不支持"
    // （只有 3.0-t2i / seededit-3.0-i2i 有），因此不转发；style-param-resolver
    // 同步把 cfgScale 标为不适用。校准悬念到此关闭（2026-08-28 官方规格核对）。
    return body;
  }

  private async request(body: Record<string, unknown>): Promise<Blob> {
    const response = await fetch(this.generationUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(IMAGE_GENERATE_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => `HTTP ${response.status}`);
      throw new Error(`[Volcengine] Image generation failed: ${response.status} — ${errText.slice(0, 200)}`);
    }

    const data = await response.json() as {
      data?: Array<{ b64_json?: string; url?: string }>;
    };

    // 本期不做组图（PO 决策②，`sequential_image_generation` 未启用）→ 服务端
    // 恒返回 1 张。若将来开了组图而这里仍只取首张，其余会被静默丢弃——留一条
    // 可观测警告，别让下一个人像上次 seed 那样靠猜发现问题。
    if ((data.data?.length ?? 0) > 1) {
      console.warn(
        `[Volcengine] 响应含 ${data.data!.length} 张图，当前只消费第 1 张`
        + '（组图模式尚未接入，见 docs/design/seedream-multi-reference-implementation.md §4）',
      );
    }

    const b64 = data.data?.[0]?.b64_json;
    if (!b64) {
      const url = data.data?.[0]?.url;
      if (url) {
        const imgResponse = await fetch(url, { signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS) });
        return imgResponse.blob();
      }
      throw new Error('[Volcengine] No image data in response');
    }

    const clean = b64.replace(/^data:[^;]+;base64,/, '');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: 'image/png' });
  }

  /**
   * Free-of-charge probe: an intentionally invalid size is rejected at
   * parameter validation (400 InvalidParameter) BEFORE any image is billed —
   * reaching that error proves endpoint + auth are good. 401/403/404 (or a
   * network failure) prove they are not.
   */
  async testConnection(): Promise<boolean> {
    try {
      const res = await fetch(this.generationUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model || 'doubao-seedream-5.0-lite',
          prompt: 'test',
          size: '1x1',
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return true; // should not happen with size 1x1, but 200 = definitely reachable
      if (res.status === 400) {
        const text = await res.text().catch(() => '');
        // A param error means we got past auth into validation.
        return !text.includes('AuthenticationError');
      }
      return false;
    } catch {
      return false;
    }
  }
}
