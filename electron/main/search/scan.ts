import { isAbsolute, relative, sep } from 'node:path';

export const INDEX_TUNING = {
  roots: 8,
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

export function isIgnoredName(name: string): boolean {
  return name.startsWith('.') || excludedNames.has(name.toLowerCase());
}

export function effectiveRoots(roots: readonly string[], excluded: readonly string[], mounts: readonly string[]) {
  const selected: string[] = [];
  for (const root of [...roots].sort((a, b) => a.length - b.length)) {
    if (isSystemPath(root) || excluded.some(path => isWithin(path, root))) continue;
    const covered = selected.some(parent => isWithin(parent, root)
      && !relative(parent, root).split(sep).some(isIgnoredName)
      && !mounts.some(mount => !isWithin(mount, parent) && isWithin(parent, mount) && isWithin(mount, root)));
    if (!covered) selected.push(root);
  }
  return selected;
}

export function createScanScope(roots: readonly string[], excluded: readonly string[], mounts: readonly string[]) {
  const boundaries = [...new Set([...roots, ...mounts])].sort((a, b) => b.length - a.length);
  const allowedRoots = new Set(roots);

  function owner(path: string) {
    if (isSystemPath(path) || excluded.some(parent => isWithin(parent, path))) return;
    const boundary = boundaries.find(parent => isWithin(parent, path));
    if (boundary !== undefined && allowedRoots.has(boundary)
      && !relative(boundary, path).split(sep).some(isIgnoredName)) return boundary;
  }

  return {
    owner,
    allows: (path: string) => owner(path) !== undefined,
    owns(parent: string, child: string) {
      const root = owner(parent);
      return root !== undefined && root === owner(child);
    },
  };
}

export interface ScanEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
}
