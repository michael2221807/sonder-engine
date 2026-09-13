/**
 * GitHub 存档插槽（per-profile cloud slots）— 关键旅程 e2e。
 * Design doc: docs/design/github-save-slots-design.md §7/§6.
 *
 * 零真实 API 契约：api.github.com 完全由本 spec 的 route mock 承接（先于
 * api-guard 注册的兜底路由，Playwright 后注册者优先），一字节不出网。
 * mock 是一个内存版 GitHub Contents API（listing / file sha / git blobs /
 * PUT / DELETE），足以驱动迁移与插槽列表的完整前端链路。
 */
import type { Page } from '@playwright/test';
import { test, expect, seedSave } from './fixtures/base';

const OWNER = 'e2e-user';
const REPO = 'aga-cloud-save-e2e';
const API = `https://api.github.com`;

/** 内存仓库：path → base64 内容。返回句柄供断言与预置。 */
async function mockGitHubRepo(page: Page, initial: Record<string, string> = {}): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const [p, utf8] of Object.entries(initial)) {
    files.set(p, Buffer.from(utf8, 'utf8').toString('base64'));
  }
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.pathname === '/user') return json(200, { login: OWNER });
    if (url.pathname === `/repos/${OWNER}/${REPO}`) return json(200, { default_branch: 'main' });

    const blobMatch = url.pathname.match(/\/git\/blobs\/(.+)$/);
    if (method === 'GET' && blobMatch) {
      const path = decodeURIComponent(blobMatch[1]).replace(/^sha:/, '');
      const content = files.get(path);
      if (content === undefined) return json(404, { message: 'Not Found' });
      return json(200, { content, encoding: 'base64' });
    }

    const contentsMatch = url.pathname.match(new RegExp(`/repos/${OWNER}/${REPO}/contents/(.+)$`));
    if (contentsMatch) {
      const path = decodeURIComponent(contentsMatch[1]);
      if (method === 'PUT') {
        const body = req.postDataJSON() as { content: string };
        files.set(path, body.content);
        return json(201, { content: { sha: `sha:${path}` } });
      }
      if (method === 'DELETE') {
        if (!files.has(path)) return json(404, { message: 'Not Found' });
        files.delete(path);
        return json(200, {});
      }
      // GET：精确文件 → sha；目录 → 一层列表（文件 + 子目录）；否则 404
      if (files.has(path)) return json(200, { sha: `sha:${path}`, path });
      const prefix = `${path}/`;
      const children = [...files.keys()].filter((k) => k.startsWith(prefix));
      if (children.length > 0) {
        const entries = new Map<string, { name: string; path: string; sha: string; type: string }>();
        for (const child of children) {
          const rest = child.slice(prefix.length);
          const seg = rest.split('/')[0];
          const isDir = rest.includes('/');
          const p = `${path}/${seg}`;
          entries.set(seg, { name: seg, path: p, sha: `sha:${p}`, type: isDir ? 'dir' : 'file' });
        }
        return json(200, [...entries.values()]);
      }
      return json(404, { message: 'Not Found' });
    }
    return json(404, { message: 'Not Found' });
  });
  return files;
}

/** 连接 GitHub（写 localStorage 三键）并重载，使首页云弹窗以已连接态打开。 */
async function connectGitHub(page: Page): Promise<void> {
  await page.evaluate(({ owner, repo }) => {
    localStorage.setItem('aga_github_sync_token', 'e2e-token-never-real');
    localStorage.setItem('aga_github_sync_owner', owner);
    localStorage.setItem('aga_github_sync_repo', repo);
  }, { owner: OWNER, repo: REPO });
  await page.reload();
  await page.getByRole('button', { name: '云存档' }).click();
}

const V2_MANIFEST = JSON.stringify({
  manifestVersion: 2,
  createdAt: '2026-07-20T00:00:00.000Z',
  engineVersion: '0.1.0',
  totalSizeBytes: 100,
  bundleChecksum: 'legacy',
  chunks: [],
});

