import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { test } from 'node:test';
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
