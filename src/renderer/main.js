import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './styles.css';
import '@lingyzh/ui/styles.css';
import { setClipboardWriter } from '@lingyzh/ui';

if (window.uah?.writeClipboard) setClipboardWriter(text => window.uah.writeClipboard(text));

createApp(App).use(createPinia()).mount('#app');
