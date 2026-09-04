/**
 * Context Compiler v1 — user-facing surfaces (ZERO real API).
 *
 * Pins the three things a player can see after the 2026-09-04 change
 * (docs/design/context-compiler-v1-implementation-plan.md S2 / S3 / S5):
 *   1. API 面板 → AI 生成设置 has a「上下文去重（分步第二步）」toggle, ON by default,
 *      and flipping it persists to `aga_ai_settings.contextCompiler` (the key
 *      game-orchestrator.ts reads every round);
 *   2. 设置 → 记忆 no longer offers「短期记忆注入方式」/「Few-shot 对数」;
 *   3. Prompt 组装面板 renders the「上下文编译」card when a step2 snapshot carries a
 *      compileTrace — fed through the SAME event path the engine uses
 *      (`emitPromptAssemblyDebug` → `ui:debug-prompt` → store → panel), so no AI call
 *      is needed to exercise the wiring.
 *
 * Runs on desktop-1920 only (sidebar navigation). Run: npx playwright test context-compiler
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import type { Page } from '@playwright/test';

const ROW = '[data-testid="api-context-compiler-row"]';
const TRACE = '[data-testid="prompt-compile-trace"]';

function settingsToggle(page: Page, label: string) {
  return page
    .locator('.setting-row', { has: page.locator('.setting-label', { hasText: label }) })
    .locator('button.aga-toggle');
}

test.describe('Context Compiler v1 surfaces', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1920', 'sidebar navigation specs run on desktop-1920 only');
  });

  test('API 面板 toggle: default ON, persists to aga_ai_settings.contextCompiler',
    { tag: ['@regression', '@settings'] },
    async ({ page, gameShell }) => {
      await seedSave(page);
      await enterSeededGame(page);
      await gameShell.goTab('api');

      const row = page.locator(ROW);
      await expect(row).toBeVisible();
      const toggle = row.locator('button.aga-toggle');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('aga_ai_settings') ?? '{}'));
      expect(stored.contextCompiler).toBe(false);
      // Co-tenant keys written by the same panel survive the read-merge write.
      expect(typeof stored.splitGen).toBe('boolean');

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('aga_ai_settings') ?? '{}'));
      expect(restored.contextCompiler).toBe(true);
    });

  test('设置 → 记忆: the two removed few-shot controls are gone',
    { tag: ['@regression', '@settings'] },
    async ({ page, gameShell }) => {
      await seedSave(page);
      await enterSeededGame(page);
      await gameShell.goTab('settings');

      // The memory section itself still renders (sanity) …
      await expect(page.locator('.setting-label', { hasText: 'Debug 模式' })).toBeVisible();
      // … but neither removed control does.
      await expect(page.locator('.setting-label', { hasText: '短期记忆注入方式' })).toHaveCount(0);
      await expect(page.locator('.setting-label', { hasText: 'Few-shot 对数' })).toHaveCount(0);
    });

  test('a real split-gen round assembles offline with the compiler ON: step1 snapshot lands in Prompt 组装 and the page stays error-free',
    { tag: ['@regression', '@debug'] },
    async ({ page, gameShell }) => {
      test.slow(); // full main-round assembly (builder + compiler step2 projection) before the aborted AI call
      await seedSave(page);

      // Registered AFTER seedSave's disableApi init script so it wins on the next boot: ONE
      // enabled LLM config pointing at loopback (so the pipeline reaches ContextAssembly
      // + AICall instead of stopping at "no config"), split generation ON so the compiler
      // branch runs, debug toggles ON so the Prompt 组装 entry and snapshots exist.
      await page.addInitScript(() => {
        localStorage.setItem('aga_api_management', JSON.stringify({
          apiConfigs: [{
            id: 'e2e-compiler', name: 'compiler', apiCategory: 'llm', provider: 'openai',
            url: 'http://127.0.0.1:1', apiKey: 'k', model: 'noop',
            temperature: 0, maxTokens: 1, enabled: true,
          }],
          apiAssignments: [],
        }));
        const ai = JSON.parse(localStorage.getItem('aga_ai_settings') ?? '{}') as Record<string, unknown>;
        localStorage.setItem('aga_ai_settings', JSON.stringify({ ...ai, splitGen: true, contextCompiler: true, maxRetries: 0 }));
        localStorage.setItem('aga_debug_settings', JSON.stringify({ debugMode: true, consoleDebug: true, aiLogging: false }));
      });
      await page.reload();
      // Zero egress: the loopback request is aborted before it leaves the browser.
      await page.route('http://127.0.0.1:1/**', (route) => route.abort('connectionrefused'));
      await enterSeededGame(page);

      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));

      await page.locator('.message-input').fill('环顾四周');
      await page.locator('.send-btn').click();

      // The step1 snapshot is emitted by ContextAssembly BEFORE the (aborted) call, so it is
      // observable offline; the panel lists it under its flow id.
      await gameShell.goTab('prompt-assembly');
      await expect(page.getByText('splitGenMainRoundStep1').first()).toBeVisible({ timeout: 30_000 });
      // The builder pieces the compiler dedups against are present in step1 (S4 in the browser).
      await expect(page.locator('.source-breakdown-chip', { hasText: '世界观' }).first()).toBeVisible();
      expect(pageErrors, 'no uncaught page errors during a compiler-on assembly').toEqual([]);
    });

  test('Prompt 组装面板 renders the 上下文编译 card from a step2 snapshot with compileTrace',
    { tag: ['@regression', '@debug'] },
    async ({ page, gameShell }) => {
      await seedSave(page);
      await enterSeededGame(page);

      // Debug 模式 gates the sidebar entry (debug-mode-gate.spec.ts).
      await gameShell.goTab('settings');
      await settingsToggle(page, 'Debug 模式').click();
      await page.locator('.sidebar a[href="/game/prompt-assembly"]').click();
      await page.waitForURL(/\/game\/prompt-assembly$/);

      // Feed a step2 snapshot through the engine's own debug emitter. Vite serves the
      // source module at this URL and the browser module graph shares the instance the
      // app imported, so this reaches the orchestrator's `ui:debug-prompt` handler.
      await page.evaluate(async () => {
        // Non-literal specifier: resolved by the browser (Vite dev server), not by tsc.
        const url = '/src/engine/core/prompt-debug.ts';
        const mod = (await import(/* @vite-ignore */ url)) as {
          emitPromptAssemblyDebug: (params: Record<string, unknown>) => void;
        };
        mod.emitPromptAssemblyDebug({
          flow: 'splitGenMainRoundStep2',
          variables: {},
          messages: [
            { role: 'system', content: 'step2 系统指令' },
            { role: 'user', content: '<玩家输入>\n我走进弄堂。\n</玩家输入>' },
          ],
          messageSources: ['module:splitGenStep2', 'current_input'],
          generationId: 'e2e-compiler_step2',
          roundNumber: 83,
          compileTrace: {
            savedTokens: 46_120,
            entries: [
              { target: '世界.地点信息', action: 'project', reason: 'compiler.reason.adjacency', before: 4_824, after: 640 },
              { target: '社交.事件.事件记录', action: 'project', reason: 'compiler.reason.recentAndRelevant', before: 21_463, after: 3_910 },
              { target: '世界.描述', action: 'strip', reason: 'compiler.reason.sentInStep1', before: 1_611, after: 0 },
              { target: 'world', action: 'strip', reason: 'compiler.reason.sentInStep1', before: 822, after: 0 },
              { target: 'MEMORY_BLOCK', action: 'strip', reason: 'compiler.reason.sentInStep1', before: 2_290, after: 0 },
              { target: 'history', action: 'truncate', reason: 'compiler.reason.fewShotFixed', before: 17_661, after: 7_100 },
            ],
          },
        });
      });

      const card = page.locator(TRACE);
      await expect(card).toBeVisible();
      await expect(card.locator('.compile-trace-row')).toHaveCount(6);
      await expect(card.locator('.compile-trace-saved')).toContainText('46,120');
      // Internal names are humanised; state paths are shown verbatim; reasons are translated.
      await expect(card).toContainText('Engram 检索块');
      await expect(card).toContainText('历史对话');
      await expect(card).toContainText('世界.地点信息');
      await expect(card).toContainText('第 1 步已发送');
      await expect(card.locator('.compile-trace-action[data-action="strip"]')).toHaveCount(3);
    });
});
