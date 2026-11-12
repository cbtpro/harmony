import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('classifies media, applies a scraper result and renames the indexed file', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harmony-media-ui-')));
  try {
    const folder = join(root, 'library');
    const profile = join(root, 'profile');
    await Promise.all([mkdir(folder), mkdir(profile)]);
    await Promise.all([
      writeFile(join(folder, 'Example Book.epub'), 'fixture'),
      writeFile(join(folder, 'Show.S01E01.mkv'), ''),
      writeFile(join(profile, 'index-rules.json'), JSON.stringify({ version: 1, roots: [folder], excluded: [] })),
    ]);

    const app = await electron.launch({
      args: ['.', `--user-data-dir=${profile}`],
      env: { ...process.env, VITE_DEV_SERVER_URL: '' },
    });
    try {
      await app.evaluate(() => {
        const original = globalThis.fetch;
        globalThis.fetch = (input, options) => {
          const url = new URL(String(input));
          if (url.origin !== 'https://openlibrary.org') return original(input, options);
          process.env.HARMONY_TEST_MEDIA_TERM = url.searchParams.get('title') ?? '';
          return Promise.resolve(Response.json({
            docs: [{ title: 'Library Handbook', author_name: ['Example Author'], first_publish_year: 2020 }],
          }));
        };
      });

      const page = await app.firstWindow();
      await page.getByRole('link', { name: '媒体库' }).click();
      const book = page.getByRole('row').filter({ hasText: 'Example Book.epub' });
      await expect(book).toContainText('电子书', { timeout: 12000 });
      await expect(page.getByRole('row').filter({ hasText: 'Show.S01E01.mkv' })).toContainText('剧集');
      await book.getByRole('button', { name: '资料与刮削' }).click();
      const editor = page.getByRole('dialog', { name: '媒体资料' });
      await editor.getByRole('tab', { name: '本地信息' }).click();
      await editor.getByRole('button', { name: '读取本地信息' }).click();
      await expect(editor.getByText('修改时间')).toBeVisible();
      await editor.getByRole('tab', { name: '在线刮削' }).click();
      await editor.getByRole('button', { name: '查询在线资料' }).click();
      await expect(editor.getByRole('list', { name: '候选资料' })).toContainText('Library Handbook');
      expect(await app.evaluate(() => process.env.HARMONY_TEST_MEDIA_TERM)).toBe('Example Book');
      await editor.getByRole('button', { name: '使用此资料' }).click();
      await expect(editor.getByRole('textbox', { name: '媒体标题' })).toHaveValue('Library Handbook');
      await editor.getByRole('button', { name: '保存资料' }).click();
      await expect(editor).toBeHidden();

      const search = page.getByRole('searchbox', { name: '查询媒体' });
      await search.fill('Example Author');
      const media = page.getByRole('row').filter({ hasText: 'Library Handbook' });
      await expect(media).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: 'Show.S01E01.mkv' })).toHaveCount(0);
      await media.getByRole('button', { name: '重命名' }).click();
      const rename = page.getByRole('dialog', { name: '重命名媒体' });
      await rename.getByRole('button', { name: '使用资料标题' }).click();
      await rename.getByRole('button', { name: '重命名', exact: true }).click();
      await expect(media).toContainText('Library Handbook.epub');
      expect(await readFile(join(folder, 'Library Handbook.epub'), 'utf8')).toBe('fixture');

      await page.getByRole('link', { name: '全局搜索' }).click();
      await page.getByRole('searchbox', { name: '搜索已索引的文件' }).fill('Library Handbook');
      await expect(page.getByRole('row').filter({ hasText: 'Library Handbook.epub' })).toBeVisible();
    } finally {
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
