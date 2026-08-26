/**
 * Provider Descriptor & Catalog — P0 of the provider-standardization epic.
 *
 * One catalog entry per (category, backend id) is the single source of truth for
 * "which providers exist and what they look like": UI dropdowns, URL presets,
 * credential form fields, capability flags and default endpoint paths all read
 * from here instead of maintaining parallel hand-synced lists.
 * Design: docs/design/volcano-ark-provider-epic.md §3.1-§3.3.
 *
 * Engine rules: no vue / vue-i18n imports and no display strings — the UI
 * resolves names via the i18n key convention `api.backend.<id>` and
 * `api.backend.hint.<id>`.
 */
import type { APICategory } from '../ai/types';

/**
 * One credential input the provider requires.
 *
 * Convention: `key === 'apiKey'` targets the existing `APIConfig.apiKey` field
 * (back-compat with every single-key provider); any other key is stored in
 * `APIConfig.credentials[key]`. Multi-credential providers (e.g. Doubao voice:
 * appId + accessToken + resourceId) declare one spec per field and the UI
 * renders the form from these specs.
 */
export interface CredentialFieldSpec {
  key: string;
  /** i18n label key, e.g. 'api.credential.appId'. */
  i18nKey: string;
  required: boolean;
  /** Render as a masked (password-style) input. */
  secret: boolean;
}

/**
 * Descriptor for one backend within one API category.
 *
 * A vendor serving several categories registers one descriptor per category
 * (Volcano Ark will register llm + image; Doubao voice tts + stt).
 */
export interface ProviderDescriptor {
  /**
   * Unique id within the category — the value persisted on `APIConfig.backend`
   * for non-llm categories (llm configs keep using `APIConfig.provider`).
   */
  id: string;
  category: APICategory;
  /** URL prefill for the add-config form ('' = user must type one). */
  urlPreset: string;
  /**
   * Default path appended to the base URL for the category's primary call.
   * Generic request builders use it as the fallback that
   * `APIConfig.customRoutingPath` overrides; provider classes with bespoke
   * request flows (Claude, Gemini, ComfyUI…) may consult it for documentation
   * value only.
   */
  defaultPath: string;
  /** Model-listing endpoint path; omitted = backend has none (UI hides the fetch-models button). */
  modelsPath?: string;
  /** Credential inputs this backend requires (empty = no credentials needed). */
  credentialFields: CredentialFieldSpec[];
  /**
   * Capability flags driving UI visibility (no feature toggles — the UI shows
   * what the selected backend declares). Key sets are category-specific, e.g.
   * image: textToImage/imageToImage/imageCaptioning/imageTagging/inpainting;
   * tts: speakerListing/streamUrl; stt: sttStreaming.
   */
  capabilities: Record<string, boolean>;
  /** Suggested default model name (UI placeholder / prefill). */
  defaultModel?: string;
}

/** Standard single-API-key credential spec shared by most backends. */
export const API_KEY_CREDENTIAL: CredentialFieldSpec = {
  key: 'apiKey',
  i18nKey: 'api.credential.apiKey',
  required: true,
  secret: true,
};

/** Same field but optional — for local services that ignore auth (CosyVoice). */
export const OPTIONAL_API_KEY_CREDENTIAL: CredentialFieldSpec = {
  ...API_KEY_CREDENTIAL,
  required: false,
};

/**
 * The one registry of provider descriptors. `main.ts` pairs its entries with
 * the per-category instance registries (image/tts/stt factories) at boot; a
 * descriptor without a factory (or vice versa) is a wiring bug surfaced there.
 */
export class ProviderCatalog {
  private entries = new Map<string, ProviderDescriptor>();

  private static keyOf(category: APICategory, id: string): string {
    return `${category}:${id}`;
  }

  register(descriptor: ProviderDescriptor): void {
    const key = ProviderCatalog.keyOf(descriptor.category, descriptor.id);
    if (this.entries.has(key)) {
      throw new Error(`[ProviderCatalog] duplicate descriptor "${key}"`);
    }
    this.entries.set(key, descriptor);
  }

  get(category: APICategory, id: string): ProviderDescriptor | undefined {
    return this.entries.get(ProviderCatalog.keyOf(category, id));
  }

  has(category: APICategory, id: string): boolean {
    return this.entries.has(ProviderCatalog.keyOf(category, id));
  }

  byCategory(category: APICategory): ProviderDescriptor[] {
    return [...this.entries.values()].filter((d) => d.category === category);
  }
}
