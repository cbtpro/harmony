<!--
 Copyright 2023 chenbitao
 
 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at
 
     http://www.apache.org/licenses/LICENSE-2.0
 
 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
-->

<script setup lang="ts">
import { ref } from 'vue';
import { Search } from '@element-plus/icons-vue';
import SearchBar from '@/components/SearchBar.vue';

const keyword = ref<string>('');

</script>

<template>
  <div class="title-bar">
    <el-row :gutter="20">
      <el-col :span="6">
        <search-bar />
      </el-col>
      <el-col :span="6">
        <el-input v-model="keyword" class="w-50 m-2" placeholder="搜索" :prefix-icon="Search" />
      </el-col>
      <el-col :span="6">
        <el-input class="search-bar" placeholder="搜索" />
      </el-col>
      <el-col :span="6">
        <switch-theme />
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.title-bar {
  width: 100%;
  height: 48px;
  background: rgba(255, 255, 255, 1);
}
</style>
