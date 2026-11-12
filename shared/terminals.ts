import type { Result } from './files';

export interface TerminalOption {
  id: string;
  label: string;
}

export interface TerminalsApi {
  list(): Promise<Result<TerminalOption[]>>;
  open(id: string, path: string): Promise<Result<void>>;
}
