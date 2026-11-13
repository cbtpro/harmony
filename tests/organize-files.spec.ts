import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function samplePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 90] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 16 >>\nstream\n0 0 20 20 re f\nendstream',
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(content.length);
    content += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = content.length;
  content += 'xref\n0 5\n0000000000 65535 f \n'
    + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return content;
}

test('archives filtered results, previews files, restores favorites, uses two panes and renames files', async () => {
  test.setTimeout(65_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harmony-organize-')));
  const profile = join(root, 'profile');
  const first = join(root, 'first');
  const second = join(root, 'second');
  const target = join(root, 'archive');
  const launch = () => electron.launch({
    args: ['.', `--user-data-dir=${profile}`],
    env: { ...process.env, VITE_DEV_SERVER_URL: '' },
  });
  try {
    await Promise.all([first, second, target, profile].map(path => mkdir(path)));
    await Promise.all([
      writeFile(join(profile, 'index-rules.json'), JSON.stringify({ version: 1, roots: [first, second], excluded: [], preferSystem: false })),
      writeFile(join(first, 'report.txt'), 'first report'),
      writeFile(join(second, 'report.txt'), 'second report'),
      writeFile(join(target, 'report.txt'), 'existing report'),
      writeFile(join(first, 'sample.md'), '# Preview heading\n<script>throw 1</script>'),
      writeFile(join(first, 'sample.pdf'), samplePdf()),
      writeFile(join(first, 'sample.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1cAAAAASUVORK5CYII=', 'base64')),
    ]);
    const app = await launch();
    try {
      const page = await app.firstWindow();
      const rendererErrors: string[] = [];
      page.on('pageerror', error => rendererErrors.push(error.message));
      page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') rendererErrors.push(message.text()); });
      await page.getByRole('link', { name: '全局搜索' }).click();
      await expect(page.getByRole('status').filter({ hasText: '索引已完成' })).toBeVisible({ timeout: 12000 });
      await page.getByRole('textbox', { name: '文件扩展名' }).fill('txt,log');
      const reports = page.getByRole('row').filter({ hasText: 'report.txt' });
      await expect(reports).toHaveCount(2);
      await reports.nth(0).getByRole('checkbox').check();
      await reports.nth(1).getByRole('checkbox').check();
      await page.getByRole('button', { name: /批量归档/ }).click();
      const archive = page.getByRole('dialog', { name: '批量归档' });
      await archive.getByRole('textbox', { name: '归档目标目录' }).fill(target);
      await archive.getByRole('combobox', { name: '同名处理' }).selectOption('keep');
      await archive.getByRole('button', { name: '生成预览' }).click();
      await expect(archive.getByRole('list', { name: '归档预览' })).toContainText('report (3).txt');
      await archive.getByRole('button', { name: '确认归档' }).click();
      await expect(archive.getByRole('status')).toContainText('完成 2 项');
      expect(await readFile(join(target, 'report.txt'), 'utf8')).toBe('existing report');
      expect([await readFile(join(target, 'report (2).txt'), 'utf8'), await readFile(join(target, 'report (3).txt'), 'utf8')].sort())
        .toEqual(['first report', 'second report']);
      await archive.getByRole('button', { name: '完成' }).click();
      await page.getByRole('button', { name: '保存搜索' }).click();
      await page.getByRole('textbox', { name: '收藏名称' }).fill('文本报告');
      await page.getByRole('button', { name: '保存收藏' }).click();
      await expect(page.getByRole('link', { name: '文本报告' })).toBeVisible();

      await page.getByRole('link', { name: '文件', exact: true }).click();
      await expect(page.getByRole('heading', { name: '文件管理' })).toBeVisible();
      const address = page.getByRole('textbox', { name: '目录路径' });
      await address.fill(first);
      await address.press('Enter');
      await expect(page.getByRole('button', { name: 'sample.md', exact: true })).toBeVisible();
      await page.getByRole('row').filter({ hasText: 'sample.md' }).press('Space');
      let preview = page.getByRole('dialog', { name: 'sample.md' });
      await expect(preview.getByRole('heading', { name: 'Preview heading' })).toBeVisible();
      await expect(preview.locator('article script')).toHaveCount(0);
      await page.keyboard.press('ArrowRight');
      preview = page.getByRole('dialog', { name: 'sample.pdf' });
      try { await expect(preview.getByLabel('PDF 页面')).toBeVisible({ timeout: 7000 }); }
      catch (error) {
        throw new Error(JSON.stringify({ dialogs: await page.getByRole('dialog').allTextContents(), rendererErrors }), { cause: error });
      }
      await expect.poll(() => preview.locator('canvas').evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBe(180);
      await page.keyboard.press('ArrowRight');
      preview = page.getByRole('dialog', { name: 'sample.png' });
      const image = preview.getByRole('img', { name: 'sample.png' });
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
      await page.keyboard.press('Escape');
      await expect(preview).toBeHidden();
      await page.getByRole('button', { name: '收藏目录' }).click();
      await page.getByRole('textbox', { name: '收藏名称' }).fill('来源目录');
      await page.getByRole('button', { name: '保存收藏' }).click();

      await page.getByRole('link', { name: '双栏', exact: true }).click();
      await expect(page.getByRole('heading', { name: '双栏文件管理' })).toBeVisible();
      const left = page.getByRole('textbox', { name: '左栏路径' });
      const right = page.getByRole('textbox', { name: '右栏路径' });
      await expect(left).toBeEnabled();
      await left.fill(first);
      await left.press('Enter');
      await expect(right).toBeEnabled();
      await right.fill(target);
      await right.press('Enter');
      const leftPane = page.locator('.file-pane').filter({ has: left });
      await leftPane.getByRole('row').filter({ hasText: 'sample.md' }).getByRole('checkbox').check();
      await page.getByRole('button', { name: '复制到右栏' }).click();
      await expect(archive.getByRole('textbox', { name: '归档目标目录' })).toHaveValue(target);
      await archive.getByRole('button', { name: '生成预览' }).click();
      await archive.getByRole('button', { name: '确认归档' }).click();
      await expect(archive.getByRole('status')).toContainText('完成 1 项');
      await archive.getByRole('button', { name: '完成' }).click();
      expect(await readFile(join(target, 'sample.md'), 'utf8')).toContain('Preview heading');
      await leftPane.getByRole('button', { name: 'Add tab' }).click();
      await expect(left).toBeEnabled();
      await left.fill(second);
      await left.press('Enter');
      await expect(leftPane.getByRole('tab', { name: 'second' })).toBeVisible();
      await leftPane.getByRole('tab', { name: 'first' }).click();
      await expect(left).toHaveValue(first);
      await expect(right).toHaveValue(target);

      await page.getByRole('link', { name: '来源目录' }).click();
      await expect(address).toHaveValue(first);
      await page.getByRole('row').filter({ hasText: 'report.txt' }).getByRole('checkbox').check();
      await page.getByRole('button', { name: '批量重命名' }).click();
      const rename = page.getByRole('dialog', { name: '批量重命名' });
      await rename.getByRole('textbox', { name: '查找文字' }).fill('report');
      await rename.getByRole('textbox', { name: '替换为' }).fill('整理');
      await rename.getByRole('checkbox', { name: '追加编号' }).check();
      await rename.getByRole('button', { name: '生成预览' }).click();
      await expect(rename.getByRole('list', { name: '重命名预览' })).toContainText('整理-001.txt');
      await rename.getByRole('button', { name: '确认重命名' }).click();
      await expect(rename.getByRole('list', { name: '重命名结果' })).toContainText('完成');
      expect(await readFile(join(first, '整理-001.txt'), 'utf8')).toBe('first report');
    } finally { await app.close(); }
    const reopened = await launch();
    try {
      const page = await reopened.firstWindow();
      await page.getByRole('link', { name: '文本报告' }).click();
      await expect(page.getByRole('textbox', { name: '文件扩展名' })).toHaveValue('txt,log');
      await page.getByRole('link', { name: '来源目录' }).click();
      await expect(page.getByRole('textbox', { name: '目录路径' })).toHaveValue(first);
    } finally { await reopened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
