import { opendir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';

export const INDEX_LIMITS = {
  roots: 8,
  entries: 25_000,
  estimatedBytes: 12 * 1024 * 1024,
  steps: 100_000,
  batchSize: 32,
  batchDelayMs: 50,
  results: 100,
};

const excludedNames = new Set(['node_modules', '$recycle.bin', 'system volume information']);
const linuxSystemPaths = new Set(['/dev', '/proc', '/sys', '/run']);
const macSystemPaths = new Set(['/dev', '/System/Volumes']);

export function isSystemPath(path: string): boolean {
  if (process.platform === 'linux' && path.startsWith('/run/media/')) return false;
  const excluded = process.platform === 'linux' ? linuxSystemPaths
    : process.platform === 'darwin' ? macSystemPaths : [];
  for (const directory of excluded) {
    if (path === directory || path.startsWith(directory + '/')) return true;
  }
  return false;
}

export function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep);
}

export interface ScanEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
}

interface ScanCallbacks {
  checkpoint(): Promise<boolean>;
  add(entry: ScanEntry): boolean;
  skip(): void;
}

export async function scanDirectories(
  roots: readonly string[],
  excluded: readonly string[],
  mounts: readonly string[],
  callbacks: ScanCallbacks,
  limits = INDEX_LIMITS,
): Promise<'ready' | 'limited' | 'stopped'> {
  const isExcluded = (path: string) => excluded.some(parent => isWithin(parent, path));
  const pending = roots.filter(path => !isExcluded(path));
  // Nested roots and mounts are traversed only through their explicit whitelist entry.
  const boundaries = new Set([...roots, ...mounts]);
  let steps = 0;

  async function beforeRead() {
    if (steps >= limits.steps) return 'limited';
    if (steps && steps % limits.batchSize === 0) await setTimeout(limits.batchDelayMs);
    if (!await callbacks.checkpoint()) return 'stopped';
    steps++;
    return 'continue';
  }

  // Each queued directory already consumes an entry in the bounded index.
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const path = pending[cursor];
    const open = await beforeRead();
    if (open !== 'continue') return open;
    const directory = await opendir(path, { bufferSize: limits.batchSize }).catch(() => null);
    if (!directory) {
      callbacks.skip();
      continue;
    }

    try {
      while (true) {
        const read = await beforeRead();
        if (read !== 'continue') return read;
        const entry = await directory.read();
        if (!entry) break;
        if (entry.name.startsWith('.') || excludedNames.has(entry.name.toLowerCase())) continue;
        const fullPath = join(path, entry.name);
        if (boundaries.has(fullPath) || isSystemPath(fullPath) || isExcluded(fullPath)) continue;
        const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : null;
        if (!kind) continue;
        if (!callbacks.add({ name: entry.name, path: fullPath, kind })) return 'limited';
        if (kind === 'directory') pending.push(fullPath);
      }
    } catch {
      callbacks.skip();
    } finally {
      await directory.close();
    }
  }
  return 'ready';
}
