<script setup lang="ts">
import { computed, onDeactivated, ref, shallowRef } from 'vue';
import { useRouter } from 'vue-router';
import { Alert, Button, Card, Descriptions, Drawer, Empty, Input, Modal, Select, Space, Table, Tabs, Tag } from 'ant-design-vue';
import { AudioOutlined, BookOutlined, FileImageOutlined, FileOutlined, ReloadOutlined, SearchOutlined, VideoCameraOutlined } from '@ant-design/icons-vue';
import { mediaCategories } from '../../shared/media';
import type { FileEntry, Result } from '../../shared/files';
import type { MediaCategory, MediaDetails, MediaEntry, MediaMetadata, MediaSource, ScrapeKind } from '../../shared/media';
import FileContextMenu from '@/features/files/FileContextMenu.vue';
import { useMediaLibrary } from '@/features/media/useMediaLibrary';
import { useWorkspaceStatus } from '@/features/workspace/status';
import { files, media } from '@/services/client';

const router = useRouter();
const library = useMediaLibrary();
const { query, category, page, status, busy, error, load, refreshIndex } = library;
const actionError = ref('');
const detail = shallowRef<MediaEntry>();
const draft = ref<MediaMetadata>({ title: '', source: 'manual' });
const details = shallowRef<MediaDetails>();
const detailTab = ref('metadata');
const editBusy = ref(false);
const detailError = ref('');
const term = ref('');
const region = ref('US');
const scrapeKind = ref<ScrapeKind>('movie');
const candidates = shallowRef<MediaMetadata[]>();
const renameTarget = shallowRef<MediaEntry>();
const stem = ref('');
const renameError = ref('');
const renaming = ref(false);
let detailSession = 0;

const categories = Object.entries(mediaCategories).map(([value, label]) => ({ value: value as MediaCategory, label }));
const options = computed(() => [
  { value: 'all', label: '全部类型' },
  ...categories.map(item => ({ ...item, label: `${item.label}（${page.value.counts[item.value] ?? 0}）` })),
]);
const scrapeOptions: Array<{ value: ScrapeKind; label: string }> = [
  { value: 'movie', label: '电影' }, { value: 'series', label: '剧集' }, { value: 'music', label: '音乐' },
  { value: 'podcast', label: '播客' }, { value: 'audiobook', label: '有声书' }, { value: 'book', label: '电子书' },
];
const regions = [
  { value: 'US', label: '美国' }, { value: 'CN', label: '中国大陆' },
  { value: 'HK', label: '中国香港' }, { value: 'TW', label: '中国台湾' }, { value: 'JP', label: '日本' },
];
const sourceLabels: Record<MediaSource, string> = {
  manual: '手动编辑', local: '文件内嵌资料', itunes: 'iTunes', 'open-library': 'Open Library', wikidata: 'Wikidata',
};
const columns = [
  { title: '媒体名称', key: 'name' },
  { title: '类型', key: 'category', width: 135 },
  { title: '操作', key: 'actions', width: 172 },
];
const pagination = computed(() => ({
  current: page.value.page, pageSize: page.value.pageSize, total: page.value.total,
  hideOnSinglePage: true, showSizeChanger: false, onChange: (number: number) => void load(number),
}));
const indexBusy = computed(() => ['running', 'paused', 'stopping'].includes(status.value?.phase ?? 'idle'));
const total = computed(() => Object.values(page.value.counts).reduce((sum, value) => sum + value, 0));
const suffix = computed(() => renameTarget.value ? extension(renameTarget.value) : '');
useWorkspaceStatus(() => `媒体库 · ${page.value.total} 项`);

function extension(entry: MediaEntry) {
  return entry.name.slice(entry.name.lastIndexOf('.'));
}

function icon(category: MediaCategory) {
  if (['movie', 'series', 'animation', 'video'].includes(category)) return VideoCameraOutlined;
  if (['music', 'podcast', 'audio', 'audiobook'].includes(category)) return AudioOutlined;
  if (category === 'image') return FileImageOutlined;
  if (['book', 'comic'].includes(category)) return BookOutlined;
  return FileOutlined;
}

function categoryLabel(value: MediaCategory) { return mediaCategories[value]; }

