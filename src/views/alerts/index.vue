<template>
  <div class="business-workspace-page art-full-height">
    <BusinessWorkspaceHeader
      eyebrow="ALERT OPERATIONS"
      title="告警事件"
      description="识别、确认并追踪异常恢复。确认仅表示有人接手，不代表调用或上游服务已恢复。"
      icon="ri:alarm-warning-line"
      :metrics="metrics"
    >
      <template #actions><BusinessTableWorkspaceActions :table="tableRef" /></template>
    </BusinessWorkspaceHeader>
    <ElAlert v-if="optionsError" type="warning" :closable="false" show-icon
      >筛选选项暂时无法加载，告警列表仍可浏览。<ElButton
        link
        type="primary"
        :loading="optionsLoading"
        @click="loadOptions"
        >重新加载</ElButton
      ></ElAlert
    >
    <div class="alert-page__workspace min-h-0 flex-1">
      <ArtTableQuery
        ref="tableRef"
        v-model="filters"
        v-model:show-search-bar="showSearchBar"
        class="h-full"
        focusable
        focus-scope-selector=".alert-page__workspace"
        :api-fn="loadAlerts"
        :columns-factory="columnsFactory"
        :search-items="searchItems"
        :enable-cache="false"
        :search-bar-props="{ showExpand: false, span: 6 }"
        :table-header-props="{ layout: 'refresh,size' }"
        :table-props="{
          rowKey: 'id',
          stripe: false,
          emptyText: '暂无符合条件的告警',
          emptyDescription: '可调整状态或应用筛选；新告警由启用的规则评估产生。'
        }"
      />
    </div>
    <AlertDetailDrawer ref="detailRef" @acknowledged="refreshData" />
  </div>
</template>

