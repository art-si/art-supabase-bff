<template>
  <div class="business-workspace-page art-full-height">
    <BusinessWorkspaceHeader
      eyebrow="UPSTREAM GOVERNANCE"
      title="上游服务"
      description="按应用与环境登记连接目标，管理凭据、运行状态及连通性。"
      icon="ri:server-line"
      :metrics="metrics"
      :tags="[
        { label: '应用与环境隔离', type: 'primary', effect: 'plain' },
        { label: '凭据仅写入服务端', type: 'success', effect: 'light' }
      ]"
    >
      <template #actions><BusinessTableWorkspaceActions :table="tableQueryRef" /></template>
    </BusinessWorkspaceHeader>

    <ElAlert v-if="optionsError" type="warning" :closable="false" show-icon>
      <template #title>应用与环境选项暂时无法加载</template>
      请重试后再登记或编辑上游服务。
      <ElButton link type="primary" :loading="optionsLoading" @click="loadOptions"
        >重新加载</ElButton
      >
    </ElAlert>
    <ElAlert
      v-else-if="options && !options.applications.some((application) => application.enabled)"
      type="info"
      :closable="false"
      show-icon
    >
      <template #title>尚无可登记服务的启用应用</template>
      请先启用一个应用，再登记上游服务。
      <RouterLink v-if="hasAuth('BffApplication:View')" to="/applications" class="text-theme">
        前往应用管理
      </RouterLink>
    </ElAlert>
    <ElAlert
      v-else-if="options && !options.networkPolicyConfigured"
      title="上游网络访问策略待配置。服务可先登记为草稿；连接检测和启用将在策略就绪后开放。"
      type="warning"
      :closable="false"
      show-icon
    />
    <ElAlert
      v-else-if="options && !options.credentialManagementReady"
      title="凭据保管服务暂不可用。需要认证的上游服务可先登记草稿，稍后再配置凭据。"
      type="warning"
      :closable="false"
      show-icon
    />

    <div class="upstream-page__workspace min-h-0 flex-1">
      <ArtTableQuery
        ref="tableQueryRef"
        v-model="filters"
        v-model:show-search-bar="showSearchBar"
        class="h-full"
        focusable
        focus-scope-selector=".upstream-page__workspace"
        :api-fn="loadUpstreams"
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
          emptyText: '暂无符合条件的上游服务',
          emptyDescription: '可调整筛选条件；新服务从登记草稿开始配置。'
        }"
      >
        <template #header-left>
          <div v-if="locatedRecordId" class="flex min-w-0 items-center gap-2" aria-live="polite">
            <ElTag type="primary" effect="plain" round>定位服务</ElTag>
            <span class="max-w-48 truncate text-xs text-g-700" :title="locatedRecordLabel">
              {{ locatedRecordLabel }}
            </span>
            <ElButton link type="primary" @click="clearLocate">查看全部服务</ElButton>
          </div>
        </template>
      </ArtTableQuery>
    </div>

    <UpstreamDialog ref="upstreamDialogRef" @success="refreshData" />
    <UpstreamCredentialDialog ref="credentialDialogRef" @success="refreshData" />
    <MasterDataDeleteGuard ref="deleteGuardRef" @cleared="refreshData" />
  </div>
</template>