function guessScrape(category: MediaCategory): ScrapeKind {
  if (category === 'series' || category === 'animation') return 'series';
  if (category === 'book' || category === 'comic') return 'book';
  if (category === 'audio' || category === 'music') return 'music';
  if (category === 'podcast' || category === 'audiobook') return category;
  return 'movie';
}

async function openEntry(entry: FileEntry) {
  actionError.value = '';
  const result = await files.open(entry.path);
  if (result.ok === false) actionError.value = result.message;
}

function openParent(entry: FileEntry) {
  if ('directory' in entry && typeof entry.directory === 'string') {
    void router.push({ name: 'files', query: { directory: entry.directory } });
  }
}

function openDetails(entry: MediaEntry) {
  detailSession++;
  detail.value = entry;
  const name = entry.name.slice(0, -extension(entry).length);
  draft.value = entry.metadata ? { ...entry.metadata } : { title: name, category: entry.category, source: 'manual' };
  details.value = undefined;
  candidates.value = undefined;
  detailError.value = '';
  editBusy.value = false;
  detailTab.value = 'metadata';
  term.value = draft.value.title.replace(/[._]+/g, ' ').slice(0, 128);
  scrapeKind.value = guessScrape(entry.category);
}

function closeDetails() {
  detailSession++;
  detail.value = undefined;
  editBusy.value = false;
}

async function edit<T>(operation: () => Promise<Result<T>>, apply: (value: T) => void) {
  if (editBusy.value || !detail.value) return;
  const current = detailSession;
  editBusy.value = true;
  detailError.value = '';
  try {
    const result = await operation();
    if (current !== detailSession) return;
    if (result.ok === false) detailError.value = result.message;
    else apply(result.value);
  } finally {
    if (current === detailSession) editBusy.value = false;
  }
}

function inspect() {
  const path = detail.value?.path;
  if (path) void edit(() => media.inspect(path), value => { details.value = value; });
}

function lookup() {
  candidates.value = undefined;
  void edit(() => media.scrape(scrapeKind.value, term.value, region.value), value => { candidates.value = value; });
}

function applyMetadata(metadata?: MediaMetadata) {
  if (!metadata) return;
  draft.value = { ...metadata, category: metadata.category ?? draft.value.category };
  detailTab.value = 'metadata';
}

function save() {
  const path = detail.value?.path;
  if (path) void edit(() => media.save(path, { ...draft.value }), () => {
    closeDetails();
    void load();
  });
}

function startRename(entry: MediaEntry) {
  renameTarget.value = entry;
  stem.value = entry.name.slice(0, -extension(entry).length);
  renameError.value = '';
}

function useTitleForName() {
  const title = renameTarget.value?.metadata?.title;
  if (!title) return;
  const safe = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '');
  if (safe) stem.value = safe;
}

async function rename() {
  const entry = renameTarget.value;
  if (!entry || renaming.value || !stem.value.trim()) return;
  renaming.value = true;
  renameError.value = '';
  try {
    const result = await media.rename(entry.path, stem.value);
    if (result.ok === false) renameError.value = result.message;
    else {
      renameTarget.value = undefined;
      await load();
    }
  } finally {
    renaming.value = false;
  }
}

function size(bytes: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)));
  const value = (bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 });
  return `${value} ${units[unit]}`;
}

onDeactivated(() => {
  closeDetails();
  if (!renaming.value) renameTarget.value = undefined;
});
</script>

