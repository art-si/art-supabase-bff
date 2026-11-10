<template>
  <div class="business-workspace-page art-full-height">
    <BusinessWorkspaceHeader
      eyebrow="CALL OBSERVABILITY"
      title="调用日志"
      description="按请求标识追踪已发布接口的调用结果与安全步骤摘要。未知结果可能已在上游执行，请先核对业务状态。"
      icon="ri:radar-line"
      :metrics="metrics"
    >
      <template #actions><BusinessTableWorkspaceActions :table="tableRef" /></template>
    </BusinessWorkspaceHeader>
    <ElAlert v-if="optionsError" type="warning" :closable="false" show-icon>
      <template #title>筛选选项暂时无法加载</template>
      可继续查看日志；请稍后重新加载筛选选项。
      <ElButton link type="primary" :loading="optionsLoading" @click="loadOptions"
        >重新加载</ElButton
      >
    </ElAlert>
    <div class="call-page__workspace min-h-0 flex-1">
      <ArtTableQuery
        ref="tableRef"
        v-model="filters"
        v-model:show-search-bar="showSearchBar"
        class="h-full"
        focusable
        focus-scope-selector=".call-page__workspace"
        :api-fn="loadCalls"
        :columns-factory="columnsFactory"
        :search-items="searchItems"
        :enable-cache="false"
        :search-bar-props="{ showExpand: true, span: 6 }"
        :table-header-props="{ layout: 'refresh,size' }"
        :table-props="{
          rowKey: 'requestId',
          stripe: false,
          emptyText: '暂无符合条件的调用',
          emptyDescription: '可调整请求标识、状态或时间范围后查询。'
        }"
      />
    </div>
    <CallDetailDrawer ref="detailRef" />
  </div>
</template>

