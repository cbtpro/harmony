import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { registerHooks } from 'node:module';
import type { FileIndex as Index } from '../electron/main/search/file-index';

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
const { INDEX_LIMITS } = await import('../electron/main/search/scan.ts');
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
  index.rebuild();
  await waitForPhase(index, 'ready');
  const { matches } = index.search(' CAFÉ ');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].directory, sub);
  assert.equal(index.status().count, 2);
  assert.deepEqual(index.search(''), { matches: [], truncated: false });
  assert.throws(() => index.search('x'.repeat(129)), /128/);
  index.configure({ roots: [], excluded: [] });
  assert.equal(index.status().count, 0);
  assert.equal(index.search('CAFÉ').matches.length, 0);
});

test('bounds index entries, search results, memory estimates and skipped scanning work', async t => {
  const root = await fixture(t);
  await Promise.all(['a', 'b', 'c'].map(name => writeFile(join(root, `match-${name}`), '')));
  for (const [limits, count] of [
    [{ entries: 2 }, 2],
    [{ estimatedBytes: 1 }, 0],
    [{ steps: 2 }, 1],
  ] as const) {
    const index = new FileIndex({ ...INDEX_LIMITS, results: 1, ...limits });
    index.configure({ roots: [root], excluded: [] });
    index.rebuild();
    await waitForPhase(index, 'limited');
    assert.equal(index.status().count, count);
    const result = index.search('match');
    assert.equal(result.matches.length, Math.min(1, count));
    assert.equal(result.truncated, count > 1);
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
  const automation = new IndexAutomation(index, settings, home, timing);
  t.after(() => automation.close());

  await automation.open();
  await waitForPhase(index, 'ready');
  assert.equal(index.search('secret').matches.length, 1);
  await writeFile(join(home, 'new-file.txt'), '');
  for (let attempt = 0; attempt < 200 && !index.search('new-file').matches.length; attempt++) {
    await setTimeout(5);
  }
  assert.equal(index.search('new-file').matches.length, 1);

  await assert.rejects(automation.changeRule('roots', 'add', excluded), /重叠/);
  await automation.changeRule('excluded', 'add', excluded);
  assert.equal(index.search('secret').matches.length, 0);
  await waitForPhase(index, 'ready');
  assert.equal(index.status().count, 1);
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')).excluded, [excluded]);
  automation.close();

  const reopened = new FileIndex();
  const restored = new IndexAutomation(reopened, settings, home, timing);
  t.after(() => restored.close());
  await restored.open();
  await waitForPhase(reopened, 'ready');
  assert.equal(reopened.search('secret').matches.length, 0);

  // A blacklist entry can also exclude an entire whitelisted root.
  await restored.changeRule('excluded', 'add', home);
  await waitForPhase(reopened, 'ready');
  assert.equal(reopened.status().count, 0);
  await restored.changeRule('roots', 'remove', home);
  assert.deepEqual((await restored.status()).roots, []);
  await setTimeout(20);
  assert.equal(reopened.status().phase, 'idle');
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
  assert.deepEqual(index.search('match').matches.map(match => match.name).sort(),
    ['match-external.txt', 'match-system.txt']);
});

test('quick search gives each result type its own limit and prioritizes exact and prefix matches', () => {
  const files = Array.from({ length: 12 }, (_, index) => ({
    name: `old-demo-${index}.txt`, path: `/files/old-demo-${index}.txt`, kind: 'file' as const,
  }));
  const result = quickSearch([
    ...files,
    { name: 'demo.txt', path: '/files/demo.txt', kind: 'file' },
    { name: 'demo', path: '/files/demo', kind: 'file' },
    { name: 'demo folder', path: '/files/demo folder', kind: 'directory' },
    { name: 'demo.JPG', path: '/files/demo.JPG', kind: 'file' },
  ], 'DEMO');

  assert.deepEqual(result.map(group => group.kind), ['folder', 'image', 'file']);
  assert.equal(result[2].matches.length, 5);
  assert.deepEqual(result[2].matches.slice(0, 2).map(entry => entry.name), ['demo', 'demo.txt']);
  assert.equal(quickKind({ name: 'Demo.app', path: '/Demo.app', kind: 'directory' }, 'darwin'), 'application');
  assert.equal(quickKind({ name: 'Demo.exe', path: '/Demo.exe', kind: 'file' }, 'win32'), 'application');
  assert.equal(quickKind({ name: 'Demo.desktop', path: '/Demo.desktop', kind: 'file' }, 'linux'), 'application');
});
