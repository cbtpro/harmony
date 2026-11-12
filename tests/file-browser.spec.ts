import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('browses, filters, creates, copies and handles filesystem errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harmony-ui-'));
  try {
    const target = join(directory, 'target');
    await mkdir(target);
    await writeFile(join(directory, 'sample.txt'), 'Harmony');
    const profile = join(directory, '.profile');
    await mkdir(profile);
    await writeFile(join(profile, 'index-rules.json'), JSON.stringify({ version: 1, roots: [], excluded: [] }));
    const app = await electron.launch({
      args: ['.', `--user-data-dir=${profile}`],
      env: { ...process.env, VITE_DEV_SERVER_URL: '' },
    });
    try {
      const page = await app.firstWindow();
      await expect(page.getByRole('banner')).toBeVisible();
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.getByRole('contentinfo')).toContainText('本地工作区');
      const address = page.getByRole('textbox', { name: '目录路径' });
      await expect(address).not.toHaveValue('');
      await address.fill(directory);
      await page.getByRole('button', { name: '前往' }).click();
      const row = page.getByRole('row').filter({ hasText: 'sample.txt' });
      await expect(row).toBeVisible();
      await app.evaluate(({ clipboard, shell }) => {
        shell.showItemInFolder = path => { process.env.HARMONY_TEST_REVEALED = path; };
        shell.openPath = async path => { process.env.HARMONY_TEST_OPENED = path; return ''; };
        clipboard.writeText = value => { process.env.HARMONY_TEST_COPIED = value; };
      });
      const menu = page.getByRole('menu');
      const reveal = menu.getByRole('menuitem', { name: /在.+中显示/ });
      await row.click({ button: 'right' });
      await reveal.click();
      await expect.poll(() => app.evaluate(() => process.env.HARMONY_TEST_REVEALED))
        .toBe(join(directory, 'sample.txt'));

      await row.click({ button: 'right' });
      await menu.getByRole('menuitem', { name: '复制路径' }).click();
      await expect.poll(() => app.evaluate(() => process.env.HARMONY_TEST_COPIED))
        .toBe(join(directory, 'sample.txt'));

      const folder = page.getByRole('row').filter({ hasText: 'target' });
      await folder.click({ button: 'right' });
      await menu.getByRole('menuitem', { name: /在.+中打开/ }).click();
      await expect.poll(() => app.evaluate(() => process.env.HARMONY_TEST_OPENED)).toBe(target);
      await folder.click({ button: 'right' });
      await expect(menu).toBeVisible();
      await menu.getByText('在终端中打开', { exact: true }).hover();
      if (process.platform === 'darwin') {
        await expect(page.getByRole('menuitem', { name: '终端 (Terminal)', exact: true })).toBeVisible();
      } else if (process.platform === 'win32') {
        await expect(page.getByRole('menuitem', { name: '命令提示符 (CMD)' })).toBeVisible();
      }
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await folder.click({ button: 'right' });
      await menu.getByRole('menuitem', { name: '打开文件夹' }).click();
      await expect(address).toHaveValue(target);
      await page.getByRole('button', { name: '上一级' }).click();
      await expect(row).toBeVisible();

      const filter = page.getByRole('searchbox');
      await filter.fill('missing');
      await expect(row).toHaveCount(0);
      await filter.clear();

      await page.getByRole('button', { name: '新建文件夹' }).click();
      const createDialog = page.getByRole('dialog', { name: '新建文件夹' });
      await createDialog.getByRole('textbox', { name: '文件夹名称' }).fill('整理');
      await createDialog.getByRole('button', { name: '新建', exact: true }).click();
      await page.getByRole('button', { name: '整理', exact: true }).click();
      await expect(address).toHaveValue(join(directory, '整理'));
      await page.getByRole('button', { name: '上一级' }).click();
      await expect(row).toBeVisible();

      // Keep the real IPC and filesystem calls while making native dialog selection deterministic.
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, target);
      const copy = row.getByRole('button', { name: '复制到…' });
      await copy.click();
      await expect(copy).toBeEnabled();
      expect(await readFile(join(target, 'sample.txt'), 'utf8')).toBe('Harmony');
      await copy.click();
      await expect(page.getByRole('alert')).toHaveText('同名项目已存在。');

      await row.getByRole('button', { name: '移到废纸篓' }).click();
      const trashDialog = page.getByRole('dialog', { name: '移到废纸篓' });
      await trashDialog.getByRole('button', { name: '取消' }).click();
      await expect(row).toBeVisible();

      await address.fill(join(directory, 'missing'));
      await page.getByRole('button', { name: '前往' }).click();
      await expect(page.getByRole('alert')).toHaveText('路径已不存在。');
      await expect(row).toBeVisible();
    } finally {
      await app.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
