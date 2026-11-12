import { lstat, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { IndexStorage } from './index-storage';
import { isWithin } from './scan';
import type { createScanScope, INDEX_TUNING, ScanEntry } from './scan';

interface UpdateCallbacks {
  checkpoint(): Promise<boolean>;
  observation(): number;
  changed(): void;
  visitDirectory(path: string): void;
  removeDirectory(path: string): void;
}

function isMissing(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export async function updateDirectories(
  storage: IndexStorage,
  paths: readonly string[],
  scope: ReturnType<typeof createScanScope>,
  callbacks: UpdateCallbacks,
  tuning: typeof INDEX_TUNING,
) {
  const visited = new Set<string>();
  const rootDevices = new Map<string, number>();
  let lastNewDirectory = storage.lastId();
  let steps = 0;

  async function checkpoint() {
    if (++steps >= tuning.batchSize) {
      steps = 0;
      await setTimeout(tuning.batchDelayMs);
    }
    return callbacks.checkpoint();
  }

  async function remove(path: string) {
    if (storage.find(path)?.kind !== 'file') callbacks.removeDirectory(path);
    while (await checkpoint()) {
      const removed = storage.remove(path, tuning.batchSize);
      if (!removed) return true;
      callbacks.changed();
    }
    return false;
  }

  async function refresh(path: string): Promise<boolean> {
    const root = scope.owner(path);
    if (root === undefined) return true;
    if (!await checkpoint()) return false;
    const seen = callbacks.observation();
    let directory;
    let device: number;
    try {
      const canonical = await realpath(path);
      // An ancestor replaced by a symlink must not bring a different tree into scope.
      if (!isWithin(path, canonical) || !isWithin(canonical, path)) return remove(path);
      path = canonical;
      if (scope.owner(path) !== root) return true;
      const info = await lstat(path);
      device = info.dev;
      const rootDevice = rootDevices.get(root) ?? (path === root ? device : (await lstat(root)).dev);
      rootDevices.set(root, rootDevice);
      if (!info.isDirectory() || device !== rootDevice) return remove(path);
      directory = await opendir(path, { bufferSize: tuning.batchSize });
    } catch (error) {
      return isMissing(error) ? remove(path) : true;
    }

    try {
      if (!await checkpoint()) return false;
      callbacks.visitDirectory(path);
      let entries: ScanEntry[] = [];
      while (await checkpoint()) {
        let child;
        try { child = await directory.read(); }
        catch { return true; } // Preserve cached rows if the directory could not be read completely.
        if (!await callbacks.checkpoint()) return false;
        if (child) {
          const childPath = join(path, child.name);
          const kind = child.isDirectory() ? 'directory' : child.isFile() ? 'file' : null;
          if (kind && scope.owns(path, childPath)) {
            const old = storage.find(childPath);
            if (kind === 'directory' && old?.kind !== 'directory') {
              const info = await lstat(childPath).catch(() => undefined);
              if (!info?.isDirectory() || info.dev !== device) continue;
              if (!await callbacks.checkpoint()) return false;
            }
            if (old && old.kind !== kind && !await remove(childPath)) return false;
            entries.push({ path: childPath, name: child.name, kind });
          }
        }
        if (!child || entries.length === tuning.batchSize) {
          if (storage.add(entries, seen)) callbacks.changed();
          entries = [];
        }
        if (!child) break;
      }
    } finally {
      await directory.close();
    }

    if (!await callbacks.checkpoint()) return false;
    const last = storage.lastId();
    let cursor = 0;
    while (cursor < last && await checkpoint()) {
      const rows = storage.children(path, cursor, last, tuning.batchSize);
      if (!rows.length) return true;
      for (const row of rows) {
        cursor = row.id;
        if (row.seen === seen) continue;
        try {
          const info = await lstat(row.path);
          if (scope.owns(path, row.path) && (info.isDirectory() || info.isFile())
            && await realpath(row.path) === row.path) continue;
        } catch (error) {
          if (!isMissing(error)) continue;
        }
        if (!await remove(row.path)) return false;
      }
    }
    return callbacks.checkpoint();
  }

  for (const path of paths) {
    if (!await refresh(path)) return false;
    visited.add(path);
  }
  while (await checkpoint()) {
    const next = storage.directory(lastNewDirectory);
    if (!next) return true;
    lastNewDirectory = next.id;
    if (!visited.has(next.path) && !await refresh(next.path)) return false;
  }
  return false;
}
