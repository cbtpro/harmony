import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, parse } from 'node:path';
import type { Directory, FileEntry } from '../../shared/files';

export function absolutePath(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value)) {
    throw new Error('请输入绝对路径。');
  }
  return normalize(value);
}

export function entryPath(value: unknown): string {
  const path = absolutePath(value);
  if (dirname(path) === path || parse(path).root === path) {
    throw new Error('无法对磁盘根目录执行此操作。');
  }
  return path;
}

export async function listDirectory(value: unknown): Promise<Directory> {
  const path = absolutePath(value);
  const entries = (await readdir(path, { withFileTypes: true })).map((entry): FileEntry => ({
    name: entry.name,
    path: join(path, entry.name),
    kind: entry.isDirectory() ? 'directory'
      : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'link' : 'other',
  }));
  const compare = new Intl.Collator('zh-CN', { numeric: true });
  entries.sort((left, right) =>
    Number(right.kind === 'directory') - Number(left.kind === 'directory')
    || compare.compare(left.name, right.name));
  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, entries };
}

export async function createFolder(directory: unknown, name: unknown): Promise<void> {
  if (typeof name !== 'string' || !name.trim() || /[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(name)
    || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(\.|$)/i.test(name)) {
    throw new Error('请输入有效的文件夹名称。');
  }
  await mkdir(join(absolutePath(directory), name));
}

export async function duplicateFile(source: unknown, directory: unknown): Promise<void> {
  const path = entryPath(source);
  if (!(await lstat(path)).isFile()) throw new Error('请选择普通文件。');
  await copyFile(path, join(absolutePath(directory), basename(path)), constants.COPYFILE_EXCL);
}
