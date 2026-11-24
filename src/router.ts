import { createRouter, createWebHistory } from 'vue-router'
import { useSession } from './session'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/admin' },
    { path: '/admin/sign-in', name: 'sign-in', component: () => import('./views/SignInView.vue'), meta: { public: true } },
    {
      path: '/admin',
      component: () => import('./views/AdminLayout.vue'),
      children: [
        { path: '', name: 'tenants', component: () => import('./views/TenantsView.vue') },
        { path: 'accounts', name: 'accounts', component: () => import('./views/AccountsView.vue') },
        { path: 'posts', name: 'posts', component: () => import('./views/PostsView.vue') },
        { path: 'clients', name: 'clients', component: () => import('./views/ClientsView.vue') },
        { path: 'audit', name: 'audit', component: () => import('./views/AuditView.vue') },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/admin' },
  ],
})

router.beforeEach(async (to) => {
  const session = useSession()
  if (!session.checked) await session.load()
  if (to.meta.public) return session.admin ? { name: 'tenants' } : true
  return session.admin ? true : { name: 'sign-in', query: { next: to.fullPath } }
})
