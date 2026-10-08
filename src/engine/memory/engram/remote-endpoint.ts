/**
 * Shared plumbing for the remote embedding / rerank endpoints (R6 step 8):
 * endpoint URL normalisation and a JSON POST with a timeout. Behavior is that of the
 * two copies this replaced (embedder.ts, reranker.ts) - including their one difference,
 * which trailing slashes of the base URL are stripped.
 */
import type { APIConfig } from '../../ai/types';

/**
 * Join `config.url` and a path: the user's `customRoutingPath` (when `useCustomRouting` is on
 * and the path is non-empty) overrides `defaultPath`; a missing leading slash is added.
 *
 * `stripAllTrailingSlashes`: the reranker strips every trailing slash of the base URL, the
 * embedder only one - kept as-is so the request URLs do not change.
 */
export function buildRemoteEndpoint(
  config: APIConfig,
  defaultPath: string,
  stripAllTrailingSlashes: boolean,
): string {
  const base = stripAllTrailingSlashes ? config.url.replace(/\/+$/, '') : config.url.replace(/\/$/, '');
  const useCustom =
    config.useCustomRouting === true &&
    typeof config.customRoutingPath === 'string' &&
    config.customRoutingPath.trim().length > 0;
  const rawPath = useCustom ? config.customRoutingPath!.trim() : defaultPath;
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return `${base}${path}`;
}

/**
 * POST a JSON body (Bearer auth when `apiKey` is set) and return the parsed JSON response.
 * Aborts after `timeoutMs`; a non-2xx response throws `${errorLabel} HTTP <status>: <first 200 chars>`.
 */
export async function postJsonWithTimeout(
  endpoint: string,
  apiKey: string | undefined,
  body: unknown,
  timeoutMs: number,
  errorLabel: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`${errorLabel} HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}
