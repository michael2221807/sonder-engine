/**
 * 图片提炼 · 双引擎能力门 + D3B「必须标明」（图片提炼重建 epic P3）
 *
 * Why this lives in the browser suite (iron law 2 self-check): the rebuild's
 * UI value is (a) capability-gated engine selection driven by live API-config
 * state and (b) the D3B mandate that the General-LLM engine visibly names the
 * main-chat model it reuses. Both are template bindings over injected services
 * (no component-test layer exists), so a wrong binding is catchable ONLY in a
 * real browser. Engine dispatch/parsing logic itself is pinned in vitest
 * (civitai.test.ts / llm-understanding.test.ts / understanding-prompt.test.ts).
 *
 * Fully offline: gating reads API configs from localStorage; no engine call is
 * ever fired (the start button is either disabled or never clicked).
 */
import { test, expect, seedSave, enterSeededGame } from './fixtures/base';
import { makeSeedTree } from './fixtures/seed-tree';
import { goToGameTab } from './fixtures/navigation';
import type { Page } from '@playwright/test';

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1920', 'sidebar-driven spec runs on desktop-1920 only');
});

function imageTree() {
  return makeSeedTree({
    系统: { 扩展: { image: { enabled: true } } },
  });
}

// 1×1 px PNG — 只用于打开提炼面板，绝不会被发送（零 API 契约）
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function openUnderstandingPanel(page: Page) {
  await goToGameTab(page, 'image');
  await page.getByRole('tab', { name: '预设', exact: true }).click();
  await page.getByTestId('understanding-import-input').setInputFiles({
    name: 'probe.png', mimeType: 'image/png', buffer: TINY_PNG,
  });
}

/** Seed API configs on top of seedSave's disable-api baseline (registered later → wins). */
async function seedApiConfigs(page: Page, configs: Array<Record<string, unknown>>) {
  await page.addInitScript((cfgs) => {
    localStorage.setItem('aga_api_management', JSON.stringify({ apiConfigs: cfgs, apiAssignments: [] }));
  }, configs);
  await page.reload();
}

const CIVITAI_IMAGE_CONFIG = {
  id: 'e2e-civitai', name: 'civitai-img', apiCategory: 'image', provider: 'openai',
  backend: 'civitai', url: 'https://orchestration.civitai.com', apiKey: 'k', model: '',
  temperature: 0, maxTokens: 1, enabled: true,
};
const MAIN_LLM_CONFIG = {
  id: 'e2e-llm', name: 'main-llm', apiCategory: 'llm', provider: 'openai',
  url: 'http://127.0.0.1:1', apiKey: 'k', model: 'noop-model',
  temperature: 0, maxTokens: 1, enabled: true,
};

test.describe('图片提炼 · 双引擎能力门 (offline: full)', () => {
  test('无任何可用引擎时：选择器禁用 + 引导文案 + 开始按钮禁用（无死控件）',
    { tag: ['@regression', '@image', '@understanding-rebuild'] },
    async ({ page }) => {
      // GIVEN 默认种子（disable-api：无可用 LLM、无图像 API）
      await seedSave(page, { tree: imageTree(), sessionType: 'play' });
      await enterSeededGame(page);

      // WHEN 打开提炼面板
      await openUnderstandingPanel(page);

      // THEN 完整禁用 + 指路文案
      await expect(page.getByTestId('understanding-no-engine')).toBeVisible();
      await expect(page.getByTestId('understanding-no-engine')).toContainText('API 管理');
      await expect(page.getByTestId('understanding-start-btn')).toBeDisabled();
    });

  test('仅配置 Civitai 图像 API：Civitai 引擎可用，通用 LLM 禁用并提示',
    { tag: ['@regression', '@image', '@understanding-rebuild'] },
    async ({ page }) => {
      await seedSave(page, { tree: imageTree(), sessionType: 'play' });
      await seedApiConfigs(page, [CIVITAI_IMAGE_CONFIG]);
      await enterSeededGame(page);

      await openUnderstandingPanel(page);

      await expect(page.getByTestId('understanding-no-engine')).toHaveCount(0);
      await expect(page.getByTestId('understanding-start-btn')).toBeEnabled();
      // 通用 LLM 不可用的提示（D7 引导），Civitai 侧无提示
      await expect(page.getByTestId('understanding-llm-hint')).toBeVisible();
      await expect(page.getByTestId('understanding-civitai-hint')).toHaveCount(0);
      // 选中引擎为 Civitai 视觉
      await expect(page.getByTestId('understanding-engine-select')).toContainText('Civitai 视觉');
    });

  test('仅配置 OpenAI 兼容主对话：通用 LLM 选项标明主对话模型名（D3B「必须标明」）',
    { tag: ['@regression', '@image', '@understanding-rebuild'] },
    async ({ page }) => {
      await seedSave(page, { tree: imageTree(), sessionType: 'play' });
      await seedApiConfigs(page, [MAIN_LLM_CONFIG]);
      await enterSeededGame(page);

      await openUnderstandingPanel(page);

      // 自动落到可用引擎，且触发器标明复用的主对话模型名
      await expect(page.getByTestId('understanding-engine-select')).toContainText('noop-model');
      await expect(page.getByTestId('understanding-civitai-hint')).toBeVisible();
      await expect(page.getByTestId('understanding-start-btn')).toBeEnabled();
    });

  test('设置区：旧 WD 控件已拆除，新提炼设置 + 主对话标示行就位',
    { tag: ['@regression', '@image', '@understanding-rebuild'] },
    async ({ page }) => {
      await seedSave(page, { tree: imageTree(), sessionType: 'play' });
      await seedApiConfigs(page, [MAIN_LLM_CONFIG]);
      await enterSeededGame(page);
      await goToGameTab(page, 'image');
      await page.getByRole('tab', { name: '设置', exact: true }).click();

      // 新控件就位
      await expect(page.getByTestId('understanding-default-engine')).toBeVisible();
      await expect(page.getByTestId('understanding-civitai-model')).toHaveValue('claude-sonnet-5');
      // D3B「必须标明」：标示行显示当前主对话模型
      const note = page.getByTestId('understanding-llm-note');
      await note.scrollIntoViewIfNeeded();
      await expect(note).toContainText('noop-model');
      // 旧 WD 时代控件不复存在
      await expect(page.getByText('WD Tag 阈值')).toHaveCount(0);
    });
});
