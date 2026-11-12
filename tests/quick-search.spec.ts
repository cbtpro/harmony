import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('previews grouped files and folders and distinguishes search submission from opening a result', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harmony-quick-search-')));
  try {
    const folder = join(root, 'workspace');
    const profile = join(root, 'profile');
    const directory = join(folder, 'Demo Folder');
    await Promise.all([mkdir(directory, { recursive: true }), mkdir(profile)]);
    const image = join(folder, 'Demo Image.png');
    const document = join(folder, 'Demo Notes.txt');
    await Promise.all([
      writeFile(image, ''),
      writeFile(document, ''),
      writeFile(join(profile, 'index-rules.json'), JSON.stringify({ version: 1, roots: [folder], excluded: [] })),
    ]);
    const program = process.platform === 'darwin' ? join(folder, 'Demo App.app')
      : process.platform === 'win32' ? join(folder, 'Demo App.exe') : undefined;
    if (program) {
      if (process.platform === 'darwin') await mkdir(program);
      else await writeFile(program, '');
    }

    const app = await electron.launch({
      args: ['.', `--user-data-dir=${profile}`],
      env: { ...process.env, VITE_DEV_SERVER_URL: '' },
    });
    try {
      await app.evaluate(({ shell, clipboard }) => {
        shell.openPath = async path => { process.env.HARMONY_QUICK_OPENED = path; return ''; };
        clipboard.writeText = path => { process.env.HARMONY_QUICK_COPIED = path; };
      });
      const page = await app.firstWindow();
      await page.getByRole('link', { name: '全局搜索' }).click();
      await expect(page.getByRole('status')).toContainText('索引已完成');

      const input = page.getByRole('combobox', { name: '顶部全局搜索' });
      const preview = page.getByRole('region', { name: '搜索预览' });
      await input.fill('no-such-demo');
      await expect(preview.getByRole('status')).toHaveText('没有匹配的文件或文件夹');

      await input.fill('demo');
      const directoryOption = preview.getByRole('option', { name: /Demo Folder/ });
      await expect(directoryOption).toBeVisible();
      await expect(preview.getByRole('group', { name: '图片' })).toContainText('Demo Image.png');
      await expect(preview.getByRole('group', { name: '文件', exact: true })).toContainText('Demo Notes.txt');
      if (program) await expect(preview.getByRole('group', { name: '程序' })).toContainText('Demo App');

      await input.press('Enter');
      await expect(preview).toBeHidden();
      await expect(page.getByRole('searchbox', { name: '搜索已索引的文件' })).toHaveValue('demo');

      await input.click();
      await expect(directoryOption).toBeVisible();
      await input.press('ArrowDown');
      await expect(directoryOption).toHaveAttribute('aria-selected', 'true');
      await input.press('ArrowUp');
      await expect(preview.getByRole('option', { name: /Demo Notes.txt/ })).toHaveAttribute('aria-selected', 'true');
      await input.press('ArrowDown');
      await input.press('Enter');
      await expect(page.getByRole('textbox', { name: '目录路径' })).toHaveValue(directory);

      await input.fill('demo');
      const fileOption = preview.getByRole('option', { name: /Demo Notes.txt/ });
      await fileOption.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '复制路径' }).click();
      await expect.poll(() => app.evaluate(() => process.env.HARMONY_QUICK_COPIED)).toBe(document);

      await preview.getByRole('option', { name: /Demo Image.png/ }).click();
      await expect.poll(() => app.evaluate(() => process.env.HARMONY_QUICK_OPENED)).toBe(image);
      await input.click();
      await fileOption.click();
      await expect.poll(() => app.evaluate(() => process.env.HARMONY_QUICK_OPENED)).toBe(document);
      if (program) {
        await input.click();
        await preview.getByRole('option', { name: /Demo App/ }).click();
        await expect.poll(() => app.evaluate(() => process.env.HARMONY_QUICK_OPENED)).toBe(program);
      }
    } finally {
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
