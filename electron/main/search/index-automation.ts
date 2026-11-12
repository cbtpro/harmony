import { realpath, stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import type { IndexRules, IndexSettings, IndexStatus } from '../../../shared/search';
import { absolutePath } from '../files';
import type { FileIndex, ScanMode } from './file-index';
import { IndexWatcher } from './index-watcher';
import { loadRules, RULE_LIMITS, saveRules } from './rules-store';
import { isSystemPath, isWithin } from './scan';

const DEFAULT_TIMING = { startup: 1500, ruleChange: 250, refresh: 30 * 60 * 1000 };
const SYSTEM_THREADS = availableParallelism();
const MAX_THREADS = Math.max(1, SYSTEM_THREADS - 1);

export interface IndexCompletion {
  count: number;
  skipped: number;
}

export class IndexAutomation {
  private visible = false;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private warning?: string;
  private loaded?: Promise<void>;
  private changes = Promise.resolve();
  private watcher?: IndexWatcher;
  private threads = Math.min(4, MAX_THREADS, Math.max(1, Math.floor(SYSTEM_THREADS / 2)));

  constructor(
    index: FileIndex,
    settingsPath: string,
    home: string,
    timing = DEFAULT_TIMING,
    mounts: () => Promise<string[]> = async () => [],
    onComplete?: (completion: IndexCompletion) => void,
  ) {
    this.index = index;
    this.settingsPath = settingsPath;
    this.home = home;
    this.timing = timing;
    this.mounts = mounts;
    this.onComplete = onComplete;
  }

  private readonly index: FileIndex;
  private readonly settingsPath: string;
  private readonly home: string;
  private readonly mounts: () => Promise<string[]>;
  private readonly timing: typeof DEFAULT_TIMING;
  private readonly onComplete?: (completion: IndexCompletion) => void;

  async open() {
    this.visible = true;
    await this.status();
    this.schedule(this.timing.startup, true, 'restore');
  }

  close() {
    this.visible = false;
    this.cancelSchedule();
    this.closeWatcher();
    this.index.stop(false);
  }

  async status(): Promise<IndexStatus> {
    this.loaded ??= loadRules(this.settingsPath, this.home).then(rules => {
      if (rules.threads) this.threads = Math.min(rules.threads, MAX_THREADS);
      this.index.configure(rules);
    }).catch(() => {
      this.warning = '无法读取已保存的索引规则。请重新配置索引范围。';
    });
    await this.loaded;
    return { ...this.index.status(), settingsWarning: this.warning };
  }

  async settings(): Promise<IndexSettings> {
    await this.status();
    return { threads: this.threads, maxThreads: MAX_THREADS, systemThreads: SYSTEM_THREADS };
  }

  setThreads(value: unknown) {
    const change = this.changes.then(async () => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_THREADS) {
        throw new Error(`索引线程数必须是 1 到 ${MAX_THREADS} 之间的整数。`);
      }
      const { roots, excluded } = await this.status();
      if (this.warning) throw new Error('请先在全局搜索中恢复索引规则。');
      await saveRules(this.settingsPath, { roots, excluded, threads: value });
      this.threads = value;
      return this.settings();
    });
    this.changes = change.then(() => {}, () => {});
    return change;
  }

  changeRule(list: keyof IndexRules, action: 'add' | 'remove', value: unknown) {
    const change = this.changes.then(async () => {
      const { roots, excluded } = await this.status();
      const rules = { roots, excluded };
      if (action === 'add') {
        const path = await realpath(absolutePath(value));
        if (path.length > 4096 || !(await stat(path)).isDirectory()
          || (list === 'roots' && isSystemPath(path))) {
          throw new Error('请选择有效的目录。');
        }
        if (rules[list].some(existing => isWithin(existing, path) && isWithin(path, existing))) {
          return this.status();
        }
        if (rules[list].length >= RULE_LIMITS[list]) throw new Error('目录数量已达上限。');
        rules[list].push(path);
      } else {
        if (typeof value !== 'string' || !rules[list].includes(value)) return this.status();
        rules[list] = rules[list].filter(path => path !== value);
      }

      await saveRules(this.settingsPath, { ...rules, threads: this.threads });
      this.warning = undefined;
      this.closeWatcher();
      this.index.configure(rules, true);
      this.schedule(this.timing.ruleChange, true);
      return this.status();
    });
    this.changes = change.then(() => {}, () => {});
    return change;
  }

  async resume() {
    const status = this.index.resume();
    if (!status.resumable || !['paused', 'stopped', 'failed'].includes(status.phase)) return status;
    const mounts = await this.mounts();
    const resumed = this.startScan(mounts, 'continue');
    this.finishScan(true);
    return resumed;
  }

  async rebuild() {
    await this.status();
    const mounts = await this.mounts();
    const status = this.startScan(mounts);
    this.finishScan(true);
    return status;
  }

  async stop() {
    this.closeWatcher();
    const status = this.index.stop();
    if (status.resumable) this.cancelSchedule();
    else this.finishScan(false);
    return this.status();
  }

  private cancelSchedule() {
    this.generation++;
    clearTimeout(this.timer);
  }

  private closeWatcher() {
    this.watcher?.close();
    this.watcher = undefined;
  }

  private startScan(mounts: readonly string[], mode: ScanMode = 'fresh') {
    let watcher: IndexWatcher | undefined;
    const status = this.index.rebuild(mounts, path => watcher?.visitDirectory(path), this.threads, mode);
    this.closeWatcher();
    if (this.visible && status.phase === 'running') {
      const { roots, scope } = this.index.scanPlan(mounts);
      watcher = new IndexWatcher(roots, {
        allows: scope.allows,
        kind: path => this.index.findIndexedPath(path)?.kind,
        update: async paths => {
          await this.index.whenIdle();
          if (!watcher || this.watcher !== watcher) return;
          const active = watcher;
          await this.index.reconcile(paths, mounts, {
            visitDirectory: path => active.visitDirectory(path),
            removeDirectory: path => active.removeDirectory(path),
          });
        },
      });
      this.watcher = watcher;
    }
    return status;
  }

  private schedule(delay: number, notifyOnCompletion: boolean, mode: ScanMode = 'fresh') {
    this.cancelSchedule();
    if (!this.visible || !this.index.status().roots.length) return;
    const generation = this.generation;
    this.timer = setTimeout(async () => {
      const mounts = await this.mounts();
      await this.index.whenIdle();
      if (generation !== this.generation || !this.visible) return;
      this.startScan(mounts, mode);
      this.finishScan(notifyOnCompletion);
    }, delay);
    this.timer.unref();
  }

  private finishScan(notifyOnCompletion: boolean) {
    this.cancelSchedule();
    const generation = this.generation;
    void this.index.whenIdle().then(() => {
      if (generation !== this.generation || !this.visible) return;
      if (this.index.status().resumable) return;
      this.schedule(this.timing.refresh, false);
      if (!notifyOnCompletion || !this.onComplete) return;
      const { phase, count, skipped } = this.index.status();
      if (phase !== 'ready') return;
      try {
        this.onComplete({ count, skipped });
      } catch (error) {
        console.warn('索引完成回调执行失败', error);
      }
    });
  }
}
