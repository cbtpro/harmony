import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rename, rm, rmdir, unlink, utimes } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { filesystemPath } from './file-path';

export function sameIdentity(a: BigIntStats, b: BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino;
}

export function unchanged(a: BigIntStats | undefined, b: BigIntStats | undefined) {
  return !a || !b ? a === b : sameIdentity(a, b) && a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs;
}

export async function snapshot(path: string) {
  try { return await lstat(filesystemPath(path), { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

interface TreeEntry { name: string; state: BigIntStats }
export interface DirectoryTree { entries: TreeEntry[]; files: number; directories: number; skipped: number }
type CopyFile = typeof copyFile;
export const MAX_TREE_ENTRIES = 50_000;

export async function readTree(source: string, checkName: (name: string) => void, remaining: number): Promise<DirectoryTree> {
  if (remaining < 1) throw new Error(`一次最多预览 ${MAX_TREE_ENTRIES} 个目录项目，请分批选择。`);
  const entries: TreeEntry[] = [];
  let files = 0;
  let directories = 0;
  let skipped = 0;
  const pending = [source];
  const root = await snapshot(source);
  if (!root?.isDirectory()) throw new Error('源文件夹已变更。');
  while (pending.length) {
    const path = pending.pop()!;
    const state = await snapshot(path);
    if (!state) throw new Error(`目录内容已变更：${path}`);
    const name = relative(source, path);
    if (state.dev !== root.dev || (!state.isDirectory() && !state.isFile())) {
      skipped++;
      continue;
    }
    if (name) checkName(name);
    entries.push({ name, state });
    if (state.isDirectory()) {
      if (name) directories++;
      const children = await readdir(filesystemPath(path));
      if (entries.length + pending.length + children.length + skipped > remaining) {
        throw new Error(`一次最多预览 ${MAX_TREE_ENTRIES} 个目录项目，请分批选择。`);
      }
      if (!unchanged(state, await snapshot(path))) throw new Error(`目录内容已变更：${path}`);
      for (const child of children.sort().reverse()) pending.push(join(path, child));
    } else files++;
  }
  return { entries, files, directories, skipped };
}

async function verifyTree(source: string, tree: DirectoryTree) {
  for (const { name, state } of tree.entries) {
    if (!unchanged(state, await snapshot(join(source, name)))) {
      throw new Error(`源目录内容已变更，请重新预览：${join(source, name)}`);
    }
  }
}

// On POSIX, reserve the name before rename can replace an empty directory.
async function publishDirectory(source: string, target: string) {
  if (process.platform === 'win32') {
    await rename(filesystemPath(source), filesystemPath(target));
    return;
  }
  const targetPath = filesystemPath(target);
  await mkdir(targetPath);
  const reservation = await snapshot(target);
  try {
    if (!unchanged(reservation, await snapshot(target))) throw new Error('目标目录已变更，请重新预览。');
    await rename(filesystemPath(source), targetPath);
  } catch (error) {
    if (reservation && unchanged(reservation, await snapshot(target))) await rmdir(targetPath).catch(() => {});
    throw error;
  }
}

export async function transferDirectory(source: string, target: string, tree: DirectoryTree, move: boolean,
  sameVolume: boolean, copy: CopyFile = copyFile) {
  await verifyTree(source, tree);
  if (move && sameVolume) {
    try { await publishDirectory(source, target); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error; }
  }

  const staging = join(dirname(target), `.harmony-transfer-${randomUUID()}`);
  await mkdir(filesystemPath(staging));
  try {
    for (const { name, state } of tree.entries) {
      if (!name) continue;
      const input = join(source, name);
      const output = join(staging, name);
      if (!unchanged(state, await snapshot(input))) throw new Error(`源文件已变更：${input}`);
      if (state.isDirectory()) await mkdir(filesystemPath(output));
      else {
        await copy(filesystemPath(input), filesystemPath(output), constants.COPYFILE_EXCL);
        if ((await snapshot(output))?.size !== state.size) throw new Error(`目标文件大小校验失败：${input}`);
      }
    }
    for (let i = tree.entries.length - 1; i >= 0; i--) {
      const { name, state } = tree.entries[i];
      await utimes(filesystemPath(join(staging, name)), Number(state.atimeMs) / 1000, Number(state.mtimeMs) / 1000);
    }
    await verifyTree(source, tree);
    await publishDirectory(staging, target);
  } finally {
    await rm(filesystemPath(staging), { recursive: true, force: true }).catch(() => {});
  }
  if (!move) return;
  const quarantine = join(dirname(source), `.harmony-moved-${randomUUID()}`);
  try {
    await verifyTree(source, tree);
    await publishDirectory(source, quarantine);
  } catch { throw new Error(`目标已复制，源文件夹未移除，请核对两处目录：${source}`); }
  try {
    for (let i = tree.entries.length - 1; i >= 0; i--) {
      const { name, state } = tree.entries[i];
      const path = join(quarantine, name);
      const current = await snapshot(path);
      if (!current || !sameIdentity(state, current) || (!state.isDirectory() && !unchanged(state, current))) {
        throw new Error('源目录内容已变更。');
      }
      if (state.isDirectory()) await rmdir(filesystemPath(path));
      else await unlink(filesystemPath(path));
    }
  }
  catch { return `目标已完成，源目录清理未完成。剩余项目位于 ${quarantine}`; }
}
