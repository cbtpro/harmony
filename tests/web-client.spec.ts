import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('shares the engine with the webpage and denies unauthenticated requests', async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'harmony-web-ui-')));
  try {
    const data = join(profile, 'workspace');
    await mkdir(data);
    await writeFile(join(data, 'shared-file.txt'), 'Web file preview');
    await writeFile(join(profile, 'index-rules.json'), JSON.stringify({ version: 1, roots: [data], excluded: [] }));
    const app = await electron.launch({
      args: ['.', `--user-data-dir=${profile}`],
      env: { ...process.env, VITE_DEV_SERVER_URL: '' },
    });
    try {
      const desktop = await app.firstWindow();
      await desktop.getByRole('link', { name: '磁盘', exact: true }).click();
      await expect(desktop.getByRole('link', { name: '浏览磁盘' }).first()).toBeVisible({ timeout: 12000 });

      // Open the HTTP UI in Chromium with no preload or Electron bridge.
      await app.evaluate(({ shell, BrowserWindow }) => {
        shell.openExternal = async url => {
          const window = new BrowserWindow({ webPreferences: { sandbox: true } });
          await window.loadURL(url);
        };
      });
      const opened = app.waitForEvent('window');
      await desktop.getByRole('button', { name: '在浏览器打开' }).click();
      const web = await opened;
      await expect(web.getByRole('heading', { name: '文件管理' })).toBeVisible();
      expect(await web.evaluate(() => 'harmonyDesktop' in window)).toBe(false);
      expect(new URL(web.url()).hash).not.toContain('connect=');
      const rejected = await fetch(new URL('/api/request', web.url()), { method: 'POST' });
      expect(rejected.status).toBe(403);

      const address = web.getByRole('textbox', { name: '目录路径' });
      await address.fill(data);
      await address.press('Enter');
      await expect(web.getByRole('button', { name: 'shared-file.txt' })).toBeVisible();
      await web.getByRole('row').filter({ hasText: 'shared-file.txt' }).press('Space');
      await expect(web.getByRole('dialog', { name: 'shared-file.txt' })).toContainText('Web file preview');
      await web.keyboard.press('Escape');
      await expect(web.getByRole('dialog', { name: 'shared-file.txt' })).toBeHidden();
      await app.evaluate(({ shell }) => {
        shell.showItemInFolder = path => { process.env.HARMONY_WEB_TEST_REVEALED = path; };
      });
      await web.getByRole('row').filter({ hasText: 'shared-file.txt' }).click({ button: 'right' });
      await web.getByRole('menuitem', { name: /在.+中显示/ }).click();
      await expect.poll(() => app.evaluate(() => process.env.HARMONY_WEB_TEST_REVEALED))
        .toBe(join(data, 'shared-file.txt'));
      await web.getByRole('button', { name: '新建文件夹' }).click();
      const dialog = web.getByRole('dialog', { name: '新建文件夹' });
      await dialog.getByRole('textbox', { name: '文件夹名称' }).fill('Web 创建');
      await dialog.getByRole('button', { name: '新建', exact: true }).click();
      await expect(web.getByRole('button', { name: 'Web 创建' })).toBeVisible();

      await desktop.getByRole('link', { name: '文件', exact: true }).click();
      const desktopAddress = desktop.getByRole('textbox', { name: '目录路径' });
      await desktopAddress.fill(data);
      await desktopAddress.press('Enter');
      await expect(desktop.getByRole('button', { name: 'Web 创建' })).toBeVisible();

      await web.getByRole('link', { name: '媒体库' }).click();
      await expect(web.getByRole('heading', { name: '媒体库', exact: true })).toBeVisible();
      await expect(web.getByRole('row').filter({ hasText: 'shared-file.txt' })).toBeVisible({ timeout: 12000 });
      await web.clock.install();
      await web.clock.pauseAt(new Date(Date.now() + 1000));
      const quickInput = web.getByRole('combobox', { name: '顶部全局搜索' });
      const preview = web.getByRole('region', { name: '搜索预览' });
      try {
        await quickInput.fill('shared-file');
        await expect(preview.getByRole('status')).toHaveText('正在搜索…');
      } finally {
        await web.clock.resume();
      }
      await expect(preview.getByRole('option', { name: /shared-file.txt/ })).toBeVisible();
      await quickInput.press('Escape');
      await expect(preview).toBeHidden();

      await web.getByRole('link', { name: '全局搜索' }).click();
      await web.getByRole('searchbox', { name: '搜索已索引的文件' }).fill('shared-file');
      await expect(web.getByRole('row').filter({ hasText: 'shared-file.txt' })).toBeVisible();
      await web.reload();
      await expect(web.getByRole('heading', { name: '全局搜索' })).toBeVisible();
      await expect(web.getByRole('status')).toContainText('索引已完成');
    } finally {
      await app.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
