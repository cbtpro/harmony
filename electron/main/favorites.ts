import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Favorite, FavoriteInput } from '../../shared/favorites';
import { MAX_SEARCH_QUERY, parseSearchFilters } from '../../shared/search';
import { absolutePath } from './files';

const limit = 100;
const maxBytes = 1024 * 1024;

function parse(value: unknown): FavoriteInput {
  const input = value as Partial<FavoriteInput> | null;
  const label = typeof input?.label === 'string' ? input.label.trim() : '';
  if (!label || label.length > 80) throw new Error('收藏名称须为 1 到 80 个字符。');
  if (input?.kind === 'directory') {
    if (typeof input.directory !== 'string' || input.directory.length > 4096) throw new Error('收藏目录无效。');
    return { kind: 'directory', label, directory: absolutePath(input.directory) };
  }
  if (input?.kind === 'search' && typeof input.query === 'string' && input.query.length <= MAX_SEARCH_QUERY) {
    const query = input.query.trim();
    const filters = parseSearchFilters(input.filters);
    if (filters.directory) filters.directory = absolutePath(filters.directory);
    if (!query && !Object.values(filters).some(Boolean)) throw new Error('请先填写搜索条件。');
    return { kind: 'search', label, query, filters };
  }
  throw new Error('收藏内容无效。');
}

export function createFavorites(file: string) {
  let queue = Promise.resolve();

  async function load(): Promise<Favorite[]> {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > maxBytes) throw new Error('收藏文件不可读取。');
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data?.version !== 1 || !Array.isArray(data.items) || data.items.length > limit) throw new Error('收藏文件格式无效。');
      const seen = new Set<string>();
      return data.items.map((item: { id?: unknown }) => {
        const id = item?.id;
        if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || seen.has(id)) throw new Error('收藏文件格式无效。');
        seen.add(id);
        return { ...parse(item), id };
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  function change(update: (items: Favorite[]) => Favorite[]) {
    const next = queue.then(async () => {
      const items = update(await load());
      if (items.length > limit) throw new Error('最多收藏 100 项。');
      const text = JSON.stringify({ version: 1, items });
      if (Buffer.byteLength(text) > maxBytes) throw new Error('收藏文件超过存储上限。');
      const temporary = file + '.' + randomUUID() + '.tmp';
      await mkdir(dirname(file), { recursive: true });
      try {
        await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      return items;
    });
    queue = next.then(() => {}, () => {});
    return next;
  }

  return {
    list: () => queue.then(load),
    add: (input: unknown) => change(items => [...items, { ...parse(input), id: randomUUID() }]),
    remove: (id: unknown) => change(items => items.filter(item => item.id !== id)),
  };
}
