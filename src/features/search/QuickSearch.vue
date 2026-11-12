<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Button, Input, Spin, message } from 'ant-design-vue';
import { AppstoreOutlined, FileImageOutlined, FileOutlined, FolderOutlined, SearchOutlined } from '@ant-design/icons-vue';
import type { FileEntry } from '../../../shared/files';
import { MAX_SEARCH_QUERY } from '../../../shared/search';
import type { QuickSearchGroup, QuickSearchMatch } from '../../../shared/search';
import FileContextMenu from '@/features/files/FileContextMenu.vue';
import { quickSearch } from '@/services/client';

const router = useRouter();
const route = useRoute();
const root = ref<HTMLElement>();
const input = ref<{ focus(): void }>();
const query = ref('');
const expanded = ref(false);
const loading = ref(false);
const error = ref('');
const menuOpen = ref(false);
const groups = shallowRef<QuickSearchGroup[]>([]);
const selectedPath = ref<string>();
const results = computed(() => groups.value.flatMap(group => group.matches));
const selected = computed(() => results.value.find(result => result.path === selectedPath.value));
const visible = computed(() => expanded.value && !!query.value.trim());
let opening = false;

const shortcut = /Mac/i.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
const groupLabels = { folder: '文件夹', application: '程序', image: '图片', file: '文件' };
const actionLabels = { folder: '打开文件夹', application: '运行程序', image: '打开图片', file: '打开文件' };
const icons = { folder: FolderOutlined, application: AppstoreOutlined, image: FileImageOutlined, file: FileOutlined };

function dismiss() {
  expanded.value = false;
  selectedPath.value = undefined;
  menuOpen.value = false;
}

watch(() => route.name, dismiss);
watch(() => route.query.q, value => {
  query.value = typeof value === 'string' ? value.slice(0, MAX_SEARCH_QUERY) : '';
}, { immediate: true });

watch([query, visible], ([value, show], _, cleanup) => {
  selectedPath.value = undefined;
  groups.value = [];
  error.value = '';
  menuOpen.value = false;
  loading.value = show;
  if (!show) return;

  let current = true;
  const timer = setTimeout(async () => {
    const result = await quickSearch.find(value.trim());
    if (!current) return;
    if (result.ok === false) error.value = result.message;
    else groups.value = result.value;
    loading.value = false;
  }, 160);
  cleanup(() => {
    current = false;
    clearTimeout(timer);
  });
});

function update(value: string) {
  query.value = value;
  expanded.value = true;
}

function fullSearch() {
  const q = query.value.trim();
  dismiss();
  void router.push({ name: 'search', query: q ? { q } : {} });
}

async function activate(result: QuickSearchMatch) {
  if (opening) return;
  dismiss();
  if (result.group === 'folder') {
    void router.push({ name: 'files', query: { directory: result.path } });
    return;
  }
  opening = true;
  try {
    const response = await quickSearch.open(result.path);
    if (response.ok === false) void message.error(response.message);
  } finally {
    opening = false;
  }
}

function submit() {
  if (menuOpen.value) return;
  if (selected.value) void activate(selected.value);
  else fullSearch();
}

function optionId(group: QuickSearchMatch['group'], index: number) {
  return `quick-search-${group}-${index}`;
}

const activeId = computed(() => {
  if (!selected.value || !visible.value) return undefined;
  const group = groups.value.find(item => item.kind === selected.value?.group);
  if (group) return optionId(group.kind, group.matches.findIndex(item => item.path === selectedPath.value));
});

function onKey(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229 || menuOpen.value) return;
  if (event.key === 'Escape' && visible.value) {
    event.preventDefault();
    dismiss();
    return;
  }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
  if (!query.value.trim()) return;
  event.preventDefault();
  if (!visible.value) {
    expanded.value = true;
    return;
  }
  const items = results.value;
  if (!items.length) return;
  const direction = event.key === 'ArrowDown' ? 1 : -1;
  const current = items.findIndex(item => item.path === selectedPath.value);
  const next = current < 0 ? (direction > 0 ? 0 : items.length - 1)
    : (current + direction + items.length) % items.length;
  selectedPath.value = items[next].path;
  void nextTick(() => {
    if (activeId.value) document.getElementById(activeId.value)?.scrollIntoView({ block: 'nearest' });
  });
}

function contextEntry(result: QuickSearchMatch): FileEntry {
  return result.group === 'application' ? { ...result, kind: 'file' } : result;
}

function resultFor(entry: FileEntry) {
  return results.value.find(result => result.path === entry.path);
}

function menuLabel(entry: FileEntry) {
  const result = resultFor(entry);
  return result ? actionLabels[result.group] : '打开';
}

function openFromMenu(entry: FileEntry) {
  const result = resultFor(entry);
  if (result) void activate(result);
}

function openParent(entry: FileEntry) {
  const result = resultFor(entry);
  if (!result) return;
  dismiss();
  void router.push({ name: 'files', query: { directory: result.directory } });
}

