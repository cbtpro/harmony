<script setup lang="ts">
import { computed, onDeactivated, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Alert, Button, Card, Empty, Input, Modal, Table, Tag } from 'ant-design-vue';
import {
  ArrowUpOutlined, FileOutlined, FolderOpenOutlined, FolderOutlined, HomeOutlined, LinkOutlined,
  PlusOutlined, ReloadOutlined, SearchOutlined,
} from '@ant-design/icons-vue';
import type { FileEntry } from '../../shared/files';
import FileContextMenu from '@/features/files/FileContextMenu.vue';
import FilePreview from '@/features/files/FilePreview.vue';
import DeleteDialog from '@/features/files/DeleteDialog.vue';
import RenameDialog from '@/features/files/RenameDialog.vue';
import { useFilePreview } from '@/features/files/useFilePreview';
import FavoriteDialog from '@/features/workspace/FavoriteDialog.vue';
import type { FavoriteInput } from '../../shared/favorites';
import { useFileBrowser } from '@/features/files/useFileBrowser';
import { useWorkspaceStatus } from '@/features/workspace/status';

import { files } from '@/services/client';

const browser = useFileBrowser(files);
const { directory, address, query, busy, error, entries } = browser;
const preview = useFilePreview(() => entries.value);
const { path: previewPath, candidates: previewEntries } = preview;
const favorite = ref<FavoriteInput>();
const selected = ref<string[]>([]);
const renaming = ref<string[]>();
const selection = computed(() => ({
  selectedRowKeys: selected.value,
  onChange: (keys: (string | number)[]) => { selected.value = keys.map(String); },
  getCheckboxProps: (entry: FileEntry) => ({ disabled: entry.kind !== 'file' }),
}));
watch([() => directory.value?.path, query], () => { selected.value = []; });
const route = useRoute();
const router = useRouter();
const creating = ref(false);
const folderName = ref('');
const folderError = ref('');
const deletion = ref<{ entry: FileEntry; permanent: boolean }>();
const columns = [
  { title: '名称', key: 'name' },
  { title: '类型', key: 'kind', width: 92 },
  { title: '操作', key: 'actions', width: 204 },
];
const kindLabels = { directory: '文件夹', file: '文件', link: '链接', other: '其他' };
const kindIcons = { directory: FolderOutlined, file: FileOutlined, link: LinkOutlined, other: FileOutlined };
const pagination = { pageSize: 25, hideOnSinglePage: true, showSizeChanger: false };

useWorkspaceStatus(() => {
  if (busy.value) return '正在处理文件';
  if (!directory.value) return '';
  return query.value.trim()
    ? `匹配 ${entries.value.length} 项 · 共 ${directory.value.entries.length} 项`
    : `${entries.value.length} 项`;
});

let appliedPath: string | null | undefined;
watch([() => route.name, () => route.query.directory, busy], ([name, value, waiting]) => {
  if (name !== 'files' || waiting) return;
  const path = typeof value === 'string' ? value : null;
  if (path === appliedPath) return;
  appliedPath = path;
  if (path !== directory.value?.path) void browser.navigate(path ?? undefined);
}, { immediate: true });

function goToDirectory(path?: string) {
  if (path === route.query.directory) {
    void browser.navigate(path);
    return;
  }
  void router.push({ name: 'files', query: path ? { directory: path } : {} });
}

async function chooseDirectory() {
  const previous = directory.value?.path;
  await browser.choose();
  const selected = directory.value?.path;
  if (route.name === 'files' && selected && selected !== previous) goToDirectory(selected);
}

function openEntry(entry: FileEntry) {
  if (entry.kind === 'directory') goToDirectory(entry.path);
  else void browser.open(entry);
}

onDeactivated(() => {
  creating.value = false;
  deletion.value = undefined;
  favorite.value = undefined;
});

function showFolderDialog() {
  folderName.value = '';
  folderError.value = '';
  creating.value = true;
}

async function createFolder() {
  if (busy.value || !folderName.value.trim()) return;
  await browser.create(folderName.value);
  folderError.value = error.value;
  if (!folderError.value) creating.value = false;
}

</script>