test.describe('cloud save slots', () => {
  test('v2 cloud repo: explicit migration upgrades to slot format and retires the v2 index', async ({ page }) => {
    const { profileId } = await seedSave(page);
    const repo = await mockGitHubRepo(page, { 'v2/manifest.json': V2_MANIFEST });
    await connectGitHub(page);

    // v2 格式 → 迁移卡片出现，插槽列表不出现
    await expect(page.getByTestId('cs-migrate-btn')).toBeVisible();
    await expect(page.getByTestId('cs-slot-list')).toHaveCount(0);

    await page.getByTestId('cs-migrate-btn').click();
    await page.getByTestId('cs-migrate-run').click();

    // 迁移完成态（逐插槽验证通过后才出现）
    await expect(page.getByTestId('cs-migrate-done')).toBeVisible({ timeout: 20_000 });

    // 云端事实：v2 索引已删；本档案插槽 + global 设置插槽已建
    expect(repo.has('v2/manifest.json')).toBe(false);
    expect(repo.has(`slots/${profileId}/manifest.json`)).toBe(true);
    expect(repo.has('global/manifest.json')).toBe(true);

    // 关掉完成弹窗 → 插槽列表接管（本地档案行 + global 行）
    await page.getByRole('button', { name: '确认' }).click();
    await expect(page.getByTestId('cs-slot-list')).toBeVisible();
    await expect(page.getByTestId(`cs-row-${profileId}`)).toBeVisible();
    await expect(page.getByTestId('cs-row-global')).toBeVisible();
  });

  test('v3 cloud repo: slot list shows cloud-only profiles; delete removes the cloud slot after double-confirm', async ({ page }) => {
    await seedSave(page);
    const ghostManifest = JSON.stringify({
      manifestVersion: 2,
      createdAt: '2026-07-21T00:00:00.000Z',
      engineVersion: '0.1.0',
      totalSizeBytes: 2048,
      bundleChecksum: 'x',
      chunks: [],
      slotMeta: { profileId: 'ghost_profile', profileName: '云端幽灵', packId: 'tianming', slotCount: 1, lastPlayedAt: null },
    });
    const repo = await mockGitHubRepo(page, {
      'slots/ghost_profile/manifest.json': ghostManifest,
      'slots/ghost_profile/state.abc.gz': 'fake-chunk',
    });
    await connectGitHub(page);

    // v3 格式：插槽列表直接接管；云端独有档案可见（含档案名与"云端档案"标记）
    const ghostRow = page.getByTestId('cs-row-ghost_profile');
    await expect(ghostRow).toBeVisible();
    await expect(ghostRow).toContainText('云端幽灵');
    await expect(ghostRow).toContainText('云端档案');
    // 本地档案行显示"云端暂无"+ 上传
    await expect(page.getByTestId('cs-slot-list')).toContainText('云端暂无');

    // 删除云端插槽：二次确认后 manifest+块全部消失，行随刷新移除
    await page.getByTestId('cs-delete-ghost_profile').click();
    await page.getByTestId('cs-delete-confirm').click();
    await expect(page.getByTestId('cs-row-ghost_profile')).toHaveCount(0, { timeout: 15_000 });
    expect(repo.has('slots/ghost_profile/manifest.json')).toBe(false);
    expect(repo.has('slots/ghost_profile/state.abc.gz')).toBe(false);
  });
});

/**
 * 存档新鲜度（docs/design/cloud-slot-freshness.md）：云端 manifest slotMeta 的
 * lastPlayedAt + lastRound 与本地档案戳比较 → 高亮建议按钮 + 旧盖新对照确认。
 */
