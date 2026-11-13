import { lstat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { SearchFilters } from '../../../shared/search';
import type { ScanEntry } from './scan';
import { isWithin } from './scan';

export async function* filteredSearch(
  batches: AsyncIterable<readonly ScanEntry[]>, filters: SearchFilters, directory?: string,
) {
  const cutoff = filters.days ? Date.now() - filters.days * 86_400_000 : undefined;
  const extensions = filters.extension ? new Set(filters.extension.split(',')) : undefined;
  for await (const entries of batches) {
    const candidates = entries.filter(entry => (!directory || isWithin(directory, entry.path))
      && (!extensions || entry.kind === 'file' && extensions.has(extname(entry.name).slice(1).toLowerCase()))
      && (!filters.minSize || entry.kind === 'file'));
    for (let offset = 0; offset < candidates.length; offset += 16) {
      const matches = await Promise.all(candidates.slice(offset, offset + 16).map(async entry => {
        const info = await lstat(entry.path).catch(() => undefined);
        if (!info || (entry.kind === 'file' ? !info.isFile() : !info.isDirectory())
          || (cutoff && info.mtimeMs < cutoff) || (filters.minSize && info.size < filters.minSize)) return;
        return { ...entry, size: info.isFile() ? info.size : undefined, modified: info.mtimeMs };
      }));
      yield matches.flatMap(match => match ? [match] : []);
    }
  }
}
