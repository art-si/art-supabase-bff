<template>
  <ArtDrawer ref="drawerRef" :loading="loading" :show-footer="false">
    <div class="grid min-w-0 gap-4">
      <ElAlert v-if="error" :title="error" type="error" :closable="false" show-icon
        ><ElButton link type="primary" :loading="loading" @click="loadDetail"
          >重新加载</ElButton
        ></ElAlert
      >
      <template v-if="detail && !error">
        <ArtEntitySummary
          compact
          icon="ri:alarm-warning-line"
          :title="detail.ruleName"
          :description="`${detail.applicationName} · ${detail.interfaceName || '全部接口'}`"
        >
          <template #aside
            ><ElTag :type="stateTone[detail.state]" effect="light" round>{{
              stateLabel[detail.state]
            }}</ElTag></template
          >
        </ArtEntitySummary>
        <ElAlert
          v-if="detail.state === 'acknowledged'"
          title="已确认仅表示有人接手；恢复状态由后续规则评估确认。"
          type="warning"
          :closable="false"
          show-icon
        />
        <ArtSectionCard
          title="监测证据"
          :subtitle="`${metricLabel[detail.metric]} · ${formatTime(detail.windowStartedAt)} 至 ${formatTime(detail.windowEndedAt)}`"
          preserve-content-structure
        >
          <ArtDescriptions
            :data="detail"
            :items="evidenceItems"
            :columns="2"
            :tablet-columns="2"
            :mobile-columns="1"
            class="p-3"
          />
        </ArtSectionCard>
        <ArtSectionCard
          title="处理轨迹"
          subtitle="确认与恢复分别记录，便于复核"
          preserve-content-structure
        >
          <ArtDescriptions
            :data="detail"
            :items="timelineItems"
            :columns="2"
            :tablet-columns="2"
            :mobile-columns="1"
            class="p-3"
          />
        </ArtSectionCard>
        <div class="flex flex-wrap items-center gap-2">
          <ElButton
            v-if="detail.state === 'open' && hasAuth('BffAlert:Acknowledge')"
            type="primary"
            :loading="acknowledging"
            @click="acknowledge"
            >确认接手</ElButton
          >
          <RouterLink
            v-if="hasAuth('BffCall:View')"
            :to="{
              name: 'BffCalls',
              query: {
                applicationId: detail.applicationId,
                environment: detail.environment,
                interfaceId: detail.interfaceId || undefined,
                from: detail.windowStartedAt,
                to: detail.windowEndedAt
              }
            }"
            class="text-theme"
            @click="drawerRef?.handleClose()"
            >查看关联调用</RouterLink
          >
          <RouterLink
            v-if="hasAuth('BffAlertRule:View')"
            :to="{ name: 'BffAlertRules' }"
            class="text-theme"
            @click="drawerRef?.handleClose()"
            >查看告警规则列表</RouterLink
          >
        </div>
      </template>
    </div>
  </ArtDrawer>
</template>

