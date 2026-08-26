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

/**
 * Map a requested width/height onto Seedream's allowed pixel range, keeping
 * aspect ratio and rounding to multiples of 8:
 * - seedream-4.x: both sides within [1280, 4096]
 * - seedream-3.x: both sides within [512, 2048]
 * - unknown models: conservative [512, 4096] clamp (no upscale below 512)
 */
export function resolveSeedreamSize(model: string, width: number, height: number): string {
  const m = model.toLowerCase();
  const [min, max] = m.includes('seedream-4') ? [1280, 4096]
    : m.includes('seedream-3') ? [512, 2048]
    : [512, 4096];

  // Non-finite/zero guards: fall back to a square request rather than emitting
  // "NaNxNaN" at the API (review Minor 2026-08-26).
  const safeW = Number.isFinite(width) && width > 0 ? width : 1024;
  const safeH = Number.isFinite(height) && height > 0 ? height : 1024;

  let w = Math.max(1, Math.round(safeW));
  let h = Math.max(1, Math.round(safeH));

  // Scale up so the smaller side reaches min, then down so the larger side
  // fits max (down-scale wins if the aspect ratio cannot satisfy both).
  const upScale = Math.max(min / w, min / h, 1);
  w *= upScale; h *= upScale;
  const downScale = Math.min(max / w, max / h, 1);
  w *= downScale; h *= downScale;

  const roundTo8 = (v: number) => Math.min(max, Math.max(min, Math.round(v / 8) * 8));
  return `${roundTo8(w)}x${roundTo8(h)}`;
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

  async imageToImage(
    prompt: string,
    _negative: string,
    width: number,
    height: number,
    reference: ImageReferenceInput,
    options?: Record<string, unknown>,
  ): Promise<Blob> {
    const source = reference.dataUrl ?? reference.url;
    if (!source) throw new Error('[Volcengine] 参考图缺少 dataUrl/url');
    const body = this.buildBody(prompt, width, height, options);
    body.image = [source];
    return this.request(body);
  }

  private buildBody(
    prompt: string,
    width: number,
    height: number,
    options?: Record<string, unknown>,
  ): Record<string, unknown> {
    const model = this.model || 'doubao-seedream-4-0-250828';
    const body: Record<string, unknown> = {
      model,
      prompt,
      size: resolveSeedreamSize(model, width, height),
      response_format: 'b64_json',
      // Off by default — game art must not carry the provider watermark.
      watermark: options?.watermark === true,
    };
    if (typeof options?.seed === 'number' && options.seed >= 0) body.seed = options.seed;
    // guidance_scale (Seedream 3.x only, range 1-10) is deliberately NOT
    // forwarded yet: style-param-resolver marks cfgScale not-applicable for
    // this backend pending real-key calibration (P1 acceptance). When
    // calibration confirms behavior per model family, re-enable there first.
    return body;
  }

  private async request(body: Record<string, unknown>): Promise<Blob> {
    const endpoint = this.endpoint.replace(/\/+$/, '');
    const response = await fetch(`${endpoint}${GENERATION_PATH}`, {
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
    const endpoint = this.endpoint.replace(/\/+$/, '');
    try {
      const res = await fetch(`${endpoint}${GENERATION_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model || 'doubao-seedream-4-0-250828',
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
