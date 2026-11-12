import { dirname } from 'node:path';
import { MAX_SEARCH_QUERY } from '../../../shared/search';
import type { IndexRules, IndexStatus, SearchResults } from '../../../shared/search';
import { INDEX_LIMITS, scanDirectories } from './scan';
import type { ScanEntry } from './scan';

function fold(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

export class FileIndex {
  private rules: IndexRules = { roots: [], excluded: [] };
  private revision = 0;
  private fileChanges = 0;
  private readonly renamedDuringScan = new Set<string>();
  private task?: Promise<void>;
  private entries: Array<ScanEntry & { key: string }> = [];
  private phase: IndexStatus['phase'] = 'idle';
  private skipped = 0;
  private foreground = 0;
  private wake?: () => void;

  private readonly limits: typeof INDEX_LIMITS;

  constructor(limits = INDEX_LIMITS) {
    this.limits = limits;
  }

  status(): IndexStatus {
    return {
      roots: [...this.rules.roots],
      excluded: [...this.rules.excluded],
      revision: this.revision + this.fileChanges,
      phase: this.phase,
      count: this.entries.length,
      skipped: this.skipped,
    };
  }

  configure(rules: IndexRules) {
    this.stop();
    this.rules = rules;
    this.entries = [];
    this.renamedDuringScan.clear();
    this.skipped = 0;
    this.revision++;
    if (!this.task) this.phase = 'idle';
  }

  whenIdle(): Promise<void> {
    return this.task ?? Promise.resolve();
  }

  rebuild(mounts: readonly string[] = []): IndexStatus {
    if (this.task) throw new Error('请先停止当前索引任务。');
    if (!this.rules.roots.length) throw new Error('请先添加白名单目录。');
    this.entries = [];
    this.renamedDuringScan.clear();
    this.skipped = 0;
    this.revision++;
    this.phase = 'running';
    this.task = this.scan(this.rules, this.revision, mounts).finally(() => { this.task = undefined; });
    return this.status();
  }

  pause(): IndexStatus {
    if (this.phase === 'running') this.phase = 'paused';
    return this.status();
  }

  resume(): IndexStatus {
    if (this.phase === 'paused') {
      this.phase = 'running';
      this.wake?.();
    }
    return this.status();
  }

  stop(): IndexStatus {
    if (this.phase === 'running' || this.phase === 'paused') {
      this.phase = 'stopping';
      this.wake?.();
    }
    return this.status();
  }

  async prioritize<T>(operation: () => Promise<T>): Promise<T> {
    this.foreground++;
    try {
      return await operation();
    } finally {
      if (--this.foreground === 0) this.wake?.();
    }
  }

  private async checkpoint(): Promise<boolean> {
    while (this.phase === 'paused' || (this.phase === 'running' && this.foreground > 0)) {
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = undefined;
    }
    return this.phase === 'running';
  }

  private async scan(rules: IndexRules, revision: number, mounts: readonly string[]) {
    let bytes = 0;
    try {
      const result = await scanDirectories(rules.roots, rules.excluded, mounts, {
        checkpoint: () => this.checkpoint(),
        skip: () => { if (revision === this.revision) this.skipped++; },
        add: entry => {
          if (revision !== this.revision) return false;
          if (this.renamedDuringScan.has(entry.path)) return true;
          const key = fold(entry.name);
          // Conservative per-entry accounting for UTF-16 strings and object overhead.
          const size = 256 + 2 * (entry.path.length + entry.name.length + key.length);
          if (this.entries.length >= this.limits.entries
            || bytes + size > this.limits.estimatedBytes) return false;
          bytes += size;
          this.entries.push({ ...entry, key });
          return true;
        },
      }, this.limits);
      this.phase = revision !== this.revision ? 'idle'
        : this.phase === 'stopping' ? 'stopped' : result;
    } catch {
      this.phase = revision !== this.revision ? 'idle'
        : this.phase === 'stopping' ? 'stopped' : 'failed';
    }
  }

  indexedEntries(): readonly ScanEntry[] {
    return this.entries;
  }

  replaceIndexedFile(previous: string, next: ScanEntry) {
    const current = this.entries.find(entry => entry.kind === 'file' && entry.path === previous);
    if (this.task) {
      this.renamedDuringScan.add(previous);
      this.renamedDuringScan.delete(next.path);
      if (current) this.renamedDuringScan.add(next.path);
    }
    if (!current) return;
    this.entries = this.entries.filter(entry => entry.path !== next.path);
    Object.assign(current, next, { key: fold(next.name) });
    this.fileChanges++;
  }

  search(value: unknown): SearchResults {
    if (typeof value !== 'string' || value.length > MAX_SEARCH_QUERY) {
      throw new Error(`请输入最多 ${MAX_SEARCH_QUERY} 个字符的文件名。`);
    }

    const query = fold(value.trim());
    const matches: SearchResults['matches'] = [];
    if (query) {
      for (const { key, name, path, kind } of this.entries) {
        if (!key.includes(query)) continue;
        if (matches.length === this.limits.results) return { matches, truncated: true };
        matches.push({ name, path, kind, directory: dirname(path) });
      }
    }
    return { matches, truncated: false };
  }
}
