/**
 * LLM endpoint path resolution — epic P4 (decision D4).
 *
 * `/v1/chat/completions` used to be hardcoded in three places (OpenAIProvider
 * ×2, AIService.testConnection llm branch, fetchModels). This is the single
 * resolution point: an explicit custom routing path wins, then the llm
 * catalog preset's defaultPath (e.g. Volcano Ark's `/api/v3/chat/completions`),
 * then the OpenAI-compatible default.
 */
import { providerCatalog } from './catalog-instance';

const DEFAULT_CHAT_PATH = '/v1/chat/completions';
const DEFAULT_MODELS_PATH = '/v1/models';

export function resolveLlmChatPath(backend?: string, customPath?: string): string {
  const custom = customPath?.trim();
  if (custom) return custom.startsWith('/') ? custom : `/${custom}`;
  if (backend) {
    const d = providerCatalog.get('llm', backend);
    if (d?.defaultPath) return d.defaultPath;
  }
  return DEFAULT_CHAT_PATH;
}

/**
 * Model-listing path for OpenAI-compatible providers. `null` = the preset
 * declares no listing endpoint (UI hides the fetch-models button); presets
 * unknown to the catalog keep the OpenAI default.
 */
export function resolveLlmModelsPath(backend?: string): string | null {
  if (backend) {
    const d = providerCatalog.get('llm', backend);
    if (d) return d.modelsPath ?? null;
  }
  return DEFAULT_MODELS_PATH;
}
