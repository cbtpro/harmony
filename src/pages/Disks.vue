<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue';
import { Alert, Button, Card, Empty, Progress, Tag } from 'ant-design-vue';
import { HddOutlined, ReloadOutlined } from '@ant-design/icons-vue';
import type { Disk } from '../../shared/disks';
import { disks } from '@/services/client';
import { useWorkspaceStatus } from '@/features/workspace/status';

const volumes = shallowRef<Disk[]>([]);
const busy = ref(false);
const error = ref('');
const scope = { full: '已加入索引', partial: '部分目录已加入', excluded: '已被黑名单排除', none: '未加入索引' };
const colors = { full: 'green', partial: 'blue', excluded: 'orange', none: undefined };
const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
useWorkspaceStatus(() => `${volumes.value.length} 个磁盘`);

function size(bytes: number) {
  const unit = Math.min(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`;
}

async function run(path?: string) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    if (path) {
      const result = await disks.index(path);
      if (result.ok === false) { error.value = result.message; return; }
    }
    const result = await disks.list();
    if (result.ok) volumes.value = result.value;
    else if (result.ok === false) error.value = result.message;
  } finally {
    busy.value = false;
  }
}
onMounted(() => run());
</script>

<template>
  <section class="page" aria-labelledby="disks-title">
    <div class="page-heading">
      <h1 id="disks-title">磁盘</h1>
      <Button :loading="busy" @click="run()"><template #icon><ReloadOutlined /></template>刷新磁盘</Button>
    </div>
    <Alert v-if="error" role="alert" type="error" show-icon :message="error" />
    <Empty v-if="!volumes.length && !busy && !error" description="没有可访问的磁盘" />
    <div class="disk-grid">
      <Card v-for="disk in volumes" :key="disk.path" size="small" class="disk-card">
        <div class="disk-heading">
          <span class="disk-icon"><HddOutlined /></span>
          <div class="disk-identity">
            <h2>{{ disk.name }}</h2>
            <p class="result-path">{{ disk.path }}</p>
          </div>
        </div>
        <div class="disk-capacity">
          <template v-if="disk.total && disk.available !== null">
            <div class="disk-space"><strong>{{ size(disk.available) }}</strong><span>可用 · 共 {{ size(disk.total) }}</span></div>
            <Progress :percent="Math.min(100, Math.max(0, Math.round(100 * (1 - disk.available / disk.total))))"
              :show-info="false" size="small" />
          </template>
          <p v-else>容量暂不可用</p>
        </div>
        <Tag :color="colors[disk.scope]">{{ scope[disk.scope] }}</Tag>
        <div class="toolbar">
          <RouterLink :to="{ path: '/', query: { directory: disk.path } }">浏览磁盘</RouterLink>
          <Button v-if="disk.scope === 'none' || disk.scope === 'partial'" size="small"
            :disabled="busy" @click="run(disk.path)">将整个磁盘加入索引</Button>
        </div>
      </Card>
    </div>
  </section>
</template>

<style scoped>
.disk-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(292px, 100%), 1fr)); gap: 18px; }
.disk-card { min-width: 0; }
.disk-card :deep(.ant-card-body) { padding: 20px; }
.disk-heading { display: flex; align-items: center; gap: 12px; }
.disk-icon {
  display: grid; place-items: center; flex: none; width: 44px; height: 44px;
  border-radius: 10px; background: var(--selection); color: var(--accent); font-size: 20px;
}
.disk-identity { min-width: 0; }
.disk-identity h2 { margin: 0; overflow-wrap: anywhere; font-size: 16px; }
.disk-identity p { margin: 2px 0 0; }
.disk-capacity { margin: 22px 0 12px; }
.disk-space { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.disk-space strong { font-size: 25px; letter-spacing: -.045em; color: var(--text); }
.disk-space span, .disk-capacity p { font-size: 12px; color: var(--muted); }
.disk-card .toolbar { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--outline); justify-content: space-between; }
</style>
