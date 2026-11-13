<script setup lang="ts">
import { nextTick, ref, shallowRef, watch } from 'vue';
import { Alert, Button, Spin } from 'ant-design-vue';
import { AnnotationMode, getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;
const props = defineProps<{ data: string }>();
const document = shallowRef<PDFDocumentProxy>();
const canvas = ref<HTMLCanvasElement>();
const page = ref(1);
const loading = ref(true);
const error = ref('');

watch(() => props.data, async (data, _, cleanup) => {
  document.value = undefined;
  page.value = 1;
  loading.value = true;
  error.value = '';
  let active = true;
  const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
  const task = getDocument({ data: bytes, useWasm: false, useWorkerFetch: false, disableFontFace: true, enableXfa: false });
  cleanup(() => { active = false; void task.destroy().catch(() => {}); });
  try {
    const loaded = await task.promise;
    if (active) document.value = loaded;
  } catch {
    if (active) error.value = '无法读取此 PDF。';
  } finally { if (active) loading.value = false; }
}, { immediate: true });

watch([document, page], async ([doc, number], _, cleanup) => {
  if (!doc) return;
  let active = true;
  let cancel: (() => void) | undefined;
  cleanup(() => { active = false; cancel?.(); });
  try {
    await nextTick();
    const output = canvas.value;
    if (!output) return;
    const content = await doc.getPage(number);
    if (!active) return;
    const natural = content.getViewport({ scale: 1 });
    const viewport = content.getViewport({ scale: Math.min(1.5, 1000 / natural.width, 1600 / natural.height) });
    output.width = Math.ceil(viewport.width);
    output.height = Math.ceil(viewport.height);
    const task = content.render({ canvas: output, viewport, annotationMode: AnnotationMode.DISABLE });
    cancel = () => task.cancel();
    await task.promise;
  } catch (failure) {
    if (active) {
      console.warn('PDF 页面渲染失败', failure);
      error.value = '无法渲染此 PDF 页面。';
    }
  }
});
</script>

<template>
  <Spin v-if="loading" />
  <Alert v-else-if="error" role="alert" type="error" :message="error" />
  <div v-else-if="document" class="pdf-preview">
    <div class="toolbar">
      <Button :disabled="page <= 1" @click="page--">上一页</Button>
      <span>第 {{ page }} / {{ document.numPages }} 页</span>
      <Button :disabled="page >= document.numPages" @click="page++">下一页</Button>
    </div>
    <canvas ref="canvas" aria-label="PDF 页面" />
  </div>
</template>

<style scoped>
.pdf-preview canvas { display: block; max-width: 100%; height: auto; margin: 12px auto 0; }
</style>
