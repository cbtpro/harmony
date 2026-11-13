<script setup lang="ts">
import { computed, onActivated, ref, shallowRef } from 'vue';
import { Alert, Button, Card, InputNumber, Modal, Switch } from 'ant-design-vue';
import type { IndexSettings } from '../../shared/search';
import { indexSettings, isDesktop } from '@/services/client';

const settings = shallowRef<IndexSettings>();
const threads = ref<number | null>(null);
const preferSystem = ref(true);
const busy = ref(false);
const error = ref('');
const saved = ref(false);
const maintenance = ref<'open' | 'rebuild'>();
const maintenanceMessage = ref('');
const confirmRepair = ref(false);
const valid = computed(() => settings.value && threads.value !== null
  && Number.isInteger(threads.value) && threads.value >= 1 && threads.value <= settings.value.maxThreads);

async function update(save: boolean) {
  if (busy.value || (save && !valid.value)) return;
  busy.value = true;
  error.value = '';
  saved.value = false;
  try {
    const result = save && threads.value !== null ? await indexSettings.save(threads.value, preferSystem.value) : await indexSettings.get();
    if (result.ok === false) error.value = result.message;
    else {
      settings.value = result.value;
      threads.value = result.value.threads;
      preferSystem.value = result.value.preferSystem ?? true;
      saved.value = save;
    }
  } finally {
    busy.value = false;
  }
}

async function spotlight(action: 'open' | 'rebuild') {
  maintenance.value = action;
  maintenanceMessage.value = '';
  error.value = '';
  try {
    const result = await (action === 'open' ? indexSettings.openSpotlight() : indexSettings.rebuildSpotlight());
    if (result.ok === false) error.value = result.message;
    else if (action === 'rebuild') maintenanceMessage.value = '已请求重建，索引进度由 macOS 管理。';
  } finally { maintenance.value = undefined; }
}

function repair() {
  confirmRepair.value = false;
  void spotlight('rebuild');
}

onActivated(() => void update(false));
</script>

<template>
  <section class="workspace-page" aria-labelledby="settings-title">
    <header class="workspace-page-header">
      <h1 id="settings-title">设置</h1>
    </header>
    <Card title="文件索引" :loading="busy && !settings">
      <Alert v-if="error" role="alert" type="error" show-icon :message="error" />
      <form v-if="settings" class="index-settings" @submit.prevent="update(true)">
        <label v-if="settings.systemProviders?.length" class="source-option">
          <Switch v-model:checked="preferSystem" aria-label="优先使用系统索引" :disabled="busy" @change="saved = false" />
          优先使用系统索引
        </label>
        <p v-if="settings.systemProviders?.length">{{ settings.systemProviders.join(' / ') }}。系统索引未覆盖的白名单目录由 Harmony 扫描。</p>
        <label for="index-threads">索引线程数</label>
        <InputNumber id="index-threads" v-model:value="threads" :min="1" :max="settings.maxThreads"
          :disabled="busy" aria-describedby="index-threads-hint" @change="saved = false" />
        <p id="index-threads-hint">
          系统可用 {{ settings.systemThreads }} 个线程，可设置 1 到 {{ settings.maxThreads }} 个索引线程。
          新设置在下次开始扫描或从断点继续时生效。
        </p>
        <div class="settings-actions">
          <Button type="primary" html-type="submit" :loading="busy"
            :disabled="!valid || (threads === settings.threads && preferSystem === settings.preferSystem)">保存设置</Button>
          <span v-if="saved" role="status">设置已保存</span>
        </div>
      </form>
      <div v-if="settings?.spotlightMaintenance && isDesktop" class="spotlight-actions">
        <Button :loading="maintenance === 'open'" :disabled="!!maintenance" @click="spotlight('open')">打开 Spotlight 设置</Button>
        <Button :loading="maintenance === 'rebuild'" :disabled="!!maintenance" @click="confirmRepair = true">修复 Spotlight 索引</Button>
        <span v-if="maintenanceMessage" role="status">{{ maintenanceMessage }}</span>
      </div>
    </Card>
    <Modal v-model:open="confirmRepair" title="重建 Spotlight 索引？" ok-text="重建索引" cancel-text="取消" @ok="repair">
      <p>此操作会重新建立启动磁盘的 Spotlight 索引。重建期间，搜索结果可能不完整。macOS 会要求管理员授权。</p>
    </Modal>
  </section>
</template>

<style scoped>
.index-settings { display: grid; gap: 10px; justify-items: start; }
.index-settings label { font-weight: 600; }
.index-settings p { margin: 0 0 6px; color: var(--muted); }
.settings-actions { display: flex; align-items: center; gap: 12px; }
.source-option, .spotlight-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.spotlight-actions { margin-top: 18px; }
</style>
