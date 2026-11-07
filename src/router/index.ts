import type { App, Component } from 'vue'
import { watch } from 'vue'
import { omit } from 'lodash-es'
import { createRouter, createWebHistory } from 'vue-router'
import { RouteRegistry } from '@/router/core/route-registry'
import { registerApplicationViewModules } from '@/router/core/component-loader'
import { setupAfterEachGuard } from '@/router/guards/after-each'
import { useMenuStore } from '@/store/modules/menu'
import { useWorktabStore } from '@/store/modules/worktab'
import { useUserStore } from '@/store/modules/user'
import { notifyFriendlyError } from '@/hooks/core/useArtFeedback'
import { bffSession, loadSession } from '@bff/api/bff'

export const HOME_PAGE_PATH = '/applications'
registerApplicationViewModules(
  'bff',
  '/src/views',
  import.meta.glob<{ default: Component }>('/src/views/**/*.vue')
)
registerApplicationViewModules('shared', '/shared', {
  '/shared/system/menu.vue': () => import('@/views/system/menu/index.vue'),
  '/shared/system/role.vue': () => import('@/views/system/role/index.vue'),
  '/shared/system/website-config.vue': () => import('@/views/system/website-config/index.vue'),
  '/shared/data-center/dict.vue': () => import('@/views/data-center/dict/index.vue')
})

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/auth/login',
      name: 'Login',
      component: { render: () => null },
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
    const userStore = useUserStore()
    userStore.clearDictionaryCache()
    userStore.setUserInfo(
      session
        ? {
            userId: session.user.id,
            nickName: session.user.name,
            email: session.user.email,
            tenantId: session.user.tenantId,
            platformSuper: false
          }
        : {}
    )
    userStore.setLoginStatus(Boolean(session))
    if (session) return
    registry.unregister()
    menuStore.setMenuList([])
    useWorktabStore().clearAll()
  })
  router.beforeEach(async (to) => {
    if (to.path === '/auth/login') {
      const query = new URLSearchParams({
        returnTo: typeof to.query.returnTo === 'string' ? to.query.returnTo : '/applications'
      })
      if (to.query.signed_out === '1' || to.query.error === 'access_denied')
        query.set('force_login', '1')
      if (typeof to.query.error === 'string') query.set('restart', '1')
      if (to.query.error === 'access_denied') query.set('reason', 'access_denied')
      window.location.replace('/api/auth/login?' + query)
      return false
    }
    if (to.path === '/403') return true
    const recoveredPath = router.resolve({
      path: to.path,
      query: omit(to.query, '_bff_auth_retry'),
      hash: to.hash
    }).fullPath
    try {
      if (!bffSession.value) await loadSession()
      if (!bffSession.value) {
        window.location.replace('/api/auth/login?' + new URLSearchParams({ returnTo: to.fullPath }))
        return false
      }
      if (!registry.isRegistered()) {
        try {
          await useUserStore().fetchDictList()
        } catch (error) {
          notifyFriendlyError(error, '基础选项暂时无法加载，请稍后刷新页面', 'warning')
        }
        const menus = bffSession.value.menu
        menuStore.setMenuList(menus)
        registry.register(menus)
        useWorktabStore().validateWorktabs(router)
        // Match pro's route replay: Vue Router 5 drops embedded query strings in path objects.
        return to.path === '/' ? menuStore.getHomePath() : recoveredPath
      }
      if (to.path === '/') return menuStore.getHomePath()
      if (to.query._bff_auth_retry) return recoveredPath
      return true
    } catch {
      if (to.query._bff_auth_retry === '1') {
        window.location.replace(
          '/api/auth/login?' +
            new URLSearchParams({
              reason: 'service_unavailable',
              restart: '1',
              force_login: '1',
              returnTo: recoveredPath
            })
        )
        return false
      }
      window.location.replace(
        '/api/auth/login?' +
          new URLSearchParams({
            returnTo: router.resolve({
              path: to.path,
              query: { ...to.query, _bff_auth_retry: '1' },
              hash: to.hash
            }).fullPath,
            restart: '1'
          })
      )
      return false
    }
  })
  setupAfterEachGuard(router)
  app.use(router)
}
