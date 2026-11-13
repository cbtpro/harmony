<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Alert, Button, Input, Modal } from 'ant-design-vue';
import type { BatchOutcome, BatchPlan, ConflictPolicy, TransferAction } from '../../../shared/files';
import { batchFiles, files } from '@/services/client';

const props = defineProps<{ paths?: string[]; destination?: string; operation?: TransferAction }>();
const emit = defineEmits<{ (event: 'close' | 'completed'): void }>();
const destination = ref('');
const operation = ref<TransferAction>('copy');
const policy = ref<ConflictPolicy>('skip');
const busy = ref(false);
const error = ref('');
const plan = ref<BatchPlan>();
const outcome = ref<BatchOutcome[]>();
const summary = computed(() => outcome.value ? `完成 ${outcome.value.filter(item => item.status === 'done').length} 项，共 ${outcome.value.length} 项。` : '');
const labels = { ready: '就绪', replace: '替换', skip: '跳过', blocked: '不可执行' };
let generation = 0;

watch(() => props.paths, () => {
  destination.value = props.destination ?? '';
  operation.value = props.operation ?? 'copy';
  policy.value = 'skip';
  outcome.value = undefined;
  error.value = '';
  generation++;
  plan.value = undefined;
});
watch([destination, operation, policy], () => { generation++; plan.value = undefined; });

async function choose() {
  const result = await files.choose();
  if (result.ok && result.value) destination.value = result.value;
  else if (!result.ok) error.value = result.message;
}

async function submit() {
  if (busy.value || !props.paths?.length) return;
  if (outcome.value) return emit('close');
  busy.value = true;
  error.value = '';
  const current = generation;
  try {
    if (plan.value?.ticket) {
      const result = await batchFiles.run(plan.value.ticket);
      if (!result.ok) { error.value = result.message; plan.value = undefined; }
      else {
        outcome.value = result.value;
        emit('completed');
      }
    } else {
      const result = await batchFiles.transfer(props.paths, destination.value, operation.value, policy.value);
      if (current !== generation) return;
      if (result.ok) plan.value = result.value;
      else error.value = result.message;
    }
  } finally { busy.value = false; }
}
</script>

<template>
  <Modal :open="!!paths" title="批量归档" :width="740" :closable="!busy" :mask-closable="!busy"
    :keyboard="!busy" @cancel="!busy && emit('close')">
    <div v-if="!outcome" class="toolbar">
      <select v-model="operation" aria-label="归档方式" :disabled="busy">
        <option value="copy">复制</option><option value="move">移动</option>
      </select>
      <select v-model="policy" aria-label="同名处理" :disabled="busy">
        <option value="skip">跳过同名</option><option value="keep">保留两份</option><option value="replace">替换同名文件</option>
      </select>
      <Input v-model:value="destination" aria-label="归档目标目录" placeholder="目标目录的绝对路径" :disabled="busy" />
      <Button :disabled="busy" @click="choose">选择目录</Button>
    </div>
    <Alert v-if="error" type="error" role="alert" :message="error" show-icon />
    <p v-if="summary" role="status">{{ summary }}</p>
    <p v-if="!outcome && plan?.rows.some(row => row.action === 'replace')">确认后将替换预览中标出的目标文件。</p>
    <ul v-if="outcome" class="batch-list" aria-label="归档结果">
      <li v-for="item in outcome" :key="item.source">
        <strong>{{ item.status === 'done' ? '完成' : item.status === 'skipped' ? '跳过' : '失败' }}</strong>
        {{ item.source }} <span v-if="item.message"> · {{ item.message }}</span>
        <small v-if="item.target">→ {{ item.target }}</small>
      </li>
    </ul>
    <ul v-else-if="plan" class="batch-list" aria-label="归档预览">
      <li v-for="item in plan.rows" :key="item.source">
        <strong>{{ labels[item.action] }}</strong> {{ item.source }}
        <small v-if="item.target">→ {{ item.target }}</small>
        <small v-if="item.contents">含 {{ item.contents.files }} 个文件、{{ item.contents.directories }} 个子文件夹<span v-if="item.contents.skipped">，跳过 {{ item.contents.skipped }} 个链接或特殊项目</span></small>
        <details v-if="item.contents?.sample.length">
          <summary>查看目标目录内容<span v-if="item.contents.files + item.contents.directories > item.contents.sample.length">（前 20 项）</span></summary>
          <ul><li v-for="name in item.contents.sample" :key="name">{{ name }}</li></ul>
        </details>
        <small v-if="item.reason">{{ item.reason }}</small>
      </li>
    </ul>
    <template #footer>
      <Button v-if="!outcome" :disabled="busy" @click="emit('close')">取消</Button>
      <Button type="primary" :loading="busy" :disabled="!outcome && (!destination.trim() || (!!plan && !plan.ticket))"
        @click="submit">{{ outcome ? '完成' : plan?.ticket ? '确认归档' : '生成预览' }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.toolbar .ant-input { flex: 1 1 240px; }
select { padding: 4px 9px; border: 1px solid var(--outline); border-radius: 6px; background: var(--surface); color: var(--text); }
.batch-list { padding-left: 20px; max-height: 340px; overflow: auto; overflow-wrap: anywhere; }
.batch-list li { margin: 7px 0; }
.batch-list small { display: block; }
</style>