function outside(target: EventTarget | null) {
  return target instanceof Element && !root.value?.contains(target)
    && !(menuOpen.value && target.closest('.harmony-file-menu'));
}

function onPointer(event: PointerEvent) {
  if (visible.value && outside(event.target)) dismiss();
}

function onFocusOut(event: FocusEvent) {
  if (visible.value && outside(event.relatedTarget)) dismiss();
}

function onShortcut(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    input.value?.focus();
    expanded.value = true;
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('keydown', onShortcut);
});
onUnmounted(() => {
  document.removeEventListener('pointerdown', onPointer, true);
  window.removeEventListener('keydown', onShortcut);
});
</script>

<template>
  <div ref="root" class="global-search" @focusout="onFocusOut">
    <form @submit.prevent="submit">
      <Input ref="input" :value="query" :maxlength="MAX_SEARCH_QUERY" role="combobox"
        aria-label="顶部全局搜索" aria-autocomplete="list" :aria-expanded="visible"
        :aria-controls="visible ? 'quick-search-list' : undefined" :aria-activedescendant="activeId"
        placeholder="搜索文件或文件夹" @update:value="update" @focus="expanded = true"
        @click="expanded = true" @keydown="onKey">
        <template #prefix><SearchOutlined aria-hidden="true" /></template>
        <template #suffix><kbd>{{ shortcut }}</kbd></template>
      </Input>
    </form>
    <section v-if="visible" class="quick-panel" aria-label="搜索预览">
      <div v-if="loading" class="quick-state" role="status"><Spin size="small" />正在搜索…</div>
      <p v-else-if="error" class="quick-state" role="alert">{{ error }}</p>
      <p v-else-if="!groups.length" class="quick-state" role="status">没有匹配的文件或文件夹</p>
      <div id="quick-search-list" class="quick-results" role="listbox" aria-label="搜索结果" :aria-busy="loading">
        <FileContextMenu v-if="groups.length" v-slot="{ row }" open-parent :open-label="menuLabel"
          @open-change="menuOpen = $event" @open-entry="openFromMenu" @open-parent="openParent">
          <div v-for="group in groups" :key="group.kind" class="quick-group" role="group" :aria-label="groupLabels[group.kind]">
            <div class="quick-group-title" aria-hidden="true">{{ groupLabels[group.kind] }}</div>
            <div v-for="(result, index) in group.matches" :id="optionId(group.kind, index)" :key="result.path"
              class="quick-option" role="option" :aria-selected="result.path === selectedPath"
              v-bind="row(contextEntry(result))" @mousedown.left.prevent @click="activate(result)">
              <span class="quick-icon" :data-kind="group.kind"><component :is="icons[group.kind]" aria-hidden="true" /></span>
              <span class="quick-name">
                <strong>{{ result.name }}</strong>
                <small :title="result.directory">{{ result.directory }}</small>
              </span>
              <span class="quick-action" aria-hidden="true">{{ actionLabels[group.kind] }}</span>
            </div>
          </div>
        </FileContextMenu>
      </div>
      <div class="quick-footer">
        <Button type="link" size="small" @click="fullSearch">查看全部结果</Button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.global-search { position: relative; z-index: 20; }
.quick-panel {
  position: absolute;
  inset: calc(100% + 8px) 0 auto;
  border: 1px solid var(--outline);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 12px 32px #10182726;
  color: var(--text);
  line-height: 1.4;
}
.quick-state { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 74px; margin: 0; padding: 12px; color: var(--muted); }
.quick-results { max-height: min(58vh, 440px); overflow: auto; overscroll-behavior: contain; }
.quick-group { padding: 5px 7px; }
.quick-group + .quick-group { border-top: 1px solid var(--outline); }
.quick-group-title { padding: 4px 7px; color: var(--muted); font-size: 12px; font-weight: 600; }
.quick-option {
  display: flex; align-items: center; gap: 9px; min-height: 45px; padding: 5px 7px;
  border-radius: 6px; cursor: pointer;
}
.quick-option:hover { background: var(--subtle); }
.quick-option[aria-selected='true'], .quick-option.context-row-active { background: var(--selection); }
.quick-icon {
  display: grid; place-items: center; flex: none; width: 28px; height: 28px;
  border-radius: 6px; background: var(--selection); color: var(--accent);
}
.quick-icon[data-kind='folder'] { background: light-dark(#f8ecdb, #463424); color: light-dark(#905515, #f2bd78); }
.quick-name { display: grid; gap: 2px; flex: 1; min-width: 0; }
.quick-name > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.quick-name small, .quick-action { color: var(--muted); font-size: 11px; }
.quick-action { white-space: nowrap; }
.quick-footer { display: flex; justify-content: flex-end; padding: 5px 7px; border-top: 1px solid var(--outline); }
@media (max-width: 640px) {
  .quick-action { display: none; }
  .quick-panel { min-width: min(265px, calc(100vw - 78px)); }
}
</style>
