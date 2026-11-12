import { dirname, extname } from 'node:path';
import { MAX_SEARCH_QUERY } from '../../../shared/search';
import type { QuickSearchGroup, QuickSearchKind } from '../../../shared/search';
import { classify } from '../media/classification';
import { indexKey } from './index-storage';
import type { ScanEntry } from './scan';

const groups: readonly QuickSearchKind[] = ['folder', 'application', 'image', 'file'];
const GROUP_LIMIT = 5;
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function quickKind(entry: ScanEntry, platform = process.platform): QuickSearchKind {
  const extension = extname(entry.name).toLowerCase();
  if (entry.kind === 'directory') {
    return platform === 'darwin' && extension === '.app' ? 'application' : 'folder';
  }
  if ((platform === 'win32' && ['.exe', '.com'].includes(extension))
    || (platform === 'linux' && extension === '.desktop')) return 'application';
  return classify(entry.name) === 'image' ? 'image' : 'file';
}

export async function quickSearch(
  read: (term: string) => AsyncIterable<readonly ScanEntry[]> | Iterable<readonly ScanEntry[]>,
  input: unknown,
): Promise<QuickSearchGroup[]> {
  if (typeof input !== 'string' || input.length > MAX_SEARCH_QUERY) {
    throw new Error(`请输入最多 ${MAX_SEARCH_QUERY} 个字符的文件名。`);
  }
  const term = indexKey(input.trim());
  if (!term) return [];

  const buckets: Record<QuickSearchKind, Array<{ entry: ScanEntry; rank: number }>> = {
    folder: [], application: [], image: [], file: [],
  };

  for await (const batch of read(term)) {
    for (const entry of batch) {
      const name = indexKey(entry.name);
      const position = name.indexOf(term);
      if (position < 0) continue;
      const rank = name === term ? 0 : position === 0 ? 1 : 2;
      const bucket = buckets[quickKind(entry)];
      const ahead = bucket.findIndex(other => rank < other.rank
        || (rank === other.rank && byName.compare(entry.name, other.entry.name) < 0));
      if (ahead !== -1) bucket.splice(ahead, 0, { entry, rank });
      else if (bucket.length < GROUP_LIMIT) bucket.push({ entry, rank });
      if (bucket.length > GROUP_LIMIT) bucket.pop();
    }
  }

  return groups.filter(kind => buckets[kind].length).map(kind => ({
    kind,
    matches: buckets[kind].map(({ entry }) => ({
      name: entry.name, path: entry.path, kind: entry.kind, directory: dirname(entry.path), group: kind,
    })),
  }));
}
