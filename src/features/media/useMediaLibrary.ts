import { onActivated, onDeactivated, ref, shallowRef, watch } from 'vue';
import type { MediaCategory, MediaPage } from '../../../shared/media';
import type { IndexStatus } from '../../../shared/search';
import { media, search } from '@/services/client';

export function useMediaLibrary() {
  const query = ref('');
  const category = ref<MediaCategory | 'all'>('all');
  const page = shallowRef<MediaPage>({ items: [], total: 0, page: 1, pageSize: 24, counts: {} });
  const status = shallowRef<IndexStatus>();
  const busy = ref(false);
  const error = ref('');
  let active = false;
  let activation = 0;
  let request = 0;
  let pollTimer: ReturnType<typeof setTimeout>;
  let filterTimer: ReturnType<typeof setTimeout>;
  let lastLoad = 0;

  async function load(number = page.value.page) {
    lastLoad = Date.now();
    const current = ++request;
    busy.value = true;
    error.value = '';
    try {
      const result = await media.list({ query: query.value, category: category.value, page: number });
      if (!active || current !== request) return;
      if (result.ok === false) error.value = result.message;
      else page.value = result.value;
    } finally {
      if (current === request) busy.value = false;
    }
  }

  async function checkIndex(cycle: number) {
    const result = await search.status();
    if (!active || cycle !== activation) return;
    if (result.ok) {
      const previous = status.value;
      status.value = result.value;
      const systemCatalog = result.value.sources?.some(source => source.provider !== 'Harmony');
      if (!previous || previous.count !== result.value.count || previous.revision !== result.value.revision
        || (systemCatalog && Date.now() - lastLoad >= 30_000)) {
        await load();
      }
    }
    if (active && cycle === activation) {
      const building = status.value?.phase === 'running'
        || (status.value?.phase === 'idle' && !!status.value.roots.length);
      pollTimer = setTimeout(() => void checkIndex(cycle), building ? 1600 : 5000);
    }
  }

  async function refreshIndex() {
    error.value = '';
    const result = await search.rebuild();
    if (result.ok === false) error.value = result.message;
    else {
      status.value = result.value;
      await load();
    }
  }

  watch([query, category], () => {
    clearTimeout(filterTimer);
    if (active) filterTimer = setTimeout(() => void load(1), 230);
  });

  onActivated(() => {
    active = true;
    if (status.value) void load();
    void checkIndex(++activation);
  });
  onDeactivated(() => {
    active = false;
    request++;
    busy.value = false;
    clearTimeout(filterTimer);
    clearTimeout(pollTimer);
  });

  return { query, category, page, status, busy, error, load, refreshIndex };
}
