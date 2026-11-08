<template>
  <ElButton @click="openGuide">
    <template #icon><ArtSvgIcon icon="ri:book-open-line" /></template>
    使用流程
  </ElButton>
  <ArtDrawer ref="drawerRef" :show-footer="false">
    <ArtSectionCard
      :title="`接入流程 · ${current.title}`"
      subtitle="按顺序完成配置；每个阶段都保留独立的验证与权限检查。"
    >
      <ol class="grid gap-3 pb-2 sm:grid-cols-2">
        <li v-for="(item, index) in steps" :key="item.path" class="min-w-0 rounded-lg bg-g-100 p-3">
          <p
            class="mb-2 text-sm font-semibold"
            :class="index === step ? 'text-theme' : 'text-g-900'"
          >
            {{ index + 1 }}. {{ item.title }}{{ index === step ? '（当前）' : '' }}
          </p>
          <p class="mb-2 text-xs leading-5 text-g-700">{{ item.description }}</p>
          <RouterLink
            v-if="index !== step && hasAuth(item.permission)"
            :to="{ path: item.path, query: applicationId && index > 0 ? { applicationId } : {} }"
            class="text-sm text-theme underline underline-offset-4"
          >
            前往{{ item.title }}
          </RouterLink>
        </li>
      </ol>
      <p class="text-xs leading-5 text-g-700">
        发布并启用后，在 Pro 的「BFF 接入中心」选择应用、环境和接口调用。Pro
        需完成桥接部署，账号需已开通 BFF 成员及应用访问权。
        网络可达仅说明连接成功；定义验证检查结构，接口测试检查实际请求与输出，发布前仍需重新检查。
      </p>
    </ArtSectionCard>
  </ArtDrawer>
</template>

<script setup lang="ts">
  import { useAuth } from '@/hooks/core/useAuth'
  import type { ArtDrawerExpose } from '@/components/core/drawers/art-drawer/types'
  const drawerRef = ref<ArtDrawerExpose>()
  function openGuide(): void {
    void drawerRef.value?.handleOpen(undefined, { title: '接口接入流程', size: 'lg' })
  }
  const props = defineProps<{ step: 0 | 1 | 2 | 3; applicationId?: string }>()
  const { hasAuth } = useAuth()
  const steps = [
    {
      title: '应用管理',
      path: '/applications',
      permission: 'BffApplication:View',
      description:
        '登记并启用应用，为普通成员分配应用访问权。应用地址是访问入口，不是上游接口地址。'
    },
    {
      title: '上游服务',
      path: '/upstreams',
      permission: 'BffUpstream:View',
      description:
        '按应用和环境登记服务地址，配置凭据并启用。确认网络策略允许访问，再检测连接；本地地址要求服务进程持续运行。'
    },
    {
      title: '接口编排',
      path: '/interfaces',
      permission: 'BffInterface:View',
      description:
        '声明输入，配置上游步骤和输出映射。保存后先验证定义，再运行测试。分页示例可填页码 1、页长 20。'
    },
    {
      title: '版本发布',
      path: '/releases',
      permission: 'BffRelease:View',
      description:
        '选择接口并发布草稿，逐项处理发布前检查。确认运行版本已启用，再调用；修改草稿后需重新测试和发布。'
    }
  ] as const
  const current = computed(() => steps[props.step])
</script>
