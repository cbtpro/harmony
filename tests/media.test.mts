import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/electron/main/')
      && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
      return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
const { classify } = await import('../electron/main/media/classification.ts');
const { createMediaLibrary } = await import('../electron/main/media/library.ts');
const { createBatchFiles } = await import('../electron/main/batch-files.ts');
const { FileIndex } = await import('../electron/main/search/file-index.ts');
hooks.deregister();

test('classifies media formats, episode names and dedicated folders', () => {
  const examples = [
    ['Movies/Example.MKV', 'movie'], ['Example_S01E02.mp4', 'series'], ['动画/片段.mp4', 'animation'],
    ['example.webm', 'video'], ['音乐/example.flac', 'music'], ['Podcasts/example.mp3', 'podcast'],
    ['example.wav', 'audio'], ['example.m4b', 'audiobook'], ['photo.HEIC', 'image'],
    ['example.epub', 'book'], ['漫画/example.pdf', 'comic'], ['example.cbz', 'comic'],
    ['example.srt', 'subtitle'], ['example.m3u8', 'playlist'],
  ];
  for (const [name, category] of examples) assert.equal(classify(name), category);
  assert.equal(classify('readme.md'), undefined);
});

test('queries a media catalog, refuses collisions and preserves metadata on rename', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harmony-media-unit-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'library');
  await mkdir(folder);
  const original = join(folder, 'Read me.EPUB');
  const existing = join(folder, 'Existing.EPUB');
  await Promise.all([writeFile(original, 'book data'), writeFile(existing, 'other book'), writeFile(join(folder, 'notes.md'), '')]);

  const index = new FileIndex();
  index.configure({ roots: [folder], excluded: [] });
  index.rebuild();
  await index.whenIdle();

  const file = join(root, 'media.json');
  const library = createMediaLibrary(index, file);
  assert.equal((await library.list({ category: 'all' })).total, 2);
  const details = await library.inspect(original);
  assert.equal(details.size, 9);
  assert.equal(details.probe, 'unsupported');

  await library.save(original, { title: 'Catalog handbook', creator: 'Example Author', source: 'manual' });
  assert.equal((await library.list({ query: 'example author', category: 'book' })).total, 1);
  await assert.rejects(library.rename(original, 'Existing'), { code: 'EEXIST' });
  await assert.rejects(library.rename(original, '../Escape'), /有效的文件名/);
  assert.equal(await readFile(existing, 'utf8'), 'other book');

  const renamed = await library.rename(original, 'New handbook');
  assert.equal(renamed.path, join(folder, 'New handbook.EPUB'));
  assert.equal(await readFile(renamed.path, 'utf8'), 'book data');
  await assert.rejects(readFile(original), { code: 'ENOENT' });
  assert.equal((await index.search('new handbook')).matches[0]?.path, renamed.path);
  assert.equal((await index.search('read me')).matches.length, 0);

  const reopened = createMediaLibrary(index, file);
  const result = await reopened.list({ query: 'catalog handbook', category: 'all' });
  assert.equal(result.items[0]?.path, renamed.path);
  assert.equal(result.items[0]?.metadata?.creator, 'Example Author');

  const archive = join(root, 'archive');
  await mkdir(archive);
  const batch = createBatchFiles(reopened.relocateMetadata);
  const plan = await batch.transfer([renamed.path], archive, 'move', 'skip');
  const [moved] = await batch.run(plan.ticket);
  assert.equal(moved.status, 'done');
  assert.equal(moved.message, undefined);
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(persisted.entries.map(([path, metadata]) => [path, metadata.title]), [
    [join(archive, 'New handbook.EPUB'), 'Catalog handbook'],
  ]);
});
