<script setup lang="ts">
import { ipcRenderer } from 'electron';
import { effect, onUnmounted } from 'vue';
import { RouterView, useRouter, } from 'vue-router';
import TitleBar from '@/components/TitleBar.vue';
import Navigation from '@/components/Navigation.vue';

const router = useRouter();
const jumpAbout = function (event: Electron.IpcRendererEvent, ...args: any[]): void {
  const [path] = args;
  console.log('home中的响应', path);
  router.push(path);
};
effect(() => {
  ipcRenderer.on('jump-router', jumpAbout)
});
onUnmounted(() => {
  ipcRenderer.removeListener('jump-router', jumpAbout);
});

console.log("[App.vue]", `Hello world from Electron ${process.versions.electron}!`);
</script>

<template>
  <title-bar />
  <navigation />
  <router-view></router-view>
</template>

<style>
/* @media (prefers-color-scheme: dark) {
  body { background: #333; color: white; }
}

@media (prefers-color-scheme: light) {
  body { background: #ddd; color: black; }
}

@media (prefers-color-scheme: pink) {
  body { background: #ddd; color: black; }
} */
</style>
