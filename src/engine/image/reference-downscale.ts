// App doc: docs/user-guide/pages/game-image.md §参考重绘
/**
 * 参考图下采样（2026-09-02，多图参考重绘超时修复）
 *
 * 问题：参考图此前**原样**以全分辨率 base64 送出。用户上传的原图动辄
 * 2560×1440（实测存档里就有一张 1.92MB / 3.7M 像素），而生成目标最大不过
 * 2048²——多出来的像素对结果毫无增益，却让上游的**输入图片内容审核**
 * 逐张变慢。实测（真实存档图 + 真实 gproxy→方舟链路）：
 *
 *   832²/1024² 生成图 ×2   0.52MB →  51.8s  ✅
 *   2560×1440 上传图 ×1    2.56MB →  88.9s
 *   2560×1440 上传图 ×3    7.67MB → 216.3s  ❌ 越过 180s 超时闸 = 用户看到的"超时"
 *
 * 所以耗时由**总像素/字节量**驱动，多图只是让它线性累加。修复即在发送前
 * 把每张参考图压到"够用就好"：长边 ≤1536（仍高于常见输出 832/1024/1216）、
 * 重编码为 JPEG。实测同组 3 张大图压缩后 7.67MB → 0.4MB 级别。
 *
 * **产品决策（PO 2026-09-02）：不静默压缩。** 超时已放宽到 300s 容纳大图；
 * 压缩由用户在 UI 里显式点「压缩」触发（{@link isReferenceOversized} 负责
 * 判断何时提示）。引擎绝不背着用户改动他的参考图。
 *
 * 设计约束：
 * - **fail-soft**：任何一步失败（无 canvas 的测试/SSR 环境、解码失败、
 *   toDataURL 抛错）都原样返回，绝不因为"压缩失败"阻断生图。
 * - **只在超限时动手**：长边已达标的图原样返回，不做无谓的有损重编码。
 * - 引擎层用 canvas 有先例（`png-metadata.ts` 的 NovelAI 隐写解析）。
 */

/** 参考图长边上限。高于常见输出尺寸（832/1024/1216），低于上游审核变慢的量级。 */
export const REFERENCE_MAX_EDGE = 1536;

/** 重编码质量。0.88 在插画/照片上视觉无损，体积却只有 PNG 的十几分之一。 */
export const REFERENCE_JPEG_QUALITY = 0.88;

/**
 * 需要压缩的判定：像素超限，或体积超过该阈值（后者兜住"尺寸不大但存了
 * 无损 PNG"的情况）。base64 长度 ≈ 字节数 × 4/3。
 */
const REFERENCE_MAX_BYTES = 600 * 1024;

/** data URL 的近似字节数（base64 长度 × 3/4）。UI 展示与阈值判断共用。 */
export function estimateDataUrlBytes(dataUrl: string): number {
  return estimateBytesFromDataUrl(dataUrl);
}

/**
 * 该参考图是否「偏大到值得提示用户压缩」。
 * 判据与 {@link downscaleReferenceDataUrl} 的动手条件一致：体积超阈值即算。
 * （像素维度要解码才知道，UI 侧只用体积判断，够用且零成本。）
 */
export function isReferenceOversized(dataUrl: string): boolean {
  return dataUrl.startsWith('data:') && estimateBytesFromDataUrl(dataUrl) > REFERENCE_MAX_BYTES;
}

function estimateBytesFromDataUrl(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  return Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
}

/** 运行环境是否具备解码 + 重编码能力（浏览器有；vitest/node 无 → 降级）。 */
function canDownscale(): boolean {
  return typeof document !== 'undefined'
    && typeof Image !== 'undefined'
    && typeof document.createElement === 'function';
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = dataUrl;
  });
}

/**
 * 把一张参考图 data URL 压到发送尺寸。
 *
 * @param dataUrl 必须是 `data:` URL；远程 URL 原样返回（我们不代下载）。
 * @param maxEdge 长边上限，默认 {@link REFERENCE_MAX_EDGE}。
 * @returns 压缩后的 data URL；任何不适用/失败的情况都返回原值。
 */
export async function downscaleReferenceDataUrl(
  dataUrl: string,
  maxEdge: number = REFERENCE_MAX_EDGE,
): Promise<string> {
  if (!dataUrl.startsWith('data:') || !canDownscale()) return dataUrl;

  try {
    const img = await loadImage(dataUrl);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return dataUrl;

    const longest = Math.max(w, h);
    const overSized = longest > maxEdge;
    const overWeight = estimateBytesFromDataUrl(dataUrl) > REFERENCE_MAX_BYTES;
    if (!overSized && !overWeight) return dataUrl;

    const scale = overSized ? maxEdge / longest : 1;
    const targetW = Math.max(1, Math.round(w * scale));
    const targetH = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, targetW, targetH);

    const out = canvas.toDataURL('image/jpeg', REFERENCE_JPEG_QUALITY);
    // 极端情况下重编码可能反而更大（例如本来就是高压缩 JPEG 的小图）——
    // 取更小的那个，保证这一步永远不会让请求变重。
    return out.length < dataUrl.length ? out : dataUrl;
  } catch {
    // fail-soft：宁可发原图（慢），也不能让压缩失败变成生图失败。
    return dataUrl;
  }
}
