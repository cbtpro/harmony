import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, realpath, rename, stat, unlink } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import type { BatchOutcome, BatchPlan, BatchRow, RenameOptions } from '../../shared/files';
import { absolutePath, entryPath, validEntryName } from './files';
import { componentLength, filesystemPath } from './file-path';
import { MAX_TREE_ENTRIES, readTree, sameIdentity, snapshot, transferDirectory, unchanged } from './directory-transfer';
import type { DirectoryTree } from './directory-transfer';

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
  tree?: DirectoryTree;
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
  return join(await canonicalDirectory(dirname(path)), basename(path));
}

async function canonicalDirectory(path: string) {
  return absolutePath(await realpath(filesystemPath(path)));
}

function inside(parent: string, path: string) {
  const suffix = relative(pathKey(parent), pathKey(path));
  return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep);
}

function numberedName(name: string, suffix: number, directory: boolean) {
  const [stem, extension] = directory ? [name, ''] : splitName(name);
  const ending = ` (${suffix})${extension}`;
  let prefix = '';
  for (const character of stem) {
    if (componentLength(prefix + character + ending) > 255) break;
    prefix += character;
  }
  if (!prefix) throw new Error('文件名太长，无法添加副本编号。');
  return prefix + ending;
}

function checkTarget(path: string) {
  if (componentLength(basename(path)) > 255
    || process.platform === 'win32' && filesystemPath(path).length >= 32767) {
    throw new Error(`目标路径或名称太长，请缩短名称或选择其他目录：${path}`);
  }
}

async function exclusiveCopy(source: string, target: string) {
  const temporary = join(dirname(target), `.harmony-transfer-${randomUUID()}.tmp`);
  try {
    await copyFile(filesystemPath(source), filesystemPath(temporary), constants.COPYFILE_EXCL);
    // Publish the finished copy without replacing an entry created after the preview.
    try { await link(filesystemPath(temporary), filesystemPath(target)); }
    catch (error) {
      if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await copyFile(filesystemPath(temporary), filesystemPath(target), constants.COPYFILE_EXCL);
    }
  } finally { await unlink(filesystemPath(temporary)).catch(() => {}); }
}

