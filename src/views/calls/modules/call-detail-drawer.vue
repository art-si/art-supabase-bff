<template>
  <ArtDrawer ref="drawerRef" :loading="loading" :show-footer="false">
    <div class="grid min-w-0 gap-4">
      <ElAlert v-if="error" :title="error" type="error" :closable="false" show-icon>
        <ElButton link type="primary" :loading="loading" @click="loadDetail">重新加载</ElButton>
      </ElAlert>
      <template v-if="detail && !error">
        <ArtEntitySummary
          compact
          icon="ri:radar-line"
          :title="detail.interfaceName"
          :description="`${detail.method} ${detail.pathTemplate} · V${detail.versionNumber}`"
        >
          <template #aside>
            <ElTag :type="statusTone[detail.status]" effect="light" round>{{
              statusLabel[detail.status]
            }}</ElTag>
          </template>
        </ArtEntitySummary>
        <ElAlert
          v-if="detail.status === 'unknown'"
          title="调用结果未知。上游操作可能已经执行，请先按请求标识核对业务结果，避免重复写入。"
          type="warning"
          :closable="false"
          show-icon
        />
        <ArtSectionCard
          title="调用概况"
          subtitle="仅展示用于排障的安全元数据"
          preserve-content-structure
        >
          <ArtDescriptions
            :data="detail"
            :items="overviewItems"
            :columns="2"
            :tablet-columns="2"
            :mobile-columns="1"
            class="p-3"
          />
        </ArtSectionCard>
        <ArtSectionCard
          title="步骤结果"
          :subtitle="`${detail.steps.length} 个步骤，按执行顺序记录`"
          :empty="!detail.steps.length"
          empty-title="暂无步骤记录"
          empty-description="本次请求未进入上游执行步骤。"
          preserve-content-structure
        >
          <ol class="grid gap-1 p-3">
            <li
              v-for="(step, index) in detail.steps"
              :key="`${step.key}-${index}`"
              class="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-g-200 py-2 last:border-0"
            >
              <div class="min-w-0"
                ><strong class="block truncate text-sm text-g-900" :title="step.key"
                  >{{ index + 1 }}. {{ step.key }}</strong
                ><span v-if="step.code" class="text-xs text-g-700">{{ step.code }}</span></div
              >
              <div class="flex items-center gap-2"
                ><ElTag
                  :type="
                    step.status === 'passed'
                      ? 'success'
                      : step.status === 'failed'
                        ? 'danger'
                        : 'info'
                  "
                  effect="light"
                  round
                  >{{ { passed: '通过', failed: '失败', skipped: '跳过' }[step.status] }}</ElTag
                ><span class="text-xs text-g-700"
                  >{{ step.statusCode ? `HTTP ${step.statusCode} · ` : ''
                  }}{{ step.durationMs }} ms</span
                ></div
              >
            </li>
          </ol>
        </ArtSectionCard>
      </template>
    </div>
  </ArtDrawer>
</template>

<script setup lang="ts">
  import { ElButton, ElTag } from 'element-plus'
  import { formatWithDayjs } from '@/utils/time'
  import type { ArtDescriptionItem } from '@/components/core/base/art-descriptions/types'
  import type { ArtDrawerExpose } from '@/components/core/drawers/art-drawer/types'
  import ArtDrawer from '@/components/core/drawers/art-drawer/index.vue'
  import ArtDescriptions from '@/components/core/base/art-descriptions/index.vue'
  import ArtSectionCard from '@/components/core/surfaces/art-section-card/index.vue'
  import { BffApiError } from '@bff/api/bff'
  import { fetchCallDetail } from '@bff/api/observability'
  import type { CallRecord, CallStatus } from '@bff/types/observability'

  const drawerRef = ref<ArtDrawerExpose<string>>()
  const requestId = ref('')
  const detail = shallowRef<CallRecord>()
  const loading = ref(false)
  const error = ref('')
  const statusLabel: Record<CallStatus, string> = {
    running: '执行中',
    succeeded: '成功',
    failed: '失败',
    unknown: '结果未知'
  }
  const statusTone: Record<CallStatus, 'info' | 'success' | 'danger' | 'warning'> = {
    running: 'info',
    succeeded: 'success',
    failed: 'danger',
    unknown: 'warning'
  }
  const overviewItems: ArtDescriptionItem<CallRecord>[] = [
    { key: 'requestId', label: '请求标识', field: 'requestId', copyable: true, span: 2 },
    { key: 'application', label: '所属应用', field: 'applicationName' },
    {
      key: 'environment',
      label: '环境',
      formatter: (_value, row) =>
        ({ development: '开发', staging: '预发布', production: '生产' })[row.environment]
    },
    {
      key: 'startedAt',
      label: '开始时间',
      formatter: (_value, row) => formatWithDayjs(row.startedAt) || '—'
    },
    {
      key: 'finishedAt',
      label: '结束时间',
      formatter: (_value, row) => (row.finishedAt ? formatWithDayjs(row.finishedAt) || '—' : '—')
    },
    {
      key: 'durationMs',
      label: '总耗时',
      formatter: (_value, row) => (row.durationMs === null ? '—' : `${row.durationMs} ms`)
    },
    {
      key: 'httpStatus',
      label: 'HTTP 状态',
      formatter: (_value, row) => (row.httpStatus === null ? '—' : String(row.httpStatus))
    },
    { key: 'errorClass', label: '错误类别', field: 'errorClass' },
    { key: 'errorCode', label: '错误代码', field: 'errorCode' }
  ]
  async function loadDetail(): Promise<void> {
    if (!requestId.value || loading.value) return
    loading.value = true
    error.value = ''
    try {
      detail.value = await fetchCallDetail(requestId.value)
    } catch (cause) {
      detail.value = undefined
      error.value = cause instanceof BffApiError ? cause.message : '调用详情加载失败，请稍后重试'
    } finally {
      loading.value = false
    }
  }
  async function handleOpen(id: string): Promise<void> {
    requestId.value = id
    detail.value = undefined
    error.value = ''
    await drawerRef.value?.handleOpen(id, {
      title: '调用详情',
      subtitle: '请求链路与安全步骤摘要',
      headerIcon: 'ri:radar-line',
      size: 'lg',
      showFooter: false
    })
    await loadDetail()
  }
  defineExpose({ handleOpen })
</script>
