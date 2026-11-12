import { realpath, stat } from 'node:fs/promises';
import type { IndexRules, IndexStatus } from '../../../shared/search';
import { absolutePath } from '../files';
import type { FileIndex } from './file-index';
import { loadRules, RULE_LIMITS, saveRules } from './rules-store';
import { isSystemPath, isWithin } from './scan';

const DEFAULT_TIMING = { startup: 1500, ruleChange: 250, refresh: 30 * 60 * 1000 };

export class IndexAutomation {
  private visible = false;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private warning?: string;
  private loaded?: Promise<void>;
  private changes = Promise.resolve();

  constructor(
    index: FileIndex,
    settingsPath: string,
    home: string,
    timing = DEFAULT_TIMING,
    mounts: () => Promise<string[]> = async () => [],
  ) {
    this.index = index;
    this.settingsPath = settingsPath;
    this.home = home;
    this.timing = timing;
    this.mounts = mounts;
  }

  private readonly index: FileIndex;
  private readonly settingsPath: string;
  private readonly home: string;
  private readonly mounts: () => Promise<string[]>;
  private readonly timing: typeof DEFAULT_TIMING;

  async open() {
    this.visible = true;
    await this.status();
    this.schedule(this.timing.startup);
  }

  close() {
    this.visible = false;
    this.cancelSchedule();
    this.index.stop();
  }

  async status(): Promise<IndexStatus> {
    this.loaded ??= loadRules(this.settingsPath, this.home).then(rules => {
      this.index.configure(rules);
    }).catch(() => {
      this.warning = '无法读取已保存的索引规则。请重新配置索引范围。';
    });
    await this.loaded;
    return { ...this.index.status(), settingsWarning: this.warning };
  }

  changeRule(list: keyof IndexRules, action: 'add' | 'remove', value: unknown, mountRoots: readonly string[] = []) {
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
        if (list === 'roots') {
          const withinSameMount = (parent: string, child: string) => isWithin(parent, child)
            && !mountRoots.some(mount => mount !== parent && isWithin(parent, mount) && isWithin(mount, child));
          if (roots.some(root => withinSameMount(root, path))) {
            throw new Error('该目录与现有白名单重叠。请先移除较宽的范围。');
          }
          if (mountRoots.includes(path)) rules.roots = roots.filter(root => !withinSameMount(path, root));
          else if (roots.some(root => withinSameMount(path, root))) {
            throw new Error('该目录与现有白名单重叠。请先移除较宽的范围。');
          }
        }
        if (rules[list].length >= RULE_LIMITS[list]) throw new Error('目录数量已达上限。');
        rules[list].push(path);
      } else {
        if (typeof value !== 'string' || !rules[list].includes(value)) return this.status();
        rules[list] = rules[list].filter(path => path !== value);
      }

      await saveRules(this.settingsPath, rules);
      this.warning = undefined;
      this.index.configure(rules);
      this.schedule(this.timing.ruleChange);
      return this.status();
    });
    this.changes = change.then(() => {}, () => {});
    return change;
  }

  async rebuild() {
    await this.status();
    const mounts = await this.mounts();
    const status = this.index.rebuild(mounts);
    this.scheduleRefreshAfterScan();
    return status;
  }

  async stop() {
    this.index.stop();
    this.scheduleRefreshAfterScan();
    return this.status();
  }

  private cancelSchedule() {
    this.generation++;
    clearTimeout(this.timer);
  }

  private schedule(delay: number) {
    this.cancelSchedule();
    if (!this.visible || !this.index.status().roots.length) return;
    const generation = this.generation;
    this.timer = setTimeout(async () => {
      const mounts = await this.mounts();
      await this.index.whenIdle();
      if (generation !== this.generation || !this.visible) return;
      this.index.rebuild(mounts);
      this.scheduleRefreshAfterScan();
    }, delay);
    this.timer.unref();
  }

  private scheduleRefreshAfterScan() {
    this.cancelSchedule();
    const generation = this.generation;
    void this.index.whenIdle().then(() => {
      if (generation === this.generation) this.schedule(this.timing.refresh);
    });
  }
}
