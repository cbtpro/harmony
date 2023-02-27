<script setup lang="ts">
import { ipcRenderer } from 'electron';
import { computed, ref, effect, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import dayjs from 'dayjs';
import { useCounterStore } from '@/store/counter';
import { DATE_FMT_YYYY_MM_DD_HH_MM_SS } from '@/constants/app';

defineProps<{ msg: string }>()

const store = useCounterStore();

const { count, double, } = storeToRefs(store);
const { increment } = store;

const now = ref(Date.now());

let nowTimer: number;
const freshNow = () => {
  now.value = Date.now();
  nowTimer = window.setTimeout(() => {
    freshNow();
  }, 1000);
};
effect(() => {
  freshNow();
});

onUnmounted(() => {
  if (nowTimer) {
    window.clearTimeout(nowTimer);
  }
});

const nowFmt = computed(() => {
  return dayjs(now.value).format(DATE_FMT_YYYY_MM_DD_HH_MM_SS);
});

const sendMsg = () => {
  ipcRenderer.send('send-msg', nowFmt.value);
};
</script>

<template>
  <h1>{{ msg }}</h1>

  <div class="card">
    <button type="button" @click="increment">count is {{ count }}</button>
    <div>double count is {{ double }}</div>
    <div>now is {{ nowFmt }}</div>
    <button type="button" @click="sendMsg">给主进程发消息，观察IDE控制台</button>
    <p>
      Edit
      <code>components/HelloWorld.vue</code> to test HMR
    </p>
  </div>

  <p>
    Check out
    <a href="https://vuejs.org/guide/quick-start.html#local" target="_blank"
      >create-vue</a
    >, the official Vue + Vite starter
  </p>
  <p>
    Install
    <a href="https://github.com/johnsoncodehk/volar" target="_blank">Volar</a>
    in your IDE for a better DX
  </p>
  <p class="read-the-docs">Click on the Vite and Vue logos to learn more</p>
</template>

<style scoped>
.read-the-docs {
  color: #888;
}
</style>
