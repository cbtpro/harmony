<script setup lang="ts">
import { ref, watch } from 'vue';
import { Alert, Input, Modal } from 'ant-design-vue';
import type { FavoriteInput } from '../../../shared/favorites';
import { useFavorites } from './useFavorites';

const props = defineProps<{ item?: FavoriteInput }>();
const emit = defineEmits<{ (event: 'close'): void }>();
const label = ref('');
const favorites = useFavorites();
const { error, pending } = favorites;
watch(() => props.item, item => { label.value = item?.label ?? ''; });
async function save() {
  if (props.item && label.value.trim() && await favorites.add({ ...props.item, label: label.value })) emit('close');
}
</script>

<template>
  <Modal :open="!!item" title="添加收藏" ok-text="保存收藏" :confirm-loading="pending"
    :ok-button-props="{ disabled: !label.trim() }" @ok="save" @cancel="emit('close')">
    <form @submit.prevent="save"><Input v-model:value="label" aria-label="收藏名称" :maxlength="80" /></form>
    <Alert v-if="error" type="error" role="alert" :message="error" />
  </Modal>
</template>
