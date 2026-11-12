<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref } from 'vue';
import { useRoute } from 'vue-router';
import { Badge, Button, ConfigProvider, Layout, message, Tabs, theme } from 'ant-design-vue';
import zhCN from 'ant-design-vue/es/locale/zh_CN';
import {
  AppstoreOutlined, FolderOutlined, GlobalOutlined, HddOutlined, InfoCircleOutlined, SearchOutlined, SettingOutlined, VideoCameraOutlined,
} from '@ant-design/icons-vue';
import QuickSearch from '@/features/search/QuickSearch.vue';
import { useRouteTabs } from '@/features/workspace/useRouteTabs';
import { workspaceRoutes } from '@/router';
import { workspaceStatus } from '@/features/workspace/status';
import { isDesktop, openWeb } from '@/services/client';

const route = useRoute();
const status = ref('');
provide(workspaceStatus, status);

const preference = window.matchMedia('(prefers-color-scheme: dark)');
const dark = ref(preference.matches);
const appearance = computed(() => ({
  algorithm: dark.value ? theme.darkAlgorithm : theme.defaultAlgorithm,
  token: {
    colorPrimary: dark.value ? '#8fafff' : '#244fc1',
    colorBgContainer: dark.value ? '#1a202d' : '#ffffff',
    colorText: dark.value ? '#e9edf5' : '#172235',
    borderRadius: 7,
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  },
}));
const navigationIcons = { files: FolderOutlined, disks: HddOutlined, media: VideoCameraOutlined, search: SearchOutlined, settings: SettingOutlined, about: InfoCircleOutlined };
const { tabs, cacheNames, scrollArea, locationFor, activate, close } = useRouteTabs();

async function openBrowser() {
  const result = await openWeb();
  if (result.ok === false) void message.error(result.message);
}

function updateTheme(event: MediaQueryListEvent) {
  dark.value = event.matches;
}

onMounted(() => {
  preference.addEventListener('change', updateTheme);
});
onUnmounted(() => {
  preference.removeEventListener('change', updateTheme);
});
</script>

<template>
  <ConfigProvider :theme="appearance" :locale="zhCN" :auto-insert-space-in-button="false">
    <Layout class="workspace">
      <Layout.Header class="workspace-header" role="banner">
        <RouterLink :to="locationFor('files')" class="brand" aria-label="Harmony">
          <span class="brand-icon" aria-hidden="true"><AppstoreOutlined /></span>
          <span>Harmony</span>
        </RouterLink>
        <QuickSearch />
        <Button v-if="isDesktop" class="browser-launch" aria-label="在浏览器打开" @click="openBrowser">
          <template #icon><GlobalOutlined /></template><span class="browser-label">在浏览器打开</span>
        </Button>
      </Layout.Header>
      <Layout class="workspace-body" has-sider>
        <Layout.Sider class="workspace-sidebar" width="var(--sidebar-width)" theme="light">
          <nav aria-label="主导航">
            <RouterLink v-for="item in workspaceRoutes" :key="item.name" :to="locationFor(item.name)" class="workspace-link" :class="{ 'workspace-link-secondary': item.name === 'about' }" :title="item.meta.title" :aria-label="item.meta.title">
              <component :is="navigationIcons[item.name]" aria-hidden="true" />
              <span>{{ item.meta.title }}</span>
            </RouterLink>
          </nav>
        </Layout.Sider>
        <Layout.Content class="workspace-content">
          <Tabs class="workspace-tabs" :locale="{ removeAriaLabel: '关闭标签' }" type="editable-card" size="small" hide-add
            :active-key="route.name?.toString()" @change="activate" @edit="close">
            <Tabs.TabPane v-for="tab in tabs" :key="tab.name" :closable="!tab.pinned">
              <template #tab>
                <span class="workspace-tab-label">
                  <component :is="navigationIcons[tab.name as keyof typeof navigationIcons]" aria-hidden="true" />
                  {{ tab.title }}
                </span>
              </template>
            </Tabs.TabPane>
          </Tabs>
          <div ref="scrollArea" class="workspace-route">
            <RouterView v-slot="{ Component, route: pageRoute }">
              <KeepAlive :include="cacheNames">
                <component :is="Component" :key="pageRoute.name" />
              </KeepAlive>
            </RouterView>
          </div>
        </Layout.Content>
      </Layout>
      <Layout.Footer class="workspace-footer" role="contentinfo">
        <Badge status="success" text="本地工作区" />
        <span v-if="status" class="workspace-detail">{{ status }}</span>
      </Layout.Footer>
    </Layout>
  </ConfigProvider>
</template>
