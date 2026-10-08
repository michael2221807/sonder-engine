/**
 * Zero-real-API egress guard (extracted from game-card-epic.spec.ts).
 *
 * Three intents in one place:
 *  1. BLOCKED_PATTERNS — the known LLM / embedding / rerank / image-gen endpoints.
 *     Any hit is recorded and aborted (it should never fire: nothing is configured).
 *  2. Catch-all violation guard — a `**\/*` route registered FIRST (so it has the
 *     LOWEST precedence; Playwright tries the most-recently-registered match first).
 *     It allows only same-origin / loopback / data: / blob: and records ANY other
 *     host (including api.github.com, which the LLM list misses) as a violation,
 *     then aborts it.
 *  3. The fixture in `base.ts` asserts BOTH lists are empty in teardown, so any
 *     un-mocked egress becomes a TEST FAILURE — never a silent hang or token bill.
 */
import type { Page, Route } from '@playwright/test';

const BLOCKED_PATTERNS: string[] = [
  '**/v1/chat/completions',      // OpenAI / DeepSeek / custom LLM
  '**/v1/messages',              // Claude
  '**/v1beta/**',                // Gemini generateContent / streamGenerateContent
  '**/v1/embeddings',            // embeddings (OpenAI-shape)
  '**/v1/embed',                 // embeddings (Cohere-shape)
  '**/v1/rerank',                // rerank
  '**/v1/images/generations',    // OpenAI images
  '**/generate-image',           // NovelAI
  '**/sdapi/v1/**',              // SD WebUI
  'https://image.novelai.net/**',
  'https://api.openai.com/**',
  'https://orchestration.civitai.com/**',
  'https://api.github.com/**',                              // GitHub cloud sync
  'http://localhost:8188/**', 'http://127.0.0.1:8188/**',   // ComfyUI
  'http://localhost:7860/**', 'http://127.0.0.1:7860/**',   // SD WebUI
];

/**
 * Benign third-party STATIC assets (web fonts). These carry no tokens and are not
 * data egress, but we abort them anyway so the suite is fully HERMETIC (no external
 * network at all): the app falls back to system fonts, which is fine because the
 * suite asserts on the DOM, not glyph rendering (visual regression is not adopted).
 * Aborting silently keeps them OUT of the violation list.
 */
const IGNORED_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

/** Records every real-API attempt so a test can assert the suite stayed offline. */
export interface GuardState {
  /** Hits on a known LLM/embedding/image/github endpoint. */
  hits: string[];
  /** Any other unexpected cross-origin host that tried to egress (catch-all net). */
  violations: string[];
}

type Verdict = 'allow' | 'ignore' | 'violation';

/** Classify a request: same-origin/loopback → allow; benign font CDN → ignore; else → violation. */
function classify(url: string): Verdict {
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('chrome-extension:') || url.startsWith('file:')) return 'allow';
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return 'allow'; // non-standard scheme — leave it to the app
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1') return 'allow';
  if (IGNORED_HOSTS.includes(hostname)) return 'ignore';
  return 'violation';
}

/**
 * Installs the guard on a page. Register order matters: the catch-all goes first
 * (lowest precedence) so the specific BLOCKED_PATTERNS handlers win for known hosts.
 */
export async function installApiGuard(page: Page): Promise<GuardState> {
  const state: GuardState = { hits: [], violations: [] };

  // Catch-all: allow same-origin/loopback, silently drop benign font CDNs,
  // record+abort any other cross-origin egress.
  await page.route('**/*', (route: Route) => {
    const url = route.request().url();
    const verdict = classify(url);
    if (verdict === 'allow') return route.continue();
    if (verdict === 'violation') state.violations.push(url);
    return route.abort('blockedbyclient');
  });

  // Known real-API endpoints — higher precedence, recorded as explicit hits.
  for (const pattern of BLOCKED_PATTERNS) {
    await page.route(pattern, (route: Route) => {
      state.hits.push(route.request().url());
      return route.abort('blockedbyclient');
    });
  }

  return state;
}
