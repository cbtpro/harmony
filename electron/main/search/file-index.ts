import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { MAX_SEARCH_QUERY } from '../../../shared/search';
import type { IndexRules, IndexStatus, SearchResults } from '../../../shared/search';
import { IndexStorage, indexKey } from './index-storage';
import { updateDirectories } from './index-reconcile';
import { createScanScope, effectiveRoots, INDEX_TUNING, isWithin } from './scan';
import { scanWithWorkers } from './scan-workers';
import type { ScanEntry } from './scan';

const QUERY_BATCH_SIZE = 512;
export type ScanMode = 'fresh' | 'restore' | 'continue';

export class FileIndex {
  private rules: IndexRules = { roots: [], excluded: [] };
  private revision = 0;
  private fileChanges = 0;
  private observation = 0;
  private task?: Promise<void>;
  private storage?: IndexStorage;
  private resumable = false;
  private building = false;
  private failure?: string;
  private phase: IndexStatus['phase'] = 'idle';
  private skipped = 0;
  private foreground = 0;
  private wake?: () => void;
  private waiting?: Promise<void>;

  private readonly tuning: typeof INDEX_TUNING;
  private readonly storageFile?: string;

  constructor(tuning = INDEX_TUNING, storageFile?: string) {
    this.tuning = tuning;
    this.storageFile = storageFile;
  }

  status(): IndexStatus {
    return {
      roots: [...this.rules.roots],
      excluded: [...this.rules.excluded],
      revision: this.revision + this.fileChanges,
      phase: this.phase,
      count: this.storage?.count ?? 0,
      skipped: this.skipped,
      resumable: this.resumable,
      failure: this.failure,
    };
  }

