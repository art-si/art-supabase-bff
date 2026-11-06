import { createRouter, createWebHistory } from 'vue-router'
import { bffSession, loadSession } from '@/api/bff'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/auth/login',
      name: 'BffLogin',
      component: () => import('@/views/auth/login/index.vue')
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'BffEntry',
      component: () => import('@/views/entry/index.vue')
    }
  ]
})
let loaded = false
router.beforeEach(async (to) => {
  if (to.path.startsWith('/auth/')) return true
  try {
    if (!loaded || !bffSession.value) {
      await loadSession()
      loaded = true
    }
    if (!bffSession.value) return { path: '/auth/login', query: { returnTo: to.fullPath } }
    for (const menu of bffSession.value.menu) {
      if (!router.hasRoute(menu.name) && menu.component === 'applications/index')
        router.addRoute({
          path: menu.path,
          name: menu.name,
          component: () => import('@/views/applications/index.vue'),
          meta: { title: menu.title }
        })
    }
    if (to.path === '/') return '/applications'
    if (to.name === 'BffEntry' && bffSession.value.menu.some((menu) => menu.path === to.path))
      return { path: to.fullPath, replace: true }
    return true
  } catch {
    return { path: '/auth/login', query: { error: 'service_unavailable' } }
  }
})
export const HOME_PAGE_PATH = '/applications'