<script setup lang="tsx">
  import { ElButton, ElTag } from 'element-plus'
  import { useAuth } from '@/hooks/core/useAuth'
  import { formatWithDayjs } from '@/utils/time'
  import type { ColumnOption } from '@/types'
  import type { SearchFormItem } from '@/components/core/forms/art-search-bar/index.vue'
  import type { ArtTableQueryExpose } from '@/components/core/tables/art-table-query/index.vue'
  import BusinessWorkspaceHeader, {
    type BusinessWorkspaceMetric
  } from '@/components/business/business-workspace-header/index.vue'
  import BusinessTableWorkspaceActions from '@/components/business/business-table-workspace-actions/index.vue'
  import BusinessTableRowActions from '@/components/business/business-table-row-actions/index.vue'
  import ArtButtonTable from '@/components/core/forms/art-button-table/index.vue'
  import { BffApiError } from '@bff/api/bff'
  import { fetchAlertOptions, fetchAlerts } from '@bff/api/observability'
  import type {
    AlertInstance,
    AlertList,
    AlertListQuery,
    AlertMetric,
    AlertOptions,
    AlertState
  } from '@bff/types/observability'
  import AlertDetailDrawer from './modules/alert-detail-drawer.vue'

  defineOptions({ name: 'BffAlertInstances' })
  const { hasAuth } = useAuth()
  const tableRef = ref<ArtTableQueryExpose>()
  const detailRef = ref<InstanceType<typeof AlertDetailDrawer>>()
  const options = shallowRef<AlertOptions>()
  const optionsLoading = ref(false)
  const optionsError = ref('')
  const showSearchBar = ref(true)
  const filters = ref({
    applicationId: '',
    environment: '',
    state: '',
    severity: '',
    period: [] as string[]
  })
  const summary = shallowRef<AlertList['summary']>({
    total: 0,
    open: 0,
    acknowledged: 0,
    recovered: 0,
    closed: 0
  })
  const loaded = ref(false)
  const statePresentation: Record<
    AlertState,
    { label: string; type: 'danger' | 'warning' | 'success' | 'info' }
  > = {
    open: { label: '待处理', type: 'danger' },
    acknowledged: { label: '已确认', type: 'warning' },
    recovered: { label: '已恢复', type: 'success' },
    closed: { label: '已关闭', type: 'info' }
  }
  const metricLabels: Record<AlertMetric, string> = {
    failure_count: '失败次数',
    failure_rate: '失败率',
    timeout_count: '超时次数',
    unknown_count: '未知结果数'
  }
  const metrics = computed<BusinessWorkspaceMetric[]>(() => [
    {
      key: 'total',
      label: '事件总数',
      value: summary.value.total,
      description: '当前筛选范围',
      icon: 'ri:alarm-warning-line',
      tone: 'primary',
      loading: !loaded.value
    },
    {
      key: 'open',
      label: '待处理',
      value: summary.value.open,
      description: '尚未有人确认',
      icon: 'ri:error-warning-line',
      tone: 'danger',
      loading: !loaded.value
    },
    {
      key: 'acknowledged',
      label: '已确认',
      value: summary.value.acknowledged,
      description: '仍需关注恢复情况',
      icon: 'ri:eye-line',
      tone: 'warning',
      loading: !loaded.value
    },
    {
      key: 'recovered',
      label: '已恢复',
      value: summary.value.recovered,
      description: '评估结果已回落',
      icon: 'ri:checkbox-circle-line',
      tone: 'success',
      loading: !loaded.value
    }
  ])
  const searchItems = computed<SearchFormItem[]>(() => [
    {
      key: 'applicationId',
      label: '所属应用',
      type: 'select',
      props: {
        placeholder: '全部应用',
        clearable: true,
        filterable: true,
        options: (options.value?.applications ?? []).map((item) => ({
          label: item.name,
          value: item.id
        }))
      }
    },
    {
      key: 'environment',
      label: '环境',
      type: 'select',
      props: {
        placeholder: '全部环境',
        clearable: true,
        options: options.value?.environments ?? []
      }
    },
    {
      key: 'state',
      label: '事件状态',
      type: 'select',
      props: { placeholder: '全部状态', clearable: true, options: options.value?.statuses ?? [] }
    },
    {
      key: 'severity',
      label: '级别',
      type: 'select',
      props: { placeholder: '全部级别', clearable: true, options: options.value?.severities ?? [] }
    },
    {
      key: 'period',
      label: '首次触发',
      type: 'date',
      span: 12,
      props: {
        type: 'datetimerange',
        valueFormat: 'YYYY-MM-DDTHH:mm:ssZ',
        startPlaceholder: '开始',
        endPlaceholder: '结束',
        clearable: true
      },
      description: '自定义范围最多 30 天；未选择时显示待处理事件及最近 30 天的历史。'
    }
  ])
  async function loadOptions(): Promise<void> {
    if (optionsLoading.value) return
    optionsLoading.value = true
    optionsError.value = ''
    try {
      options.value = await fetchAlertOptions()
    } catch (error) {
      optionsError.value =
        error instanceof BffApiError ? error.message : '筛选选项加载失败，请稍后重试'
    } finally {
      optionsLoading.value = false
    }
  }
  onMounted(() => void loadOptions())
  async function loadAlerts(params: Record<string, unknown>): Promise<AlertList> {
    const period = Array.isArray(params.period) ? params.period : []
    const query: AlertListQuery = {
      current: Math.max(1, Number(params.current) || 1),
      size: Math.max(1, Number(params.size) || 20),
      applicationId: typeof params.applicationId === 'string' ? params.applicationId : undefined,
      environment: options.value?.environments.find((item) => item.value === params.environment)
        ?.value,
      state: options.value?.statuses.find((item) => item.value === params.state)?.value,
      severity: options.value?.severities.find((item) => item.value === params.severity)?.value,
      from: typeof period[0] === 'string' ? period[0] : undefined,
      to: typeof period[1] === 'string' ? period[1] : undefined
    }
    const result = await fetchAlerts(query)
    summary.value = result.summary
    loaded.value = true
    return result
  }
  function refreshData(): void {
    void tableRef.value?.refreshData()
  }
  function columnsFactory(): ColumnOption<AlertInstance>[] {
    return [
      {
        prop: 'ruleName',
        label: '告警 / 规则',
        minWidth: 245,
        formatter: (row) => (
          <div class="min-w-0 py-1">
            <strong class="block truncate font-semibold text-g-900" title={row.ruleName}>
              {row.ruleName}
            </strong>
            <span class="mt-1 block truncate text-xs text-g-700">
              {row.interfaceName || '应用内全部接口'} · {metricLabels[row.metric]}
            </span>
          </div>
        )
      },
      {
        prop: 'applicationName',
        label: '应用 / 环境',
        minWidth: 165,
        formatter: (row) => (
          <div class="grid gap-1">
            <span class="truncate text-g-900" title={row.applicationName}>
              {row.applicationName}
            </span>
            <span class="text-xs text-g-700">
              {{ development: '开发', staging: '预发布', production: '生产' }[row.environment]}
            </span>
          </div>
        )
      },
      {
        prop: 'severity',
        label: '级别',
        minWidth: 95,
        formatter: (row) => (
          <ElTag type={row.severity === 'critical' ? 'danger' : 'warning'} effect="light" round>
            {row.severity === 'critical' ? '严重' : '警告'}
          </ElTag>
        )
      },
      {
        prop: 'state',
        label: '状态',
        minWidth: 110,
        formatter: (row) => (
          <ElTag type={statePresentation[row.state].type} effect="light" round>
            {statePresentation[row.state].label}
          </ElTag>
        )
      },
      {
        prop: 'observedValue',
        label: '观测值',
        minWidth: 130,
        formatter: (row) => (
          <div class="grid gap-1">
            <strong class="text-g-900">
              {row.metric === 'failure_rate' ? `${row.observedValue}%` : row.observedValue}
            </strong>
            <span class="text-xs text-g-700">已知调用 {row.knownCalls} 次</span>
          </div>
        )
      },
      {
        prop: 'openedAt',
        label: '首次触发',
        minWidth: 150,
        formatter: (row) => formatWithDayjs(row.openedAt)
      },
      {
        prop: 'actions',
        label: '操作',
        width: 85,
        fixed: 'right',
        formatter: (row) => (
          <BusinessTableRowActions>
            {hasAuth('BffAlert:View') && (
              <ArtButtonTable
                type="view"
                label="查看告警详情"
                permission="BffAlert:View"
                onClick={() => void detailRef.value?.handleOpen(row.id)}
              />
            )}
          </BusinessTableRowActions>
        )
      }
    ]
  }
</script>
