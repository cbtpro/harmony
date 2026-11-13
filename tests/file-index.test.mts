import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { registerHooks } from 'node:module';
import type { FileIndex as Index } from '../electron/main/search/file-index';
import type { IndexCompletion } from '../electron/main/search/index-automation';

// Node's test runner needs extensions that Vite resolves during the app build.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/electron/main/search/')
      && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
      return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
const { FileIndex } = await import('../electron/main/search/file-index.ts');
const { IndexAutomation } = await import('../electron/main/search/index-automation.ts');
const { SystemIndex, collectSearch } = await import('../electron/main/search/system-index.ts');
const { spotlightQuery, windowsQuery, sparqlQuery } = await import('../electron/main/search/system-providers.ts');
const { IndexStorage } = await import('../electron/main/search/index-storage.ts');
const { INDEX_TUNING } = await import('../electron/main/search/scan.ts');
const { quickKind, quickSearch } = await import('../electron/main/search/quick-search.ts');
hooks.deregister();

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harmony-index-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function waitForPhase(index: Index, phase: ReturnType<Index['status']>['phase']) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (index.status().phase === phase) return;
    await setTimeout(5);
  }
  assert.equal(index.status().phase, phase);
}

test('indexes nested names and canonicalizes queries without following links or caches', async t => {
  const root = await fixture(t);
  const sub = join(root, 'sub');
  await mkdir(sub);
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'café-ignore.txt'), '');
  await writeFile(join(sub, 'Cafe\u0301.txt'), '');
  await writeFile(join(root, '.café-hidden.txt'), '');
  await symlink(root, join(sub, 'loop'), 'junction');

  const index = new FileIndex();
  index.configure({ roots: [root], excluded: [] });
  index.rebuild([], undefined, 3);
  await waitForPhase(index, 'ready');
  const { matches } = await index.search(' CAFÉ ');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].directory, sub);
  assert.equal(index.status().count, 2);
  assert.deepEqual(await index.search(''), { matches: [], truncated: false });
  await assert.rejects(index.search('x'.repeat(129)), /128/);
  index.configure({ roots: [], excluded: [] });
  assert.equal(index.status().count, 0);
  assert.equal((await index.search('CAFÉ')).matches.length, 0);
});

test('scans beyond the old entry cap and still bounds each search response', async t => {
  const root = await fixture(t);
  const folders = 50;
  const filesPerFolder = 500;
  for (let directory = 0; directory < folders; directory++) {
    const folder = join(root, `folder-${directory}`);
    await mkdir(folder);
    for (let start = 0; start < filesPerFolder; start += 32) {
      await Promise.all(Array.from({ length: Math.min(32, filesPerFolder - start) }, (_, offset) =>
        writeFile(join(folder, `match-${start + offset}.txt`), '')));
    }
  }
  await writeFile(join(root, 'folder-49', 'tail-marker.txt'), '');

  const index = new FileIndex({ ...INDEX_TUNING, results: 1 }, join(root, '.cache', 'index.sqlite'));
  try {
    index.configure({ roots: [root], excluded: [] });
    const start = performance.now();
    index.rebuild([], undefined, 3);
    await index.whenIdle();
    t.diagnostic(`Indexed ${index.status().count} entries in ${Math.round(performance.now() - start)} ms using 3 threads`);
    assert.equal(index.status().phase, 'ready');
    assert.equal(index.status().count, folders * (filesPerFolder + 1) + 1);
    assert.equal((await index.search('tail-marker')).matches[0]?.name, 'tail-marker.txt');
    const result = await index.search('match');
    assert.equal(result.matches.length, 1);
    assert.equal(result.truncated, true);
  } finally {
    index.dispose();
  }
});

test('yields to foreground file work and supports pause, resume and stop', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'one'), '');
  const index = new FileIndex();
  index.configure({ roots: [root], excluded: [] });

  const pending = Promise.withResolvers<void>();
  const foreground = index.prioritize(() => pending.promise);
  index.rebuild();
  await setTimeout(25);
  assert.equal(index.status().count, 0);
  assert.equal(index.pause().phase, 'paused');
  pending.resolve();
  await foreground;
  await setTimeout(25);
  assert.equal(index.status().count, 0);
  assert.equal(index.resume().phase, 'running');
  await waitForPhase(index, 'ready');
  assert.equal(index.status().count, 1);

  index.rebuild();
  index.pause();
  assert.equal(index.stop().phase, 'stopping');
  await waitForPhase(index, 'stopped');
  index.rebuild();
  await waitForPhase(index, 'ready');
});

