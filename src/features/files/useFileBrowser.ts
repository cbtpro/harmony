import { computed, ref, shallowRef } from 'vue';
import type { Directory, FileEntry, FilesApi, Result } from '../../../shared/files';

export function useFileBrowser(api: FilesApi) {
  const directory = shallowRef<Directory>();
  const address = ref('');
  const query = ref('');
  const busy = ref(false);
  const error = ref('');
  const entries = computed(() => {
    const keyword = query.value.trim().toLocaleLowerCase();
    return directory.value?.entries.filter(entry =>
      entry.name.toLocaleLowerCase().includes(keyword)) ?? [];
  });

  async function run(operation: () => Promise<void>) {
    if (busy.value) return;
    busy.value = true;
    error.value = '';
    try {
      await operation();
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : '文件操作失败。';
    } finally {
      busy.value = false;
    }
  }

  async function unwrap<T>(request: Promise<Result<T>>): Promise<T> {
    const result = await request;
    if (result.ok === false) throw new Error(result.message);
    return result.value;
  }

  async function load(path?: string) {
    const next = await unwrap(api.list(path));
    if (next.path !== directory.value?.path) query.value = '';
    directory.value = next;
    address.value = next.path;
  }

  async function choose() {
    const path = await unwrap(api.choose());
    if (path !== null) await load(path);
  }

  async function mutate(action: (path: string) => Promise<Result<void>>) {
    const path = directory.value?.path;
    if (!path) return;
    await unwrap(action(path));
    try {
      await load(path);
    } catch {
      throw new Error('操作已完成，但列表刷新失败。请重新打开目录。');
    }
  }

  return {
    directory, address, query, busy, error, entries,
    navigate: (path?: string) => run(() => load(path)),
    choose: () => run(choose),
    create: (name: string) => run(() => mutate(path => api.mkdir(path, name))),
    open: (entry: FileEntry) => run(async () => {
      if (entry.kind === 'directory') await load(entry.path);
      else await unwrap(api.open(entry.path));
    }),
    copy: (entry: FileEntry) => run(async () => {
      const destination = await unwrap(api.choose());
      if (destination !== null) await unwrap(api.copyFile(entry.path, destination));
    }),
  };
}
