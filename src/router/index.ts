import type { App, Component } from 'vue'
import { watch } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import { RouteRegistry } from '@/router/core/route-registry'
import { registerApplicationViewModules } from '@/router/core/component-loader'
import { setupAfterEachGuard } from '@/router/guards/after-each'
import { useMenuStore } from '@/store/modules/menu'
import { useWorktabStore } from '@/store/modules/worktab'
import type { AppRouteRecord } from '@/types/router'
import { bffSession, loadSession } from '@bff/api/bff'

export const HOME_PAGE_PATH = '/applications'
registerApplicationViewModules(
  'bff',
  '/src/views',
  import.meta.glob<{ default: Component }>('/src/views/**/*.vue')
)

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/auth/login',
      name: 'Login',
      component: () => import('@bff/views/auth/error/index.vue'),
      meta: { title: '统一认证', isHideTab: true }
    },
    {
      path: '/403',
      name: 'Exception403',
      component: () => import('@/views/exception/403/index.vue'),
      meta: { title: '无访问权限', isHideTab: true }
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'Exception404',
      component: () => import('@/views/exception/404/index.vue'),
      meta: { title: '页面不存在', isHideTab: true }
    }
  ]
})

export function initRouter(app: App<Element>): void {
  const registry = new RouteRegistry(router)
  const menuStore = useMenuStore()
  watch(bffSession, (session) => {
    if (session) return
    registry.unregister()
    menuStore.setMenuList([])
    useWorktabStore().clearAll()
  })
  router.beforeEach(async (to) => {
    if (to.path.startsWith('/auth/') || to.path === '/403') return true
    try {
      if (!bffSession.value) await loadSession()
      if (!bffSession.value) {
        window.location.replace('/api/auth/login?' + new URLSearchParams({ returnTo: to.fullPath }))
        return false
      }
      if (!registry.isRegistered()) {
        const menus: AppRouteRecord[] = bffSession.value.menu.map((menu) => ({
          path: menu.path,
          name: menu.name,
          component: `/bff/${menu.component}`,
          meta: { title: menu.title, icon: menu.icon, keepAlive: true }
        }))
        menuStore.setMenuList(menus)
        registry.register(menus)
        return { path: to.path === '/' ? menuStore.getHomePath() : to.fullPath, replace: true }
      }
      if (to.path === '/') return menuStore.getHomePath()
      return true
    } catch {
      return { path: '/auth/login', query: { error: 'service_unavailable' } }
    }
  })
  setupAfterEachGuard(router)
  app.use(router)
}