<script setup lang="tsx">
  import { ElButton, ElTag } from 'element-plus'
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
  import { fetchCallOptions, fetchCalls } from '@bff/api/observability'
  import type {
    CallList,
    CallListQuery,
    CallOptions,
    CallRecord,
    CallStatus
  } from '@bff/types/observability'
  import CallDetailDrawer from './modules/call-detail-drawer.vue'

  defineOptions({ name: 'BffCalls' })
  const route = useRoute()
  const tableRef = ref<ArtTableQueryExpose>()
  const detailRef = ref<InstanceType<typeof CallDetailDrawer>>()
  const options = shallowRef<CallOptions>()
  const optionsLoading = ref(false)
  const optionsError = ref('')
  const showSearchBar = ref(true)
  const routeFilters = () => {
    const environment = route.query.environment
    return {
      requestId: typeof route.query.requestId === 'string' ? route.query.requestId : '',
      applicationId: typeof route.query.applicationId === 'string' ? route.query.applicationId : '',
      environment:
        environment === 'development' || environment === 'staging' || environment === 'production'
          ? environment
          : '',
      interfaceId: typeof route.query.interfaceId === 'string' ? route.query.interfaceId : '',
      period:
        typeof route.query.from === 'string' && typeof route.query.to === 'string'
          ? [route.query.from, route.query.to]
          : []
    }
  }
  const filters = ref({
    ...routeFilters(),
    status: '',
    errorClass: ''
  })
  watch(
    () => [
      route.query.applicationId,
      route.query.environment,
      route.query.interfaceId,
      route.query.requestId,
      route.query.from,
      route.query.to
    ],
    () => {
      Object.assign(filters.value, routeFilters(), { status: '', errorClass: '' })
      tableRef.value?.cancelRequest()
      void nextTick(() => tableRef.value?.getData())
    },
    { flush: 'post' }
  )
  const summary = shallowRef<CallList['summary']>({
    total: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    timeout: 0
  })
  const loaded = ref(false)
  const metrics = computed<BusinessWorkspaceMetric[]>(() => [
    {
      key: 'total',
      label: '调用总数',
      value: summary.value.total,
      description: '当前筛选范围',
      icon: 'ri:bar-chart-2-line',
      tone: 'primary',
      loading: !loaded.value
    },
    {
      key: 'failed',
      label: '确认失败',
      value: summary.value.failed,
      description: '已确认完成但未成功',
      icon: 'ri:error-warning-line',
      tone: 'danger',
      loading: !loaded.value
    },
    {
      key: 'timeout',
      label: '超时',
      value: summary.value.timeout,
      description: '需核对上游结果',
      icon: 'ri:timer-flash-line',
      tone: 'warning',
      loading: !loaded.value
    },
    {
      key: 'unknown',
      label: '结果未知',
      value: summary.value.unknown,
      description: '可能已经执行',
      icon: 'ri:question-line',
      tone: 'info',
      loading: !loaded.value
    }
  ])
  const searchItems = computed<SearchFormItem[]>(() => [
    {
      key: 'requestId',
      label: '请求标识',
      type: 'input',
      props: { clearable: true, placeholder: '输入 Request ID' }
    },
    {
      key: 'applicationId',
      label: '所属应用',
      type: 'select',
      props: {
        clearable: true,
        filterable: true,
        placeholder: '全部应用',
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
        clearable: true,
        placeholder: '全部环境',
        options: options.value?.environments ?? []
      }
    },
    {
      key: 'status',
      label: '调用状态',
      type: 'select',
      props: { clearable: true, placeholder: '全部状态', options: options.value?.statuses ?? [] }
    },
    {
      key: 'interfaceId',
      label: '接口',
      type: 'select',
      props: {
        clearable: true,
        filterable: true,
        placeholder: '全部接口',
        options: (options.value?.interfaces ?? [])
          .filter(
            (item) =>
              !filters.value.applicationId || item.applicationId === filters.value.applicationId
          )
          .map((item) => ({ label: item.name, value: item.id }))
      }
    },
    {
      key: 'errorClass',
      label: '错误类别',
      type: 'select',
      props: {
        clearable: true,
        placeholder: '全部类别',
        options: options.value?.errorClasses ?? []
      }
    },
    {
      key: 'period',
      label: '开始时间',
      type: 'date',
      span: 12,
      props: {
        type: 'datetimerange',
        valueFormat: 'YYYY-MM-DDTHH:mm:ssZ',
        startPlaceholder: '开始',
        endPlaceholder: '结束',
        clearable: true
      }
    }
  ])
  async function loadOptions(): Promise<void> {
    if (optionsLoading.value) return
    optionsLoading.value = true
    optionsError.value = ''
    try {
      options.value = await fetchCallOptions()
    } catch (error) {
      optionsError.value =
        error instanceof BffApiError ? error.message : '筛选选项加载失败，请稍后重试'
    } finally {
      optionsLoading.value = false
    }
  }
  onMounted(() => void loadOptions())
  async function loadCalls(params: Record<string, unknown>): Promise<CallList> {
    const period = Array.isArray(params.period) ? params.period : []
    const query: CallListQuery = {
      current: Math.max(1, Number(params.current) || 1),
      size: Math.max(1, Number(params.size) || 20),
      requestId: typeof params.requestId === 'string' ? params.requestId : undefined,
      applicationId: typeof params.applicationId === 'string' ? params.applicationId : undefined,
      environment:
        params.environment === 'development' ||
        params.environment === 'staging' ||
        params.environment === 'production'
          ? params.environment
          : undefined,
      interfaceId: typeof params.interfaceId === 'string' ? params.interfaceId : undefined,
      status: options.value?.statuses.find((item) => item.value === params.status)?.value,
      errorClass: options.value?.errorClasses.find((item) => item.value === params.errorClass)
        ?.value,
      from: typeof period[0] === 'string' ? period[0] : undefined,
      to: typeof period[1] === 'string' ? period[1] : undefined
    }
    const result = await fetchCalls(query)
    summary.value = result.summary
    loaded.value = true
    return result
  }
  const statusPresentation: Record<
    CallStatus,
    { label: string; type: 'info' | 'success' | 'danger' | 'warning' }
  > = {
    running: { label: '执行中', type: 'info' },
    succeeded: { label: '成功', type: 'success' },
    failed: { label: '失败', type: 'danger' },
    unknown: { label: '结果未知', type: 'warning' }
  }
  function columnsFactory(): ColumnOption<CallRecord>[] {
    return [
      {
        prop: 'requestId',
        label: '请求标识 / 时间',
        minWidth: 225,
        formatter: (row) => (
          <div class="min-w-0 py-1">
            <strong class="block truncate font-mono text-xs text-g-900" title={row.requestId}>
              {row.requestId}
            </strong>
            <span class="mt-1 block text-xs text-g-700">{formatWithDayjs(row.startedAt)}</span>
          </div>
        )
      },
      {
        prop: 'interfaceName',
        label: '接口 / 模板',
        minWidth: 240,
        formatter: (row) => (
          <div class="min-w-0 py-1">
            <strong class="block truncate font-semibold text-g-900" title={row.interfaceName}>
              {row.interfaceName}
            </strong>
            <span
              class="mt-1 block truncate font-mono text-xs text-g-700"
              title={`${row.method} ${row.pathTemplate}`}
            >
              {row.method} {row.pathTemplate} · V{row.versionNumber}
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
        prop: 'status',
        label: '结果',
        minWidth: 115,
        formatter: (row) => (
          <div class="grid gap-1">
            <ElTag type={statusPresentation[row.status].type} effect="light" round>
              {statusPresentation[row.status].label}
            </ElTag>
            <span class="text-xs text-g-700">
              {row.httpStatus ? `HTTP ${row.httpStatus}` : row.errorCode || '—'}
            </span>
          </div>
        )
      },
      {
        prop: 'durationMs',
        label: '耗时',
        minWidth: 95,
        formatter: (row) => (row.durationMs === null ? '—' : `${row.durationMs} ms`)
      },
      {
        prop: 'actions',
        label: '操作',
        width: 84,
        fixed: 'right',
        formatter: (row) => (
          <BusinessTableRowActions>
            <ArtButtonTable
              type="view"
              label="查看调用详情"
              permission="BffCall:View"
              onClick={() => void detailRef.value?.handleOpen(row.requestId)}
            />
          </BusinessTableRowActions>
        )
      }
    ]
  }
</script>
