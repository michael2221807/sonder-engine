/**
 * NovelAI Image Provider — Sprint Image-5
 *
 * Real implementation against NovelAI's /ai/generate-image endpoint.
 * Reference: verified working implementation from original codebase.
 * Per PRINCIPLES §3.13: implemented from verified API behavior, not blindly copied.
 * Per PRINCIPLES §3.12: no Vite proxy; user configures endpoint directly.
 *
 * Key behaviors:
 * - Auth: Bearer token (user's Persistent API Token)
 * - Request: POST JSON with { input, model, action, parameters }
 * - Response: application/zip containing PNG(s) — decoded via fflate
 * - V4/V4.5 models use structured `v4_prompt` + `characterPrompts`
 * - NAI weight syntax: `1.2::tag::` for emphasis, `{tag}` boost, `[tag]` dampen
 */
// App doc: docs/user-guide/pages/game-image.md §参考重绘
import { BaseImageProvider, IMAGE_GENERATE_TIMEOUT_MS } from './base';
import type { ImageBackendType } from '../types';
import type { ImageToImageProvider } from '../provider-capabilities';
import type { ImageReferenceInput } from '../reference-types';
import { unzipSync } from 'fflate';

/** Default NovelAI negative prompt (verbatim from original) */
const DEFAULT_NEGATIVE = 'photorealistic, realistic, 3d, rendering, unreal engine, octane render, real life, photography, bokeh, lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, artist name, border, out of frame';

const V4_MODEL_RE = /^nai-diffusion-4(?:-|$)/i;

export class NovelAIImageProvider extends BaseImageProvider implements ImageToImageProvider {
  readonly backend: ImageBackendType = 'novelai';

  private buildParameters(
    prompt: string,
    negative: string,
    width: number,
    height: number,
    options?: Record<string, unknown>,
  ): { model: string; parameters: Record<string, unknown>; negativePrompt: string } {
    const model = this.model || 'nai-diffusion-4-5-full';
    const isV4 = V4_MODEL_RE.test(model);
    const seed = (options?.seed as number) ?? Math.floor(Math.random() * 4294967295);
    const steps = (options?.steps as number) ?? 28;
    const scale = (options?.cfgScale as number) ?? 5;
    const sampler = (options?.sampler as string) ?? 'k_euler_ancestral';
    const noiseSchedule = (options?.noiseSchedule as string) ?? 'karras';
    const negativePrompt = negative || DEFAULT_NEGATIVE;

    const parameters: Record<string, unknown> = {
      params_version: 3,
      width: Number.isFinite(width) ? width : 1024,
      height: Number.isFinite(height) ? height : 1024,
      scale,
      sampler,
      steps,
      n_samples: 1,
      ucPreset: 0,
      qualityToggle: true,
      sm: options?.smea === true,
      sm_dyn: options?.smeaDyn === true,
      dynamic_thresholding: false,
      controlnet_strength: 1,
      legacy: false,
      add_original_image: false,
      legacy_v3_extend: false,
      prompt,
      noise_schedule: noiseSchedule,
    };

    if (Number.isFinite(seed)) parameters.seed = seed;
    if (typeof options?.cfgRescale === 'number') parameters.cfg_rescale = options.cfgRescale;

    if (isV4) {
      parameters.v4_prompt = {
        use_coords: false, use_order: false,
        caption: { base_caption: prompt, char_captions: [] },
        legacy_uc: false,
      };
      parameters.v4_negative_prompt = {
        use_coords: false, use_order: false,
        caption: { base_caption: negativePrompt, char_captions: [] },
        legacy_uc: false,
      };
      const characterPrompts = options?.characterPrompts as Array<{
        prompt: string; uc: string; center?: { x: number; y: number };
      }> | undefined;
      if (characterPrompts?.length) {
        parameters.v4_prompt = {
          use_coords: false, use_order: false,
          caption: {
            base_caption: prompt,
            char_captions: characterPrompts.map((cp) => ({
              char_caption: cp.prompt,
              centers: cp.center ? [cp.center] : [{ x: 0.5, y: 0.5 }],
            })),
          },
          legacy_uc: false,
        };
        parameters.v4_negative_prompt = {
          use_coords: false, use_order: false,
          caption: {
            base_caption: negativePrompt,
            char_captions: characterPrompts.map((cp) => ({
              char_caption: cp.uc || '',
              centers: [{ x: 0.5, y: 0.5 }],
            })),
          },
          legacy_uc: false,
        };
      }
    } else {
      if (negativePrompt) parameters.negative_prompt = negativePrompt;
    }

    if (sampler === 'k_euler_ancestral') {
      parameters.deliberate_euler_ancestral_bug = false;
      parameters.prefer_brownian = typeof options?.preferBrownian === 'boolean'
        ? options.preferBrownian : true;
    }

    return { model, parameters, negativePrompt };
  }

