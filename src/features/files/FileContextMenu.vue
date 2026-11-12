<script setup lang="ts">
import { onDeactivated, ref, shallowRef, watch } from 'vue';
import { Dropdown, Menu, message } from 'ant-design-vue';
import {
  CodeOutlined, CopyOutlined, DeleteOutlined, ExportOutlined, FolderOpenOutlined, LinkOutlined,
} from '@ant-design/icons-vue';
import type { FileEntry } from '../../../shared/files';
import type { TerminalOption } from '../../../shared/terminals';
import { files, terminals } from '@/services/client';

const props = defineProps<{
  disabled?: boolean;
  openParent?: boolean;
  copyFile?: boolean;
  trash?: boolean;
  openLabel?: (entry: FileEntry) => string;
}>();
const emit = defineEmits<{
  (event: 'open-change', open: boolean): void;
  (event: 'open-entry' | 'open-parent' | 'copy-file' | 'trash-entry', entry: FileEntry): void;
}>();

const target = shallowRef<FileEntry>();
const open = ref(false);
const availableTerminals = shallowRef<TerminalOption[]>([]);
const detecting = ref(false);
const detectionError = ref(false);
const platform = navigator.platform;
const manager = /Mac/i.test(platform) ? '访达' : /Win/i.test(platform) ? '资源管理器' : '文件管理器';

function row(entry: FileEntry) {
  return {
    class: open.value && target.value?.path === entry.path ? 'context-row-active' : undefined,
    onContextmenu: () => {
      if (!props.disabled) target.value = entry;
    },
  };
}

function changeOpen(value: boolean) {
  open.value = value && !!target.value && !props.disabled;
  if (!open.value) target.value = undefined;
}

onDeactivated(() => changeOpen(false));

async function detectTerminals() {
  if (detecting.value) return;
  detecting.value = true;
  detectionError.value = false;
  try {
    const result = await terminals.list();
    availableTerminals.value = result.ok ? result.value : [];
    detectionError.value = result.ok === false;
  } finally {
    detecting.value = false;
  }
}

watch(open, (visible, _, cleanup) => {
  emit('open-change', visible);
  if (!visible) return;
  void detectTerminals();
  const dismiss = (event: KeyboardEvent) => {
    if (event.key === 'Escape') changeOpen(false);
  };
  document.addEventListener('keydown', dismiss);
  cleanup(() => document.removeEventListener('keydown', dismiss));
});

async function select({ key }: { key: string | number }) {
  const entry = target.value;
  changeOpen(false);
  if (!entry || props.disabled) return;

  if (typeof key === 'string' && key.startsWith('terminal:')) {
    const result = await terminals.open(key.slice('terminal:'.length), entry.path);
    if (result.ok === false) void message.error(result.message);
    return;
  }

  switch (key) {
    case 'open': emit('open-entry', entry); break;
    case 'parent': emit('open-parent', entry); break;
    case 'copy': emit('copy-file', entry); break;
    case 'trash': emit('trash-entry', entry); break;
    case 'manager': {
      const result = await (entry.kind === 'directory' ? files.open(entry.path) : files.reveal(entry.path));
      if (result.ok === false) void message.error(result.message);
      break;
    }
    case 'path': {
      const result = await files.copyPath(entry.path);
      if (result.ok) void message.success('已复制路径');
      else if (result.ok === false) void message.error(result.message);
      break;
    }
  }
}
</script>

<template>
  <Dropdown :trigger="['contextmenu']" :open="open" :disabled="disabled"
    overlay-class-name="harmony-file-menu" @open-change="changeOpen">
    <div><slot :row="row" /></div>
    <template #overlay>
      <Menu v-if="target" @click="select">
        <Menu.Item v-if="target.kind !== 'other'" key="open">
          <template #icon><FolderOpenOutlined /></template>
          {{ openLabel?.(target) ?? (target.kind === 'directory' ? '打开文件夹' : '打开文件') }}
        </Menu.Item>
        <Menu.Item v-if="openParent && target.kind !== 'directory'" key="parent">
          <template #icon><FolderOpenOutlined /></template>打开所在目录
        </Menu.Item>
        <Menu.Item key="manager">
          <template #icon><ExportOutlined /></template>
          在{{ manager }}中{{ target.kind === 'directory' ? '打开' : '显示' }}
        </Menu.Item>
        <Menu.SubMenu v-if="target.kind !== 'other'" key="terminal-menu" popup-class-name="harmony-file-menu">
          <template #icon><CodeOutlined /></template>
          <template #title>在终端中打开</template>
          <Menu.Item v-for="terminal in availableTerminals" :key="'terminal:' + terminal.id">{{ terminal.label }}</Menu.Item>
          <Menu.Item v-if="!availableTerminals.length" key="terminal-unavailable" disabled>
            {{ detecting ? '正在检测终端…' : detectionError ? '检测失败，请重试' : '未检测到可用终端' }}
          </Menu.Item>
        </Menu.SubMenu>
        <Menu.Divider />
        <Menu.Item key="path"><template #icon><LinkOutlined /></template>复制路径</Menu.Item>
        <Menu.Item v-if="copyFile && target.kind === 'file'" key="copy">
          <template #icon><CopyOutlined /></template>复制到…
        </Menu.Item>
        <template v-if="trash">
          <Menu.Divider />
          <Menu.Item key="trash" danger><template #icon><DeleteOutlined /></template>移到废纸篓</Menu.Item>
        </template>
      </Menu>
    </template>
  </Dropdown>
</template>

<style scoped>
:deep(.context-row-active > td) { background: var(--selection) !important; }
</style>
