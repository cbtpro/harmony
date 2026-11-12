// Copyright 2023 chenbitao
// 
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// 
//     http://www.apache.org/licenses/LICENSE-2.0
// 
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
import { createRouter, createWebHashHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';

declare module 'vue-router' {
  interface RouteMeta {
    title?: string;
    cacheName?: string;
    pinned?: boolean;
  }
}

export const workspaceRoutes = [
  {
    path: '/',
    name: 'files',
    meta: { title: '文件', cacheName: 'Welcome', pinned: true },
    component: () => import('@/pages/Welcome.vue'),
  },
  {
    path: '/disks',
    name: 'disks',
    meta: { title: '磁盘', cacheName: 'Disks' },
    component: () => import('@/pages/Disks.vue'),
  },
  {
    path: '/media',
    name: 'media',
    meta: { title: '媒体库', cacheName: 'MediaLibrary' },
    component: () => import('@/pages/MediaLibrary.vue'),
  },
  {
    path: '/search',
    name: 'search',
    meta: { title: '全局搜索', cacheName: 'GlobalSearch' },
    component: () => import('@/pages/GlobalSearch.vue'),
  },
  {
    path: '/settings',
    name: 'settings',
    meta: { title: '设置', cacheName: 'Settings' },
    component: () => import('@/pages/Settings.vue'),
  },
  {
    path: '/about',
    name: 'about',
    meta: { title: '关于', cacheName: 'About' },
    component: () => import('@/pages/About.vue'),
  },
] as const;

const routes: RouteRecordRaw[] = [...workspaceRoutes, { path: '/:pathMatch(.*)*', redirect: { name: 'files' } }];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
