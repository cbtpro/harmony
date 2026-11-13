import type { FileEntry, Result } from './files';

export const MAX_SEARCH_QUERY = 128;

export interface IndexRules {
  roots: string[];
  excluded: string[];
}

export interface IndexSource {
  root: string;
  provider: string;
}

export interface IndexStatus extends IndexRules {
  sources?: IndexSource[];
  revision: number;
  settingsWarning?: string;
  phase: 'idle' | 'running' | 'paused' | 'stopping' | 'ready' | 'stopped' | 'failed';
  failure?: string;
  resumable?: boolean;
  count: number;
  skipped: number;
}

export interface IndexSettings {
  threads: number;
  maxThreads: number;
  systemThreads: number;
  preferSystem?: boolean;
  systemProviders?: string[];
  spotlightMaintenance?: boolean;
}

export interface SearchMatch extends FileEntry {
  directory: string;
  size?: number;
  modified?: number;
}

export interface SearchFilters {
  extension?: string;
  directory?: string;
  days?: number;
  minSize?: number;
}

export function parseSearchFilters(input: unknown): SearchFilters {
  if (!input || typeof input !== 'object') return {};
  const value = input as Record<string, unknown>;
  const extensions = typeof value.extension === 'string' && value.extension.length <= 256
    ? [...new Set(value.extension.split(/[,，\s]+/).map(part => part.replace(/^\./, '').toLowerCase())
      .filter(part => /^[a-z0-9]{1,16}$/.test(part)))].slice(0, 16) : [];
  const number = (value: unknown) => {
    if (typeof value !== 'string' && typeof value !== 'number') return;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  };
  const days = number(value.days);
  return {
    extension: extensions.join(',') || undefined,
    directory: typeof value.directory === 'string' && value.directory.length <= 4096 ? value.directory.trim() || undefined : undefined,
    days: days && days <= 3650 ? days : undefined,
    minSize: number(value.minSize),
  };
}

export interface SearchResults {
  matches: SearchMatch[];
  truncated: boolean;
}

export interface SearchApi {
  status(): Promise<Result<IndexStatus>>;
  addRoot(): Promise<Result<IndexStatus>>;
  removeRoot(path: string): Promise<Result<IndexStatus>>;
  addExcluded(): Promise<Result<IndexStatus>>;
  removeExcluded(path: string): Promise<Result<IndexStatus>>;
  rebuild(): Promise<Result<IndexStatus>>;
  pause(): Promise<Result<IndexStatus>>;
  resume(): Promise<Result<IndexStatus>>;
  stop(): Promise<Result<IndexStatus>>;
  search(query: string, filters?: SearchFilters): Promise<Result<SearchResults>>;
}

export type QuickSearchKind = 'folder' | 'application' | 'image' | 'file';

export interface QuickSearchMatch extends SearchMatch {
  group: QuickSearchKind;
}

export interface QuickSearchGroup {
  kind: QuickSearchKind;
  matches: QuickSearchMatch[];
}

export interface QuickSearchApi {
  find(query: string): Promise<Result<QuickSearchGroup[]>>;
  open(path: string): Promise<Result<void>>;
}