<template>
  <section class="page media-page" aria-labelledby="media-title">
    <div class="page-heading">
      <div>
        <h1 id="media-title">媒体库</h1>
        <p v-if="status?.phase === 'running'">索引正在更新，媒体会逐步显示。</p>
        <p v-else-if="status?.phase === 'paused'">索引已暂停</p>
        <p v-else>{{ total }} 项媒体<span v-if="status?.phase === 'limited'"> · 索引已达上限</span></p>
      </div>
      <Space wrap>
        <RouterLink :to="{ name: 'search' }">索引设置</RouterLink>
        <Button :disabled="indexBusy || !status?.roots.length" @click="refreshIndex">
          <template #icon><ReloadOutlined /></template>更新索引
        </Button>
      </Space>
    </div>

    <div class="media-filters">
      <Input v-model:value="query" type="search" aria-label="查询媒体" placeholder="搜索文件名、标题、作者、流派或年份"
        allow-clear :maxlength="128">
        <template #prefix><SearchOutlined /></template>
      </Input>
      <Select v-model:value="category" aria-label="媒体分类" :options="options" />
    </div>
    <Alert v-if="error || actionError" role="alert" type="error" show-icon :message="error || actionError" />
    <Card size="small" class="table-section">
      <FileContextMenu v-slot="{ row }" open-parent @open-entry="openEntry" @open-parent="openParent">
        <Table :columns="columns" :data-source="page.items" :custom-row="row" row-key="path"
          size="small" table-layout="fixed" :pagination="pagination" :loading="busy">
          <template #emptyText>
            <Empty :image="Empty.PRESENTED_IMAGE_SIMPLE"
              :description="query || category !== 'all' ? '没有匹配的媒体' : '索引中暂无媒体'" />
          </template>
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              <Button type="link" class="media-name" @click="openEntry(record)">
                <span class="entry-icon"><component :is="icon(record.category)" aria-hidden="true" /></span>
                <strong>{{ record.metadata?.title || record.name }}</strong>
              </Button>
              <div class="result-path" :title="record.path">
                {{ record.metadata?.creator ? record.metadata.creator + ' · ' : '' }}{{ record.path }}
              </div>
            </template>
            <template v-else-if="column.key === 'category'">
              <Tag color="blue">{{ categoryLabel(record.category) }}</Tag>
              <small class="media-extension">{{ record.extension }}</small>
            </template>
            <template v-else-if="column.key === 'actions'">
              <Button type="text" size="small" class="file-action" @click="openDetails(record)">资料与刮削</Button>
              <Button type="text" size="small" class="file-action" @click="startRename(record)">重命名</Button>
            </template>
          </template>
        </Table>
      </FileContextMenu>
    </Card>

    <Drawer :open="!!detail" title="媒体资料" width="min(560px, 100vw)" @close="closeDetails">
      <div v-if="detail" role="dialog" aria-modal="true" aria-label="媒体资料">
        <p class="result-path">{{ detail.path }}</p>
        <Alert v-if="detailError" role="alert" type="error" show-icon :message="detailError" />
        <Tabs v-model:active-key="detailTab">
          <Tabs.TabPane key="metadata" tab="资料">
            <form class="metadata-form" @submit.prevent="save">
              <label>标题<Input v-model:value="draft.title" aria-label="媒体标题" :maxlength="256" required /></label>
              <div class="metadata-grid">
                <label>作者 / 艺术家<Input v-model:value="draft.creator" :maxlength="180" /></label>
                <label>年份<Input v-model:value="draft.year" inputmode="numeric" :maxlength="4" /></label>
                <label>分类<Select v-model:value="draft.category" :options="categories" /></label>
                <label>流派<Input v-model:value="draft.genre" :maxlength="120" /></label>
              </div>
              <label>简介<Input.TextArea v-model:value="draft.description" :maxlength="1200" :rows="4" /></label>
              <div class="toolbar metadata-footer">
                <Tag>{{ sourceLabels[draft.source] }}</Tag>
                <Button type="primary" html-type="submit" :loading="editBusy" :disabled="!draft.title.trim()">保存资料</Button>
              </div>
            </form>
          </Tabs.TabPane>
          <Tabs.TabPane key="local" tab="本地信息">
            <Button :loading="editBusy" @click="inspect">读取本地信息</Button>
            <Descriptions v-if="details" class="media-details" :column="1" size="small">
              <Descriptions.Item label="大小">{{ size(details.size) }}</Descriptions.Item>
              <Descriptions.Item label="修改时间">{{ new Date(details.modified).toLocaleString() }}</Descriptions.Item>
              <Descriptions.Item v-if="details.duration" label="时长">{{ Math.round(details.duration) }} 秒</Descriptions.Item>
              <Descriptions.Item v-if="details.width && details.height" label="分辨率">{{ details.width }} × {{ details.height }}</Descriptions.Item>
              <Descriptions.Item v-if="details.codecs?.length" label="编码">{{ details.codecs.join(' / ') }}</Descriptions.Item>
            </Descriptions>
            <p v-if="details?.probe === 'unavailable'">安装 ffprobe 后可读取时长、分辨率和内嵌标签。</p>
            <p v-else-if="details?.probe === 'unsupported'">已读取文件属性，当前格式没有可用的技术资料。</p>
            <Button v-if="details?.metadata" @click="applyMetadata(details?.metadata)">使用内嵌资料</Button>
          </Tabs.TabPane>
          <Tabs.TabPane key="online" tab="在线刮削">
            <form class="metadata-form" @submit.prevent="lookup">
              <label>查询词<Input v-model:value="term" aria-label="在线查询词" :maxlength="128" required /></label>
              <div class="metadata-grid">
                <label>资料类型<Select v-model:value="scrapeKind" :options="scrapeOptions" /></label>
                <label v-if="scrapeKind !== 'book'">地区<Select v-model:value="region" :options="regions" /></label>
              </div>
              <div class="toolbar">
                <Button type="primary" html-type="submit" :loading="editBusy" :disabled="!term.trim()">查询在线资料</Button>
                <span class="result-path">{{ scrapeKind === 'book' ? 'Open Library' : scrapeKind === 'movie' ? 'Wikidata' : 'iTunes' }} · 仅发送查询词</span>
              </div>
            </form>
            <Empty v-if="candidates && !candidates.length" :image="Empty.PRESENTED_IMAGE_SIMPLE" description="没有找到候选资料" />
            <ul v-if="candidates?.length" class="media-candidates" aria-label="候选资料">
              <li v-for="(candidate, index) in candidates" :key="index">
                <div>
                  <strong>{{ candidate.title }}</strong>
                  <p v-if="candidate.creator || candidate.year" class="result-path">{{ [candidate.creator, candidate.year].filter(Boolean).join(' · ') }}</p>
                  <p v-if="candidate.description" class="candidate-description">{{ candidate.description }}</p>
                </div>
                <Button size="small" @click="applyMetadata(candidate)">使用此资料</Button>
              </li>
            </ul>
          </Tabs.TabPane>
        </Tabs>
      </div>
    </Drawer>

    <Modal :open="!!renameTarget" title="重命名媒体" ok-text="重命名" :confirm-loading="renaming"
      :ok-button-props="{ disabled: !stem.trim() }" @ok="rename" @cancel="renameTarget = undefined">
      <form class="metadata-form" @submit.prevent="rename">
        <label>文件名<Input v-model:value="stem" aria-label="新媒体文件名" :addon-after="suffix" required /></label>
        <Button v-if="renameTarget?.metadata?.title" type="link" class="title-suggestion"
          @click="useTitleForName">使用资料标题</Button>
        <p class="result-path">新文件名 · {{ stem.trim() }}{{ suffix }}</p>
        <Alert v-if="renameError" role="alert" type="error" show-icon :message="renameError" />
      </form>
    </Modal>
  </section>
