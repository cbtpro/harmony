export interface FileEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file' | 'link' | 'other';
}

export interface Directory {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; message: string };

export interface FilesApi {
  list(path?: string): Promise<Result<Directory>>;
  choose(): Promise<Result<string | null>>;
  mkdir(directory: string, name: string): Promise<Result<void>>;
  copyFile(source: string, directory: string): Promise<Result<void>>;
  open(path: string): Promise<Result<void>>;
  reveal(path: string): Promise<Result<void>>;
  copyPath(path: string): Promise<Result<void>>;
  trash(path: string): Promise<Result<void>>;
}

export type TransferAction = 'copy' | 'move';
export type ConflictPolicy = 'skip' | 'keep' | 'replace';

export interface BatchRow {
  source: string;
  target?: string;
  action: 'ready' | 'skip' | 'replace' | 'blocked';
  reason?: string;
}

export interface BatchPlan {
  rows: BatchRow[];
  ticket?: string;
}

export interface BatchOutcome {
  source: string;
  target?: string;
  status: 'done' | 'skipped' | 'failed';
  message?: string;
}

export interface RenameOptions {
  find: string;
  replace: string;
  numbering: boolean;
  start: number;
  date: boolean;
}

export interface PreviewContent {
  kind: 'image' | 'pdf' | 'text' | 'markdown';
  data: string;
  mime?: string;
  truncated?: boolean;
}
