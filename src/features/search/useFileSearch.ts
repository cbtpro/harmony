import { computed, onActivated, onDeactivated, onUnmounted, ref, shallowRef, watch } from 'vue';
import type { Result } from '../../../shared/files';
import type { IndexStatus, SearchApi, SearchResults } from '../../../shared/search';

type RemoveRule = 'removeRoot' | 'removeExcluded';
type IndexCommand = Exclude<keyof SearchApi, 'search' | 'status' | RemoveRule>;

export function useFileSearch(api: SearchApi) {
  const status = shallowRef<IndexStatus>({ phase: 'idle', roots: [], excluded: [], revision: 0, count: 0, skipped: 0 });
  const results = shallowRef<SearchResults>();
  const query = ref('');
  const busy = ref(false);
  const error = ref('');
  const searchError = ref('');
  const active = computed(() =>
    ['running', 'paused', 'stopping'].includes(status.value.phase));

  const visible = ref(false);
  let disposed = false;
  let statusRequest = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (visible.value && !busy.value && status.value.phase !== 'paused') {
      pollTimer = setTimeout(() => void updateStatus(api.status), 1000);
    }
  }

  async function updateStatus(request: () => Promise<Result<IndexStatus>>) {
    const id = ++statusRequest;
    try {
      const response = await request();
      if (disposed || id !== statusRequest) return;
      if (response.ok === false) {
        error.value = response.message;
        return;
      }
      // Commands such as pause return scan state without changing the settings warning.
      status.value = { ...status.value, ...response.value };
      schedulePoll();
    } catch {
      if (!disposed && id === statusRequest) error.value = '无法读取索引状态。';
    }
  }

  async function command(request: IndexCommand | (() => Promise<Result<IndexStatus>>)) {
    if (busy.value) return;
    busy.value = true;
    error.value = '';
    clearTimeout(pollTimer);
    await updateStatus(typeof request === 'string' ? () => api[request]() : request);
    busy.value = false;
    schedulePoll();
  }

  watch([query, () => status.value.count, () => status.value.revision, visible], (_, previous, cleanup) => {
    if (query.value !== previous[0] || status.value.revision !== previous[2]) results.value = undefined;
    searchError.value = '';
    if (!visible.value || !query.value.trim()) return;

    let current = true;
    const timer = setTimeout(async () => {
      try {
        const response = await api.search(query.value);
        if (!current) return;
        if (response.ok === true) results.value = response.value;
        else searchError.value = response.message;
      } catch {
        if (current) searchError.value = '搜索失败。';
      }
    }, 200);
    cleanup(() => {
      current = false;
      clearTimeout(timer);
    });
  });

  onActivated(() => {
    visible.value = true;
    if (!busy.value) void updateStatus(api.status);
  });
  onDeactivated(() => {
    visible.value = false;
    clearTimeout(pollTimer);
  });
  onUnmounted(() => {
    disposed = true;
    clearTimeout(pollTimer);
  });

  return { status, active, busy, error, searchError, query, results, command,
    removeRule: (action: RemoveRule, path: string) => command(() => api[action](path)),
  };
}
