import { realpath, stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename } from 'node:path';
import type { IndexRules, IndexSettings, IndexStatus } from '../../../shared/search';
import { absolutePath } from '../files';
import type { FileIndex, ScanMode } from './file-index';
import { IndexWatcher } from './index-watcher';
import { loadRules, RULE_LIMITS, saveRules } from './rules-store';
import { isSystemPath, isWithin } from './scan';
import { SystemIndex } from './system-index';
import { SYSTEM_MEDIA_LIMIT, SYSTEM_RESULT_LIMIT } from './system-providers';
import type { SystemQuery } from './system-providers';
import type { ScanEntry } from './scan';

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
  private preferSystem = true;
  private plan?: Awaited<ReturnType<SystemIndex['plan']>>;
  private planning?: Promise<Awaited<ReturnType<SystemIndex['plan']>> | undefined>;
  private planRevision = 0;
  private lastMounts?: readonly string[];
  private localSignature?: string;
  private systemOnly = false;
  private systemRevision = 0;
  private systemMaintenanceUntil = 0;

  constructor(
    index: FileIndex,
    settingsPath: string,
    home: string,
    timing = DEFAULT_TIMING,
    mounts: () => Promise<string[]> = async () => [],
    onComplete?: (completion: IndexCompletion) => void,
    system?: SystemIndex,
  ) {
    this.index = index;
    this.settingsPath = settingsPath;
    this.home = home;
    this.timing = timing;
    this.mounts = mounts;
    this.onComplete = onComplete;
    this.system = system;
  }

  private readonly index: FileIndex;
  private readonly settingsPath: string;
  private readonly home: string;
  private readonly mounts: () => Promise<string[]>;
  private readonly timing: typeof DEFAULT_TIMING;
  private readonly onComplete?: (completion: IndexCompletion) => void;
  private readonly system?: SystemIndex;

  async open() {
    this.visible = true;
    await this.status();
    this.schedule(this.timing.startup, true, 'restore');
  }

  close() {
    this.visible = false;
    this.cancelSchedule();
    this.resetPlan();
    this.index.stop(false);
  }

  async status(): Promise<IndexStatus> {
    this.loaded ??= loadRules(this.settingsPath, this.home).then(rules => {
      if (rules.threads) this.threads = Math.min(rules.threads, MAX_THREADS);
      this.preferSystem = rules.preferSystem ?? true;
      this.index.configure(rules);
    }).catch(() => {
      this.warning = '无法读取已保存的索引规则。请重新配置索引范围。';
    });
    await this.loaded;
    const status = this.index.status();
    return { ...status, revision: status.revision + this.systemRevision, phase: this.systemOnly ? 'ready' : status.phase,
      sources: this.plan?.sources, settingsWarning: this.warning };
  }

  async pause() {
    this.index.pause();
    return this.status();
  }

  async settings(): Promise<IndexSettings> {
    await this.status();
    return { threads: this.threads, maxThreads: MAX_THREADS, systemThreads: SYSTEM_THREADS,
      preferSystem: this.preferSystem, systemProviders: this.system?.names,
      spotlightMaintenance: !!this.system && process.platform === 'darwin' };
  }

  setThreads(value: unknown, preferSystem?: unknown) {
    const change = this.changes.then(async () => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_THREADS) {
        throw new Error(`索引线程数必须是 1 到 ${MAX_THREADS} 之间的整数。`);
      }
      if (preferSystem !== undefined && typeof preferSystem !== 'boolean') throw new Error('索引来源设置无效。');
      const { roots, excluded } = await this.status();
      if (this.warning) throw new Error('请先在全局搜索中恢复索引规则。');
      const prefer = typeof preferSystem === 'boolean' ? preferSystem : this.preferSystem;
      await saveRules(this.settingsPath, { roots, excluded, threads: value, preferSystem: prefer });
      this.threads = value;
      if (prefer !== this.preferSystem) {
        this.preferSystem = prefer;
        this.resetPlan();
        this.index.stop(false);
        this.schedule(this.timing.ruleChange, false, 'restore');
      }
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

      await saveRules(this.settingsPath, { ...rules, threads: this.threads, preferSystem: this.preferSystem });
      this.warning = undefined;
      this.resetPlan();
      this.index.configure(rules, true);
      this.schedule(this.timing.ruleChange, true);
      return this.status();
    });
    this.changes = change.then(() => {}, () => {});
    return change;
  }

  private resetPlan() {
    this.planRevision++;
    this.systemRevision++;
    this.plan = undefined;
    this.planning = undefined;
    this.systemOnly = false;
    this.closeWatcher();
  }

  private async resolvePlan(mounts: readonly string[]) {
    if (!this.system) return;
    const revision = this.planRevision;
    this.planning ??= this.system.plan(this.index.scanPlan(mounts).roots, this.preferSystem).then(plan => {
      if (revision !== this.planRevision) return;
      if (JSON.stringify(this.plan?.sources) !== JSON.stringify(plan.sources)) this.systemRevision++;
      this.plan = plan;
      this.planning = undefined;
      return plan;
    });
    return this.planning;
  }

  refreshSystem() {
    this.systemMaintenanceUntil = Date.now() + 5 * 60_000;
    this.system?.invalidate();
    if (this.preferSystem) this.schedule(5 * 60_000, false, 'restore');
  }

  async *searchEntries(query: SystemQuery, media = false, directory?: string): AsyncGenerator<readonly ScanEntry[]> {
    await this.status();
    if (!this.system || !this.preferSystem) {
      yield* this.index.batches(query.term, directory);
      return;
    }
    const revision = this.planRevision;
    const mounts = this.lastMounts ?? await this.mounts();
    const plan = this.plan ?? await this.resolvePlan(mounts);
    if (revision !== this.planRevision) return;
    const { scope } = this.index.scanPlan(mounts);
    if (plan?.providers.size) {
      yield* this.system.batches(plan.providers, scope, query, media ? SYSTEM_MEDIA_LIMIT : SYSTEM_RESULT_LIMIT,
        () => this.scheduleFallback(), () => revision === this.planRevision, directory);
    }
    if (revision !== this.planRevision) return;
    for await (const entries of this.index.batches(query.term, directory)) {
      yield entries.filter(entry => {
        const root = scope.owner(entry.path);
        return root !== undefined && !plan?.providers.has(root);
      });
    }
  }

  private fallbackPending = false;

  private scheduleFallback() {
    if (this.fallbackPending || !this.visible || Date.now() < this.systemMaintenanceUntil) return;
    this.fallbackPending = true;
    void this.index.whenIdle().then(() => {
      this.fallbackPending = false;
      if (this.visible && this.preferSystem) this.schedule(this.timing.ruleChange, false, 'restore');
    });
  }

  async findEntry(path: string) {
    const local = this.index.findIndexedPath(path);
    if (!this.system || !this.preferSystem) return local;
    const revision = this.planRevision;
    const mounts = this.lastMounts ?? await this.mounts();
    const { scope } = this.index.scanPlan(mounts);
    const plan = this.plan ?? await this.resolvePlan(mounts);
    if (revision !== this.planRevision) return;
    const owner = scope.owner(path);
    const provider = owner === undefined ? undefined : plan?.providers.get(owner);
    if (owner === undefined) return;
    if (!provider) return local;
    for await (const entries of this.system.batches(new Map([[owner, provider]]), scope, { term: basename(path) },
      SYSTEM_RESULT_LIMIT, () => this.scheduleFallback(), () => revision === this.planRevision)) {
      const match = entries.find(entry => entry.path === path);
      if (match) return match;
    }
  }

  async resume() {
    this.index.resume();
    const status = await this.status();
    if (!status.resumable || !['paused', 'stopped', 'failed'].includes(status.phase)) return status;
    const mounts = await this.mounts();
    const resumed = await this.startScan(mounts, 'continue');
    this.finishScan(true);
    return resumed;
  }

  async rebuild() {
    await this.status();
    const mounts = await this.mounts();
    this.systemMaintenanceUntil = 0;
    this.system?.invalidate();
    const status = await this.startScan(mounts);
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

  private async startScan(mounts: readonly string[], mode: ScanMode = 'fresh') {
    this.lastMounts = mounts;
    const generation = this.generation;
    const plan = await this.resolvePlan(mounts);
    if (generation !== this.generation) return this.status();
    const excluded = [...(plan?.providers.keys() ?? [])];
    const localSignature = JSON.stringify(excluded);
    if (plan?.sources.length && !plan.localRoots.length) {
      if (!this.systemOnly) {
        this.closeWatcher();
        this.index.dispose();
      }
      this.systemOnly = true;
      this.localSignature = localSignature;
      return this.status();
    }
    this.systemOnly = false;
    if (mode === 'restore' && localSignature === this.localSignature && this.index.status().phase === 'ready') {
      return this.status();
    }
    let watcher: IndexWatcher | undefined;
    const status = this.index.rebuild(mounts, path => watcher?.visitDirectory(path), this.threads, mode, excluded);
    this.localSignature = localSignature;
    this.closeWatcher();
    if (this.visible && status.phase === 'running') {
      const { roots, scope } = this.index.scanPlan(mounts, excluded);
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
          }, excluded);
        },
      });
      this.watcher = watcher;
    }
    return { ...status, revision: status.revision + this.systemRevision, sources: plan?.sources };
  }

  private schedule(delay: number, notifyOnCompletion: boolean, mode: ScanMode = 'fresh') {
    this.cancelSchedule();
    if (!this.visible || !this.index.status().roots.length) return;
    const generation = this.generation;
    this.timer = setTimeout(async () => {
      try {
        const mounts = await this.mounts();
        await this.index.whenIdle();
        if (generation !== this.generation || !this.visible) return;
        await this.startScan(mounts, mode);
        if (generation !== this.generation || !this.visible) return;
        this.finishScan(notifyOnCompletion);
      } catch (error) {
        console.warn('无法刷新索引来源', error);
        if (generation === this.generation) this.schedule(this.timing.refresh, false);
      }
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
      if (this.systemOnly || !notifyOnCompletion || !this.onComplete) return;
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
