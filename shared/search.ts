import type { FileEntry, Result } from './files';

export const MAX_SEARCH_QUERY = 128;

export interface IndexRules {
  roots: string[];
  excluded: string[];
}

export interface IndexStatus extends IndexRules {
  revision: number;
  settingsWarning?: string;
  phase: 'idle' | 'running' | 'paused' | 'stopping' | 'ready' | 'limited' | 'stopped' | 'failed';
  count: number;
  skipped: number;
}

export interface SearchMatch extends FileEntry {
  directory: string;
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
  search(query: string): Promise<Result<SearchResults>>;
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