<template>
  <section class="page files-page" aria-labelledby="files-title" @keydown="preview.key">
    <div class="page-heading">
      <h1 id="files-title">文件管理</h1>
      <div class="toolbar">
        <Button :disabled="busy || !selected.length" @click="renaming = [...selected]">批量重命名</Button>
        <Button type="primary" :disabled="busy || !directory" @click="showFolderDialog">
          <template #icon><PlusOutlined /></template>新建文件夹
        </Button>
      </div>
    </div>

    <Card size="small" class="directory-panel" aria-label="目录导航">
      <div class="toolbar directory-actions">
        <Button :disabled="busy" @click="goToDirectory()">
          <template #icon><HomeOutlined /></template>主目录
        </Button>
        <Button :disabled="busy || !directory?.parent" @click="goToDirectory(directory?.parent ?? undefined)">
          <template #icon><ArrowUpOutlined /></template>上一级
        </Button>
        <Button :disabled="busy" @click="chooseDirectory">
          <template #icon><FolderOpenOutlined /></template>选择目录
        </Button>
        <Button :disabled="busy || !directory" @click="browser.navigate(directory?.path)">
          <template #icon><ReloadOutlined /></template>刷新
        </Button>
        <Button :disabled="!directory" @click="directory && (favorite = { kind: 'directory', directory: directory.path, label: directory.path.split(/[\\/]/).filter(Boolean).pop() || directory.path })">收藏目录</Button>
      </div>
      <form class="path-form" @submit.prevent="goToDirectory(address)">
        <Input v-model:value="address" aria-label="目录路径" placeholder="输入目录的绝对路径"
          required :disabled="busy">
          <template #prefix><FolderOutlined /></template>
        </Input>
        <Button html-type="submit" :disabled="busy">前往</Button>
      </form>
    </Card>

    <Alert v-if="error && !creating" role="alert" type="error" show-icon :message="error" />
    <Card size="small" class="table-section">
      <template #title><span class="table-title">目录内容</span></template>
      <template #extra>
        <Input v-model:value="query" class="table-filter" type="search" aria-label="筛选文件"
          placeholder="筛选当前目录" allow-clear>
          <template #prefix><SearchOutlined /></template>
        </Input>
      </template>
      <FileContextMenu v-slot="{ row }" :disabled="busy" copy-file trash permanent-delete
        @open-entry="openEntry" @copy-file="browser.copy" @trash-entry="deletion = { entry: $event, permanent: false }"
        @delete-entry="deletion = { entry: $event, permanent: true }">
        <Table size="small" :columns="columns" :data-source="entries" row-key="path" :custom-row="(entry: FileEntry) => ({ ...row(entry), ...preview.row(entry) })"
          :pagination="pagination" :loading="busy" :row-selection="selection" table-layout="fixed">
          <template #emptyText><Empty :image="Empty.PRESENTED_IMAGE_SIMPLE" description="没有可显示的项目" /></template>
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              <Button type="link" class="entry-link" :disabled="busy || record.kind === 'other'" @click="openEntry(record)">
                <span class="file-label">
                  <span class="entry-icon" :class="'entry-icon-' + record.kind">
                    <component :is="kindIcons[record.kind as FileEntry['kind']]" aria-hidden="true" />
                  </span>
                  <span class="file-name">{{ record.name }}</span>
                </span>
              </Button>
            </template>
            <template v-else-if="column.key === 'kind'">
              <Tag :color="record.kind === 'directory' ? 'blue' : undefined">{{ kindLabels[record.kind as FileEntry['kind']] }}</Tag>
            </template>
            <template v-else-if="column.key === 'actions'">
              <Button v-if="record.kind === 'file'" size="small" type="text" @click="preview.open(record)">预览</Button>
              <Button v-if="record.kind === 'file'" size="small" type="text" class="file-action"
                :disabled="busy" @click="browser.copy(record)">复制到…</Button>
              <Button size="small" type="text" class="file-action" :disabled="busy"
                @click="deletion = { entry: record, permanent: false }">移到废纸篓</Button>
            </template>
          </template>
        </Table>
      </FileContextMenu>
    </Card>

    <FilePreview v-model:path="previewPath" :entries="previewEntries" />
    <FavoriteDialog :item="favorite" @close="favorite = undefined" />
    <RenameDialog :paths="renaming" @close="renaming = undefined" @completed="selected = []; browser.navigate(directory?.path)" />
    <Modal v-model:open="creating" title="新建文件夹" ok-text="新建" :confirm-loading="busy"
      :ok-button-props="{ disabled: !folderName.trim() }" @ok="createFolder">
      <form @submit.prevent="createFolder">
        <Input v-model:value="folderName" aria-label="文件夹名称" placeholder="输入文件夹名称" :disabled="busy" />
      </form>
      <Alert v-if="folderError" role="alert" class="dialog-error" type="error" show-icon :message="folderError" />
    </Modal>
    <DeleteDialog :request="deletion" @close="deletion = undefined" @completed="selected = []; browser.navigate(directory?.path)" />
  </section>
</template>

<style scoped>
.entry-link.ant-btn { max-width: 100%; height: auto; padding: 2px 0; text-align: left; white-space: normal; }
.entry-link.ant-btn .file-label { display: inline-flex; }
.dialog-error { margin-top: 12px; }
</style>
