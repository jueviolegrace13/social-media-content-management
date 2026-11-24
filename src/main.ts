import Aura from '@primeuix/themes/aura'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import ConfirmationService from 'primevue/confirmationservice'
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './style.css'

createApp(App)
  .use(createPinia())
  .use(VueQueryPlugin, { queryClientConfig: { defaultOptions: { queries: { staleTime: 15_000, retry: 1 } } } })
  .use(router)
  .use(PrimeVue, {
    theme: {
      preset: Aura,
      options: { darkModeSelector: 'system', cssLayer: { name: 'primevue', order: 'theme, base, primevue, components, utilities' } },
    },
  })
  .use(ConfirmationService)
  .mount('#app')