  configure(rules: IndexRules, discardCheckpoint = false) {
    this.stop(false);
    this.rules = rules;
    this.reset();
    this.phase = this.task ? 'stopping' : 'idle';
    if (this.storageFile && (discardCheckpoint || !rules.roots.length)) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { rmSync(this.storageFile + suffix, { force: true }); }
        catch (error) { console.warn('无法移除旧的索引缓存', error); }
      }
    }
  }

  whenIdle(): Promise<void> {
    return this.task ?? Promise.resolve();
  }

  scanPlan(mounts: readonly string[]) {
    const excluded = this.storageFile ? [...this.rules.excluded, dirname(this.storageFile)] : this.rules.excluded;
    const roots = effectiveRoots(this.rules.roots, excluded, mounts);
    return { roots, excluded, scope: createScanScope(roots, excluded, mounts) };
  }

  rebuild(mounts: readonly string[] = [], visitDirectory?: (path: string) => void,
    threads = 1, mode: ScanMode = 'fresh'): IndexStatus {
    if (this.task) throw new Error('请先停止当前索引任务。');
    if (!this.rules.roots.length) throw new Error('请先添加白名单目录。');
    const { roots, excluded, scope } = this.scanPlan(mounts);
    const boundaries = mounts.filter(mount => roots.some(root => isWithin(root, mount)));
    const signature = JSON.stringify([1, [...roots].sort(), [...excluded].sort(), boundaries.sort()]);
    const previous = this.storage;
    const reuse = mode === 'continue' && previous && previous.checkpoint()?.signature === signature;
    if (reuse) this.storage = undefined;
    this.reset();
    try {
      const storage = reuse ? previous : new IndexStorage(this.storageFile);
      this.storage = storage;
      const saved = mode === 'fresh' ? undefined : storage.checkpoint();
      const continuing = saved?.signature === signature && saved.phase !== 'ready';
      if (!continuing) storage.begin(signature, roots);
      this.skipped = continuing ? saved.skipped : 0;
      this.resumable = continuing || roots.length > 0;
      if (mode === 'restore' && continuing && (saved.phase === 'paused' || saved.phase === 'stopped')) {
        this.phase = saved.phase;
        return this.status();
      }
      if (continuing) storage.setScanState('running');
      this.building = true;
      this.phase = 'running';
      this.task = this.scan(storage, scope, this.revision, threads, continuing, visitDirectory).finally(() => {
        this.building = false;
        this.task = undefined;
      });
    } catch (error) {
      this.fail(this.revision, error);
    }
    return this.status();
  }

  reconcile(paths: readonly string[], mounts: readonly string[], watchers: {
    visitDirectory(path: string): void;
    removeDirectory(path: string): void;
  }) {
    const storage = this.storage;
    if (this.task || !storage || this.phase !== 'ready' || !paths.length) return Promise.resolve();
    const revision = this.revision;
    this.phase = 'running';
    this.task = updateDirectories(storage, paths, this.scanPlan(mounts).scope, {
      ...watchers,
      checkpoint: async () => await this.checkpoint() && revision === this.revision,
      observation: () => ++this.observation,
      changed: () => { this.fileChanges++; },
    }, this.tuning).then(complete => {
      this.finish(revision, complete ? 'ready' : 'stopped');
    }, error => this.fail(revision, error)).finally(() => { this.task = undefined; });
    return this.task;
  }

  dispose() {
    this.stop(false);
    this.reset();
  }

  private reset() {
    this.storage?.close();
    this.storage = undefined;
    this.resumable = false;
    this.failure = undefined;
    this.skipped = 0;
    this.revision++;
  }

  pause(): IndexStatus {
    if (this.phase === 'running') {
      if (this.building) this.storage?.setScanState('paused');
      this.phase = 'paused';
    }
    return this.status();
  }

  resume(): IndexStatus {
    if (this.phase === 'paused' && this.task) {
      if (this.building) this.storage?.setScanState('running');
      this.phase = 'running';
      this.signal();
    }
    return this.status();
  }

  stop(save = true): IndexStatus {
    if (this.phase === 'running' || this.phase === 'paused') {
      if (save && this.resumable) this.storage?.setScanState('stopped');
      this.phase = this.task ? 'stopping' : 'stopped';
      this.signal();
    }
    return this.status();
  }

  async prioritize<T>(operation: () => Promise<T>): Promise<T> {
    this.foreground++;
    try {
      return await operation();
    } finally {
      if (--this.foreground === 0) this.signal();
    }
  }

  private async checkpoint(): Promise<boolean> {
    while (this.phase === 'paused' || (this.phase === 'running' && this.foreground > 0)) {
      this.waiting ??= new Promise<void>(resolve => { this.wake = resolve; });
      await this.waiting;
    }
    return this.phase === 'running';
  }

  private signal() {
    const wake = this.wake;
    this.waiting = undefined;
    this.wake = undefined;
    wake?.();
  }

  private async scan(storage: IndexStorage, scope: ReturnType<typeof createScanScope>, revision: number,
    threads: number, continuing: boolean, visitDirectory?: (path: string) => void) {
    try {
      await setImmediate();
      if (revision !== this.revision) return this.finish(revision, 'stopped');
      if (continuing && visitDirectory) {
        for (const path of storage.completedDirectories(256)) visitDirectory(path);
      }
      const complete = !storage.next(new Set()) || await scanWithWorkers(threads, 128, scope, {
        checkpoint: async () => await this.checkpoint() && revision === this.revision,
        visitDirectory,
        next: reserved => revision === this.revision ? storage.next(reserved) : undefined,
        write: (path, entries, done, skipped) => {
          if (revision !== this.revision) return;
          storage.scanBatch(path, entries, done, skipped);
          if (skipped) this.skipped++;
        },
      });
      if (complete && revision === this.revision && this.phase !== 'stopping') {
        storage.setScanState('ready');
        this.resumable = false;
      }
      this.finish(revision, complete ? 'ready' : 'stopped');
    } catch (error) { this.fail(revision, error); }
  }

  private fail(revision: number, error: unknown) {
    this.finish(revision, 'failed');
    if (revision !== this.revision || this.phase !== 'failed') return;
    this.signal();
    this.failure = (error as { errcode?: number }).errcode === 13
      ? '索引磁盘空间不足，请释放空间后继续。' : '无法继续建立索引，可重新建立。';
    console.warn('索引任务失败', error);
  }

  private finish(revision: number, phase: 'ready' | 'stopped' | 'failed') {
    if (revision === this.revision) this.phase = this.phase === 'stopping' ? 'stopped' : phase;
    else if (this.phase === 'stopping') this.phase = 'idle';
  }

  async *batches(term = ''): AsyncGenerator<readonly ScanEntry[]> {
    const storage = this.storage;
    if (!storage) return;
    const last = storage.lastId();
    for (let cursor = 0; cursor < last;) {
      if (cursor) await setImmediate();
      if (storage !== this.storage) throw new Error('索引已更新，请重新查询。');
      const rows = storage.read(cursor, last, QUERY_BATCH_SIZE, term);
      if (!rows.length) break;
      cursor = rows[rows.length - 1].id;
      const entries = rows.filter(row => row.matched).map(({ path, name, kind }) => ({ path, name, kind }));
      if (entries.length) yield entries;
    }
  }

  findIndexedPath(path: string) {
    return this.storage?.find(path);
  }

  replaceIndexedFile(previous: string, next: ScanEntry) {
    const storage = this.storage;
    if (!storage) return;
    try {
      if (storage.replace(previous, next, this.building)) this.fileChanges++;
    } catch (error) {
      // The file rename has already committed. A cache failure must not report it as undone.
      this.configure(this.rules);
      this.phase = 'failed';
      this.failure = '无法更新索引，可重新建立。';
      console.warn('无法更新索引中的文件名', error);
    }
  }

  async search(value: unknown): Promise<SearchResults> {
    if (typeof value !== 'string' || value.length > MAX_SEARCH_QUERY) {
      throw new Error(`请输入最多 ${MAX_SEARCH_QUERY} 个字符的文件名。`);
    }

    const query = indexKey(value.trim());
    const matches: SearchResults['matches'] = [];
    if (query) {
      for await (const entries of this.batches(query)) {
        for (const { name, path, kind } of entries) {
          if (matches.length === this.tuning.results) return { matches, truncated: true };
          matches.push({ name, path, kind, directory: dirname(path) });
        }
      }
    }
    return { matches, truncated: false };
  }
}
