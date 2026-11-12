import type { Result } from './files';

export interface Disk {
  name: string;
  path: string;
  total: number | null;
  available: number | null;
  scope: 'full' | 'partial' | 'excluded' | 'none';
}

export interface DisksApi {
  list(): Promise<Result<Disk[]>>;
  index(path: string): Promise<Result<void>>;
}
