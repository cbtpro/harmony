import '@/services/client';
import { createApp } from 'vue';
import router from '@/router';
import App from '@/App.vue';
import 'ant-design-vue/dist/reset.css';
import '@/style.css';

const app = createApp(App).use(router);
void router.isReady().then(() => app.mount('#app'));
