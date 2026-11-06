import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import App from './App.vue'
import { router } from './router'
import i18n from './locales'
import { setupGlobDirectives } from './directives'
import '@styles/core/tailwind.css'
import '@styles/index.scss'

const app = createApp(App)
app.use(createPinia().use(piniaPluginPersistedstate))
app.use(i18n)
app.use(router)
setupGlobDirectives(app)
app.mount('#app')
