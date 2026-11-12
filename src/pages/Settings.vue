<script setup lang="ts">
import { computed, onActivated, ref, shallowRef } from 'vue';
import { Alert, Button, Card, InputNumber } from 'ant-design-vue';
import type { IndexSettings } from '../../shared/search';
import { indexSettings } from '@/services/client';

const settings = shallowRef<IndexSettings>();
const threads = ref<number | null>(null);
const busy = ref(false);
const error = ref('');
const saved = ref(false);
const valid = computed(() => settings.value && threads.value !== null
  && Number.isInteger(threads.value) && threads.value >= 1 && threads.value <= settings.value.maxThreads);

async function update(save: boolean) {
  if (busy.value || (save && !valid.value)) return;
  busy.value = true;
  error.value = '';
  saved.value = false;
  try {
    const result = save && threads.value !== null ? await indexSettings.save(threads.value) : await indexSettings.get();
    if (result.ok === false) error.value = result.message;
    else {
      settings.value = result.value;
      threads.value = result.value.threads;
      saved.value = save;
    }
  } finally {
    busy.value = false;
  }
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
        <label for="index-threads">索引线程数</label>
        <InputNumber id="index-threads" v-model:value="threads" :min="1" :max="settings.maxThreads"
          :disabled="busy" aria-describedby="index-threads-hint" @change="saved = false" />
        <p id="index-threads-hint">
          系统可用 {{ settings.systemThreads }} 个线程，可设置 1 到 {{ settings.maxThreads }} 个索引线程。
          新设置在下次开始扫描或从断点继续时生效。
        </p>
        <div class="settings-actions">
          <Button type="primary" html-type="submit" :loading="busy"
            :disabled="!valid || threads === settings.threads">保存设置</Button>
          <span v-if="saved" role="status">设置已保存</span>
        </div>
      </form>
    </Card>
  </section>
</template>

<style scoped>
.index-settings { display: grid; gap: 10px; justify-items: start; }
.index-settings label { font-weight: 600; }
.index-settings p { margin: 0 0 6px; color: var(--muted); }
.settings-actions { display: flex; align-items: center; gap: 12px; }
</style>
