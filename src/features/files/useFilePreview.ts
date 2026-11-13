import { computed, onDeactivated, ref } from 'vue';
import type { FileEntry } from '../../../shared/files';

export function useFilePreview(entries: () => FileEntry[]) {
  const candidates = computed(() => entries().filter(entry => entry.kind === 'file'));
  const selected = ref<string>();
  const path = ref<string>();

  function open(entry?: FileEntry) {
    if (entry?.kind === 'file') path.value = entry.path;
    else if (candidates.value.some(candidate => candidate.path === selected.value)) path.value = selected.value;
  }

  function key(event: KeyboardEvent) {
    if (event.key !== ' ' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || (event.target instanceof HTMLElement && event.target.closest('input,textarea,button,a,select,[contenteditable],.ant-modal'))) return;
    if (!candidates.value.some(candidate => candidate.path === selected.value)) return;
    event.preventDefault();
    open();
  }

  function row(entry: FileEntry) {
    return {
      tabindex: entry.kind === 'file' ? 0 : undefined,
      onFocus: () => { selected.value = entry.kind === 'file' ? entry.path : undefined; },
      onClick: () => { selected.value = entry.kind === 'file' ? entry.path : undefined; },
      'data-preview-selected': selected.value === entry.path ? 'true' : undefined,
    };
  }

  onDeactivated(() => { path.value = undefined; });
  return { candidates, selected, path, open, key, row };
}
