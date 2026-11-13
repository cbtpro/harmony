import { expect, test, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';

test('dual panes copy and move a deep folder and keep trash and permanent deletion separate', async () => {
  test.setTimeout(65_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harmony-long-path-')));
  const profile = join(root, 'profile');
  const source = join(root, 'source');
  const target = join(root, 'target');
  const folder = '资料';
  const parts = ['甲'.repeat(75), 'b'.repeat(120), 'c'.repeat(120)];
  const deep = join(source, folder, ...parts);
  const file = '报告.txt';
  expect(join(deep, file).length).toBeGreaterThan(300);
  try {
    await mkdir(toNamespacedPath(deep), { recursive: true });
    await Promise.all([mkdir(target), mkdir(profile)]);
    await writeFile(toNamespacedPath(join(deep, file)), 'original');
    await writeFile(join(profile, 'index-rules.json'), JSON.stringify({ version: 1, roots: [], excluded: [] }));
    const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env: { ...process.env, VITE_DEV_SERVER_URL: '' } });
    try {
      await app.evaluate(({ shell }) => { shell.trashItem = async () => { throw new Error('模拟系统回收站拒绝'); }; });
      const page = await app.firstWindow();
      await page.getByRole('link', { name: '双栏', exact: true }).click();
      const left = page.getByRole('textbox', { name: '左栏路径' });
      const right = page.getByRole('textbox', { name: '右栏路径' });
      const leftPane = page.locator('.file-pane').filter({ has: left });
      const rightPane = page.locator('.file-pane').filter({ has: right });
      const archive = page.getByRole('dialog', { name: '批量归档' });
      async function navigate(address: typeof left, path: string) {
        await expect(address).toBeEnabled();
        await address.fill(path);
        await address.press('Enter');
        await expect(address).toBeEnabled();
        await expect(address).toHaveValue(path);
      }
      await navigate(left, source);
      await navigate(right, target);
      const row = leftPane.getByRole('row').filter({ hasText: folder });
      await row.getByRole('checkbox').check();
      await page.getByRole('button', { name: '复制到右栏' }).click();
      await archive.getByRole('button', { name: '生成预览' }).click();
      await expect(archive.getByRole('list', { name: '归档预览' })).toContainText('含 1 个文件、3 个子文件夹');
      await archive.getByRole('button', { name: '确认归档' }).click();
      await expect(archive.getByRole('status')).toContainText('完成 1 项');
      await archive.getByRole('button', { name: '完成' }).click();
      expect(await readFile(toNamespacedPath(join(target, folder, ...parts, file)), 'utf8')).toBe('original');

      await row.getByRole('checkbox').check();
      await page.getByRole('button', { name: '移动到右栏' }).click();
      await archive.getByRole('combobox', { name: '同名处理' }).selectOption('keep');
      await archive.getByRole('button', { name: '生成预览' }).click();
      await expect(archive.getByRole('list', { name: '归档预览' })).toContainText('资料 (2)');
      await archive.getByRole('button', { name: '确认归档' }).click();
      await expect(archive.getByRole('status')).toContainText('完成 1 项');
      await archive.getByRole('button', { name: '完成' }).click();
      await expect(row).toHaveCount(0);
      const moved = join(target, '资料 (2)', ...parts);
      await navigate(right, moved);
      const fileRow = rightPane.getByRole('row').filter({ hasText: file });
      const path = toNamespacedPath(join(moved, file));
      await fileRow.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '移到废纸篓' }).click();
      const trash = page.getByRole('dialog', { name: '移到废纸篓' });
      await trash.getByRole('button', { name: '移到废纸篓' }).click();
      await expect(trash.getByRole('alert')).toContainText('模拟系统回收站拒绝');
      expect(await readFile(path, 'utf8')).toBe('original');
      await trash.getByRole('button', { name: '取消' }).click();

      const permanent = page.getByRole('dialog', { name: '永久删除' });
      await fileRow.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '永久删除…' }).click();
      await permanent.getByRole('button', { name: '取消' }).click();
      expect(await readFile(path, 'utf8')).toBe('original');
      await fileRow.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '永久删除…' }).click();
      await permanent.getByRole('button', { name: '确认永久删除' }).click();
      await expect(fileRow).toHaveCount(0);
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await app.close(); }
  } finally { await rm(toNamespacedPath(root), { recursive: true, force: true }); }
});
