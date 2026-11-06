<template>
  <div class="min-h-dvh flex items-center justify-center px-5 py-10">
    <ArtSectionCard
      v-if="message"
      class="w-full max-w-lg"
      title="登录未完成"
      subtitle="使用统一账号安全访问 BFF 平台。"
    >
      <ElAlert :title="message" type="error" :closable="false" show-icon />
      <ElButton type="primary" size="large" class="mt-5 w-full" :loading="loading" @click="login">{{
        '重试登录'
      }}</ElButton>
    </ArtSectionCard>
    <div v-else role="status" aria-live="polite" class="flex items-center gap-3 text-g-700">
      <ArtSvgIcon icon="ri:shield-keyhole-line" class="text-theme text-2xl" aria-hidden="true" />
      <p>正在连接统一认证…</p>
    </div>
  </div>
</template>
<script setup lang="ts">
  import { getAuthStatus } from '@bff/api/bff'
  const route = useRoute()
  const loading = ref(false)
  const failure = ref('')
  const signedOut = computed(() => route.query.signed_out === '1' && !failure.value)
  const errors: Record<string, string> = {
    access_denied: '该账号尚未开通平台访问权限，或权限已停用，请联系管理员。',
    authorization_cancelled: '你已取消本次授权，可以重新发起登录。',
    login_failed: '此次登录未完成，请重新登录。',
    login_unavailable: '统一登录暂时不可用，请稍后重试。',
    service_unavailable: '暂时无法检查登录状态，请稍后重试。'
  }
  const message = computed(() => {
    if (failure.value) return failure.value
    if (route.query.error) return errors[String(route.query.error)] || errors.login_failed
    return ''
  })
  async function login(): Promise<void> {
    if (loading.value) return
    loading.value = true
    failure.value = ''
    try {
      const status = await getAuthStatus()
      if (!status.authenticationConfigured) {
        failure.value = '统一登录接入尚未完成，请联系平台管理员。'
        return
      }
      const query = new URLSearchParams({
        returnTo: typeof route.query.returnTo === 'string' ? route.query.returnTo : '/applications'
      })
      if (signedOut.value) query.set('force_login', '1')
      window.location.replace('/api/auth/login?' + query)
    } catch {
      failure.value = '服务暂时不可用，请稍后重试。'
    } finally {
      loading.value = false
    }
  }
  onMounted(() => {
    if (signedOut.value) {
      window.location.replace('/api/auth/login?force_login=1&returnTo=%2Fapplications')
      return
    }
    if (!message.value) void login()
  })
</script>
