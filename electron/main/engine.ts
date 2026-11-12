import { execFile } from 'node:child_process';
import { lstat, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Disk } from '../../shared/disks';
import type { Result } from '../../shared/files';
import type { IndexRules } from '../../shared/search';
import { discoverMounts, diskSpace } from './disks';
import { absolutePath, createFolder, duplicateFile, entryPath, listDirectory } from './files';
import { createMediaLibrary } from './media/library';
import { FileIndex } from './search/file-index';
import { IndexAutomation } from './search/index-automation';
import type { IndexCompletion } from './search/index-automation';
import { createTerminalService } from './terminals';
import { quickKind, quickSearch } from './search/quick-search';
import { isWithin } from './search/scan';

interface PlatformActions {
  chooseDirectory(): Promise<string | null>;
  open(path: string): Promise<string>;
  reveal(path: string): void;
  copyPath(path: string): void;
  trash(path: string): Promise<void>;
  onIndexComplete(completion: IndexCompletion): void;
}

const messages: Record<string, string> = {
  EEXIST: '同名项目已存在。',
  ENOENT: '路径已不存在。',
  ENOTDIR: '该路径不是文件夹。',
  EACCES: '没有访问权限。',
  EPERM: '系统拒绝了该操作。',
  ENOSPC: '磁盘空间不足。',
};

const run = promisify(execFile);

export type Dispatch = (name: string, args: unknown[]) => Promise<Result<unknown>>;

export function createEngine(home: string, rulesFile: string, platform: PlatformActions) {
  const index = new FileIndex(undefined, join(dirname(rulesFile), '.harmony-index', 'files.sqlite'));
  const media = createMediaLibrary(index, join(dirname(rulesFile), 'media-metadata.json'));
  const terminals = createTerminalService(home);
  const mounts = () => discoverMounts(home);
  const mountPaths = async () => (await mounts().catch(() => [])).map(mount => mount.path);
  const automation = new IndexAutomation(index, rulesFile, home, undefined, mountPaths, platform.onIndexComplete);

  async function choose(value: unknown) {
    if (value === undefined) return platform.chooseDirectory();
    const path = absolutePath(value);
    if (!(await stat(path)).isDirectory()) throw new Error('该路径不是文件夹。');
    return path;
  }

  async function addRule(list: keyof IndexRules, value: unknown) {
    const path = await choose(value);
    return path ? automation.changeRule(list, 'add', path) : automation.status();
  }

  async function listDisks(): Promise<Disk[]> {
    const [volumes, rules] = await Promise.all([mounts(), automation.status()]);
    const output: Disk[] = [];
    for (const mount of volumes.slice(0, 64)) {
      const path = mount.path;
      if (process.platform === 'linux' && !(await stat(path).catch(() => null))?.isDirectory()) continue;
      const included = rules.roots.filter(root => isWithin(path, root)
        && !volumes.some(other => other.path !== path && isWithin(path, other.path) && isWithin(other.path, root)));
      const accessible = included.filter(root => !rules.excluded.some(excluded => isWithin(excluded, root)));
      const scope = rules.excluded.some(excluded => isWithin(excluded, path)) ? 'excluded'
        : accessible.includes(path) ? 'full' : accessible.length ? 'partial' : 'none';
      output.push({ path, name: mount.name, scope, ...await diskSpace(mount) });
    }
    return output;
  }

  async function indexDisk(value: unknown) {
    const path = absolutePath(value);
    const paths = await mountPaths();
    if (!paths.includes(path)) throw new Error('磁盘已卸载或无法访问。');
    await automation.changeRule('roots', 'add', path);
  }

  async function openPath(path: string) {
    const error = await platform.open(path);
    if (error) throw new Error(error);
  }

  async function openQuickResult(value: unknown) {
    const path = absolutePath(value);
    const entry = index.findIndexedPath(path);
    if (!entry) throw new Error('该项目已不在搜索索引中，请重新搜索。');
    const kind = quickKind(entry);
    if (kind === 'folder') throw new Error('请在文件页面浏览目录。');

    const stats = await lstat(path);
    if (entry.kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) {
      throw new Error('该项目已变更，请重新搜索。');
    }
    if (process.platform === 'linux' && kind === 'application') {
      try { await run('gio', ['launch', path], { timeout: 5000 }); }
      catch { throw new Error('系统无法启动此程序，请确认 GIO 和程序启动器可用。'); }
    } else {
      await openPath(path);
    }
  }

  type Operation = (...args: unknown[]) => unknown;
  const commands = new Map<string, Operation>([
    ['files:list', path => index.prioritize(() => listDirectory(path === undefined || path === null ? home : path))],
    ['files:choose', value => index.prioritize(() => choose(value))],
    ['files:mkdir', (directory, name) => index.prioritize(() => createFolder(directory, name))],
    ['files:copyFile', (source, directory) => index.prioritize(() => duplicateFile(source, directory))],
    ['files:open', path => index.prioritize(() => openPath(absolutePath(path)))],
    ['files:reveal', value => index.prioritize(async () => {
      const path = absolutePath(value);
      await lstat(path);
      platform.reveal(path);
    })],
    ['files:copy-path', path => platform.copyPath(absolutePath(path))],
    ['files:trash', path => index.prioritize(() => platform.trash(entryPath(path)))],
    ['terminals:list', () => terminals.list()],
    ['terminals:open', (id, path) => index.prioritize(() => terminals.open(id, absolutePath(path)))],
    ['media:list', query => media.list(query)],
    ['media:inspect', path => index.prioritize(() => media.inspect(path))],
    ['media:scrape', (kind, query, country) => media.scrape(kind, query, country)],
    ['media:save', (path, metadata) => index.prioritize(() => media.save(path, metadata))],
    ['media:rename', (path, stem) => index.prioritize(() => media.rename(path, stem))],
    ['search:status', () => automation.status()],
    ['search:add-root', value => index.prioritize(() => addRule('roots', value))],
    ['search:remove-root', path => automation.changeRule('roots', 'remove', path)],
    ['search:add-excluded', value => index.prioritize(() => addRule('excluded', value))],
    ['search:remove-excluded', path => automation.changeRule('excluded', 'remove', path)],
    ['search:rebuild', () => automation.rebuild()],
    ['search:pause', () => index.pause()],
    ['search:resume', () => automation.resume()],
    ['search:settings', () => automation.settings()],
    ['search:set-threads', value => automation.setThreads(value)],
    ['search:stop', () => automation.stop()],
    ['search:find', query => index.search(query)],
    ['search:quick', query => quickSearch(term => index.batches(term), query)],
    ['search:open-quick', path => index.prioritize(() => openQuickResult(path))],
    ['disks:list', () => index.prioritize(listDisks)],
    ['disks:index', path => index.prioritize(() => indexDisk(path))],
  ]);

  const dispatch: Dispatch = async (name, args) => {
    const operation = commands.get(name);
    if (!operation) return { ok: false, message: '不支持该操作。' };
    try {
      return { ok: true, value: await operation(...args) };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      return { ok: false, message: failure.code
        ? messages[failure.code] ?? '文件操作失败。'
        : failure.message || '文件操作失败。' };
    }
  };

  return {
    dispatch,
    open: () => automation.open(),
    close() {
      automation.close();
      index.dispose();
    },
  };
}
