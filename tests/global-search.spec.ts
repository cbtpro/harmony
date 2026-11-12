import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('indexes automatically, enforces both lists and restores rules on restart', async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'harmony-search-ui-')));
  try {
    const root = join(fixture, 'workspace');
    const sub = join(root, '归档');
    const excluded = join(root, 'private');
    const profile = join(fixture, 'profile');
    await Promise.all([mkdir(sub, { recursive: true }), mkdir(excluded, { recursive: true }), mkdir(profile)]);
    await writeFile(join(sub, 'Project-2026.txt'), '');
    await writeFile(join(excluded, 'Project-secret.txt'), '');
    await writeFile(join(profile, 'index-rules.json'), JSON.stringify({
      version: 1, roots: [], excluded: [],
    }));

    const launch = () => electron.launch({
      args: ['.', `--user-data-dir=${profile}`],
      env: { ...process.env, VITE_DEV_SERVER_URL: '' },
    });
    const app = await launch();
    try {
      const page = await app.firstWindow();
      await page.getByRole('link', { name: '全局搜索' }).click();
      await expect(page.getByRole('button', { name: '立即重建索引' })).toBeDisabled();
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, root);
      await page.getByRole('button', { name: '添加白名单目录' }).click();
      await expect(page.getByRole('list', { name: '白名单' })).toContainText(root);
      await expect(page.getByRole('status')).toContainText('索引已完成');

      await page.getByRole('searchbox', { name: '搜索已索引的文件' }).fill('project');
      const privateResult = page.getByRole('row').filter({ hasText: 'Project-secret.txt' });
      await expect(privateResult).toBeVisible();
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, excluded);
      await page.getByRole('button', { name: '添加黑名单目录' }).click();
      await expect(page.getByRole('list', { name: '黑名单' })).toContainText(excluded);
      await expect(page.getByRole('status')).toContainText('索引已完成');
      const result = page.getByRole('row').filter({ hasText: 'Project-2026.txt' });
      await expect(result).toBeVisible();
      await expect(privateResult).toHaveCount(0);
      await result.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '打开所在目录' }).click();
      await expect(page.getByRole('textbox', { name: '目录路径' })).toHaveValue(sub);
      const fileFilter = page.getByRole('searchbox', { name: '筛选文件' });
      await fileFilter.fill('2026');
      const searchTab = page.getByRole('tab', { name: '全局搜索' });
      await searchTab.click();
      await expect(searchTab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('searchbox', { name: '搜索已索引的文件' })).toHaveValue('project');
      await expect(result).toBeVisible();
      await page.getByRole('tab', { name: '文件', exact: true }).click();
      await expect(page.getByRole('textbox', { name: '目录路径' })).toHaveValue(sub);
      await expect(fileFilter).toHaveValue('2026');

      await page.goBack();
      await expect(searchTab).toHaveAttribute('aria-selected', 'true');
      await page.locator('.ant-tabs-tab').filter({ has: searchTab }).getByRole('button', { name: '关闭标签' }).click();
      await expect(searchTab).toHaveCount(0);
      await expect(page.getByRole('tab', { name: '文件', exact: true })).toHaveAttribute('aria-selected', 'true');
      await page.getByRole('link', { name: '全局搜索' }).click();
      await expect(page.getByRole('searchbox', { name: '搜索已索引的文件' })).toHaveValue('');
    } finally {
      await app.close();
    }

    const reopened = await launch();
    try {
      const page = await reopened.firstWindow();
      const topSearch = page.getByRole('combobox', { name: '顶部全局搜索' });
      await expect(topSearch).toBeVisible();
      await page.keyboard.press('Control+k');
      await expect(topSearch).toBeFocused();
      await topSearch.fill('project');
      await topSearch.press('Enter');
      await expect(page.getByRole('list', { name: '白名单' })).toContainText(root);
      await expect(page.getByRole('list', { name: '黑名单' })).toContainText(excluded);
      await expect(page.getByRole('status')).toContainText('索引已完成');
      await expect(page.getByRole('searchbox', { name: '搜索已索引的文件' })).toHaveValue('project');
      await expect(page.getByRole('row').filter({ hasText: 'Project-2026.txt' })).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: 'Project-secret.txt' })).toHaveCount(0);
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
