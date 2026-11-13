<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Alert, Button, Card, Input, Table, Tabs } from 'ant-design-vue';
import type { FileEntry } from '../../../shared/files';
import { useFileBrowser } from './useFileBrowser';
import { useFilePreview } from './useFilePreview';
import FilePreview from './FilePreview.vue';
import { files } from '@/services/client';

const props = defineProps<{ title: string }>();
const emit = defineEmits<{ (event: 'location', directory?: string): void; (event: 'selection', paths: string[]): void }>();
const browser = useFileBrowser(files);
const { directory, address, entries, busy, error } = browser;
const preview = useFilePreview(() => entries.value);
const { path: previewPath, candidates: previewEntries } = preview;
interface PaneTab { id: string; path?: string }
const tabs = ref<PaneTab[]>([{ id: '1' }]);
const activeTab = ref('1');
const selected = ref<string[]>([]);
let sequence = 1;
const columns = [{ title: '名称', key: 'name' }, { title: '操作', key: 'actions', width: 76 }];
const selection = computed(() => ({
  selectedRowKeys: selected.value,
  onChange: (keys: (number | string)[]) => select(keys.map(String)),
  getCheckboxProps: (entry: FileEntry) => ({ disabled: entry.kind !== 'file' }),
}));

function select(paths: string[]) {
  selected.value = paths;
  emit('selection', paths);
}
function sync() {
  const tab = tabs.value.find(item => item.id === activeTab.value);
  if (tab) tab.path = directory.value?.path;
  emit('location', directory.value?.path);
  select([]);
}
async function navigate(path?: string) {
  await browser.navigate(path);
  sync();
}
async function choose() {
  await browser.choose();
  sync();
}
async function activate(key: string | number) {
  if (busy.value || key === activeTab.value) return;
  const tab = tabs.value.find(item => item.id === key);
  if (!tab) return;
  activeTab.value = tab.id;
  await navigate(tab.path);
}
function edit(key: string | number | Event, action: 'add' | 'remove') {
  if (busy.value) return;
  if (action === 'add') {
    if (tabs.value.length >= 12) return;
    const id = String(++sequence);
    tabs.value.push({ id, path: directory.value?.path });
    void activate(id);
    return;
  }
  const index = tabs.value.findIndex(item => item.id === key);
  if (index === -1 || tabs.value.length <= 1) return;
  if (key === activeTab.value) void activate((tabs.value[index - 1] ?? tabs.value[index + 1]).id);
  tabs.value.splice(index, 1);
}
function open(entry: FileEntry) {
  if (entry.kind === 'directory') void navigate(entry.path);
  else void browser.open(entry);
}
function titleFor(path?: string) {
  return path?.split(/[\\/]/).filter(Boolean).pop() ?? '主目录';
}
defineExpose({ refresh: () => navigate(directory.value?.path) });
onMounted(() => void navigate());
</script>

<template>
  <Card size="small" :title="title" :aria-label="title" class="file-pane" @keydown="preview.key">
    <Tabs :active-key="activeTab" type="editable-card" size="small" :hide-add="tabs.length >= 12" @change="activate" @edit="edit">
      <Tabs.TabPane v-for="tab in tabs" :key="tab.id" :tab="titleFor(tab.path)" :closable="tabs.length > 1" />
    </Tabs>
    <div class="toolbar pane-nav">
      <Button :disabled="busy || !directory?.parent" @click="navigate(directory?.parent ?? undefined)">上一级</Button>
      <Button :disabled="busy" @click="choose">选择目录</Button>
      <Button :disabled="busy" @click="navigate(directory?.path)">刷新</Button>
    </div>
    <form class="pane-nav toolbar" @submit.prevent="navigate(address)">
      <Input v-model:value="address" :aria-label="title + '路径'" :disabled="busy" required />
      <Button html-type="submit" :disabled="busy">前往</Button>
    </form>
    <Alert v-if="error" role="alert" type="error" :message="error" />
    <Table size="small" :columns="columns" :data-source="entries" row-key="path" :row-selection="selection"
      :custom-row="preview.row" :loading="busy" :pagination="{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }">
      <template #bodyCell="{ column, record }">
        <Button v-if="column.key === 'name'" class="pane-name" type="link" :title="record.name" @click="open(record)">{{ record.kind === 'directory' ? '📁 ' : '' }}{{ record.name }}</Button>
        <Button v-else-if="record.kind === 'file'" size="small" type="text" @click="preview.open(record)">预览</Button>
      </template>
    </Table>
    <FilePreview v-model:path="previewPath" :entries="previewEntries" />
  </Card>
</template>

<style scoped>
.file-pane { min-width: 0; }
.pane-nav { margin-bottom: 8px; flex-wrap: wrap; }
.pane-nav .ant-input { flex: 1 1 190px; min-width: 0; }
.pane-name.ant-btn { max-width: 100%; text-align: left; height: auto; padding: 0; white-space: normal; overflow-wrap: anywhere; }
</style>
