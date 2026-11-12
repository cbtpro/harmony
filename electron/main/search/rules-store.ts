import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { absolutePath } from '../files';
import type { IndexRules } from '../../../shared/search';
import { INDEX_TUNING, isSystemPath } from './scan';

export const RULE_LIMITS = { roots: INDEX_TUNING.roots, excluded: 16 };
const MAX_SETTINGS_BYTES = 1024 * 1024;
export interface SavedIndexRules extends IndexRules { threads?: number }

function parsePaths(value: unknown, limit: number) {
  if (!Array.isArray(value) || value.length > limit) throw new Error('索引目录规则无效。');
  return [...new Set(value.map((entry: unknown) => {
    const path = absolutePath(entry);
    if (path.length > 4096) throw new Error('索引路径太长。');
    return path;
  }))];
}

export async function loadRules(file: string, home: string): Promise<SavedIndexRules> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { roots: [await realpath(absolutePath(home))], excluded: [] };
    }
    throw error;
  }
  if (!info.isFile() || info.size > MAX_SETTINGS_BYTES) throw new Error('索引规则文件太大。');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  if (saved?.version !== 1) throw new Error('索引规则版本无效。');
  return {
    roots: parsePaths(saved.roots, RULE_LIMITS.roots).filter(path => !isSystemPath(path)),
    excluded: parsePaths(saved.excluded, RULE_LIMITS.excluded),
    threads: Number.isSafeInteger(saved.threads) && saved.threads > 0 ? saved.threads : undefined,
  };
}

export async function saveRules(file: string, rules: SavedIndexRules): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, ...rules }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
