<script setup lang="ts">
import { ref, watch } from 'vue';
import { Alert, Button, Checkbox, Input, InputNumber, Modal } from 'ant-design-vue';
import type { BatchOutcome, BatchPlan, RenameOptions } from '../../../shared/files';
import { batchFiles } from '@/services/client';

const props = defineProps<{ paths?: string[] }>();
const emit = defineEmits<{ (event: 'close' | 'completed'): void }>();
const defaults = (): RenameOptions => ({ find: '', replace: '', numbering: false, start: 1, date: false });
const options = ref(defaults());
const plan = ref<BatchPlan>();
const results = ref<BatchOutcome[]>();
const busy = ref(false);
const error = ref('');
const labels = { ready: '就绪', replace: '替换', skip: '跳过', blocked: '冲突' };
watch(() => props.paths, () => {
  options.value = defaults();
  plan.value = undefined;
  results.value = undefined;
  error.value = '';
});
watch(options, () => { plan.value = undefined; }, { deep: true });

async function submit() {
  if (busy.value || !props.paths?.length) return;
  if (results.value) return emit('close');
  busy.value = true;
  error.value = '';
  try {
    if (plan.value?.ticket) {
      const result = await batchFiles.run(plan.value.ticket);
      if (result.ok) {
        results.value = result.value;
        emit('completed');
      } else { error.value = result.message; plan.value = undefined; }
    } else {
      const result = await batchFiles.rename(props.paths, options.value);
      if (result.ok) plan.value = result.value;
      else error.value = result.message;
    }
  } finally { busy.value = false; }
}
function name(path: string) { return path.split(/[\\/]/).pop(); }
</script>

<template>
  <Modal :open="!!paths" title="批量重命名" :width="720" :closable="!busy" :mask-closable="!busy"
    :keyboard="!busy" @cancel="!busy && emit('close')">
    <div v-if="!results" class="rename-controls">
      <Input v-model:value="options.find" aria-label="查找文字" placeholder="查找文字" :disabled="busy" :maxlength="255" />
      <Input v-model:value="options.replace" aria-label="替换为" placeholder="替换为" :disabled="busy" :maxlength="255" />
      <div class="toolbar">
        <Checkbox v-model:checked="options.numbering" :disabled="busy">追加编号</Checkbox>
        <InputNumber v-model:value="options.start" aria-label="起始编号" :min="0" :max="999999" :precision="0" :disabled="busy || !options.numbering" />
        <Checkbox v-model:checked="options.date" :disabled="busy">追加当天日期</Checkbox>
      </div>
      <p>保留扩展名。预览会标出名称冲突。</p>
    </div>
    <Alert v-if="error" role="alert" type="error" :message="error" />
    <ul v-if="results" class="rename-results" aria-label="重命名结果">
      <li v-for="row in results" :key="row.source">
        <strong>{{ row.status === 'done' ? '完成' : row.status === 'skipped' ? '跳过' : '失败' }}</strong>
        {{ name(row.source) }} <template v-if="row.target">→ {{ name(row.target) }}</template> {{ row.message }}
      </li>
    </ul>
    <ul v-else-if="plan" class="rename-results" aria-label="重命名预览">
      <li v-for="row in plan.rows" :key="row.source">
        <strong>{{ labels[row.action] }}</strong> <span :title="row.source">{{ name(row.source) }}</span>
        <span v-if="row.target" :title="row.target"> → {{ name(row.target) }}</span>
        <small v-if="row.reason"> · {{ row.reason }}</small>
      </li>
    </ul>
    <template #footer>
      <Button v-if="!results" :disabled="busy" @click="emit('close')">取消</Button>
      <Button type="primary" :loading="busy" :disabled="!results && (!!plan && !plan.ticket)"
        @click="submit">{{ results ? '完成' : plan?.ticket ? '确认重命名' : '生成预览' }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.rename-controls { display: grid; gap: 8px; }
.rename-controls p { margin: 0; color: var(--muted); }
.rename-results { max-height: 340px; overflow: auto; overflow-wrap: anywhere; }
.rename-results li { margin: 8px 0; }
</style>
