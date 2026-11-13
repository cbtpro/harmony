import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, realpath, rename, stat, unlink } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { BatchOutcome, BatchPlan, BatchRow, RenameOptions } from '../../shared/files';
import { absolutePath, entryPath, validEntryName } from './files';

const MAX_ITEMS = 100;
const MAX_PLANS = 16;
const PLAN_LIFETIME = 5 * 60_000;

interface Work {
  row: BatchRow;
  sourceState?: BigIntStats;
  targetState?: BigIntStats;
  parentPath?: string;
  parentState?: BigIntStats;
  move?: boolean;
}

async function snapshot(path: string) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function sameIdentity(a: BigIntStats, b: BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino;
}

function unchanged(a: BigIntStats | undefined, b: BigIntStats | undefined) {
  return !a || !b ? a === b : sameIdentity(a, b) && a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs;
}

function pathKey(path: string) {
  return process.platform === 'linux' ? path : path.normalize('NFC').toLowerCase();
}

function splitName(name: string) {
  const extension = extname(name);
  return [name.slice(0, name.length - extension.length), extension] as const;
}

function validateSources(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ITEMS) {
    throw new Error(`请选择 1 到 ${MAX_ITEMS} 个文件。`);
  }
  const unique = new Map<string, string>();
  for (const item of value) {
    const path = entryPath(item);
    unique.set(pathKey(path), path);
  }
  return [...unique.values()];
}

async function canonicalSource(path: string) {
  return join(await realpath(dirname(path)), basename(path));
}

