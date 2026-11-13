import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
const { createFolder, duplicateFile, entryPath, listDirectory, permanentlyDelete } = await import('../electron/main/files.ts');
const { filesystemPath, windowsPath } = await import('../electron/main/file-path.ts');
const { transferDirectory } = await import('../electron/main/directory-transfer.ts');
hooks.deregister();

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'harmony-unit-'));
  t.after(() => rm(filesystemPath(directory), { recursive: true, force: true }));
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

test('normalizes Windows drive and UNC paths without exposing device paths', () => {
  assert.equal(windowsPath('c:/source/../target'), 'c:\\target');
  assert.equal(windowsPath('\\\\?\\C:\\目标'), 'C:\\目标');
  assert.equal(windowsPath('\\\\?\\UNC\\server\\share\\目标'), '\\\\server\\share\\目标');
  assert.throws(() => windowsPath('\\\\.\\PhysicalDrive0'), /绝对路径/);
  assert.throws(() => windowsPath('\\\\?\\GLOBALROOT\\Device\\Disk'), /绝对路径/);
  assert.throws(() => windowsPath('C:\\file.txt:stream'), /文件名/);
});

test('copies, moves, lists and deletes a directory tree with paths longer than 300 characters', async t => {
  const root = await realpath(await fixture(t));
  const source = join(root, 'source');
  const archive = join(root, 'archive');
  const parts = ['目录'.repeat(35), 'a'.repeat(125), 'b'.repeat(125)];
  const deep = join(source, ...parts);
  const name = '报告.txt';
  assert.ok(join(deep, name).length > 300);
  await mkdir(filesystemPath(deep), { recursive: true });
  await mkdir(archive);
  await mkdir(filesystemPath(join(deep, 'empty')));
  await writeFile(filesystemPath(join(deep, name)), 'long-path content');
  const batch = createBatchFiles(() => {});
  const inside = await batch.transfer([source], deep, 'move', 'keep');
  assert.equal(inside.rows[0].action, 'blocked');
  assert.match(inside.rows[0].reason!, /自身/);
  const plan = await batch.transfer([source, join(deep, name)], archive, 'copy', 'keep');
  const contents = plan.rows[0].contents;
  assert.ok(contents, plan.rows[0].reason);
  assert.deepEqual([contents.files, contents.directories, contents.skipped], [1, 4, 0]);
  assert.ok(contents.sample.includes(join(...parts, name)));
  assert.equal(plan.rows[1].action, 'skip');
  assert.deepEqual((await batch.run(plan.ticket)).map(row => row.status), ['done', 'skipped']);
  const copied = join(archive, 'source', ...parts);
  assert.deepEqual((await listDirectory(copied)).entries.map(item => item.name), ['empty', name]);
  assert.equal(await readFile(filesystemPath(join(copied, name)), 'utf8'), 'long-path content');
  const move = await batch.transfer([source], archive, 'move', 'keep');
  assert.equal((await batch.run(move.ticket))[0].status, 'done');
  await assert.rejects(stat(source), { code: 'ENOENT' });
  const moved = join(archive, 'source (2)', ...parts);
  assert.equal(await readFile(filesystemPath(join(moved, name)), 'utf8'), 'long-path content');
  await permanentlyDelete(moved);
  await assert.rejects(stat(filesystemPath(moved)), { code: 'ENOENT' });
});

test('cross-volume move keeps the source and removes staged data when copying fails', async t => {
  const root = await realpath(await fixture(t));
  const sourceDevice = (await stat(root, { bigint: true })).dev;
  let otherVolume = process.env.HARMONY_CROSS_VOLUME_DIR;
  if (!otherVolume && process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true') {
    for (const candidate of [process.env.GITHUB_WORKSPACE, process.env.PUBLIC, process.env.RUNNER_TEMP]) {
      if (!candidate) continue;
      const info = await stat(candidate, { bigint: true }).catch(() => undefined);
      if (info?.isDirectory() && info.dev !== sourceDevice) { otherVolume = candidate; break; }
    }
    assert.ok(otherVolume, 'Windows CI must exercise a real second volume');
  }
  const archive = otherVolume ? await mkdtemp(join(otherVolume, 'target-')) : join(root, 'target');
  if (otherVolume) {
    t.after(() => rm(archive, { recursive: true, force: true }));
    assert.notEqual(sourceDevice, (await stat(archive, { bigint: true })).dev);
  } else await mkdir(archive);
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'a.txt'), 'first');
  await writeFile(join(source, 'b.txt'), 'second');
  let copies = 0;
  const batch = createBatchFiles(() => {}, (from, to, tree, move, sameVolume) => {
    if (otherVolume) assert.equal(sameVolume, false);
    return transferDirectory(from, to, tree, move, otherVolume ? sameVolume : false, async (input, output, mode) => {
      if (++copies === 2) throw Object.assign(new Error('simulated destination write failure'), { code: 'ENOSPC' });
      await copyFile(input, output, mode);
    });
  });
  const plan = await batch.transfer([source], archive, 'move', 'skip');
  const [result] = await batch.run(plan.ticket);
  assert.equal(copies, 2);
  assert.equal(result.status, 'failed');
  assert.match(result.message!, /simulated destination/);
  assert.equal(await readFile(join(source, 'a.txt'), 'utf8'), 'first');
  assert.equal(await readFile(join(source, 'b.txt'), 'utf8'), 'second');
  assert.deepEqual((await listDirectory(archive)).entries, []);
  const retry = createBatchFiles(() => {}, (from, to, tree, move) => transferDirectory(from, to, tree, move, false));
  const retryPlan = await retry.transfer([source], archive, 'move', 'skip');
  const [completed] = await retry.run(retryPlan.ticket);
  assert.equal(completed.status, 'done', completed.message);
  assert.equal(completed.message, undefined);
  assert.equal(await readFile(join(archive, 'source', 'b.txt'), 'utf8'), 'second');
  await assert.rejects(stat(source), { code: 'ENOENT' });
});

test('directory copies skip links and moves preserve directories that contain them', async t => {
  const root = await realpath(await fixture(t));
  const source = join(root, 'source');
  const target = join(root, 'target');
  const external = join(root, 'external');
  await Promise.all([mkdir(source), mkdir(target), mkdir(external)]);
  await writeFile(join(external, 'outside.txt'), 'original');
  await symlink(external, join(source, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const batch = createBatchFiles(() => {});
  const move = await batch.transfer([source], target, 'move', 'skip');
  assert.equal(move.ticket, undefined);
  assert.match(move.rows[0].reason!, /特殊项目/);
  const copy = await batch.transfer([source], target, 'copy', 'skip');
  assert.equal(copy.rows[0].contents?.skipped, 1);
  assert.equal((await batch.run(copy.ticket))[0].status, 'done');
  assert.deepEqual((await listDirectory(join(target, 'source'))).entries, []);
  assert.equal(await readFile(join(external, 'outside.txt'), 'utf8'), 'original');
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
