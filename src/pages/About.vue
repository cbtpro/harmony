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
import { Card, Descriptions, Tag } from 'ant-design-vue';
import { version } from '../../package.json';
</script>

<template>
  <section class="page" aria-labelledby="about-title">
    <div class="page-heading">
      <div>
        <h1 id="about-title">关于 Harmony</h1>
        <p>本地文件管理与索引搜索</p>
      </div>
      <Tag color="blue">v{{ version }}</Tag>
    </div>
    <Card size="small" title="应用信息">
      <Descriptions :column="1">
        <Descriptions.Item label="支持平台">macOS、Linux、Windows</Descriptions.Item>
        <Descriptions.Item label="文件索引">按名称搜索，索引规则保存在本机</Descriptions.Item>
      </Descriptions>
    </Card>
  </section>
</template>