test('automatically refreshes its default home and saves blacklist changes', async t => {
  const fixtureRoot = await fixture(t);
  const home = join(fixtureRoot, 'home');
  const excluded = join(home, 'private');
  const settings = join(fixtureRoot, 'rules.json');
  await mkdir(excluded, { recursive: true });
  await writeFile(join(excluded, 'secret.txt'), '');
  const timing = { startup: 5, ruleChange: 5, refresh: 100 };
  const index = new FileIndex();
  const completions: IndexCompletion[] = [];
  const automation = new IndexAutomation(index, settings, home, timing, undefined,
    completion => { completions.push(completion); });
  t.after(() => automation.close());

  await automation.open();
  await waitForPhase(index, 'ready');
  assert.equal((await index.search('secret')).matches.length, 1);
  assert.deepEqual(completions, [{ count: 2, skipped: 0 }]);
  await writeFile(join(home, 'new-file.txt'), '');
  for (let attempt = 0; attempt < 200 && !(await index.search('new-file')).matches.length; attempt++) {
    await setTimeout(5);
  }
  assert.equal((await index.search('new-file')).matches.length, 1);
  await index.whenIdle();
  assert.equal(completions.length, 1);

  await automation.changeRule('roots', 'add', excluded);
  await waitForPhase(index, 'ready');
  assert.equal(index.status().count, 3);
  assert.equal((await index.search('secret')).matches.length, 1);
  await automation.changeRule('excluded', 'add', excluded);
  assert.equal((await index.search('secret')).matches.length, 0);
  await waitForPhase(index, 'ready');
  assert.equal(index.status().count, 1);
  assert.deepEqual(completions.at(-1), { count: 1, skipped: 0 });
  assert.equal(completions.length, 3);
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')).excluded, [excluded]);
  automation.close();

  const reopened = new FileIndex();
  const restored = new IndexAutomation(reopened, settings, home, timing);
  t.after(() => restored.close());
  await restored.open();
  await waitForPhase(reopened, 'ready');
  assert.equal((await reopened.search('secret')).matches.length, 0);

  // A blacklist entry can also exclude an entire whitelisted root.
  await restored.changeRule('excluded', 'add', home);
  await waitForPhase(reopened, 'ready');
  assert.equal(reopened.status().count, 0);
  await restored.changeRule('roots', 'remove', home);
  await restored.changeRule('roots', 'remove', excluded);
  assert.deepEqual((await restored.status()).roots, []);
  await setTimeout(20);
  assert.equal(reopened.status().phase, 'idle');
});

test('persists a paused scan and resumes only after continuing from its saved directory queue', async t => {
  const root = await fixture(t);
  const home = join(root, 'workspace');
  const cache = join(root, 'cache', 'index.sqlite');
  const paths = ['alpha', 'beta', 'gamma'].map(name => join(home, name));
  for (const [number, directory] of paths.entries()) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `checkpoint-${number}.txt`), '');
  }

  const index = new FileIndex(INDEX_TUNING, cache);
  const rules = { roots: [home], excluded: [] };
  let partial: number;
  try {
    index.configure(rules);
    let opened = 0;
    index.rebuild([], () => { if (++opened === 3) index.pause(); });
    await waitForPhase(index, 'paused');
    partial = index.status().count;
    assert.ok(partial >= 4 && partial < 6);
  } finally {
    const closing = index.whenIdle();
    index.dispose();
    await closing;
  }

  const snapshot = new IndexStorage(cache);
  try {
    assert.equal(snapshot.checkpoint()?.phase, 'paused');
    assert.equal(snapshot.completedDirectories(10).length, 3);
  } finally {
    snapshot.close();
  }

  const restored = new FileIndex(INDEX_TUNING, cache);
  try {
    restored.configure(rules);
    assert.equal(restored.rebuild([], undefined, 2, 'restore').phase, 'paused');
    assert.equal(restored.status().count, partial);
    assert.equal(restored.status().resumable, true);
    restored.rebuild([], undefined, 2, 'continue');
    await restored.whenIdle();
    assert.equal(restored.status().phase, 'ready');
    assert.equal(restored.status().resumable, false);
    assert.equal(restored.status().count, 6);
    assert.equal((await restored.search('checkpoint-')).matches.length, 3);
  } finally {
    restored.dispose();
  }
});

