<template>
  <div class="business-workspace-page art-full-height">
    <BusinessWorkspaceHeader
      eyebrow="ALERT POLICY"
      title="告警规则"
      description="按应用、环境与接口定义异常阈值。停用和归档保留历史告警，不改变既有调用记录。"
      icon="ri:notification-badge-line"
      :metrics="metrics"
    >
      <template #actions><BusinessTableWorkspaceActions :table="tableRef" /></template>
    </BusinessWorkspaceHeader>
    <ElAlert v-if="optionsError" type="warning" :closable="false" show-icon
      >规则仍可浏览，编辑选项暂时不可用。<ElButton
        link
        type="primary"
        :loading="optionsLoading"
        @click="loadOptions"
        >重新加载</ElButton
      ></ElAlert
    >
    <div class="alert-rule-page__workspace min-h-0 flex-1">
      <ArtTableQuery
        ref="tableRef"
        v-model="filters"
        v-model:show-search-bar="showSearchBar"
        class="h-full"
        focusable
        focus-scope-selector=".alert-rule-page__workspace"
        :api-fn="loadRules"
        :columns-factory="columnsFactory"
        :search-items="searchItems"
        :header-actions="headerActions"
        header-actions-placement="workspace"
        :enable-cache="false"
        :search-bar-props="{ showExpand: false, span: 6 }"
        :table-header-props="{ layout: 'refresh,size' }"
        :table-props="{
          rowKey: 'id',
          stripe: false,
          emptyText: '暂无符合条件的告警规则',
          emptyDescription: '可调整筛选条件，或创建第一条规则。'
        }"
      />
    </div>
    <AlertRuleEditor ref="editorRef" @success="refreshData" />
  </div>
</template>