<script setup lang="tsx">
  import { ElButton, ElMessage, ElTag } from 'element-plus'
  import { useAuth } from '@/hooks/core/useAuth'
  import { useArtFeedback, notifyFriendlyError } from '@/hooks/core/useArtFeedback'
  import { useRecordDeleteGuard } from '@/hooks/core/useRecordDeleteGuard'
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
  import ArtButtonMore, {
    type ButtonMoreItem
  } from '@/components/core/forms/art-button-more/index.vue'
  import MasterDataDeleteGuard from '@/components/business/master-data-delete-guard/index.vue'
  import { BffApiError } from '@bff/api/bff'
  import {
    changeUpstreamStatus,
    deleteUpstream,
    fetchUpstreamOptions,
    fetchUpstreams,
    testUpstreamHealth
  } from '@bff/api/upstreams'
  import type {
    UpstreamEnvironment,
    UpstreamHealthStatus,
    UpstreamOptions,
    UpstreamService,
    UpstreamStatus,
    UpstreamSummary
  } from '@bff/types/upstream'
  import UpstreamDialog from './modules/upstream-dialog.vue'
  import UpstreamCredentialDialog from './modules/upstream-credential-dialog.vue'

  defineOptions({ name: 'BffUpstreams' })

  const route = useRoute()
  const router = useRouter()
  const { hasAuth } = useAuth()
  const { confirmAction } = useArtFeedback()
  const tableQueryRef = ref<ArtTableQueryExpose>()
  const upstreamDialogRef = ref<InstanceType<typeof UpstreamDialog>>()
  const credentialDialogRef = ref<InstanceType<typeof UpstreamCredentialDialog>>()
  const options = shallowRef<UpstreamOptions>()
  const optionsLoading = ref(false)
  const optionsError = ref('')
  const summary = shallowRef<UpstreamSummary>({
    total: 0,
    active: 0,
    draft: 0,
    disabled: 0,
    reachable: 0,
    failed: 0
  })
  const loaded = ref(false)
  const visibleRecords = shallowRef<UpstreamService[]>([])
  const busyRowId = ref('')
  const showSearchBar = ref(true)
  const filters = ref({ applicationId: '', name: '', environment: '', status: '' })
  const locatedRecordId = computed(() =>
    typeof route.query.recordId === 'string' ? route.query.recordId : ''
  )
  const locatedRecordLabel = computed(
    () => visibleRecords.value.find((row) => row.id === locatedRecordId.value)?.name || '指定服务'
  )
  watch(locatedRecordId, () => {
    filters.value = { applicationId: '', name: '', environment: '', status: '' }
    void tableQueryRef.value?.refreshCreate()
  })
  function clearLocate(): void {
    void router.replace({ query: { ...route.query, recordId: undefined }, hash: route.hash })
  }

  const metrics = computed<BusinessWorkspaceMetric[]>(() => [
    {
      key: 'total',
      label: '服务总数',
      value: summary.value.total,
      description: '当前租户已登记服务',
      icon: 'ri:server-line',
      tone: 'primary',
      loading: !loaded.value
    },
    {
      key: 'active',
      label: '已启用',
      value: summary.value.active,
      description: '当前启用的上游配置',
      icon: 'ri:play-circle-line',
      tone: 'success',
      loading: !loaded.value
    },
    {
      key: 'reachable',
      label: '连通正常',
      value: summary.value.reachable,
      description: '最近一次检测可达',
      icon: 'ri:link-m',
      tone: 'info',
      loading: !loaded.value
    },
    {
      key: 'failed',
      label: '连接异常',
      value: summary.value.failed,
      description: '需要排查的连接',
      icon: 'ri:error-warning-line',
      tone: 'danger',
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
        options: (options.value?.applications ?? []).map((app) => ({
          label: app.name,
          value: app.id
        }))
      }
    },
    {
      key: 'name',
      label: '服务名称',
      type: 'input',
      props: { placeholder: '搜索名称或编码', clearable: true }
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
      key: 'status',
      label: '运行状态',
      type: 'select',
      props: {
        placeholder: '全部状态',
        clearable: true,
        options: [
          { label: '草稿', value: 'draft' },
          { label: '已启用', value: 'active' },
          { label: '已停用', value: 'disabled' }
        ]
      }
    }
  ])

  const headerActions = computed<ArtTableQueryHeaderAction[]>(() => [
    {
      type: 'add',
      label: '登记上游服务',
      permission: 'BffUpstream:Add',
      disabled:
        optionsLoading.value ||
        !options.value?.applications.some((application) => application.enabled),
      onClick: openCreate
    }
  ])

  const { deleteGuardRef, deleteRecord, deleteBusy } = useRecordDeleteGuard(
    'bff_upstream_services',
    '上游服务',
    {
      bff_upstream_services: {
        label: '使用中的服务',
        description: '请先停用服务后再删除。',
        actionLabel: '查看服务',
        routeName: 'BffUpstreams',
        routeQuery: (record) => ({ recordId: record.targetId }),
        canNavigate: () => hasAuth('BffUpstream:View'),
        order: 10
      }
    }
  )

  async function loadOptions(): Promise<UpstreamOptions | undefined> {
    if (optionsLoading.value) return options.value
    optionsLoading.value = true
    optionsError.value = ''
    try {
      options.value = await fetchUpstreamOptions()
      return options.value
    } catch (error) {
      optionsError.value =
        error instanceof BffApiError ? error.message : '应用与环境选项加载失败，请稍后重试'
      return undefined
    } finally {
      optionsLoading.value = false
    }
  }
  onMounted(() => {
    void loadOptions()
  })

  async function loadUpstreams(params: Record<string, unknown>) {
    const environment = params.environment
    const status = params.status
    const result = await fetchUpstreams({
      current: Math.max(1, Number(params.current) || 1),
      size: Math.max(1, Number(params.size) || 20),
      applicationId: typeof params.applicationId === 'string' ? params.applicationId : '',
      name: typeof params.name === 'string' ? params.name : '',
      environment:
        environment === 'development' || environment === 'staging' || environment === 'production'
          ? environment
          : undefined,
      status:
        status === 'draft' || status === 'active' || status === 'disabled' ? status : undefined,
      recordId: locatedRecordId.value || undefined
    })
    summary.value = result.summary
    visibleRecords.value = result.records
    loaded.value = true
    return result
  }

  function refreshData(): void {
    void tableQueryRef.value?.refreshData()
  }

  async function openCreate(): Promise<void> {
    const currentOptions = await loadOptions()
    if (!currentOptions) return
    if (!currentOptions.applications.some((application) => application.enabled)) {
      ElMessage.warning('请先在应用管理中登记并启用一个应用')
      return
    }
    await upstreamDialogRef.value?.handleOpen(currentOptions)
  }

  async function openEdit(row: UpstreamService): Promise<void> {
    const currentOptions = await loadOptions()
    if (currentOptions) await upstreamDialogRef.value?.handleOpen(currentOptions, row)
  }

  const environmentLabel = (value: UpstreamEnvironment): string =>
    options.value?.environments.find((item) => item.value === value)?.label ??
    { development: '开发', staging: '预发布', production: '生产' }[value]
  const statusPresentation: Record<
    UpstreamStatus,
    { label: string; tone: 'info' | 'success' | 'warning' }
  > = {
    draft: { label: '草稿', tone: 'info' },
    active: { label: '已启用', tone: 'success' },
    disabled: { label: '已停用', tone: 'warning' }
  }
  const healthPresentation: Record<
    UpstreamHealthStatus,
    { label: string; tone: 'info' | 'success' | 'danger' | 'warning' }
  > = {
    unknown: { label: '未检测', tone: 'info' },
    reachable: { label: '连通正常', tone: 'success' },
    failed: { label: '连接异常', tone: 'danger' },
    stale: { label: '待重新检测', tone: 'warning' }
  }

  function rowActions(row: UpstreamService): ButtonMoreItem[] {
    const canTest = Boolean(options.value?.networkPolicyConfigured)
    const canActivate =
      canTest && row.application.enabled && (row.authType === 'none' || row.credentialConfigured)
    return [
      {
        key: 'credential',
        label: '管理凭据',
        icon: 'ri:key-2-line',
        auth: 'BffUpstream:RotateSecret',
        disabled:
          Boolean(busyRowId.value) ||
          row.authType === 'none' ||
          !options.value?.credentialManagementReady
      },
      {
        key: 'status',
        label: row.status === 'active' ? '停用服务' : '启用服务',
        icon: row.status === 'active' ? 'ri:pause-circle-line' : 'ri:play-circle-line',
        auth: 'BffUpstream:ChangeStatus',
        disabled: Boolean(busyRowId.value) || (row.status !== 'active' && !canActivate)
      },
      {
        key: 'test',
        label: '检测连接',
        icon: 'ri:heartbeat-line',
        auth: 'BffUpstream:Test',
        disabled: Boolean(busyRowId.value) || !canTest
      },
      {
        key: 'delete',
        label: '删除服务',
        icon: 'ri:delete-bin-4-line',
        auth: 'BffUpstream:Delete',
        color: 'var(--el-color-danger)',
        disabled: deleteBusy.value || Boolean(busyRowId.value)
      }
    ]
  }

  function showError(error: unknown, fallback: string): void {
    if (error instanceof BffApiError && error.status === 409) {
      notifyFriendlyError(error, fallback, 'warning')
      return
    }
    notifyFriendlyError(error, fallback)
  }

  async function handleStatus(row: UpstreamService): Promise<void> {
    if (busyRowId.value || !hasAuth('BffUpstream:ChangeStatus')) return
    const next = row.status === 'active' ? 'disabled' : 'active'
    try {
      await confirmAction(
        next === 'disabled'
          ? `停用「${row.name}」后，依赖此服务的已发布接口将无法继续调用。`
          : `启用「${row.name}」后，已发布接口可使用该上游连接。连接检测仅验证网络可达，不验证业务认证。`,
        next === 'disabled' ? '停用上游服务' : '启用上游服务',
        {
          confirmButtonText: next === 'disabled' ? '确认停用' : '确认启用',
          confirmButtonType: next === 'disabled' ? 'danger' : 'primary'
        }
      )
    } catch {
      return
    }
    busyRowId.value = row.id
    try {
      await changeUpstreamStatus(row.id, row.version, next)
      ElMessage.success(next === 'active' ? '服务已启用' : '服务已停用')
      refreshData()
    } catch (error) {
      showError(error, '服务状态调整失败，请刷新后重试')
    } finally {
      busyRowId.value = ''
    }
  }

  async function handleTest(row: UpstreamService): Promise<void> {
    if (busyRowId.value || !hasAuth('BffUpstream:Test')) return
    busyRowId.value = row.id
    try {
      const result = await testUpstreamHealth(row.id, row.version)
      if (result.probeStale) ElMessage.warning('配置已变化，本次旧结果未应用，请重新检测连接。')
      else if (result.healthStatus === 'reachable')
        ElMessage.success('连接正常。检测仅验证网络连通性，不验证上游认证。')
      else ElMessage.warning('连接检测未通过，请检查服务地址、网络策略和上游状态。')
      refreshData()
    } catch (error) {
      showError(error, '连接检测失败，请核对网络策略与上游地址')
      refreshData()
    } finally {
      busyRowId.value = ''
    }
  }

  async function handleDelete(row: UpstreamService): Promise<void> {
    await deleteRecord({
      resource: { id: row.id, label: row.name, status: row.status },
      permission: 'BffUpstream:Delete',
      remove: () => deleteUpstream(row.id, row.version),
      onDeleted: async () => {
        refreshData()
      },
      failureMessage: '上游服务删除失败，请处理引用或刷新列表后重试'
    })
  }

  function handleMoreClick(item: ButtonMoreItem, row: UpstreamService): void {
    if (item.key === 'credential') void credentialDialogRef.value?.handleOpen(row)
    if (item.key === 'status') void handleStatus(row)
    if (item.key === 'test') void handleTest(row)
    if (item.key === 'delete') void handleDelete(row)
  }

  function columnsFactory(): ColumnOption<UpstreamService>[] {
    return [
      {
        prop: 'name',
        label: '上游服务',
        minWidth: 240,
        formatter: (row) => (
          <div class="min-w-0 py-1">
            <strong class="block truncate font-semibold text-g-900" title={row.name}>
              {row.name}
            </strong>
            <span class="mt-1 block truncate font-mono text-xs text-g-700" title={row.code}>
              {row.code}
            </span>
          </div>
        )
      },
      {
        prop: 'application',
        label: '所属应用 / 环境',
        minWidth: 210,
        formatter: (row) => (
          <div class="min-w-0 py-1">
            <span class="block truncate font-medium text-g-900" title={row.application.name}>
              {row.application.name}
            </span>
            <div class="mt-1 flex items-center gap-2">
              <span class="truncate text-xs text-g-700" title={row.application.code}>
                {row.application.code}
              </span>
              <ElTag size="small" effect="plain" type="primary">
                {environmentLabel(row.environment)}
              </ElTag>
            </div>
          </div>
        )
      },
      {
        prop: 'baseUrl',
        label: '基础地址',
        minWidth: 250,
        showOverflowTooltip: true,
        formatter: (row) => (
          <span class="block truncate font-mono text-xs text-g-700" title={row.baseUrl}>
            {row.baseUrl}
          </span>
        )
      },
      {
        prop: 'status',
        label: '运行状态',
        minWidth: 105,
        formatter: (row) => (
          <ElTag type={statusPresentation[row.status].tone} effect="light" round>
            {statusPresentation[row.status].label}
          </ElTag>
        )
      },
      {
        prop: 'authType',
        label: '认证配置',
        minWidth: 130,
        formatter: (row) => (
          <div class="grid gap-1 py-1 text-xs">
            <span class="text-g-900">
              {{ none: '无认证', bearer: 'Bearer', api_key_header: 'API Key' }[row.authType]}
            </span>
            <span class={row.credentialConfigured ? 'text-success' : 'text-g-700'}>
              {row.authType === 'none'
                ? '无需凭据'
                : row.credentialConfigured
                  ? '凭据已配置'
                  : '待配置凭据'}
            </span>
          </div>
        )
      },
      {
        prop: 'healthStatus',
        label: '连接检测',
        minWidth: 130,
        formatter: (row) => (
          <div class="grid gap-1 py-1" title={row.lastHealthMessage || undefined}>
            <ElTag type={healthPresentation[row.healthStatus].tone} effect="light" round>
              {healthPresentation[row.healthStatus].label}
            </ElTag>
            <span class="text-xs text-g-700">
              {row.lastCheckedAt ? formatWithDayjs(row.lastCheckedAt) : '尚未检测'}
            </span>
            {row.lastStatusCode && (
              <span class="text-xs text-g-700">
                HTTP {row.lastStatusCode}
                {row.lastDurationMs !== null ? ` · ${row.lastDurationMs} ms` : ''}
              </span>
            )}
          </div>
        )
      },
      {
        prop: 'updatedAt',
        label: '最近更新',
        minWidth: 155,
        formatter: (row) => formatWithDayjs(row.updatedAt) || '—'
      },
      ...(hasAuth('BffUpstream:Edit') ||
      hasAuth('BffUpstream:ChangeStatus') ||
      hasAuth('BffUpstream:RotateSecret') ||
      hasAuth('BffUpstream:Test') ||
      hasAuth('BffUpstream:Delete')
        ? [
            {
              prop: 'actions',
              label: '操作',
              width: 122,
              fixed: 'right',
              formatter: (row: UpstreamService) => (
                <BusinessTableRowActions>
                  {hasAuth('BffUpstream:Edit') && (
                    <ElButton link type="primary" onClick={() => void openEdit(row)}>
                      编辑
                    </ElButton>
                  )}
                  <ArtButtonMore
                    list={rowActions(row)}
                    onClick={(item: ButtonMoreItem) => handleMoreClick(item, row)}
                  />
                </BusinessTableRowActions>
              )
            } satisfies ColumnOption<UpstreamService>
          ]
        : [])
    ]
  }
</script>
