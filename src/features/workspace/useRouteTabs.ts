import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { RouteLocationNormalizedLoaded } from 'vue-router';

interface WorkspaceTab {
  name: string;
  title: string;
  cacheName: string;
  location: string;
  pinned: boolean;
}

function asTab(route: RouteLocationNormalizedLoaded): WorkspaceTab | undefined {
  if (typeof route.name !== 'string' || !route.meta.title || !route.meta.cacheName) return;
  return {
    name: route.name,
    title: route.meta.title,
    cacheName: route.meta.cacheName,
    location: route.fullPath,
    pinned: route.meta.pinned === true,
  };
}

export function useRouteTabs() {
  const route = useRoute();
  const router = useRouter();
  const first = asTab(router.resolve({ name: 'files' }));
  const tabs = ref<WorkspaceTab[]>(first ? [first] : []);
  const scrollArea = ref<HTMLElement>();
  const scrollPositions = new Map<string, number>();
  const cacheNames = computed(() => tabs.value.map(tab => tab.cacheName));

  watch(() => route.fullPath, () => {
    const current = asTab(route);
    if (!current) return;
    const existing = tabs.value.find(tab => tab.name === current.name);
    if (existing) existing.location = current.location;
    else tabs.value.push(current);
  }, { immediate: true });

  watch(() => route.name, async (name, previous) => {
    if (typeof previous === 'string' && scrollArea.value) {
      scrollPositions.set(previous, scrollArea.value.scrollTop);
    }
    await nextTick();
    if (route.name === name && scrollArea.value && typeof name === 'string') {
      scrollArea.value.scrollTop = scrollPositions.get(name) ?? 0;
    }
  });

  function locationFor(name: string) {
    return tabs.value.find(tab => tab.name === name)?.location ?? { name };
  }

  function activate(name: string | number) {
    if (typeof name === 'string' && name !== route.name) void router.push(locationFor(name));
  }

  async function close(name: string | number | MouseEvent | KeyboardEvent) {
    const index = tabs.value.findIndex(tab => tab.name === name);
    const tab = tabs.value[index];
    if (!tab || tab.pinned) return;

    if (route.name === name) {
      const neighbor = tabs.value[index - 1] ?? tabs.value[index + 1];
      if (await router.push(neighbor.location)) return;
      if (route.name === name) return;
    }
    tabs.value = tabs.value.filter(item => item.name !== name);
    scrollPositions.delete(tab.name);
  }

  return { tabs, cacheNames, scrollArea, locationFor, activate, close };
}