<script setup lang="tsx">
  import { ElButton, ElMessage, ElTag } from 'element-plus'
  import { useAuth } from '@/hooks/core/useAuth'
  import { useArtFeedback, notifyFriendlyError } from '@/hooks/core/useArtFeedback'
  import { formatWithDayjs } from '@/utils/time'
  import type { ColumnOption } from '@/types'
  import type { SearchFormItem } from '@/components/core/forms/art-search-bar/index.vue'
  import type {
    ArtTableQueryExpose,
    ArtTableQueryHeaderAction
  } from '@/components/core/tables/art-table-query/index.vue'
  import BusinessWorkspaceHeader, {
    type BusinessWorkspaceMetric
  } from '@/components/business/business-workspace-header/index.vue'
  import BusinessTableWorkspaceActions from '@/components/business/business-table-workspace-actions/index.vue'
  import BusinessTableRowActions from '@/components/business/business-table-row-actions/index.vue'
  import ArtButtonTable from '@/components/core/forms/art-button-table/index.vue'
  import ArtButtonMore, {
    type ButtonMoreItem
  } from '@/components/core/forms/art-button-more/index.vue'
  import { BffApiError } from '@bff/api/bff'
  import {
    archiveAlertRule,
    changeAlertRuleStatus,
    evaluateAlertRule,
    fetchAlertOptions,
    fetchAlertRules
  } from '@bff/api/observability'
  import type {
    AlertMetric,
    AlertOptions,
    AlertRule,
    AlertRuleList,
    AlertRuleListQuery
  } from '@bff/types/observability'
  import AlertRuleEditor from './modules/alert-rule-editor.vue'

  defineOptions({ name: 'BffAlertRules' })
  const { hasAuth } = useAuth()
  const { confirmAction } = useArtFeedback()
  const tableRef = ref<ArtTableQueryExpose>()
  const editorRef = ref<InstanceType<typeof AlertRuleEditor>>()
  const options = shallowRef<AlertOptions>()
  const optionsLoading = ref(false)
  const optionsError = ref('')
  const showSearchBar = ref(true)
  const busyId = ref('')
  const filters = ref({
    name: '',
    applicationId: '',
    environment: '',
    metric: '',
    archived: 'false'
  })
  const summary = shallowRef<AlertRuleList['summary']>({
    total: 0,
    enabled: 0,
    disabled: 0,
    archived: 0
  })
  const loaded = ref(false)
  const metricLabels: Record<AlertMetric, string> = {
    failure_count: '失败次数',
    failure_rate: '失败率',
    timeout_count: '超时次数',
    unknown_count: '未知结果数'
  }
  const metrics = computed<BusinessWorkspaceMetric[]>(() => [
    {
      key: 'total',
      label: '规则总数',
      value: summary.value.total,
      description: '当前筛选范围',
      icon: 'ri:notification-badge-line',
      tone: 'primary',
      loading: !loaded.value
    },
    {
      key: 'enabled',
      label: '已启用',
      value: summary.value.enabled,
      description: '持续评估中',
      icon: 'ri:play-circle-line',
      tone: 'success',
      loading: !loaded.value
    },
    {
      key: 'disabled',
      label: '已停用',
      value: summary.value.disabled,
      description: '保留配置与历史',
      icon: 'ri:pause-circle-line',
      tone: 'warning',
      loading: !loaded.value
    },
    {
      key: 'archived',
      label: '已归档',
      value: summary.value.archived,
      description: '仅保留审计记录',
      icon: 'ri:archive-line',
      tone: 'info',
      loading: !loaded.value
    }
  ])
  const searchItems = computed<SearchFormItem[]>(() => [
    {
      key: 'name',
      label: '规则名称',
      type: 'input',
      props: { placeholder: '搜索规则名称', clearable: true }
    },
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
      key: 'metric',
      label: '检测指标',
      type: 'select',
      props: { placeholder: '全部指标', clearable: true, options: options.value?.metrics ?? [] }
    },
    {
      key: 'archived',
      label: '归档状态',
      type: 'select',
      props: {
        options: [
          { label: '当前规则', value: 'false' },
          { label: '归档历史', value: 'true' }
        ]
      }
    }
  ])
  const headerActions = computed<ArtTableQueryHeaderAction[]>(() => [
    {
      type: 'add',
      label: '创建告警规则',
      permission: 'BffAlert:Add',
      buttonProps: { type: 'primary', plain: false },
      disabled: !options.value || optionsLoading.value,
      onClick: () => void editorRef.value?.handleOpen(options.value!)
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
        error instanceof BffApiError ? error.message : '规则选项加载失败，请稍后重试'
    } finally {
      optionsLoading.value = false
    }
  }
  onMounted(() => void loadOptions())
  async function loadRules(params: Record<string, unknown>): Promise<AlertRuleList> {
    const query: AlertRuleListQuery = {
      current: Math.max(1, Number(params.current) || 1),
      size: Math.max(1, Number(params.size) || 20),
      name: typeof params.name === 'string' ? params.name : undefined,
      applicationId: typeof params.applicationId === 'string' ? params.applicationId : undefined,
      environment: options.value?.environments.find((item) => item.value === params.environment)
        ?.value,
      metric: options.value?.metrics.find((item) => item.value === params.metric)?.value,
      archived: params.archived === 'true'
    }
    const result = await fetchAlertRules(query)
    summary.value = result.summary
    loaded.value = true
    return result
  }
  function refreshData(): void {
    void tableRef.value?.refreshData()
  }
  function editRule(row: AlertRule): void {
    if (options.value) void editorRef.value?.handleOpen(options.value, row)
  }
  function moreItems(row: AlertRule): ButtonMoreItem[] {
    if (row.archivedAt) return []
    return [
      {
        key: 'status',
        label: row.enabled ? '停用规则' : '启用规则',
        icon: row.enabled ? 'ri:pause-circle-line' : 'ri:play-circle-line',
        auth: 'BffAlert:ChangeStatus',
        disabled: Boolean(busyId.value)
      },
      {
        key: 'evaluate',
        label: '立即评估',
        icon: 'ri:pulse-line',
        auth: 'BffAlert:Evaluate',
        disabled: Boolean(busyId.value) || !row.enabled
      },
      {
        key: 'archive',
        label: '归档规则',
        icon: 'ri:archive-line',
        auth: 'BffAlert:Archive',
        disabled: Boolean(busyId.value),
        color: 'var(--el-color-danger)'
      }
    ]
  }
  async function handleMore(item: ButtonMoreItem, row: AlertRule): Promise<void> {
    if (busyId.value || row.archivedAt) return
    if (item.key === 'status') {
      try {
        await confirmAction(
          row.enabled
            ? `停用「${row.name}」后停止新告警评估，历史实例仍保留。`
            : `启用「${row.name}」后，将按当前阈值持续评估调用。`,
          row.enabled ? '停用告警规则' : '启用告警规则',
          { confirmButtonText: row.enabled ? '确认停用' : '确认启用' }
        )
      } catch {
        return
      }
    }
    if (item.key === 'archive') {
      try {
        await confirmAction(
          `归档「${row.name}」后停止评估并保留历史记录，此操作不能在页面中撤销。`,
          '归档告警规则',
          { confirmButtonText: '确认归档', confirmButtonType: 'danger' }
        )
      } catch {
        return
      }
    }
    busyId.value = row.id
    try {
      if (item.key === 'status') {
        await changeAlertRuleStatus(row.id, row.version, !row.enabled)
        ElMessage.success(row.enabled ? '规则已停用' : '规则已启用')
      }
      if (item.key === 'archive') {
        await archiveAlertRule(row.id, row.version)
        ElMessage.success('规则已归档')
      }
      if (item.key === 'evaluate') {
        const result = await evaluateAlertRule(row.id)
        ElMessage.success(`评估完成：新触发 ${result.opened} 条，恢复 ${result.recovered} 条`)
      }
      refreshData()
    } catch (error) {
      notifyFriendlyError(error, '规则操作失败，请刷新后重试')
    } finally {
      busyId.value = ''
    }
  }
  function columnsFactory(): ColumnOption<AlertRule>[] {
    return [
      {
        prop: 'name',
        label: '规则',
        minWidth: 230,
        formatter: (row) => (
          <div class="min-w-0 py-1">
            <strong class="block truncate font-semibold text-g-900" title={row.name}>
              {row.name}
            </strong>
            <span
              class="mt-1 block truncate text-xs text-g-700"
              title={row.interfaceName || undefined}
            >
              {row.interfaceName || '应用内全部接口'}
            </span>
          </div>
        )
      },
      {
        prop: 'applicationName',
        label: '应用 / 环境',
        minWidth: 150,
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
        prop: 'metric',
        label: '检测条件',
        minWidth: 195,
        formatter: (row) => (
          <div class="grid gap-1">
            <strong class="text-g-900">
              {metricLabels[row.metric]} ≥{' '}
              {row.metric === 'failure_rate' ? `${row.threshold}%` : row.threshold}
            </strong>
            <span class="text-xs text-g-700">
              {row.windowMinutes} 分钟窗口 ·{' '}
              {row.metric === 'unknown_count'
                ? '未知结果直接计数'
                : `至少 ${row.minCalls} 次已确认调用`}
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
        prop: 'enabled',
        label: '状态',
        minWidth: 100,
        formatter: (row) => (
          <ElTag
            type={row.archivedAt ? 'info' : row.enabled ? 'success' : 'warning'}
            effect="light"
            round
          >
            {row.archivedAt ? '已归档' : row.enabled ? '已启用' : '已停用'}
          </ElTag>
        )
      },
      {
        prop: 'lastEvaluatedAt',
        label: '最近评估',
        minWidth: 150,
        formatter: (row) =>
          row.lastEvaluatedAt ? formatWithDayjs(row.lastEvaluatedAt) : '尚未评估'
      },
      ...(hasAuth('BffAlert:Edit') ||
      hasAuth('BffAlert:ChangeStatus') ||
      hasAuth('BffAlert:Archive') ||
      hasAuth('BffAlert:Evaluate')
        ? [
            {
              prop: 'actions',
              label: '操作',
              width: 100,
              fixed: 'right',
              formatter: (row: AlertRule) => (
                <BusinessTableRowActions>
                  {!row.archivedAt && hasAuth('BffAlert:Edit') && (
                    <ArtButtonTable
                      type="edit"
                      label="编辑告警规则"
                      permission="BffAlert:Edit"
                      onClick={() => editRule(row)}
                    />
                  )}
                  <ArtButtonMore
                    list={moreItems(row)}
                    onClick={(item: ButtonMoreItem) => void handleMore(item, row)}
                  />
                </BusinessTableRowActions>
              )
            } satisfies ColumnOption<AlertRule>
          ]
        : [])
    ]
  }
</script>