async function exclusiveCopy(source: string, target: string) {
  const temporary = join(dirname(target), `.harmony-transfer-${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    // Publish the finished copy without replacing an entry created after the preview.
    try { await link(temporary, target); }
    catch (error) {
      if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await copyFile(temporary, target, constants.COPYFILE_EXCL);
    }
  } finally { await unlink(temporary).catch(() => {}); }
}

async function execute(work: Work): Promise<BatchOutcome> {
  const { source, target, action, reason } = work.row;
  if (!target || action === 'blocked' || action === 'skip') {
    return { source, target, status: 'skipped', message: reason };
  }
  try {
    const canonicalParent = await realpath(dirname(target));
    const currentParent = await stat(canonicalParent, { bigint: true });
    if (canonicalParent !== work.parentPath || !work.parentState || !sameIdentity(currentParent, work.parentState)) {
      throw new Error('目标目录已变更，请重新预览。');
    }
    const currentSource = await snapshot(source);
    if (await canonicalSource(source) !== source || !currentSource?.isFile() || !unchanged(work.sourceState, currentSource)
      || !unchanged(work.targetState, await snapshot(target))) {
      throw new Error('源文件或目标已变更，请重新预览。');
    }
    if (action === 'replace') {
      const temporary = join(canonicalParent, `.harmony-transfer-${randomUUID()}.tmp`);
      try {
        await copyFile(source, temporary, constants.COPYFILE_EXCL);
        if (!unchanged(work.targetState, await snapshot(target)) || !unchanged(work.sourceState, await snapshot(source))) {
          throw new Error('复制期间文件已变更，请重新预览。');
        }
        await rename(temporary, target);
      } finally { await unlink(temporary).catch(() => {}); }
    } else if (work.move) {
      try {
        await link(source, target);
        const [linked, original] = await Promise.all([snapshot(target), snapshot(source)]);
        if (!linked || !original || !sameIdentity(currentSource, linked) || !sameIdentity(currentSource, original)) {
          throw new Error('移动期间源文件已变更，请核对目标后重新预览。');
        }
        try { await unlink(source); }
        catch {
          return { source, target, status: 'failed', message: '目标已建立，源文件未删除。' };
        }
        return { source, target, status: 'done' };
      } catch (error) {
        if (!['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      await exclusiveCopy(source, target);
    } else {
      await exclusiveCopy(source, target);
    }
    if (work.move) {
      if (!unchanged(work.sourceState, await snapshot(source))) {
        throw new Error('目标已复制，源文件在操作期间变更，已保留。');
      }
      try { await unlink(source); }
      catch { throw new Error('目标已复制，源文件未删除。'); }
    }
    return { source, target, status: 'done' };
  } catch (error) {
    return { source, target, status: 'failed', message: error instanceof Error ? error.message : '文件操作失败。' };
  }
}

export function createBatchFiles(onMove: (source: string, target: string) => void | Promise<void>) {
  const plans = new Map<string, { work: Work[]; expires: number }>();
  let running = false;

  function save(work: Work[], allowPartial = true): BatchPlan {
    const rows = work.map(item => item.row);
    if (!rows.some(row => row.action === 'ready' || row.action === 'replace')
      || (!allowPartial && rows.some(row => row.action === 'blocked'))) return { rows };
    for (const [key, plan] of plans) if (plan.expires <= Date.now()) plans.delete(key);
    if (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value!);
    const ticket = randomUUID();
    plans.set(ticket, { work, expires: Date.now() + PLAN_LIFETIME });
    return { rows, ticket };
  }

  return {
    async transfer(value: unknown, destination: unknown, operation: unknown, policy: unknown) {
      if (operation !== 'copy' && operation !== 'move') throw new Error('请选择复制或移动。');
      if (policy !== 'skip' && policy !== 'keep' && policy !== 'replace') throw new Error('请选择同名处理方式。');
      const sources = validateSources(value);
      const parentPath = await realpath(absolutePath(destination));
      const parentState = await stat(parentPath, { bigint: true });
      if (!parentState.isDirectory()) throw new Error('请选择目标目录。');
      const selectedTargets = new Set((await Promise.all(sources.map(path => canonicalSource(path).catch(() => path)))).map(pathKey));
      const reserved = new Set<string>();
      const work: Work[] = [];
      for (const path of sources) {
        try {
          const source = await canonicalSource(path);
          const sourceState = await snapshot(source);
          if (!sourceState?.isFile()) {
            work.push({ row: { source: path, action: 'blocked', reason: '只能归档普通文件。' } });
            continue;
          }
          let target = join(parentPath, basename(source));
          let targetState = await snapshot(target);
          const same = pathKey(target) === pathKey(source) || !!targetState && sameIdentity(targetState, sourceState);
          const pending = reserved.has(pathKey(target));
          if (targetState || pending || same) {
            if (policy === 'skip' || (policy === 'replace' && (same || pending || !targetState?.isFile() || selectedTargets.has(pathKey(target))))) {
              work.push({ row: { source, target, action: 'skip', reason: same ? '源文件与目标相同。'
                : pending ? '本批已有同名目标。' : '目标已有同名项目。' } });
              continue;
            }
            if (policy === 'keep') {
              const [stem, extension] = splitName(basename(source));
              let suffix = 1;
              do {
                target = join(parentPath, `${stem} (${++suffix})${extension}`);
                targetState = await snapshot(target);
              } while ((targetState || reserved.has(pathKey(target))) && suffix < 10_000);
              if (targetState || reserved.has(pathKey(target))) throw new Error('没有可用的同名副本名称。');
            }
          }
          reserved.add(pathKey(target));
          work.push({ row: { source, target, action: targetState ? 'replace' : 'ready' },
            sourceState, targetState, parentPath, parentState, move: operation === 'move' });
        } catch (error) {
          work.push({ row: { source: path, action: 'blocked', reason: error instanceof Error ? error.message : '无法检查文件。' } });
        }
      }
      return save(work);
    },

    async rename(value: unknown, input: unknown) {
      const sources = validateSources(value);
      const options = input as Partial<RenameOptions> | undefined;
      if (!options || typeof options.find !== 'string' || typeof options.replace !== 'string'
        || options.find.length > 255 || options.replace.length > 255 || typeof options.numbering !== 'boolean'
        || typeof options.date !== 'boolean' || typeof options.start !== 'number'
        || !Number.isSafeInteger(options.start) || options.start < 0 || options.start > 999999) {
        throw new Error('重命名规则无效。');
      }
      const work: Work[] = [];
      const targets = new Map<string, BatchRow>();
      const date = new Date().toLocaleDateString('sv-SE');
      for (const [number, path] of sources.entries()) {
        try {
          const source = await canonicalSource(path);
          const sourceState = await snapshot(source);
          const parentPath = dirname(source);
          const parentState = await stat(parentPath, { bigint: true });
          const [stem, extension] = splitName(basename(source));
          const replaced = options.find ? stem.split(options.find).join(options.replace) : stem;
          const name = [replaced, options.date ? date : '', options.numbering ? String(options.start + number).padStart(3, '0') : '']
            .filter(Boolean).join('-') + extension;
          const target = join(parentPath, name);
          const row: BatchRow = { source, target, action: 'ready' };
          if (!sourceState?.isFile() || !validEntryName(name)) {
            row.action = 'blocked';
            row.reason = '文件不可用或新名称无效。';
          } else if (target === source) {
            row.action = 'skip';
            row.reason = '名称相同。';
          } else if (pathKey(target) === pathKey(source) || await snapshot(target)) {
            row.action = 'blocked';
            row.reason = '目标已存在或仅大小写不同。';
          } else {
            const duplicate = targets.get(pathKey(target));
            if (duplicate) {
              duplicate.action = row.action = 'blocked';
              duplicate.reason = row.reason = '批次中有多个文件使用此名称。';
            }
            targets.set(pathKey(target), row);
          }
          work.push({ row, sourceState, parentPath, parentState, move: true });
        } catch (error) {
          work.push({ row: { source: path, action: 'blocked', reason: error instanceof Error ? error.message : '无法检查文件。' } });
        }
      }
      return save(work, false);
    },

    async run(value: unknown) {
      if (running) throw new Error('已有批量文件操作正在执行。');
      const plan = typeof value === 'string' ? plans.get(value) : undefined;
      if (!plan || typeof value !== 'string' || plan.expires < Date.now()) throw new Error('预览已失效，请重新生成。');
      plans.delete(value);
      running = true;
      try {
        const results: BatchOutcome[] = [];
        for (const item of plan.work) {
          const result = await execute(item);
          results.push(result);
          if (item.move && result.status === 'done' && result.target) {
            try { await onMove(result.source, result.target); }
            catch (error) {
              result.message = '文件操作已完成，但关联的索引或媒体资料更新失败。';
              console.warn(result.message, error);
            }
          }
        }
        return results;
      } finally { running = false; }
    },
  };
}
