<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { Alert, Button, Modal, Spin } from 'ant-design-vue';
import MarkdownIt from 'markdown-it';
import type { FileEntry, PreviewContent } from '../../../shared/files';
import { batchFiles, files } from '@/services/client';

const PdfPreview = defineAsyncComponent(() => import('./PdfPreview.vue'));
const markdown = new MarkdownIt({ html: false, linkify: false }).disable(['image', 'link', 'autolink']);
const props = defineProps<{ entries: FileEntry[]; path?: string }>();
const emit = defineEmits<{ (event: 'update:path', path?: string): void }>();
const content = ref<PreviewContent>();
const busy = ref(false);
const error = ref('');
const position = computed(() => props.entries.findIndex(entry => entry.path === props.path));
const entry = computed(() => props.entries[position.value]);
const rendered = computed(() => content.value?.kind === 'markdown' ? markdown.render(content.value.data) : '');

watch(() => props.path, async (path, _, cleanup) => {
  let active = true;
  cleanup(() => { active = false; });
  content.value = undefined;
  error.value = '';
  busy.value = !!path;
  if (!path) return;
  try {
    const result = await batchFiles.preview(path);
    if (!active) return;
    if (result.ok) content.value = result.value;
    else error.value = result.message;
  } finally { if (active) busy.value = false; }
}, { immediate: true });

function step(amount: number) {
  const next = props.entries[position.value + amount];
  if (next) emit('update:path', next.path);
}

watch(() => !!props.path, (open, _, cleanup) => {
  if (!open) return;
  function key(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      emit('update:path');
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    step(event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1);
  }
  window.addEventListener('keydown', key, true);
  cleanup(() => window.removeEventListener('keydown', key, true));
});

async function openFile() {
  if (!props.path) return;
  const result = await files.open(props.path);
  if (!result.ok) error.value = result.message;
}
</script>

<template>
  <Modal :open="!!path" :title="entry?.name ?? '文件预览'" :width="920" @cancel="emit('update:path')">
    <div class="preview-body" aria-label="文件预览">
      <Spin v-if="busy" />
      <Alert v-else-if="error" role="alert" type="info" :message="error" />
      <template v-else-if="content">
        <img v-if="content.kind === 'image'" class="preview-image" :alt="entry?.name"
          :src="'data:' + content.mime + ';base64,' + content.data" @error="error = '无法解码此图片。'" />
        <PdfPreview v-else-if="content.kind === 'pdf'" :key="path" :data="content.data" />
        <article v-else-if="content.kind === 'markdown'" class="preview-markdown" v-html="rendered" />
        <pre v-else class="preview-text">{{ content.data }}</pre>
        <p v-if="content.truncated">仅显示文件开头的 256 KiB。</p>
      </template>
    </div>
    <template #footer>
      <Button :disabled="position <= 0" @click="step(-1)">上一个文件</Button>
      <Button :disabled="position < 0 || position >= entries.length - 1" @click="step(1)">下一个文件</Button>
      <Button @click="openFile">使用默认应用打开</Button>
    </template>
  </Modal>
</template>

<style scoped>
.preview-body { min-height: 110px; max-height: 65vh; overflow: auto; overflow-wrap: anywhere; }
.preview-image { display: block; max-width: 100%; max-height: 62vh; margin: auto; object-fit: contain; }
.preview-text { margin: 0; white-space: pre-wrap; }
.preview-markdown :deep(pre) { white-space: pre-wrap; background: var(--subtle); padding: 12px; }
</style>