  private async sendAndDecode(body: Record<string, unknown>): Promise<Blob> {
    const endpoint = this.endpoint.replace(/\/+$/, '');
    const url = `${endpoint}/ai/generate-image`;
    const response = await fetch(url, {
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
      throw new Error(`[NovelAI] Image generation failed: ${response.status} — ${errText.slice(0, 200)}`);
    }
    return this.decodeZipResponse(response);
  }

  async generate(
    prompt: string,
    negative: string,
    width: number,
    height: number,
    options?: Record<string, unknown>,
  ): Promise<Blob> {
    const { model, parameters } = this.buildParameters(prompt, negative, width, height, options);
    return this.sendAndDecode({
      input: prompt,
      model,
      action: (options?.action as string) ?? 'generate',
      parameters,
    });
  }

  /**
   * NovelAI img2img 只吃**单图**（`parameters.image` 是一个 base64 字符串）。
   * 它的多图能力属于另一个功能 Vibe Transfer（`reference_image_multiple`，≤16，
   * 且 V4+ 每张需付费编码）——语义是搬运画风而非照原图重绘，不并入本方法。
   * 因此这里取首张并对多余项告警；UI 侧不声明 `multiReference`，正常路径下
   * 根本选不出第二张（查证见
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
    const { model, parameters } = this.buildParameters(prompt, negative, width, height, options);

    const reference = references[0];
    if (!reference) throw new Error('[NovelAI] 参考图列表为空');
    if (references.length > 1) {
      console.warn(`[NovelAI] 收到 ${references.length} 张参考图，img2img 只支持单图，已取第 1 张`);
    }

    const sourceDataUrl = reference.dataUrl ?? reference.url;
    if (!sourceDataUrl) throw new Error('[NovelAI] 参考图缺少 dataUrl 或 url');
    if (!sourceDataUrl.startsWith('data:')) {
      throw new Error('[NovelAI] 参考图必须是 base64 data URL（不支持远程 URL）');
    }
    parameters.image = sourceDataUrl.replace(/^data:[^;]+;base64,/, '');
    parameters.strength = reference.denoiseStrength ?? 0.55;
    const noise = (typeof reference.providerMeta?.noise === 'number')
      ? reference.providerMeta.noise : 0.1;
    parameters.noise = noise;
    if (noise > 0) {
      parameters.extra_noise_seed = typeof parameters.seed === 'number'
        ? parameters.seed
        : Math.floor(Math.random() * 4294967295);
    }
    parameters.add_original_image = true;

    return this.sendAndDecode({
      input: prompt,
      model,
      action: 'img2img',
      parameters,
    });
  }

  async testConnection(): Promise<boolean> {
    const endpoint = this.endpoint.replace(/\/+$/, '');
    try {
      const res = await fetch(`${endpoint}/user/data`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async decodeZipResponse(response: Response): Promise<Blob> {
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    try {
      const files = unzipSync(bytes);
      const fileNames = Object.keys(files);
      if (fileNames.length === 0) {
        throw new Error('[NovelAI] ZIP response contains no files');
      }

      const pngName = fileNames.find((n) => n.endsWith('.png')) ?? fileNames[0];
      const pngData = files[pngName];
      return new Blob([pngData], { type: 'image/png' });
    } catch (err) {
      if ((err as Error).message?.includes('NovelAI')) throw err;
      throw new Error(`[NovelAI] Failed to decode ZIP response: ${(err as Error).message}`);
    }
  }
}