<script setup lang="ts">
  import { ElButton, ElMessage, ElTag } from 'element-plus'
  import { useAuth } from '@/hooks/core/useAuth'
  import { useArtFeedback, notifyFriendlyError } from '@/hooks/core/useArtFeedback'
  import { formatWithDayjs } from '@/utils/time'
  import type { ArtDescriptionItem } from '@/components/core/base/art-descriptions/types'
  import type { ArtDrawerExpose } from '@/components/core/drawers/art-drawer/types'
  import ArtDrawer from '@/components/core/drawers/art-drawer/index.vue'
  import ArtDescriptions from '@/components/core/base/art-descriptions/index.vue'
  import ArtSectionCard from '@/components/core/surfaces/art-section-card/index.vue'
  import { BffApiError } from '@bff/api/bff'
  import { acknowledgeAlert, fetchAlertDetail } from '@bff/api/observability'
  import type { AlertInstance, AlertMetric, AlertState } from '@bff/types/observability'

  const emit = defineEmits<{ acknowledged: [] }>()
  const { hasAuth } = useAuth()
  const { confirmAction } = useArtFeedback()
  const drawerRef = ref<ArtDrawerExpose<string>>()
  const alertId = ref('')
  const detail = shallowRef<AlertInstance>()
  const loading = ref(false)
  const acknowledging = ref(false)
  const error = ref('')
  const formatTime = (value: string | null): string => (value ? formatWithDayjs(value) || '—' : '—')
  const metricLabel: Record<AlertMetric, string> = {
    failure_count: '失败次数',
    failure_rate: '失败率',
    timeout_count: '超时次数',
    unknown_count: '未知结果数'
  }
  const stateLabel: Record<AlertState, string> = {
    open: '待处理',
    acknowledged: '已确认',
    recovered: '已恢复',
    closed: '已关闭'
  }
  const stateTone: Record<AlertState, 'danger' | 'warning' | 'success' | 'info'> = {
    open: 'danger',
    acknowledged: 'warning',
    recovered: 'success',
    closed: 'info'
  }
  const evidenceItems: ArtDescriptionItem<AlertInstance>[] = [
    { key: 'id', label: '事件标识', field: 'id', copyable: true, span: 2 },
    { key: 'metric', label: '检测指标', formatter: (_value, row) => metricLabel[row.metric] },
    {
      key: 'observedValue',
      label: '观测值',
      formatter: (_value, row) =>
        row.metric === 'failure_rate' ? `${row.observedValue}%` : `${row.observedValue} 次`
    },
    { key: 'knownCalls', label: '已知调用', formatter: (_value, row) => `${row.knownCalls} 次` },
    { key: 'failedCalls', label: '确认失败', formatter: (_value, row) => `${row.failedCalls} 次` },
    {
      key: 'unknownCalls',
      label: '结果未知',
      formatter: (_value, row) => `${row.unknownCalls} 次`
    },
    {
      key: 'severity',
      label: '级别',
      formatter: (_value, row) => (row.severity === 'critical' ? '严重' : '警告')
    }
  ]
  const timelineItems: ArtDescriptionItem<AlertInstance>[] = [
    { key: 'openedAt', label: '首次触发', formatter: (_value, row) => formatTime(row.openedAt) },
    {
      key: 'lastObservedAt',
      label: '最近观测',
      formatter: (_value, row) => formatTime(row.lastObservedAt)
    },
    {
      key: 'acknowledgedAt',
      label: '确认时间',
      formatter: (_value, row) => formatTime(row.acknowledgedAt)
    },
    { key: 'acknowledgedByName', label: '确认人', field: 'acknowledgedByName' },
    {
      key: 'recoveredAt',
      label: '恢复时间',
      formatter: (_value, row) => formatTime(row.recoveredAt)
    },
    { key: 'closedAt', label: '关闭时间', formatter: (_value, row) => formatTime(row.closedAt) },
    {
      key: 'closedReason',
      label: '关闭原因',
      formatter: (_value, row) =>
        row.closedReason === 'disabled'
          ? '规则停用'
          : row.closedReason === 'archived'
            ? '规则归档'
            : row.closedReason === 'reconfigured'
              ? '规则重配'
              : '—'
    }
  ]
  async function loadDetail(): Promise<void> {
    if (!alertId.value || loading.value) return
    loading.value = true
    error.value = ''
    try {
      detail.value = await fetchAlertDetail(alertId.value)
    } catch (cause) {
      detail.value = undefined
      error.value = cause instanceof BffApiError ? cause.message : '告警详情加载失败，请稍后重试'
    } finally {
      loading.value = false
    }
  }
  async function acknowledge(): Promise<void> {
    if (
      !detail.value ||
      detail.value.state !== 'open' ||
      acknowledging.value ||
      !hasAuth('BffAlert:Acknowledge')
    )
      return
    try {
      await confirmAction(
        `确认接手「${detail.value.ruleName}」后，事件仍会保持未恢复，直到后续评估确认恢复。`,
        '确认告警',
        { confirmButtonText: '确认接手' }
      )
    } catch {
      return
    }
    acknowledging.value = true
    try {
      detail.value = await acknowledgeAlert(detail.value.id, detail.value.version)
      ElMessage.success('已确认接手，恢复情况仍需跟进')
      emit('acknowledged')
    } catch (cause) {
      notifyFriendlyError(cause, '确认失败，请刷新后重试')
    } finally {
      acknowledging.value = false
    }
  }
  async function handleOpen(id: string): Promise<void> {
    alertId.value = id
    detail.value = undefined
    error.value = ''
    await drawerRef.value?.handleOpen(id, {
      title: '告警详情',
      subtitle: '观测证据与处理轨迹',
      headerIcon: 'ri:alarm-warning-line',
      size: 'lg',
      showFooter: false
    })
    await loadDetail()
  }
  defineExpose({ handleOpen })
</script>
