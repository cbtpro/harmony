import { dirname, extname } from 'node:path';
import type { MediaCategory, MediaEntry, MediaMetadata, MediaPage } from '../../../shared/media';
import { openTemporaryDatabase } from '../search/index-storage';
import type { ScanEntry } from '../search/scan';
import { classify } from './classification';

const PAGE_SIZE = 24;

function orderKey(value: string) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\d+/g, match => {
    const digits = match.replace(/^0+(?=\d)/, '');
    return `0${String(digits.length).padStart(6, '0')}${digits}`;
  });
}

export async function queryCatalog(
  batches: AsyncIterable<readonly ScanEntry[]>,
  records: ReadonlyMap<string, MediaMetadata>,
  query: string,
  selected: MediaCategory | undefined,
  requestedPage: number,
): Promise<MediaPage> {
  const database = openTemporaryDatabase();
  const counts: Partial<Record<MediaCategory, number>> = {};
  let total = 0;
  try {
    database.exec(`
      CREATE TABLE matches (
        title_order TEXT, path_order TEXT, path TEXT, name TEXT, category TEXT,
        PRIMARY KEY (title_order, path_order, path)
      ) WITHOUT ROWID;
    `);
    const insert = database.prepare('INSERT INTO matches VALUES (?, ?, ?, ?, ?)');
    for await (const entries of batches) {
      database.exec('BEGIN');
      for (const entry of entries) {
        if (entry.kind !== 'file') continue;
        const detected = classify(entry.path);
        if (!detected) continue;
        const metadata = records.get(entry.path);
        const category = metadata?.category ?? detected;
        if (query && ![entry.name, metadata?.title, metadata?.creator, metadata?.genre, metadata?.year]
          .some(value => value?.normalize('NFC').toLowerCase().includes(query))) continue;
        counts[category] = (counts[category] ?? 0) + 1;
        if (selected && category !== selected) continue;
        insert.run(orderKey(metadata?.title ?? entry.name), orderKey(entry.path), entry.path, entry.name, category);
        total++;
      }
      database.exec('COMMIT');
    }

    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / PAGE_SIZE)));
    const matches = database.prepare(`
      SELECT name, path, category FROM matches ORDER BY title_order, path_order, path LIMIT ? OFFSET ?
    `).all(PAGE_SIZE, (page - 1) * PAGE_SIZE) as Array<Pick<MediaEntry, 'name' | 'path' | 'category'>>;
    const items: MediaEntry[] = matches.map(({ name, path, category }) => ({
      name, path, kind: 'file', directory: dirname(path), category,
      extension: extname(name).slice(1).toUpperCase(), metadata: records.get(path),
    }));
    return { items, total, page, pageSize: PAGE_SIZE, counts };
  } finally {
    database.close();
  }
}