async function execute(work: Work, copyDirectory: typeof transferDirectory): Promise<BatchOutcome> {
  const { source, target, action, reason } = work.row;
  if (!target || action === 'blocked' || action === 'skip') {
    return { source, target, status: 'skipped', message: reason };
  }
  try {
    const canonicalParent = await canonicalDirectory(dirname(target));
    const currentParent = await stat(filesystemPath(canonicalParent), { bigint: true });
    if (canonicalParent !== work.parentPath || !work.parentState || !sameIdentity(currentParent, work.parentState)) {
      throw new Error('目标目录已变更，请重新预览。');
    }
    const currentSource = await snapshot(source);
    if (await canonicalSource(source) !== source || !currentSource || !unchanged(work.sourceState, currentSource)
      || !unchanged(work.targetState, await snapshot(target))) {
      throw new Error('源文件或目标已变更，请重新预览。');
    }
    if (work.tree) {
      const message = await copyDirectory(source, target, work.tree, !!work.move, currentSource.dev === currentParent.dev);
      return { source, target, status: 'done', message };
    }
    if (action === 'replace') {
      const temporary = join(canonicalParent, `.harmony-transfer-${randomUUID()}.tmp`);
      try {
        await copyFile(filesystemPath(source), filesystemPath(temporary), constants.COPYFILE_EXCL);
        if (!unchanged(work.targetState, await snapshot(target)) || !unchanged(work.sourceState, await snapshot(source))) {
          throw new Error('复制期间文件已变更，请重新预览。');
        }
        await rename(filesystemPath(temporary), filesystemPath(target));
      } finally { await unlink(filesystemPath(temporary)).catch(() => {}); }
    } else if (work.move) {
      try {
        await link(filesystemPath(source), filesystemPath(target));
        const [linked, original] = await Promise.all([snapshot(target), snapshot(source)]);
        if (!linked || !original || !sameIdentity(currentSource, linked) || !sameIdentity(currentSource, original)) {
          throw new Error('移动期间源文件已变更，请核对目标后重新预览。');
        }
        try { await unlink(filesystemPath(source)); }
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
      try { await unlink(filesystemPath(source)); }
      catch { throw new Error('目标已复制，源文件未删除。'); }
    }
    return { source, target, status: 'done' };
  } catch (error) {
    return { source, target, status: 'failed', message: error instanceof Error ? error.message : '文件操作失败。' };
  }
}

export function createBatchFiles(onMove: (source: string, target: string, kind: 'file' | 'directory') => void | Promise<void>,
  copyDirectory = transferDirectory) {
  const plans = new Map<string, { work: Work[]; expires: number }>();
  let running = false;

  function save(work: Work[], allowPartial = true): BatchPlan {
    const rows = work.map(item => item.row);
    if (!rows.some(row => row.action === 'ready' || row.action === 'replace')
      || (!allowPartial && rows.some(row => row.action === 'blocked'))) return { rows };
    for (const [key, plan] of plans) if (plan.expires <= Date.now()) plans.delete(key);
    if (work.some(item => item.tree)) {
      for (const [key, plan] of plans) if (plan.work.some(item => item.tree)) plans.delete(key);
    }
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
      const parentPath = await canonicalDirectory(absolutePath(destination));
      const parentState = await stat(filesystemPath(parentPath), { bigint: true });
      if (!parentState.isDirectory()) throw new Error('请选择目标目录。');
      const selectedTargets = new Set((await Promise.all(sources.map(path => canonicalSource(path).catch(() => path)))).map(pathKey));
      const reserved = new Set<string>();
      const work: Work[] = [];
      let remaining = MAX_TREE_ENTRIES;
      for (const path of sources) {
        try {
          const source = await canonicalSource(path);
          const sourceState = await snapshot(source);
          const directory = sourceState?.isDirectory();
          if (!sourceState || (!directory && !sourceState.isFile())) {
            work.push({ row: { source: path, action: 'blocked', reason: '请选择普通文件或文件夹。' } });
            continue;
          }
          if (directory && inside(source, parentPath)) throw new Error('不能将文件夹复制或移动到自身内部。');
          if ([...selectedTargets].some(other => other !== pathKey(source) && inside(other, source))) {
            work.push({ row: { source, action: 'skip', reason: '已选中上级文件夹。' } });
            continue;
          }
          let target = join(parentPath, basename(source));
          checkTarget(target);
          let targetState = await snapshot(target);
          const same = pathKey(target) === pathKey(source) || !!targetState && sameIdentity(targetState, sourceState);
          const pending = reserved.has(pathKey(target));
          if (targetState || pending || same) {
            if (policy === 'skip' || (policy === 'replace' && (directory || same || pending || !targetState?.isFile() || selectedTargets.has(pathKey(target))))) {
              work.push({ row: { source, target, action: 'skip', reason: same ? '源文件与目标相同。'
                : pending ? '本批已有同名目标。' : directory ? '同名文件夹可选择保留两份。' : '目标已有同名项目。' } });
              continue;
            }
            if (policy === 'keep') {
              let suffix = 1;
              do {
                target = join(parentPath, numberedName(basename(source), ++suffix, !!directory));
                checkTarget(target);
                targetState = await snapshot(target);
              } while ((targetState || reserved.has(pathKey(target))) && suffix < 10_000);
              if (targetState || reserved.has(pathKey(target))) throw new Error('没有可用的同名副本名称。');
            }
          }
          const tree = directory ? await readTree(source, name => checkTarget(join(target, name)), remaining) : undefined;
          if (operation === 'move' && tree?.skipped) throw new Error(`目录含 ${tree.skipped} 个链接或特殊项目。可复制普通项目，整目录移动已阻止。`);
          if (tree) remaining -= tree.entries.length + tree.skipped;
          reserved.add(pathKey(target));
          work.push({ row: { source, target, action: targetState ? 'replace' : 'ready',
            contents: tree && { files: tree.files, directories: tree.directories, skipped: tree.skipped,
              sample: tree.entries.slice(1, 21).map(entry => entry.name) } },
            sourceState, targetState, parentPath, parentState, move: operation === 'move', tree });
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
          const parentState = await stat(filesystemPath(parentPath), { bigint: true });
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
          const result = await execute(item, copyDirectory);
          results.push(result);
          if (item.move && result.status === 'done' && result.target) {
            try { await onMove(result.source, result.target, item.tree ? 'directory' : 'file'); }
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