test.describe('cloud slot freshness (offline: full — cloud is an in-memory mock)', () => {
  function slotManifest(profileId: string, lastPlayedAt: string, lastRound: number): string {
    return JSON.stringify({
      manifestVersion: 2,
      createdAt: '2026-07-21T00:00:00.000Z',
      engineVersion: '0.1.0',
      totalSizeBytes: 2048,
      bundleChecksum: 'x',
      chunks: [],
      slotMeta: { profileId, profileName: '叶尘', packId: 'tianming', slotCount: 1, lastPlayedAt, lastRound },
    });
  }

  test('cloud newer: download is the suggested action and uploading first shows the time+round comparison',
    { tag: ['@regression', '@cloud-slots'] },
    async ({ page }) => {
      // 重旅程：两次 reload + 真实上传管线（单 worker ≈17s，4 worker 并发重复会超 30s 默认预算）
      test.slow();
      const { profileId } = await seedSave(page); // 本地 lastSavedAt = now
      const repo = await mockGitHubRepo(page, {
        [`slots/${profileId}/manifest.json`]: slotManifest(profileId, '2099-01-01T00:00:00.000Z', 42),
      });
      await connectGitHub(page);

      const row = page.getByTestId(`cs-row-${profileId}`);
      await expect(row).toHaveAttribute('data-freshness', 'cloud-newer');
      await expect(page.getByTestId(`cs-fresh-${profileId}`)).toHaveText('云端较新');
      await expect(row).toContainText('第 42 回合');
      await expect(page.getByTestId(`cs-download-${profileId}`)).toHaveClass(/cs-btn--suggested/);
      await expect(page.getByTestId(`cs-upload-${profileId}`)).not.toHaveClass(/cs-btn--suggested/);

      // 点上传 → 先弹"用旧存档覆盖云端？"对照，取消则云端一字未动
      await page.getByTestId(`cs-upload-${profileId}`).click();
      const stamps = page.getByTestId('cs-upload-older-stamps');
      await expect(stamps).toBeVisible();
      await expect(stamps).toContainText('第 42 回合');
      await page.getByRole('button', { name: '取消' }).click();
      await expect(stamps).toHaveCount(0);
      expect([...repo.keys()].filter((k) => k.startsWith(`slots/${profileId}/`))).toEqual([`slots/${profileId}/manifest.json`]);

      // 确认覆盖 → 真实走上传管线 → 云端戳变成本地戳 → 行落到"已同步"
      await page.getByTestId(`cs-upload-${profileId}`).click();
      await page.getByTestId('cs-upload-older-confirm').click();
      await expect(row).toHaveAttribute('data-freshness', 'same', { timeout: 20_000 });
      await expect(page.getByTestId(`cs-fresh-${profileId}`)).toHaveText('已同步');
      const manifest = JSON.parse(Buffer.from(repo.get(`slots/${profileId}/manifest.json`)!, 'base64').toString('utf8')) as {
        slotMeta: { lastPlayedAt: string | null; lastRound: number | null };
      };
      expect(manifest.slotMeta.lastPlayedAt).not.toBe('2099-01-01T00:00:00.000Z');
      expect(manifest.slotMeta.lastRound).toBeNull(); // 种子槽位无 roundNumber ⇒ 回合未知
    });

  test('local newer: upload is the suggested action and the download confirm warns about overwriting newer progress',
    { tag: ['@regression', '@cloud-slots'] },
    async ({ page }) => {
      test.slow(); // 同上：两次 reload 的重旅程
      const { profileId } = await seedSave(page);
      await mockGitHubRepo(page, {
        [`slots/${profileId}/manifest.json`]: slotManifest(profileId, '2020-01-01T00:00:00.000Z', 7),
      });
      await connectGitHub(page);

      const row = page.getByTestId(`cs-row-${profileId}`);
      await expect(row).toHaveAttribute('data-freshness', 'local-newer');
      await expect(page.getByTestId(`cs-fresh-${profileId}`)).toHaveText('本地较新');
      await expect(page.getByTestId(`cs-upload-${profileId}`)).toHaveClass(/cs-btn--suggested/);
      await expect(page.getByTestId(`cs-download-${profileId}`)).not.toHaveClass(/cs-btn--suggested/);

      await page.getByTestId(`cs-download-${profileId}`).click();
      await expect(page.getByTestId('cs-download-older-warn')).toBeVisible();
      await expect(page.getByTestId('cs-download-older-warn')).toContainText('比云端玩得更远');
      await page.getByRole('button', { name: '取消' }).click();
      await expect(page.getByTestId('cs-download-older-warn')).toHaveCount(0);
    });
});
