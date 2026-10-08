// App doc: docs/user-guide/pages/game-image.md §后台生成保护机制（请求超时保护）
/**
 * Base image provider — abstract base for every concrete image backend
 * (NovelAI, OpenAI, SD-WebUI, ComfyUI, Civitai, Volcengine). Each subclass
 * implements generate() and testConnection().
 */
import type { ImageProvider, ImageBackendType } from '../types';

/**
 * 生图请求超时。300s（2026-09-02 上调，原 180s）：上游按**输入图片总像素量**
 * 做内容审核，多张大参考图会把单次请求推到 3 分钟以上——实测真实存档的
 * 2560×1440 上传图 ×3 = 216.3s，在 180s 闸下被掐断，用户看到的就是"超时"。
 * 实测数据与根因见 docs/status/bugfix-changelog.md 2026-09-02 条目。
 * 配套：UI 在参考图偏大时提供「压缩」按钮（用户自选，不静默改图）。
 */
export const IMAGE_GENERATE_TIMEOUT_MS = 300_000;
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;

export abstract class BaseImageProvider implements ImageProvider {
  abstract readonly backend: ImageBackendType;

  constructor(
    protected endpoint: string,
    protected apiKey: string,
    protected model?: string,
  ) {}

  abstract generate(
    prompt: string,
    negative: string,
    width: number,
    height: number,
    options?: Record<string, unknown>,
  ): Promise<Blob>;

  abstract testConnection(): Promise<boolean>;
}
