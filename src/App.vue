<script setup lang="ts">
import { RouterView, } from 'vue-router';
import Navigation from './components/Navigation.vue'

console.log("[App.vue]", `Hello world from Electron ${process.versions.electron}!`);
</script>

<template>
  <Navigation />
  <router-view></router-view>
</template>

<style>
</style>
