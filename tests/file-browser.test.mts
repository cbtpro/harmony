import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useFileBrowser } from '../src/features/files/useFileBrowser.ts';
import type { Directory, FilesApi, Result } from '../shared/files.ts';

const directory: Directory = {
  path: '/fixtures',
  parent: '/',
  entries: [{ name: 'Notes.TXT', path: '/fixtures/Notes.TXT', kind: 'file' }],
};

function api(overrides: Partial<FilesApi>): FilesApi {
  return {
    list: async () => ({ ok: true, value: directory }),
    choose: async () => ({ ok: true, value: null }),
    mkdir: async () => ({ ok: true, value: undefined }),
    copyFile: async () => ({ ok: true, value: undefined }),
    open: async () => ({ ok: true, value: undefined }),
    reveal: async () => ({ ok: true, value: undefined }),
    copyPath: async () => ({ ok: true, value: undefined }),
    trash: async () => ({ ok: true, value: undefined }),
    deletePermanently: async () => ({ ok: true, value: undefined }),
    ...overrides,
  };
}

test('keeps the previous listing and filter when navigation fails', async () => {
  const browser = useFileBrowser(api({
    list: async path => path === '/missing'
      ? { ok: false, message: '目录不存在' }
      : { ok: true, value: directory },
  }));
  await browser.navigate();
  browser.query.value = '  notes.txt ';
  await browser.navigate('/missing');
  assert.equal(browser.error.value, '目录不存在');
  assert.equal(browser.directory.value?.path, directory.path);
  assert.deepEqual(browser.entries.value, directory.entries);
  assert.equal(browser.busy.value, false);
});

test('prevents concurrent operations while a directory is loading', async () => {
  const { promise, resolve } = Promise.withResolvers<Result<Directory>>();
  let createCalls = 0;
  const browser = useFileBrowser(api({
    list: () => promise,
    mkdir: async () => {
      createCalls++;
      return { ok: true, value: undefined };
    },
  }));
  const initialLoad = browser.navigate();
  assert.equal(browser.busy.value, true);
  await browser.create('整理');
  resolve({ ok: true, value: directory });
  await initialLoad;
  assert.equal(createCalls, 0);
  assert.equal(browser.busy.value, false);
});
