import { createApp } from 'vue';
import { createPinia } from 'pinia';
import router from '@/router';

import '@/style.css';
import App from '@/App.vue';
import '@/samples/node-api';

const pinia = createPinia()

const app = createApp(App);
app.use(pinia);
app.use(router);

app.mount('#app')
  .$nextTick(() => {
    postMessage({ payload: 'removeLoading' }, '*');
  });