</template>

<style scoped>
.media-filters { display: grid; grid-template-columns: minmax(0, 1fr) minmax(115px, 180px); gap: 10px; }
.media-filters .ant-select { width: 100%; }
.media-name.ant-btn { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; padding: 0; height: auto; white-space: normal; color: var(--text); text-align: left; }
.media-name strong { overflow-wrap: anywhere; }
.media-name .entry-icon { color: var(--accent); }
.media-extension { display: block; margin-top: 4px; color: var(--muted); }
.metadata-form, .metadata-form label { display: grid; gap: 8px; }
.metadata-form { gap: 14px; }
.metadata-form label { min-width: 0; }
.metadata-grid { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.metadata-footer { justify-content: space-between; }
.metadata-form p { margin: 0; }
.title-suggestion { justify-self: start; padding: 0; }
.media-details { margin-block: 15px; }
.media-candidates { margin: 14px 0 0; padding: 0; list-style: none; }
.media-candidates li { display: flex; align-items: start; justify-content: space-between; gap: 12px; border-top: 1px solid var(--outline); padding: 12px 0; }
.media-candidates p { margin: 3px 0 0; }
.candidate-description { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
@media (max-width: 640px) {
  .media-filters { grid-template-columns: 1fr; }
  .media-page :deep(.ant-table-content) { overflow-x: auto; }
  .media-page :deep(.ant-table-content > table) { min-width: 465px; }
}
</style>
