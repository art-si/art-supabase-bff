<template>
  <ElConfigProvider :locale="zh" :z-index="3000">
    <a class="bff-skip" href="#main-content">跳至主要内容</a>
    <div v-if="bffSession && !route.path.startsWith('/auth/')" class="bff-shell">
      <aside class="bff-sidebar">
        <RouterLink to="/applications" class="bff-brand" aria-label="BFF 平台"
          ><ArtSvgIcon icon="ri:stack-line" /><span>BFF 平台</span></RouterLink
        >
        <div class="bff-sidebar-caption">工作空间</div>
        <nav aria-label="主导航"
          ><RouterLink
            v-for="menu in bffSession.menu"
            :key="menu.path"
            :to="menu.path"
            :aria-label="menu.title"
            class="bff-nav-item"
            ><ArtSvgIcon :icon="menu.icon" /><span>{{ menu.title }}</span></RouterLink
          ></nav
        >
        <div class="bff-sidebar-footer"
          ><ArtSvgIcon icon="ri:shield-check-line" /><span>统一身份认证</span></div
        >
      </aside>
      <div class="bff-main-column">
        <header class="bff-header"
          ><span class="font-medium">{{ route.meta.title || 'BFF 平台' }}</span
          ><div class="flex items-center gap-3"
            ><ElButton
              text
              :aria-label="dark ? '切换亮色主题' : '切换暗色主题'"
              @click="toggleTheme"
              ><ArtSvgIcon :icon="dark ? 'ri:sun-line' : 'ri:moon-line'" /></ElButton
            ><span class="bff-user-name">{{ bffSession.user.name || bffSession.user.email }}</span
            ><ElTag size="small" effect="plain">{{
              bffSession.user.role === 'admin' ? '管理员' : '成员'
            }}</ElTag
            ><ElButton :loading="leaving" text @click="leave">退出</ElButton></div
          ></header
        >
        <main id="main-content" tabindex="-1" class="bff-main"
          ><RouterView class="art-page-view"
        /></main>
      </div>
    </div>
    <main v-else id="main-content" tabindex="-1"><RouterView /></main>
  </ElConfigProvider>
</template>
<script setup lang="ts">
  import zh from 'element-plus/es/locale/lang/zh-cn'
  import { ElMessage } from 'element-plus'
  import { bffSession, signOut } from '@/api/bff'
  import { initializeTheme, useTheme } from '@/hooks/core/useTheme'
  import { useSettingStore } from '@/store/modules/setting'
  import { SystemThemeEnum } from '@/enums/app-enum'
  const route = useRoute(),
    router = useRouter()
  const settingStore = useSettingStore()
  const { switchThemeStyles } = useTheme()
  const dark = computed(() => settingStore.systemThemeType === SystemThemeEnum.DARK)
  const leaving = ref(false)
  onBeforeMount(initializeTheme)
  function toggleTheme(): void {
    switchThemeStyles(dark.value ? SystemThemeEnum.LIGHT : SystemThemeEnum.DARK)
  }
  watch(bffSession, (session, previous) => {
    if (previous && !session && !leaving.value && !route.path.startsWith('/auth/'))
      void router.replace({ path: '/auth/login', query: { returnTo: route.fullPath } })
  })
  async function leave(): Promise<void> {
    leaving.value = true
    try {
      await signOut()
      await router.replace({ path: '/auth/login', query: { signed_out: '1' } })
    } catch {
      ElMessage.error('退出失败，请稍后重试')
    } finally {
      leaving.value = false
    }
  }
</script>
<style lang="scss">
  :root {
    --custom-radius: 8px;
    --art-control-radius: 8px;
    --art-surface-radius: 10px;
    --art-dialog-radius: 12px;
    --art-drawer-radius: 12px;
  }

  body {
    margin: 0;
    color: var(--art-gray-900);
    background: var(--default-bg-color);
  }

  .bff-shell {
    display: flex;
    height: 100dvh;
  }

  .bff-sidebar {
    display: flex;
    flex: 0 0 224px;
    flex-direction: column;
    padding: 24px 16px 16px;
    background: var(--default-box-color);
    border-right: 1px solid var(--default-border);
  }

  .bff-brand {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 0 12px 34px;
    font-size: 20px;
    font-weight: 650;
    color: var(--art-gray-900);
    text-decoration: none;
  }

  .bff-brand .art-svg-icon {
    width: 26px;
    height: 26px;
    color: var(--theme-color);
  }

  .bff-sidebar-caption {
    padding: 0 12px 12px;
    font-size: 12px;
    color: var(--art-gray-700);
  }

  .bff-nav-item {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 12px;
    color: var(--art-gray-700);
    text-decoration: none;
    border-radius: var(--art-control-radius);
  }

  .bff-nav-item.router-link-active {
    font-weight: 600;
    color: var(--art-primary-text);
    background: color-mix(in srgb, var(--theme-color) 12%, transparent);
  }

  .bff-sidebar-footer {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 16px 12px;
    margin-top: auto;
    font-size: 12px;
    color: var(--art-gray-700);
  }

  .bff-main-column {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .bff-header {
    display: flex;
    flex: 0 0 64px;
    gap: 16px;
    align-items: center;
    justify-content: space-between;
    padding: 0 24px;
    background: var(--default-box-color);
    border-bottom: 1px solid var(--default-border);
  }

  .bff-main {
    flex: 1;
    min-height: 0;
    padding: 24px;
    overflow: hidden;
  }

  .bff-skip {
    position: fixed;
    top: 8px;
    left: 8px;
    z-index: 10000;
    padding: 8px 12px;
    color: var(--el-color-white);
    background: var(--theme-color);
    transform: translateY(-200%);
  }

  .bff-skip:focus {
    transform: translateY(0);
  }

  a:focus-visible {
    outline: 2px solid var(--theme-color);
    outline-offset: 3px;
  }

  @media (width <= 800px) {
    .bff-sidebar {
      flex-basis: 160px;
      padding-inline: 10px;
    }

    .bff-main {
      padding: 16px;
    }

    .bff-header {
      padding-inline: 16px;
    }

    .bff-user-name {
      display: none;
    }
  }

  @media (width <= 560px) {
    .bff-sidebar {
      flex-basis: 58px;
      padding-inline: 6px;
    }

    .bff-sidebar span,
    .bff-sidebar-caption {
      display: none;
    }

    .bff-brand {
      padding-inline: 10px;
    }

    .bff-nav-item {
      justify-content: center;
    }

    .bff-sidebar-footer {
      padding-inline: 14px;
    }

    .bff-main {
      padding: 12px;
    }
  }
</style>
