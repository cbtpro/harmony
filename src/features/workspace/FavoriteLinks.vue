<script setup lang="ts">
import { onMounted } from 'vue';
import { Button, message } from 'ant-design-vue';
import { CloseOutlined, FolderOutlined, SearchOutlined } from '@ant-design/icons-vue';
import type { Favorite } from '../../../shared/favorites';
import { useFavorites } from './useFavorites';

const favorites = useFavorites();
const { items, pending, error } = favorites;
onMounted(() => void favorites.load());

function destination(item: Favorite) {
  if (item.kind === 'directory') return { name: 'files', query: { directory: item.directory } };
  const { extension, directory, days, minSize } = item.filters;
  return { name: 'search', query: { q: item.query || undefined, extension, directory,
    days: days?.toString(), minSize: minSize?.toString() } };
}

async function remove(id: string) {
  if (!await favorites.remove(id)) void message.error(error.value);
}
</script>

<template>
  <section v-if="items.length" class="favorites" aria-label="收藏">
    <div class="favorite-title">收藏</div>
    <div v-for="item in items" :key="item.id" class="favorite-row">
      <RouterLink class="workspace-link favorite-link" :to="destination(item)" :aria-label="item.label" :title="item.label">
        <FolderOutlined v-if="item.kind === 'directory'" /><SearchOutlined v-else /><span>{{ item.label }}</span>
      </RouterLink>
      <Button type="text" size="small" :disabled="pending" :aria-label="'移除收藏 ' + item.label" @click="remove(item.id)">
        <template #icon><CloseOutlined /></template>
      </Button>
    </div>
  </section>
</template>

<style scoped>
.favorites { padding: 0 12px 14px; }
.favorite-title { color: #c7d2e7; font-size: 12px; margin: 0 0 4px 9px; }
.favorite-row { display: flex; align-items: center; }
.favorite-row .ant-btn { color: #c7d2e7; flex: none; }
.favorite-link { flex: 1; min-width: 0; }
.favorite-link span:last-child { white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
@media (max-width: 740px) {
  .favorites { padding-inline: 5px; }
  .favorite-row { position: relative; }
  .favorite-row .ant-btn { position: absolute; right: 0; top: 0; opacity: 0; }
  .favorite-row:hover .ant-btn, .favorite-row:focus-within .ant-btn { opacity: 1; }
}
</style>
