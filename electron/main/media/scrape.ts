import type { MediaMetadata, ScrapeKind } from '../../../shared/media';
import { parseMetadata, text } from './metadata-store';

const itunes = {
  series: { media: 'tvShow', entity: 'tvSeason' },
  music: { media: 'music', entity: 'song' },
  podcast: { media: 'podcast', entity: 'podcast' },
  audiobook: { media: 'audiobook', entity: 'audiobook' },
} as const;

export function isScrapeKind(kind: unknown): kind is ScrapeKind {
  return typeof kind === 'string' && (kind === 'book' || kind === 'movie' || Object.prototype.hasOwnProperty.call(itunes, kind));
}

async function fetchCatalog(url: URL) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(8500), redirect: 'error',
    headers: { Accept: 'application/json', 'User-Agent': 'Harmony/1.0 (desktop media library; https://github.com/cbtpro/harmony)' },
  });
  if (!response.ok || !response.body) throw new Error('在线资料暂不可用。');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512 * 1024) throw new Error('在线资料响应过大。');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function scrape(kind: ScrapeKind, query: string, country: string): Promise<MediaMetadata[]> {
  if (kind === 'movie') {
    const language = country === 'JP' ? 'ja' : ['CN', 'HK', 'TW'].includes(country) ? 'zh' : 'en';
    const url = new URL('https://www.wikidata.org/w/api.php');
    url.search = new URLSearchParams({
      action: 'wbsearchentities', search: query, language, uselang: language, format: 'json', limit: '20',
    }).toString();
    const result = await fetchCatalog(url);
    if (result?.error) throw new Error('Wikidata 暂不可用。');
    const rows: Array<Record<string, unknown>> = Array.isArray(result?.search) ? result.search.slice(0, 20) : [];
    return rows.flatMap(row => {
      if (!row || typeof row !== 'object') return [];
      const title = text(row.label, 256);
      const description = text(row.description, 1200);
      if (!title || !description || !/\b(?:film|movie)\b|电影|電影|影片|映画/i.test(description)) return [];
      return [parseMetadata({
        title, description, year: description.match(/\b(?:18|19|20)\d{2}\b/)?.[0],
        creator: description.match(/(?:directed by|film by) ([^,;]+)$/i)?.[1],
        source: 'wikidata', category: 'movie',
      })];
    }).slice(0, 10);
  }

  if (kind === 'book') {
    const url = new URL('https://openlibrary.org/search.json');
    url.search = new URLSearchParams({
      title: query, limit: '10', fields: 'title,author_name,first_publish_year',
    }).toString();
    const result = await fetchCatalog(url);
    const rows: unknown[] = Array.isArray(result?.docs) ? result.docs.slice(0, 10) : [];
    return rows.flatMap(row => {
      if (!row || typeof row !== 'object' || !('title' in row) || !text(row.title, 256)) return [];
      return [parseMetadata({
        title: row.title,
        creator: 'author_name' in row && Array.isArray(row.author_name) ? row.author_name.slice(0, 3).join(', ') : undefined,
        year: 'first_publish_year' in row ? String(row.first_publish_year) : undefined,
        source: 'open-library', category: 'book',
      })];
    });
  }

  const url = new URL('https://itunes.apple.com/search');
  url.search = new URLSearchParams({ term: query, country, ...itunes[kind], limit: '10' }).toString();
  const result = await fetchCatalog(url);
  const rows: Array<Record<string, unknown>> = Array.isArray(result?.results) ? result.results.slice(0, 10) : [];
  return rows.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    const title = text(row.trackName, 256) ?? text(row.collectionName, 256);
    if (!title) return [];
    return [parseMetadata({
      title, creator: row.artistName, year: text(row.releaseDate, 4), genre: row.primaryGenreName,
      description: row.longDescription ?? row.shortDescription ?? row.description,
      source: 'itunes', category: kind,
    })];
  });
}