test('validates and persists the index thread count separately from scan progress', async t => {
  const root = await fixture(t);
  const file = join(root, 'rules.json');
  const automation = new IndexAutomation(new FileIndex(), file, root);
  const settings = await automation.settings();
  assert.equal(settings.maxThreads, Math.max(1, settings.systemThreads - 1));
  await assert.rejects(automation.setThreads(settings.maxThreads + 1), /索引线程数/);
  await assert.rejects(automation.setThreads(1.5), /索引线程数/);
  await automation.setThreads(1);
  const reopened = new IndexAutomation(new FileIndex(), file, root);
  assert.equal((await reopened.settings()).threads, 1);
  assert.deepEqual((await reopened.status()).roots, [root]);
});

test('searches system-covered roots without crawling them, applies blacklist, and falls back after failure', async t => {
  const root = await fixture(t);
  const covered = join(root, 'covered');
  const local = join(root, 'local');
  const excluded = join(covered, 'private');
  const systemFile = join(covered, 'match-system.txt');
  const localFile = join(local, 'match-local.txt');
  const blockedFile = join(excluded, 'match-private.txt');
  const rules = join(root, 'rules.json');
  await Promise.all([mkdir(excluded, { recursive: true }), mkdir(local)]);
  await Promise.all([systemFile, localFile, blockedFile].map(path => writeFile(path, '')));
  await writeFile(rules, JSON.stringify({ version: 1, roots: [covered, local], excluded: [excluded] }));
  let fails = false;
  const system = new SystemIndex([{
    name: 'Test system',
    probe: async path => path === covered,
    async find() {
      if (fails) throw new Error('Provider stopped');
      return [systemFile, blockedFile, localFile, join(covered, 'match-stale.txt')];
    },
  }]);
  const index = new FileIndex();
  const automation = new IndexAutomation(index, rules, root,
    { startup: 5, ruleChange: 5, refresh: 60_000 }, undefined, undefined, system);
  t.after(() => { automation.close(); index.dispose(); });
  await automation.open();
  await waitForPhase(index, 'ready');
  assert.equal(index.status().count, 1);
  assert.deepEqual((await automation.status()).sources, [
    { root: local, provider: 'Harmony' }, { root: covered, provider: 'Test system' },
  ]);
  const find = () => collectSearch(automation.searchEntries({ term: 'match-' }), 100);
  assert.deepEqual((await find()).matches.map(entry => entry.path), [systemFile, localFile]);
  assert.equal((await automation.findEntry(systemFile))?.path, systemFile);
  assert.equal(await automation.findEntry(blockedFile), undefined);

  fails = true;
  await find();
  for (let attempt = 0; attempt < 200 && index.status().count !== 2; attempt++) await setTimeout(10);
  await index.whenIdle();
  assert.equal(index.status().count, 2);
  assert.deepEqual((await find()).matches.map(entry => entry.path).sort(), [systemFile, localFile].sort());
  await automation.setThreads(1, false);
  const reopened = new IndexAutomation(new FileIndex(), rules, root, undefined, undefined, undefined, system);
  assert.equal((await reopened.settings()).preferSystem, false);
});

test('escapes names and scopes passed to platform search engines', () => {
  assert.equal(spotlightQuery({ term: 'a"*?\\b' }), String.raw`kMDItemFSName == "*a\"\*\?\\b*"cd`);
  assert.match(windowsQuery("C:\\O'Brien", { term: "it's" }, 10), /SCOPE='file:C:\/O''Brien' AND System.FileName LIKE '%it''s%'/);
  assert.ok(sparqlQuery('/tmp/test folder', { term: 'a"b' }, 10).includes(String.raw`"a\"b"`));
});

test('reports a manual rebuild and ignores an index stopped by the user', async t => {
  const root = await fixture(t);
  const home = join(root, 'home');
  await mkdir(home);
  await Promise.all(['one', 'two'].map(name => writeFile(join(home, name), '')));
  const index = new FileIndex();
  const completions: IndexCompletion[] = [];
  const automation = new IndexAutomation(index, join(root, 'rules.json'), home,
    { startup: 60_000, ruleChange: 60_000, refresh: 60_000 }, undefined,
    completion => { completions.push(completion); });
  t.after(() => automation.close());

  await automation.open();
  await automation.rebuild();
  await index.whenIdle();
  assert.deepEqual(completions, [{ count: 2, skipped: 0 }]);

  const pending = Promise.withResolvers<void>();
  const foreground = index.prioritize(() => pending.promise);
  try {
    await automation.rebuild();
    await automation.stop();
  } finally {
    pending.resolve();
    await foreground;
  }
  await index.whenIdle();
  assert.equal(index.status().phase, 'stopped');
  assert.equal(completions.length, 1);
});

