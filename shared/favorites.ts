import type { SearchFilters } from './search';

export type FavoriteInput =
  | { kind: 'directory'; label: string; directory: string }
  | { kind: 'search'; label: string; query: string; filters: SearchFilters };

export type Favorite = FavoriteInput & { id: string };
