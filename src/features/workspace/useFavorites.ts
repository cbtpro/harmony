import { readonly, ref, shallowRef } from 'vue';
import type { Favorite, FavoriteInput } from '../../../shared/favorites';
import { favoritesApi } from '@/services/client';

const items = shallowRef<Favorite[]>([]);
const pending = ref(false);
const error = ref('');
let revision = 0;

async function update(request: () => ReturnType<typeof favoritesApi.list>) {
  const version = ++revision;
  pending.value = true;
  error.value = '';
  const result = await request();
  if (version !== revision) return result.ok;
  pending.value = false;
  if (result.ok) items.value = result.value;
  else error.value = result.message;
  return result.ok;
}

export function useFavorites() {
  return {
    items: readonly(items), pending: readonly(pending), error: readonly(error),
    load: () => update(favoritesApi.list),
    add: (input: FavoriteInput) => update(() => favoritesApi.add(input)),
    remove: (id: string) => update(() => favoritesApi.remove(id)),
  };
}