test('uses native directory events to update names and subtrees before a scheduled scan', async t => {
  const root = await fixture(t);
  const home = join(root, 'home');
  const staging = join(root, 'staging');
  const incoming = join(home, 'incoming');
  const excluded = join(home, 'private');
  const settings = join(root, 'rules.json');
  await Promise.all([mkdir(excluded, { recursive: true }), mkdir(join(staging, 'deep'), { recursive: true })]);
  await writeFile(join(staging, 'deep', 'watch-original.txt'), '');
  await writeFile(settings, JSON.stringify({ version: 1, roots: [home], excluded: [excluded] }));

  const index = new FileIndex({ ...INDEX_TUNING, batchDelayMs: 0 });
  const completions: IndexCompletion[] = [];
  const automation = new IndexAutomation(index, settings, home,
    { startup: 5, ruleChange: 5, refresh: 60_000 }, undefined,
    completion => { completions.push(completion); });
  t.after(() => { automation.close(); index.dispose(); });
  await automation.open();
  await waitForPhase(index, 'ready');

  async function expectMatches(query: string, names: string[]) {
    for (let attempt = 0; attempt < 250; attempt++) {
      const actual = (await index.search(query)).matches.map(match => match.name).sort();
      if (JSON.stringify(actual) === JSON.stringify(names)) return;
      await setTimeout(20);
    }
    assert.deepEqual((await index.search(query)).matches.map(match => match.name).sort(), names);
  }

  await rename(staging, incoming);
  await expectMatches('watch-', ['watch-original.txt']);
  await rename(join(incoming, 'deep', 'watch-original.txt'), join(incoming, 'deep', 'watch-renamed.txt'));
  await writeFile(join(excluded, 'watch-hidden.txt'), '');
  await expectMatches('watch-', ['watch-renamed.txt']);
  await rm(incoming, { recursive: true });
  await expectMatches('watch-', []);
  assert.equal(index.status().count, 0);
  assert.deepEqual(completions, [{ count: 0, skipped: 0 }]);
});

test('keeps automatic indexing off if saved settings cannot be read', async t => {
  const root = await fixture(t);
  const settings = join(root, 'invalid.json');
  await writeFile(settings, '{broken');
  const index = new FileIndex();
  const automation = new IndexAutomation(index, settings, root, { startup: 0, ruleChange: 0, refresh: 10 });
  t.after(() => automation.close());
  await automation.open();
  await setTimeout(15);
  const status = await automation.status();
  assert.match(status.settingsWarning ?? '', /无法读取/);
  assert.deepEqual(status.roots, []);
  assert.equal(status.phase, 'idle');
});

test('searches explicitly indexed volumes without crossing unselected mount boundaries', async t => {
  const system = await fixture(t);
  const external = join(system, 'external');
  const other = join(system, 'other');
  await Promise.all([mkdir(external), mkdir(other)]);
  await Promise.all([
    writeFile(join(system, 'match-system.txt'), ''),
    writeFile(join(external, 'match-external.txt'), ''),
    writeFile(join(other, 'match-other.txt'), ''),
  ]);
  const index = new FileIndex();
  index.configure({ roots: [system, external], excluded: [] });
  index.rebuild([system, external, other]);
  await waitForPhase(index, 'ready');
  assert.deepEqual((await index.search('match')).matches.map(match => match.name).sort(),
    ['match-external.txt', 'match-system.txt']);
});

test('quick search gives each result type its own limit and prioritizes exact and prefix matches', async () => {
  const files = Array.from({ length: 12 }, (_, index) => ({
    name: `old-demo-${index}.txt`, path: `/files/old-demo-${index}.txt`, kind: 'file' as const,
  }));
  const result = await quickSearch(() => [[
    ...files,
    { name: 'demo.txt', path: '/files/demo.txt', kind: 'file' },
    { name: 'demo', path: '/files/demo', kind: 'file' },
    { name: 'demo folder', path: '/files/demo folder', kind: 'directory' },
    { name: 'demo.JPG', path: '/files/demo.JPG', kind: 'file' },
  ]], 'DEMO');

  assert.deepEqual(result.map(group => group.kind), ['folder', 'image', 'file']);
  assert.equal(result[2].matches.length, 5);
  assert.deepEqual(result[2].matches.slice(0, 2).map(entry => entry.name), ['demo', 'demo.txt']);
  assert.equal(quickKind({ name: 'Demo.app', path: '/Demo.app', kind: 'directory' }, 'darwin'), 'application');
  assert.equal(quickKind({ name: 'Demo.exe', path: '/Demo.exe', kind: 'file' }, 'win32'), 'application');
  assert.equal(quickKind({ name: 'Demo.desktop', path: '/Demo.desktop', kind: 'file' }, 'linux'), 'application');
});
