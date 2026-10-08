// Design: docs/design/civitai-lora-shelf-design.md
import type { CivitaiLoraTrigger } from './types';

interface CivitaiModelVersionResponse {
  id: number;
  name?: string;
  trainedWords?: string[];
  baseModel?: string;
  modelId?: number;
  model?: {
    name?: string;
    type?: string;
    nsfw?: boolean;
  };
  files?: unknown[];
  images?: unknown[];
}

export type CivitaiMetadataResult =
  | {
      success: true;
      data: {
        modelName: string;
        versionName: string;
        baseModel?: string;
        trainedWords: string[];
        mature: boolean;
        modelVersionId: number;
        modelId: number;
        sourceUrl: string;
      };
    }
  | {
      success: false;
      error: string;
    };

const VERSION_ID_RE = /@(\d+)$/;

export function extractVersionIdFromAir(air: string): number | null {
  const m = air.trim().match(VERSION_ID_RE);
  return m ? Number(m[1]) : null;
}

export async function fetchCivitaiLoraMetadata(params: {
  air: string;
  apiKey?: string;
}): Promise<CivitaiMetadataResult> {
  const versionId = extractVersionIdFromAir(params.air);
  if (!versionId) {
    return { success: false, error: 'AIR 中未找到版本 ID（格式: modelId@versionId）' };
  }

  const url = `https://civitai.com/api/v1/model-versions/${versionId}`;

  // Attempt 1: no auth (public models)
  let response = await tryFetch(url);

  // Attempt 2: retry with auth only on 401/403 (likely auth/CORS issue)
  if (!response.ok && params.apiKey && (response.status === 401 || response.status === 403)) {
    response = await tryFetch(url, params.apiKey);
  }

  if (!response.ok) {
    return { success: false, error: response.error ?? `请求失败: HTTP ${response.status}` };
  }

  try {
    const data = response.data as CivitaiModelVersionResponse;
    if (!data || typeof data !== 'object') {
      return { success: false, error: '响应格式不正确' };
    }

    const modelId = data.modelId ?? 0;
    const modelVersionId = data.id ?? versionId;

    return {
      success: true,
      data: {
        modelName: data.model?.name ?? '',
        versionName: data.name ?? '',
        baseModel: data.baseModel,
        trainedWords: Array.isArray(data.trainedWords) ? data.trainedWords.filter((w) => typeof w === 'string' && w.trim()) : [],
        mature: data.model?.nsfw === true,
        modelVersionId,
        modelId,
        sourceUrl: modelId
          ? `https://civitai.com/models/${modelId}?modelVersionId=${modelVersionId}`
          : '',
      },
    };
  } catch {
    return { success: false, error: '响应解析失败' };
  }
}

export function trainedWordsToTriggers(words: string[]): CivitaiLoraTrigger[] {
  const now = Date.now();
  return words
    .filter((w) => w.trim())
    .map((w, i) => ({
      id: `meta_${now}_${i}`,
      text: w.trim(),
      enabled: true,
      source: 'metadata' as const,
      createdAt: now,
      updatedAt: now,
    }));
}

// ── Internal ──

interface FetchResult {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
}

async function tryFetch(url: string, apiKey?: string): Promise<FetchResult> {
  try {
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return { ok: false, status: res.status };
    }

    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      return { ok: false, error: '请求超时' };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `网络错误: ${msg}` };
  }
}
