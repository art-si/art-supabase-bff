import App from '@/App.vue'
import { bootstrapRuntime } from '@/bootstrap-runtime'
import { useWebsiteConfig } from '@/hooks/core/useWebsiteConfig'
import { bffSession, signOut } from '@bff/api/bff'
import { initRouter } from '@bff/router'
import { createBffWebsiteDefaults } from '@bff/config/branding'

useWebsiteConfig().setWebsiteConfig(createBffWebsiteDefaults())

bootstrapRuntime({
  rootComponent: App,
  installRouter: initRouter,
  manageSupabaseSession: false,
  authContext: {
    hasAuth: (permission) => bffSession.value?.permissions.includes(permission) ?? false,
    hasRole: (role) => bffSession.value?.user.role === role,
    account: {
      user: () => bffSession.value?.user,
      logout: async () => {
        await signOut()
        window.location.replace('/api/auth/login?force_login=1&returnTo=%2Fapplications')
      }
    }
  }
})
