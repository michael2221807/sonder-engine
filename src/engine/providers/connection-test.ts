/**
 * Connection-test delegation contract — epic P0 item 6.
 *
 * AIService.testConnection used to hand-roll per-category probes, including an
 * image branch hardcoded to Civitai's endpoint (wrong for every other image
 * backend) and tts/stt branches hardcoded to the CosyVoice contract. Categories
 * with provider classes now register a tester (wired in main.ts from the
 * per-category registries), so each backend's own `testConnection()` is what
 * the APIPanel button actually exercises — and AIService carries zero
 * backend-specific knowledge.
 */

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** The raw form/config values the APIPanel test button holds. */
export interface ConnectionTestConfig {
  url: string;
  apiKey: string;
  model: string;
  /** Backend id (catalog descriptor id) — required for delegated categories. */
  backend?: string;
  customRoutingPath?: string;
  credentials?: Record<string, string>;
  /** Optional speaker for TTS probes (empty = server picks its first voice). */
  ttsSpeaker?: string;
}

export type ConnectionTester = (config: ConnectionTestConfig) => Promise<ConnectionTestResult>;

/** Wrap a body with latency measurement + uniform error shaping. */
export async function measureConnectionTest(
  body: () => Promise<{ ok: boolean; error?: string }>,
): Promise<ConnectionTestResult> {
  const start = Date.now();
  try {
    const { ok, error } = await body();
    return { ok, latencyMs: Date.now() - start, error: ok ? undefined : error ?? '连接失败' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timeout = msg.includes('abort') || msg.includes('signal') || msg.includes('timed out');
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: timeout ? '连接超时（10s）' : msg.slice(0, 120),
    };
  }
}
