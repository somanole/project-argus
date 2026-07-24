import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './styles/theme/index.scss';
import './styles/app.scss';
import App from './App.vue';
import { router } from './router';

createApp(App).use(createPinia()).use(router).mount('#app');
