<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Alert, Badge, Button, Card, Collapse, Empty, Input, Table, Tag } from 'ant-design-vue';
import { FileOutlined, FolderOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons-vue';
import { useWorkspaceStatus } from '@/features/workspace/status';
import FileContextMenu from '@/features/files/FileContextMenu.vue';
import type { FileEntry } from '../../shared/files';
import type { IndexStatus } from '../../shared/search';
import { MAX_SEARCH_QUERY } from '../../shared/search';
import { useFileSearch } from '@/features/search/useFileSearch';

import { files, search } from '@/services/client';

const { status, active, busy, error, searchError, query, results, command, removeRule } =
  useFileSearch(search);
const openError = ref('');
const opening = ref(false);
const route = useRoute();
const router = useRouter();
const columns = [
  { title: '名称与路径', key: 'name' },
  { title: '操作', key: 'actions', width: 178 },
];
const pagination = { pageSize: 20, hideOnSinglePage: true, showSizeChanger: false };
const phaseBadge: Record<IndexStatus['phase'], 'default' | 'processing' | 'success' | 'warning' | 'error'> = {
  idle: 'default', running: 'processing', paused: 'warning', stopping: 'processing',
  ready: 'success', stopped: 'default', failed: 'error',
};

function routeQuery(value: unknown) {
  return typeof value === 'string' ? value.slice(0, MAX_SEARCH_QUERY) : '';
}

let appliedQuery: string | undefined;
watch([() => route.name, () => route.query.q], ([name, value]) => {
  if (name !== 'search') return;
  const next = routeQuery(value);
  if (next === appliedQuery) return;
  appliedQuery = next;
  query.value = next;
}, { immediate: true });

watch(query, (value, _, cleanup) => {
  if (route.name !== 'search' || value === routeQuery(route.query.q)) return;
  const location = route.fullPath;
  const timer = setTimeout(() => {
    if (route.fullPath === location) {
      void router.replace({ name: 'search', query: { ...route.query, q: value || undefined } });
    }
  }, 250);
  cleanup(() => clearTimeout(timer));
});

const phaseText = {
  idle: '等待自动索引',
  running: '正在建立索引',
  paused: '索引已暂停',
  stopping: '正在停止索引',
  ready: '索引已完成',
  stopped: '本次索引已停止，保留已收录的项目',
  failed: '索引未能完成，可重新建立',
};

const indexStatusText = computed(() => status.value.failure ?? phaseText[status.value.phase]);
useWorkspaceStatus(() => `${indexStatusText.value} · 已收录 ${status.value.count} 项`);

function openLocation(entry: FileEntry) {
  const directory = entry.kind === 'directory' ? entry.path : 'directory' in entry ? entry.directory : undefined;
  if (typeof directory === 'string') void router.push({ name: 'files', query: { directory } });
}

function openEntry(entry: FileEntry) {
  if (entry.kind === 'directory') openLocation(entry);
  else void openFile(entry.path);
}

async function openFile(path: string) {
  if (opening.value) return;
  opening.value = true;
  openError.value = '';
  try {
    const result = await files.open(path);
    if (result.ok === false) openError.value = result.message;
  } catch {
    openError.value = '无法打开文件。';
  } finally {
    opening.value = false;
  }
}
</script>

<template>
  <section class="page search-page" aria-labelledby="search-title">
    <div class="page-heading"><h1 id="search-title">全局搜索</h1></div>

    <Input v-model:value="query" class="search-field" size="large" type="search" :maxlength="MAX_SEARCH_QUERY"
      aria-label="搜索已索引的文件" placeholder="输入文件或文件夹名称" allow-clear>
      <template #prefix><SearchOutlined /></template>
    </Input>

    <Alert v-if="error || searchError || openError" role="alert" type="error" show-icon :message="error || searchError || openError" />
    <Alert v-if="results?.truncated" type="info" show-icon
      :message="`仅显示前 ${results.matches.length} 项，可缩小搜索范围。`" />
    <div class="search-layout" :class="{ 'search-layout-with-results': query.trim() }">
      <Card v-if="query.trim()" size="small" title="搜索结果" class="table-section search-results">
        <FileContextMenu v-slot="{ row }" :disabled="opening" open-parent
          @open-entry="openEntry" @open-parent="openLocation">
          <Table size="small" :columns="columns" :data-source="results?.matches ?? []" row-key="path" :custom-row="row"
            :pagination="pagination" table-layout="fixed">
            <template #emptyText>
              <Empty :image="Empty.PRESENTED_IMAGE_SIMPLE"
                :description="results ? '索引中没有匹配项目' : '正在搜索'" />
            </template>
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'name'">
                <span class="file-label">
                  <FolderOutlined v-if="record.kind === 'directory'" class="folder-mark" />
                  <FileOutlined v-else />
                  <strong class="file-name">{{ record.name }}</strong>
                </span>
                <div class="result-path">{{ record.path }}</div>
              </template>
              <template v-else-if="column.key === 'actions'">
                <RouterLink :to="{ path: '/', query: { directory: record.kind === 'directory' ? record.path : record.directory } }">
                  {{ record.kind === 'directory' ? '浏览文件夹' : '打开所在目录' }}
                </RouterLink>
                <Button v-if="record.kind === 'file'" size="small" type="text" class="file-action"
                  :disabled="opening" @click="openFile(record.path)">打开文件</Button>
              </template>
            </template>
          </Table>
        </FileContextMenu>
      </Card>

      <Collapse class="index-panel" :default-active-key="['index']">
        <Collapse.Panel key="index" header="文件索引">
          <template #extra>
            <span role="status"><Badge :status="phaseBadge[status.phase]" :text="indexStatusText" /></span>
          </template>
          <Alert v-if="status.settingsWarning" role="alert" class="index-alert" type="warning" show-icon :message="status.settingsWarning" />
          <p class="index-description">
            已收录 {{ status.count }} 项<span v-if="status.skipped">，{{ status.skipped }} 个目录未能完整读取</span>。
            规则自动保存，白名单重叠时只扫描一次，黑名单优先。
          </p>
          <div class="index-rules">
            <div v-for="rule in [
              { title: '白名单', paths: status.roots, add: 'addRoot', remove: 'removeRoot', color: 'blue' },
              { title: '黑名单', paths: status.excluded, add: 'addExcluded', remove: 'removeExcluded', color: 'orange' },
            ] as const" :key="rule.title" class="rule">
              <div class="rule-heading">
                <h3>{{ rule.title }}</h3><Tag :color="rule.color">{{ rule.paths.length }}</Tag>
              </div>
              <p v-if="!rule.paths.length">{{ rule.add === 'addRoot' ? '白名单为空，自动索引已停用。' : '尚未添加排除目录。' }}</p>
              <ul v-else :aria-label="rule.title">
                <li v-for="path in rule.paths" :key="path">
                  <span :title="path">{{ path }}</span>
                  <Button size="small" type="text" :disabled="busy" :aria-label="`从${rule.title}移除 ${path}`"
                    @click="removeRule(rule.remove, path)">移除</Button>
                </li>
              </ul>
              <Button size="small" :disabled="busy" @click="command(rule.add)">
                <template #icon><PlusOutlined /></template>添加{{ rule.title }}目录
              </Button>
            </div>
          </div>
          <div class="toolbar">
            <Button size="small" :disabled="busy || active || !status.roots.length" @click="command('rebuild')">立即重建索引</Button>
            <Button v-if="status.phase === 'running'" size="small" :disabled="busy" @click="command('pause')">暂停索引</Button>
            <Button v-if="status.phase === 'paused'" size="small" :disabled="busy" @click="command('resume')">继续索引</Button>
            <Button v-if="status.resumable && ['stopped', 'failed'].includes(status.phase)" size="small"
              :disabled="busy" @click="command('resume')">从断点继续</Button>
            <Button v-if="active" size="small" :disabled="busy || status.phase === 'stopping'"
              @click="command('stop')">停止本次索引</Button>
          </div>
        </Collapse.Panel>
      </Collapse>
    </div>
  </section>
</template>

<style scoped>
.search-layout { display: grid; align-items: start; gap: 18px; }
.search-layout > * { min-width: 0; }
.index-panel { background: var(--surface); border-color: var(--outline); }
@media (min-width: 1250px) {
  .search-layout-with-results { grid-template-columns: minmax(0, 1fr) minmax(300px, 32%); }
  .search-layout-with-results .index-rules { grid-template-columns: minmax(0, 1fr); }
}
.index-panel :deep(.ant-collapse-header) { align-items: baseline; }
.index-panel :deep(.ant-collapse-header-text) { flex: none; }
.index-panel :deep(.ant-collapse-extra) { min-width: 0; margin-inline-start: auto; text-align: end; }
.index-alert { margin-bottom: 12px; }
.index-description { margin: 0 0 12px; color: var(--muted); }
.index-rules { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 12px; margin-bottom: 12px; }
.rule { min-width: 0; padding: 12px; border: 1px solid var(--outline); border-radius: 8px; }
.rule-heading { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.rule h3 { margin: 0; font-size: 14px; }
.rule p { margin: 0 0 10px; color: var(--muted); }
.rule ul { list-style: none; padding: 0; margin: 0 0 8px; }
.rule li { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.rule li span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
