import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './styles/n8n-tokens/index.scss';
import App from './App.vue';

createApp(App).use(createPinia()).mount('#app');
