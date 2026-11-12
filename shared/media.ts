import type { Result } from './files';
import type { SearchMatch } from './search';

export const mediaCategories = {
  movie: '电影', series: '剧集', animation: '动画', video: '其他视频',
  music: '音乐', podcast: '播客', audio: '其他音频', audiobook: '有声书',
  image: '图片', book: '电子书', comic: '漫画', subtitle: '字幕', playlist: '播放列表',
} as const;

export type MediaCategory = keyof typeof mediaCategories;
export type MediaSource = 'manual' | 'local' | 'itunes' | 'open-library' | 'wikidata';
export type ScrapeKind = 'movie' | 'series' | 'music' | 'podcast' | 'audiobook' | 'book';

export interface MediaMetadata {
  title: string;
  creator?: string;
  year?: string;
  genre?: string;
  description?: string;
  category?: MediaCategory;
  source: MediaSource;
}

export interface MediaEntry extends SearchMatch {
  category: MediaCategory;
  extension: string;
  metadata?: MediaMetadata;
}

export interface MediaQuery {
  query: string;
  category: MediaCategory | 'all';
  page: number;
}

export interface MediaPage {
  items: MediaEntry[];
  total: number;
  page: number;
  pageSize: number;
  counts: Partial<Record<MediaCategory, number>>;
}

export interface MediaDetails {
  size: number;
  modified: string;
  probe: 'ready' | 'unsupported' | 'unavailable';
  duration?: number;
  width?: number;
  height?: number;
  codecs?: string[];
  metadata?: MediaMetadata;
}

export interface MediaApi {
  list(query: MediaQuery): Promise<Result<MediaPage>>;
  inspect(path: string): Promise<Result<MediaDetails>>;
  scrape(kind: ScrapeKind, query: string, country: string): Promise<Result<MediaMetadata[]>>;
  save(path: string, metadata: MediaMetadata): Promise<Result<void>>;
  rename(path: string, stem: string): Promise<Result<{ path: string }>>;
}
