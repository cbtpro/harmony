import { link, lstat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { MediaCategory, MediaEntry, MediaMetadata, MediaPage } from '../../../shared/media';
import { absolutePath } from '../files';
import type { FileIndex } from '../search/file-index';
import type { ScanEntry } from '../search/scan';
import { classify } from './classification';
import { createMetadataStore, isCategory, parseMetadata, text } from './metadata-store';
import { inspectMedia } from './probe';
import { isScrapeKind, scrape } from './scrape';

const PAGE_SIZE = 24;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function mediaPath(value: unknown) {
  const path = absolutePath(value);
  const category = classify(path);
  if (!category) throw new Error('此文件类型未纳入媒体库。');
  return { path, category };
}

function newFileName(path: string, value: unknown) {
  const stem = typeof value === 'string' ? value.trim() : '';
  const name = stem + extname(path);
  if (!stem || stem.startsWith('.') || /[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(stem)
    || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(\.|$)/i.test(stem)
    || Buffer.byteLength(name) > 255) throw new Error('请输入有效的文件名。');
  return name;
}

export function createMediaLibrary(index: FileIndex, file: string) {
  const store = createMetadataStore(file);
  let writes = Promise.resolve();
  let activeLookups = 0;
  let activeProbes = 0;

  function serialize<T>(operation: () => Promise<T>) {
    const result = writes.then(operation);
    writes = result.then(() => {}, () => {});
    return result;
  }

  return {
    async list(value: unknown): Promise<MediaPage> {
      const input = value as { query?: unknown; category?: unknown; page?: unknown } | null;
      const query = text(input?.query, 128)?.normalize('NFC').toLowerCase() ?? '';
      const categoryValue = input?.category;
      const selected = isCategory(categoryValue) ? categoryValue : undefined;
      const pageValue = input?.page;
      const requestedPage = typeof pageValue === 'number' && Number.isSafeInteger(pageValue)
        ? Math.max(1, pageValue) : 1;
      const records = await store.load();
      const counts: Partial<Record<MediaCategory, number>> = {};
      const matches: Array<{ entry: ScanEntry; category: MediaCategory; metadata?: MediaMetadata }> = [];
      for (const entry of index.indexedEntries()) {
        if (entry.kind !== 'file') continue;
        const detected = classify(entry.path);
        if (!detected) continue;
        const metadata = records.get(entry.path);
        const category = metadata?.category ?? detected;
        if (query && ![entry.name, metadata?.title, metadata?.creator, metadata?.genre, metadata?.year]
          .some(value => value?.normalize('NFC').toLowerCase().includes(query))) continue;
        counts[category] = (counts[category] ?? 0) + 1;
        if (selected && category !== selected) continue;
        matches.push({ entry, category, metadata });
      }
      matches.sort((left, right) => collator.compare(left.metadata?.title ?? left.entry.name, right.metadata?.title ?? right.entry.name)
        || collator.compare(left.entry.path, right.entry.path));
      const page = Math.min(requestedPage, Math.max(1, Math.ceil(matches.length / PAGE_SIZE)));
      const items: MediaEntry[] = matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
        .map(({ entry, category, metadata }) => ({
          name: entry.name, path: entry.path, kind: 'file', directory: dirname(entry.path),
          category, extension: extname(entry.name).slice(1).toUpperCase(), metadata,
        }));
      return { items, total: matches.length, page, pageSize: PAGE_SIZE, counts };
    },

    async inspect(value: unknown) {
      const { path, category } = mediaPath(value);
      if (activeProbes >= 2) throw new Error('正在读取其他媒体，请稍后重试。');
      activeProbes++;
      try { return await inspectMedia(path, category); }
      finally { activeProbes--; }
    },

    async scrape(kind: unknown, value: unknown, country: unknown) {
      const query = text(value, 128);
      if (!query || !isScrapeKind(kind) || typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) {
        throw new Error('请输入有效的查询条件。');
      }
      if (activeLookups >= 2) throw new Error('已有在线查询正在进行，请稍后重试。');
      activeLookups++;
      try { return await scrape(kind, query, country); }
      catch { throw new Error('在线资料查询失败，请检查网络后重试。'); }
      finally { activeLookups--; }
    },

    save(value: unknown, metadata: unknown) {
      return serialize(async () => {
        const { path } = mediaPath(value);
        if (!(await lstat(path)).isFile()) throw new Error('请选择普通媒体文件。');
        const records = new Map(await store.load());
        records.set(path, parseMetadata(metadata));
        await store.save(records);
      });
    },

    rename(value: unknown, stem: unknown) {
      return serialize(async () => {
        const { path } = mediaPath(value);
        const name = newFileName(path, stem);
        const destination = join(dirname(path), name);
        if (path === destination) return { path };
        const original = await lstat(path, { bigint: true });
        if (!original.isFile()) throw new Error('请选择普通媒体文件。');

        const records = await store.load();
        const metadata: MediaMetadata | undefined = records.get(path);
        const moved = new Map(records);
        moved.delete(path);
        moved.delete(destination);
        if (metadata) moved.set(destination, metadata);
        const metadataChanged = !!metadata || records.has(destination);

        // An exclusive hard link keeps the media data in place and refuses any destination collision.
        try { await link(path, destination); }
        catch (error) {
          if (['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw new Error('此磁盘不支持应用内的防覆盖重命名。');
          }
          throw error;
        }

        let metadataMoved = false;
        const isOriginal = async (candidate: string) => {
          const current = await lstat(candidate, { bigint: true }).catch(() => undefined);
          return current?.dev === original.dev && current.ino === original.ino;
        };
        try {
          if (metadataChanged) {
            await store.save(moved);
            metadataMoved = true;
          }
          if (!await isOriginal(path) || !await isOriginal(destination)) {
            throw new Error('文件已在其他程序中变更，请刷新后重试。');
          }
          await unlink(path);
        } catch (error) {
          // Only remove the new link while the original still protects the file's data.
          if (await isOriginal(path) && await isOriginal(destination)) {
            await unlink(destination);
            if (metadataMoved) await store.save(records);
          }
          throw error;
        }
        index.replaceIndexedFile(path, { name: basename(destination), path: destination, kind: 'file' });
        return { path: destination };
      });
    },
  };
}
