import type { AppRouteRecordRaw } from '@/utils/router'
// Public framework routes only; BFF business routes come from the server session.
export const staticRoutes: AppRouteRecordRaw[] = [
  { path: '/auth/login', name: 'BffLogin', component: () => import('@/views/auth/login/index.vue'), meta: { title: '统一登录', isHideTab: true } },
  { path: '/403', name: 'Exception403', component: () => import('@/views/exception/403/index.vue'), meta: { title: '403', isHideTab: true } },
  { path: '/500', name: 'Exception500', component: () => import('@/views/exception/500/index.vue'), meta: { title: '500', isHideTab: true } }
]
