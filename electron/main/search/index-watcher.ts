import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isWithin } from './scan';
import type { ScanEntry } from './scan';

const MAX_WATCHES = 256;
const MAX_PENDING = 128;
const DEBOUNCE_MS = 250;
const nativeRecursive = process.platform === 'darwin' || process.platform === 'win32';

interface WatchOptions {
  allows(path: string): boolean;
  kind(path: string): ScanEntry['kind'] | undefined;
  update(paths: readonly string[]): Promise<void>;
}

export class IndexWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly dirty = new Set<string>();
  private readonly roots: ReadonlySet<string>;
  private readonly options: WatchOptions;
  private timer?: ReturnType<typeof setTimeout>;
  private updating = false;
  private closed = false;

  constructor(roots: readonly string[], options: WatchOptions) {
    this.roots = new Set(roots);
    this.options = options;
    for (const root of roots) this.visitDirectory(root);
  }

  visitDirectory(path: string) {
    if (this.closed || this.watchers.has(path) || this.watchers.size >= MAX_WATCHES
      || (nativeRecursive && !this.roots.has(path)) || !this.options.allows(path)) return;
    try {
      const watcher = watch(path, { recursive: nativeRecursive, persistent: false }, (event, name) => {
        if (this.closed || this.watchers.get(path) !== watcher) return;
        if (!name) {
          this.enqueue(path);
          return;
        }
        const candidate = resolve(path, name);
        if (!isWithin(path, candidate) || !this.options.allows(candidate)) return;
        const kind = this.options.kind(candidate);
        if (event === 'change' && kind === 'file') return;
        if (candidate === path || kind === 'directory') this.enqueue(candidate);
        if (candidate !== path) this.enqueue(dirname(candidate));
      });
      this.watchers.set(path, watcher);
      watcher.on('error', () => {
        if (this.watchers.get(path) !== watcher) return;
        this.watchers.delete(path);
        watcher.close();
        this.enqueue(path);
      });
    } catch { /* The scheduled scan still covers paths where watching is unavailable. */ }
  }

  removeDirectory(path: string) {
    for (const [directory, watcher] of this.watchers) {
      if (!isWithin(path, directory)) continue;
      this.watchers.delete(directory);
      watcher.close();
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.dirty.clear();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private enqueue(path: string) {
    if (this.closed || this.dirty.size >= MAX_PENDING || !this.options.allows(path)) return;
    this.dirty.add(path);
    this.schedule();
  }

  private schedule() {
    if (this.closed || this.updating || this.timer || !this.dirty.size) return;
    this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
    this.timer.unref();
  }

  private async flush() {
    this.timer = undefined;
    this.updating = true;
    const paths = [...this.dirty];
    this.dirty.clear();
    try { await this.options.update(paths); }
    catch (error) { console.warn('文件变更同步失败', error); }
    finally {
      this.updating = false;
      this.schedule();
    }
  }
}
