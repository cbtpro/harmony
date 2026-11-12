import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mediaCategories } from '../../../shared/media';
import type { MediaCategory, MediaMetadata, MediaSource } from '../../../shared/media';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_RECORDS = 5000;
const sources = new Set<MediaSource>(['manual', 'local', 'itunes', 'open-library', 'wikidata']);

export function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.trim().slice(0, max) || undefined : undefined;
}

export function isCategory(value: unknown): value is MediaCategory {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(mediaCategories, value);
}

export function parseMetadata(value: unknown): MediaMetadata {
  if (typeof value !== 'object' || !value) throw new Error('媒体资料格式无效。');
  const fields = value as Record<string, unknown>;
  const title = text(fields.title, 256);
  if (!title) throw new Error('请输入媒体标题。');
  const year = text(fields.year, 4);
  return {
    title,
    creator: text(fields.creator, 180),
    year: year && /^\d{4}$/.test(year) ? year : undefined,
    genre: text(fields.genre, 120),
    description: text(fields.description, 1200),
    category: isCategory(fields.category) ? fields.category : undefined,
    source: sources.has(fields.source as MediaSource) ? fields.source as MediaSource : 'manual',
  };
}

export function createMetadataStore(file: string) {
  let loaded: Promise<Map<string, MediaMetadata>> | undefined;

  async function read() {
    let info;
    try { info = await stat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map<string, MediaMetadata>();
      throw error;
    }
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('媒体资料库无法读取。');
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_RECORDS) {
      throw new Error('媒体资料库格式无效。');
    }
    const records = new Map<string, MediaMetadata>();
    for (const item of data.entries) {
      if (!Array.isArray(item) || typeof item[0] !== 'string') throw new Error('媒体资料库格式无效。');
      records.set(item[0], parseMetadata(item[1]));
    }
    return records;
  }

  return {
    load: () => loaded ??= read().catch(error => {
      loaded = undefined;
      throw error;
    }),
    async save(records: Map<string, MediaMetadata>) {
      const data = JSON.stringify({ version: 1, entries: [...records] });
      if (records.size > MAX_RECORDS || Buffer.byteLength(data) > MAX_BYTES) throw new Error('媒体资料库已达到存储上限。');
      const temporary = `${file}.${randomUUID()}.tmp`;
      await mkdir(dirname(file), { recursive: true });
      try {
        await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
        loaded = Promise.resolve(records);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    },
  };
}
