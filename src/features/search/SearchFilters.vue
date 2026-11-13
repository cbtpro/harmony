<script setup lang="ts">
import { Input, InputNumber } from 'ant-design-vue';
import type { SearchFilters } from '../../../shared/search';

defineProps<{ value: SearchFilters }>();
const emit = defineEmits<{ (event: 'update:value', value: SearchFilters): void }>();
</script>

<template>
  <div class="search-filters">
    <Input :value="value.extension" aria-label="文件扩展名" placeholder="扩展名，如 mp4, mkv" :maxlength="256" allow-clear
      @update:value="emit('update:value', { ...value, extension: $event || undefined })" />
    <Input :value="value.directory" aria-label="搜索范围目录" placeholder="目录绝对路径" allow-clear
      @update:value="emit('update:value', { ...value, directory: $event || undefined })" />
    <InputNumber :value="value.days" aria-label="最近修改天数" placeholder="近几天修改" :min="1" :max="3650" :precision="0"
      @update:value="emit('update:value', { ...value, days: typeof $event === 'number' ? $event : undefined })" />
    <InputNumber :value="value.minSize ? value.minSize / 1048576 : undefined" aria-label="最小文件大小 MiB"
      placeholder="最小大小 MiB" :min="0.01" :precision="2"
      @update:value="emit('update:value', { ...value, minSize: typeof $event === 'number' ? Math.round($event * 1048576) : undefined })" />
  </div>
</template>

<style scoped>
.search-filters { display: grid; grid-template-columns: 1fr 2fr 1fr 1fr; gap: 8px; }
.search-filters > * { min-width: 0; width: 100%; }
@media (max-width: 800px) { .search-filters { grid-template-columns: 1fr 1fr; } }
</style>
