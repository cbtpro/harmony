import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/electron/main/') && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
      return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
const { createBatchFiles } = await import('../electron/main/batch-files.ts');
const { readFilePreview } = await import('../electron/main/file-preview.ts');
const { createFavorites } = await import('../electron/main/favorites.ts');
const { filteredSearch } = await import('../electron/main/search/filtered-search.ts');
hooks.deregister();
import { createFolder, duplicateFile, entryPath, listDirectory } from '../electron/main/files.ts';

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'harmony-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('lists folders first, sorts numbers naturally and reports the parent', async t => {
  const directory = await fixture(t);
  await createFolder(directory, '整理');
  await writeFile(join(directory, '2.txt'), '');
  await writeFile(join(directory, '10.txt'), '');
  const result = await listDirectory(directory);
  assert.deepEqual(result.entries.map(({ name, kind }) => [name, kind]), [
    ['整理', 'directory'], ['2.txt', 'file'], ['10.txt', 'file'],
  ]);
  assert.equal((await listDirectory(join(directory, '整理'))).parent, directory);
});

test('rejects relative paths, traversal, reserved names and root mutations', async t => {
  const directory = await fixture(t);
  await assert.rejects(listDirectory('relative'));
  for (const name of ['', '..', '../outside', 'a/b', 'a\\b', 'CON.txt', 'bad.']) {
    await assert.rejects(createFolder(directory, name), /有效/);
  }
  assert.throws(() => entryPath(parse(directory).root), /根目录/);
  await createFolder(directory, 'existing');
  await assert.rejects(createFolder(directory, 'existing'), { code: 'EEXIST' });
});

test('copies bytes without overwriting an existing file', async t => {
  const directory = await fixture(t);
  const source = join(directory, 'sample.txt');
  const target = join(directory, 'target');
  await createFolder(directory, 'target');
  await writeFile(source, 'original');
  await duplicateFile(source, target);
  await writeFile(source, 'modified');
  await assert.rejects(duplicateFile(source, target), { code: 'EEXIST' });
  assert.equal(await readFile(join(target, 'sample.txt'), 'utf8'), 'original');
  await assert.rejects(duplicateFile(target, directory), /普通文件/);
});

test('previews conflict policies and rejects stale archive targets', async t => {
  const root = await fixture(t);
  const source = join(root, 'source');
  const target = join(root, 'target');
  await Promise.all([createFolder(root, 'source'), createFolder(root, 'target')]);
  const original = join(source, 'document.txt');
  const existing = join(target, 'document.txt');
  await writeFile(original, 'source data');
  await writeFile(existing, 'previous data');
  const batch = createBatchFiles(() => {});
  const skipped = await batch.transfer([original], target, 'copy', 'skip');
  assert.equal(skipped.rows[0].action, 'skip');
  assert.equal(skipped.ticket, undefined);

  const replace = await batch.transfer([original], target, 'copy', 'replace');
  assert.equal(replace.rows[0].action, 'replace');
  await writeFile(existing, 'changed after preview');
  assert.equal((await batch.run(replace.ticket))[0].status, 'failed');
  assert.equal(await readFile(existing, 'utf8'), 'changed after preview');
  await assert.rejects(batch.run(replace.ticket), /预览已失效/);

  const safeReplace = await batch.transfer([original], target, 'copy', 'replace');
  assert.equal((await batch.run(safeReplace.ticket))[0].status, 'done');
  assert.equal(await readFile(existing, 'utf8'), 'source data');

  const move = await batch.transfer([original], target, 'move', 'keep');
  assert.equal((await batch.run(move.ticket))[0].status, 'done');
  assert.equal(await readFile(join(target, 'document (2).txt'), 'utf8'), 'source data');
  await assert.rejects(readFile(original), { code: 'ENOENT' });
});

test('blocks duplicate rename destinations and applies numbering after preview', async t => {
  const root = await fixture(t);
  const one = join(root, 'demo.txt');
  const two = join(root, 'demodemo.txt');
  await Promise.all([writeFile(one, 'one'), writeFile(two, 'two')]);
  const batch = createBatchFiles(() => {});
  const options = { find: 'demo', replace: '', numbering: false, start: 1, date: false };
  const collision = await batch.rename([one, two], options);
  assert.equal(collision.ticket, undefined);
  assert.deepEqual(collision.rows.map(row => row.action), ['blocked', 'blocked']);
  const numbered = await batch.rename([one, two], { ...options, numbering: true });
  assert.deepEqual((await batch.run(numbered.ticket)).map(row => row.status), ['done', 'done']);
  assert.equal(await readFile(join(root, '001.txt'), 'utf8'), 'one');
  assert.equal(await readFile(join(root, '002.txt'), 'utf8'), 'two');
  const dated = await batch.rename([join(root, '001.txt')], { ...options, date: true });
  assert.match(dated.rows[0].target!, /001-\d{4}-\d{2}-\d{2}\.txt$/);
});

test('loads text, Markdown, images, and PDFs with a bounded preview', async t => {
  const root = await fixture(t);
  const markdown = join(root, 'notes.md');
  const text = join(root, 'notes.txt');
  const image = join(root, 'notes.png');
  const pdf = join(root, 'notes.pdf');
  await Promise.all([
    writeFile(markdown, '# Notes'), writeFile(text, 'x'.repeat(300_000)),
    writeFile(image, Buffer.from([1, 2, 3])), writeFile(pdf, '%PDF-1.4'),
  ]);
  assert.equal((await readFilePreview(markdown)).kind, 'markdown');
  const preview = await readFilePreview(text);
  assert.equal(preview.data.length, 256 * 1024);
  assert.equal(preview.truncated, true);
  assert.deepEqual(await readFilePreview(image), { kind: 'image', mime: 'image/png', data: 'AQID' });
  assert.equal((await readFilePreview(pdf)).kind, 'pdf');
  await assert.rejects(readFilePreview(join(root, 'run.exe')), /不支持预览/);
});

test('persists concurrent favorites and filters indexed candidates by path, extension, time, and size', async t => {
  const root = await fixture(t);
  const path = join(root, 'report.txt');
  const storePath = join(root, 'favorites.json');
  const store = createFavorites(storePath);
  await writeFile(path, 'report contents');
  await Promise.all([
    store.add({ kind: 'directory', label: 'Folder', directory: root }),
    store.add({ kind: 'search', label: 'Reports', query: '', filters: { extension: 'TXT，.md, TXT', directory: root, days: 7, minSize: 8 } }),
  ]);
  const saved = await createFavorites(storePath).list();
  assert.equal(saved.length, 2);
  const entry = saved.find(item => item.kind === 'search');
  assert.ok(entry?.kind === 'search');
  assert.deepEqual(entry.filters, { extension: 'txt,md', directory: root, days: 7, minSize: 8 });
  const matches = [];
  async function* candidates() {
    yield [
      { name: 'report.txt', path, kind: 'file' as const },
      { name: 'missing.txt', path: join(root, 'missing.txt'), kind: 'file' as const },
      { name: 'favorites.json', path: storePath, kind: 'file' as const },
    ];
  }
  for await (const batch of filteredSearch(candidates(), entry.filters, root)) matches.push(...batch);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].size, 15);
  await store.remove(entry.id);
  assert.equal((await createFavorites(storePath).list()).length, 1);
});
