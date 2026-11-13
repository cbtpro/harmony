<script setup lang="ts">
import { ref } from 'vue';
import { Button } from 'ant-design-vue';
import FilePane from '@/features/files/FilePane.vue';
import TransferDialog from '@/features/files/TransferDialog.vue';
import type { TransferAction } from '../../shared/files';

const left = ref<{ refresh(): Promise<void> }>();
const right = ref<{ refresh(): Promise<void> }>();
const leftPath = ref<string>();
const rightPath = ref<string>();
const leftSelection = ref<string[]>([]);
const rightSelection = ref<string[]>([]);
const transfer = ref<{ paths: string[]; destination: string; operation: TransferAction }>();

function archive(from: 'left' | 'right', operation: TransferAction) {
  const paths = from === 'left' ? leftSelection.value : rightSelection.value;
  const destination = from === 'left' ? rightPath.value : leftPath.value;
  if (paths.length && destination) transfer.value = { paths: [...paths], destination, operation };
}
function refresh() {
  void left.value?.refresh();
  void right.value?.refresh();
}
</script>

<template>
  <section class="page" aria-labelledby="dual-title">
    <div class="page-heading"><h1 id="dual-title">双栏文件管理</h1></div>
    <div class="toolbar dual-actions">
      <Button :disabled="!leftSelection.length || !rightPath" @click="archive('left', 'copy')">复制到右栏</Button>
      <Button :disabled="!leftSelection.length || !rightPath" @click="archive('left', 'move')">移动到右栏</Button>
      <Button :disabled="!rightSelection.length || !leftPath" @click="archive('right', 'copy')">复制到左栏</Button>
      <Button :disabled="!rightSelection.length || !leftPath" @click="archive('right', 'move')">移动到左栏</Button>
    </div>
    <div class="panes">
      <FilePane ref="left" title="左栏" @location="leftPath = $event" @selection="leftSelection = $event" />
      <FilePane ref="right" title="右栏" @location="rightPath = $event" @selection="rightSelection = $event" />
    </div>
    <TransferDialog :paths="transfer?.paths" :destination="transfer?.destination" :operation="transfer?.operation"
      @close="transfer = undefined" @completed="refresh" />
  </section>
</template>

<style scoped>
.panes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 12px; }
.dual-actions { flex-wrap: wrap; }
@media (max-width: 740px) { .panes { grid-template-columns: 1fr; } }
</style>
