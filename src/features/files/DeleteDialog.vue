<script setup lang="ts">
import { ref, watch } from 'vue';
import { Alert, Modal } from 'ant-design-vue';
import type { FileEntry } from '../../../shared/files';
import { files } from '@/services/client';

const props = defineProps<{ request?: { entry: FileEntry; permanent: boolean } }>();
const emit = defineEmits<{ (event: 'close' | 'completed'): void }>();
const busy = ref(false);
const error = ref('');
watch(() => props.request, () => { error.value = ''; });

async function confirm() {
  if (busy.value || !props.request) return;
  const { entry, permanent } = props.request;
  busy.value = true;
  error.value = '';
  try {
    const result = await (permanent ? files.deletePermanently(entry.path) : files.trash(entry.path));
    if (!result.ok) { error.value = result.message; return; }
    emit('close');
    emit('completed');
  } finally { busy.value = false; }
}
</script>

<template>
  <Modal :open="!!request" :title="request?.permanent ? '永久删除' : '移到废纸篓'"
    :ok-text="request?.permanent ? '确认永久删除' : '移到废纸篓'" :confirm-loading="busy"
    :closable="!busy" :keyboard="!busy" :mask-closable="!busy" :cancel-button-props="{ disabled: busy }"
    :ok-button-props="{ danger: true }" @ok="confirm" @cancel="!busy && emit('close')">
    <p>{{ request?.permanent ? '此操作无法撤销。' : '将此项目移到系统回收站？' }}</p>
    <p v-if="request?.permanent && request.entry.kind === 'directory'">文件夹内的所有内容也会被删除。</p>
    <p class="delete-path">{{ request?.entry.path }}</p>
    <Alert v-if="error" role="alert" type="error" show-icon :message="error" />
  </Modal>
</template>

<style scoped>
.delete-path { overflow-wrap: anywhere; }
</style>
