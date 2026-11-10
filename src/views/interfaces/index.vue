<template>
  <div class="business-workspace-page art-full-height">
    <BusinessWorkspaceHeader
      eyebrow="INTERFACE ORCHESTRATION"
      title="接口编排"
      description="声明输入参数，串联上游步骤，验证并测试已映射的响应字段。"
      icon="ri:flow-chart"
      :metrics="metrics"
      :tags="[
        { label: '草稿设计与验证', type: 'primary', effect: 'plain' },
        { label: '版本绑定上游配置', type: 'success', effect: 'light' }
      ]"
    >
      <template #actions
        ><BffFlowGuide
          :step="2"
          :application-id="filters.applicationId"
          :environment="filters.environment" /><BusinessTableWorkspaceActions
          :table="tableQueryRef"
      /></template>
    </BusinessWorkspaceHeader>
    <ElAlert v-if="optionsError" type="warning" :closable="false" show-icon>
      <template #title>编排选项暂时无法加载</template>
      请重试后再创建或编辑草稿。
      <ElButton link type="primary" :loading="optionsLoading" @click="loadOptions"
        >重新加载</ElButton
      >
    </ElAlert>
    <ElAlert
      v-else-if="options && !options.applications.some((application) => application.enabled)"
      title="尚无可用于接口编排的启用应用。请先在应用管理中登记并启用应用。"
      type="info"
      :closable="false"
      show-icon
    />
    <ElAlert
      v-else-if="options && !options.networkPolicyConfigured"
      title="上游网络策略待配置。可先设计与验证草稿，策略就绪后再进行真实测试。"
      type="warning"
      :closable="false"
      show-icon
    />
    <div class="interface-page__workspace business-workspace-content min-h-0 flex-1">
      <ArtTableQuery
        ref="tableQueryRef"
        v-model="filters"
        v-model:show-search-bar="showSearchBar"
        class="h-full"
        focusable
        focus-scope-selector=".interface-page__workspace"
        :api-fn="loadInterfaces"
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
          emptyText: '暂无符合条件的接口草稿',
          emptyDescription: '可调整筛选条件，或新增接口草稿开始配置。'
        }"
      >
        <template v-if="locatedRecordId" #header-left>
          <div v-if="locatedRecordId" class="flex min-w-0 items-center gap-2" aria-live="polite">
            <ElTag type="primary" effect="plain" round>定位接口</ElTag>
            <span class="max-w-48 truncate text-xs text-g-700" :title="locatedRecordLabel">{{
              locatedRecordLabel
            }}</span>
            <ElButton link type="primary" @click="clearLocate">查看全部接口</ElButton>
          </div>
        </template>
      </ArtTableQuery>
    </div>
    <InterfaceEditorDialog ref="editorDialogRef" @success="refreshData" />
    <InterfaceTestDialog ref="testDialogRef" @tested="refreshData" />
    <MasterDataDeleteGuard ref="deleteGuardRef" @cleared="refreshData" />
  </div>
</template>

<script setup lang="tsx">
  import BffFlowGuide from '@bff/components/bff-flow-guide.vue'
  import { useDictionaryOptions } from '@/hooks/core/useDictionaryOptions'
  import { BFF_DICTIONARIES } from '@bff/config/dictionaries'
  import ArtDictDisplay from '@/components/core/base/art-dict-display/index.vue'
  const environmentOptions = useDictionaryOptions(BFF_DICTIONARIES.common.environment)
  const validationStatusOptions = useDictionaryOptions(BFF_DICTIONARIES.interfaces.validationStatus)
  import { ElButton, ElMessage, ElTag } from 'element-plus'
  import { useAuth } from '@/hooks/core/useAuth'
  import { notifyFriendlyError } from '@/hooks/core/useArtFeedback'
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
  import ArtButtonTable from '@/components/core/forms/art-button-table/index.vue'
  import ArtButtonMore, {
    type ButtonMoreItem
  } from '@/components/core/forms/art-button-more/index.vue'
  import MasterDataDeleteGuard from '@/components/business/master-data-delete-guard/index.vue'
  import { BffApiError } from '@bff/api/bff'
  import {
    deleteInterface,
    fetchInterfaceOptions,
    fetchInterfaces,
    validateInterface
  } from '@bff/api/interfaces'
  import type {
    InterfaceList,
    InterfaceOptions,
    InterfaceRecord,
    InterfaceListQuery
  } from '@bff/types/interface'
  import InterfaceEditorDialog from './modules/interface-editor-dialog.vue'
  import InterfaceTestDialog from './modules/interface-test-dialog.vue'

  defineOptions({ name: 'BffInterfaces' })
  const route = useRoute()
  const router = useRouter()
  const { hasAuth } = useAuth()
  const tableQueryRef = ref<ArtTableQueryExpose>()
  const editorDialogRef = ref<InstanceType<typeof InterfaceEditorDialog>>()
  const testDialogRef = ref<InstanceType<typeof InterfaceTestDialog>>()
  const options = shallowRef<InterfaceOptions>()
  const optionsLoading = ref(false)
  let optionsRequest: Promise<InterfaceOptions | undefined> | undefined
  const optionsError = ref('')
  const summary = shallowRef<InterfaceList['summary']>({
    total: 0,
    valid: 0,
    unvalidated: 0,
    tested: 0
  })
  const loaded = ref(false)
  const visibleRecords = shallowRef<InterfaceRecord[]>([])
  const busyRowId = ref('')
  const showSearchBar = ref(true)
  const filters = ref({
    name: '',
    applicationId: typeof route.query.applicationId === 'string' ? route.query.applicationId : '',
    environment:
      route.query.environment === 'development' ||
      route.query.environment === 'staging' ||
      route.query.environment === 'production'
        ? route.query.environment
        : '',
    validationStatus: ''
  })
  const locatedRecordId = computed(() =>
    typeof route.query.recordId === 'string' ? route.query.recordId : ''
  )
  const locatedRecordLabel = computed(
    () => visibleRecords.value.find((row) => row.id === locatedRecordId.value)?.name || '指定接口'
  )
  watch(
    () => [route.query.applicationId, route.query.environment, locatedRecordId.value],
    ([applicationId, environment, recordId], previous) => {
      const scope = {
        applicationId: typeof applicationId === 'string' ? applicationId : '',
        environment:
          environment === 'development' || environment === 'staging' || environment === 'production'
            ? environment
            : ''
      }
      filters.value =
        recordId !== previous?.[2]
          ? { ...filters.value, ...scope, name: '', validationStatus: '' }
          : { ...filters.value, ...scope }
      tableQueryRef.value?.cancelRequest()
      void nextTick(() => tableQueryRef.value?.getData())
    }
  )
  function clearLocate(): void {
    void router.replace({ query: { ...route.query, recordId: undefined }, hash: route.hash })
  }
  const metrics = computed<BusinessWorkspaceMetric[]>(() => [
    {
      key: 'total',
      label: '接口草稿',
      value: summary.value.total,
      description: '当前租户定义总数',
      icon: 'ri:flow-chart',
      tone: 'primary',
      loading: !loaded.value
    },
    {
      key: 'valid',
      label: '验证通过',
      value: summary.value.valid,
      description: '结构与引用可用',
      icon: 'ri:checkbox-circle-line',
      tone: 'success',
      loading: !loaded.value
    },
    {
      key: 'unvalidated',
      label: '待验证',
      value: summary.value.unvalidated,
      description: '需要执行定义检查',
      icon: 'ri:time-line',
      tone: 'warning',
      loading: !loaded.value
    },
    {
      key: 'tested',
      label: '已测试',
      value: summary.value.tested,
      description: '当前草稿已执行试跑',
      icon: 'ri:flask-line',
      tone: 'info',
      loading: !loaded.value
    }
  ])
  const searchItems = computed<SearchFormItem[]>(() => [
    {
      key: 'name',
      label: '接口名称',
      type: 'input',
      props: { placeholder: '搜索名称或编码', clearable: true }
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
        options: environmentOptions
      }
    },
    {
      key: 'validationStatus',
      label: '验证状态',
      type: 'select',
      props: {
        placeholder: '全部状态',
        clearable: true,
        options: validationStatusOptions
      }
    }
  ])
  const headerActions = computed<ArtTableQueryHeaderAction[]>(() => [
    {
      type: 'add',
      label: '新增接口草稿',
      buttonProps: { type: 'primary', plain: false },
      permission: 'BffInterface:Add',
      disabled: optionsLoading.value || !options.value?.applications.some((item) => item.enabled),
      onClick: openCreate
    }
  ])
  const { deleteGuardRef, deleteRecord, deleteBusy } = useRecordDeleteGuard(
    'bff_interfaces',
    '接口草稿',
    {
      bff_interface_versions: {
        label: '已发布版本',
        description: '发布历史需要保留，已产生发布版本的接口不能删除。',
        actionLabel: '查看版本',
        routeName: 'BffReleases',
        routeQuery: (record) => ({ recordId: record.targetId }),
        canNavigate: () => hasAuth('BffRelease:View'),
        order: 10
      }
    }
  )

  function loadOptions(): Promise<InterfaceOptions | undefined> {
    if (optionsRequest) return optionsRequest
    optionsLoading.value = true
    optionsError.value = ''
    optionsRequest = fetchInterfaceOptions()
      .then((loaded) => {
        options.value = loaded
        return loaded
      })
      .catch((error: unknown) => {
        optionsError.value =
          error instanceof BffApiError ? error.message : '接口选项加载失败，请稍后重试'
        return undefined
      })
      .finally(() => {
        optionsLoading.value = false
        optionsRequest = undefined
      })
    return optionsRequest
  }
  onMounted(() => {
    void loadOptions()
  })

  async function loadInterfaces(params: Record<string, unknown>) {
    const environment = params.environment
    const validationStatus = params.validationStatus
    const query: InterfaceListQuery = {
      current: Math.max(1, Number(params.current) || 1),
      size: Math.max(1, Number(params.size) || 20),
      name: typeof params.name === 'string' ? params.name : '',
      applicationId: typeof params.applicationId === 'string' ? params.applicationId : '',
      environment:
        environment === 'development' || environment === 'staging' || environment === 'production'
          ? environment
          : undefined,
      validationStatus:
        validationStatus === 'unvalidated' ||
        validationStatus === 'valid' ||
        validationStatus === 'invalid'
          ? validationStatus
          : undefined,
      recordId: locatedRecordId.value || undefined
    }
    const result = await fetchInterfaces(query)
    summary.value = result.summary
    visibleRecords.value = result.records
    loaded.value = true
    return result
  }
  function refreshData(): void {
    void tableQueryRef.value?.refreshData()
  }
  async function openCreate(): Promise<void> {
    const current = options.value ?? (await loadOptions())
    if (current) await editorDialogRef.value?.handleOpen(current, undefined, false, filters.value)
  }
  function openEdit(row: InterfaceRecord): void {
    const current = options.value ?? {
      applications: [row.application],
      environments: [{ label: environmentLabel(row.environment), value: row.environment }],
      upstreams: [],
      networkPolicyConfigured: false,
      writeTestsConfigured: false
    }
    void editorDialogRef.value?.handleOpen(current, row, !options.value)
    if (!options.value)
      void loadOptions().then((loaded) => {
        if (loaded) editorDialogRef.value?.updateOptions(loaded, row.id)
        else editorDialogRef.value?.setOptionsError(row.id, optionsError.value)
      })
  }
  async function openTest(row: InterfaceRecord): Promise<void> {
    const current = options.value ?? (await loadOptions())
    if (current) await testDialogRef.value?.handleOpen(row, current)
  }
  function showError(error: unknown, fallback: string): void {
    notifyFriendlyError(
      error,
      fallback,
      error instanceof BffApiError && error.status === 409 ? 'warning' : 'error'
    )
  }
  async function handleValidate(row: InterfaceRecord): Promise<void> {
    if (busyRowId.value || !hasAuth('BffInterface:Validate')) return
    busyRowId.value = row.id
    try {
      const result = await validateInterface(row.id, row.version)
      if (result.validationStatus === 'valid') ElMessage.success('接口定义验证通过')
      else
        ElMessage.warning(
          `接口定义存在 ${result.validationIssues.length} 项问题，请编辑草稿后重新验证`
        )
      refreshData()
    } catch (error) {
      showError(error, '接口验证失败，请检查定义和上游引用')
    } finally {
      busyRowId.value = ''
    }
  }
  async function handleDelete(row: InterfaceRecord): Promise<void> {
    await deleteRecord({
      resource: { id: row.id, label: row.name },
      permission: 'BffInterface:Delete',
      remove: () => deleteInterface(row.id, row.version),
      onDeleted: async () => {
        refreshData()
      },
      failureMessage: '接口草稿删除失败，请处理引用或刷新后重试'
    })
  }
  function canTest(row: InterfaceRecord): boolean {
    return Boolean(
      options.value?.networkPolicyConfigured &&
      row.validationStatus === 'valid' &&
      row.validatedVersion === row.version
    )
  }
  function moreActions(row: InterfaceRecord): ButtonMoreItem[] {
    return [
      {
        key: 'releases',
        label: '前往发布',
        icon: 'ri:git-commit-line',
        auth: 'BffRelease:View'
      },
      {
        key: 'validate',
        label: '验证定义',
        icon: 'ri:checkbox-circle-line',
        auth: 'BffInterface:Validate',
        disabled: Boolean(busyRowId.value)
      },
      {
        key: 'test',
        label: '运行测试',
        icon: 'ri:flask-line',
        auth: 'BffInterface:Test',
        disabled: Boolean(busyRowId.value) || !canTest(row)
      },
      {
        key: 'delete',
        label: '删除草稿',
        icon: 'ri:delete-bin-4-line',
        auth: 'BffInterface:Delete',
        color: 'var(--el-color-danger)',
        disabled: Boolean(busyRowId.value) || deleteBusy.value
      }
    ]
  }
  function handleMoreClick(item: ButtonMoreItem, row: InterfaceRecord): void {
    if (item.key === 'releases' && hasAuth('BffRelease:View'))
      void router.push({
        name: 'BffReleases',
        query: { applicationId: row.applicationId, environment: row.environment, recordId: row.id }
      })
    if (item.key === 'validate') void handleValidate(row)
    if (item.key === 'test') void openTest(row)
    if (item.key === 'delete') void handleDelete(row)
  }
  const environmentLabel = (value: InterfaceRecord['environment']): string =>
    environmentOptions.find((item) => item.value === value)?.label ?? '环境待核对'
  const testText = {
    not_tested: '未测试',
    passed: '测试通过',
    failed: '测试失败',
    stale: '待重测'
  } as const

  function columnsFactory(): ColumnOption<InterfaceRecord>[] {
    return [
      {
        prop: 'name',
        label: '接口草稿',
        minWidth: 225,
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
        label: '应用 / 环境',
        minWidth: 185,
        formatter: (row) => (
          <div class="min-w-0 py-1">
            <span class="block truncate font-medium text-g-900" title={row.application.name}>
              {row.application.name}
            </span>
            <span class="mt-1 block text-xs text-g-700">{environmentLabel(row.environment)}</span>
          </div>
        )
      },
      {
        prop: 'path',
        label: '请求定义',
        minWidth: 225,
        formatter: (row) => (
          <div class="flex min-w-0 items-center gap-2">
            <ElTag size="small" effect="plain" type="primary">
              {row.method}
            </ElTag>
            <code class="truncate text-xs text-g-700" title={row.path}>
              {row.path}
            </code>
          </div>
        )
      },
      {
        prop: 'definition',
        label: '编排',
        minWidth: 95,
        formatter: (row) => `${row.definition.steps.length} 步`
      },
      {
        prop: 'validationStatus',
        label: '定义验证',
        minWidth: 120,
        formatter: (row) => (
          <span title={row.validationIssues.join('；') || undefined}>
            <ArtDictDisplay
              dictCode={BFF_DICTIONARIES.interfaces.validationStatus}
              value={row.validationStatus}
              display="tag"
            />
          </span>
        )
      },
      {
        prop: 'lastTestStatus',
        label: '最近测试',
        minWidth: 120,
        formatter: (row) => (
          <ElTag
            type={
              row.lastTestStatus === 'passed'
                ? 'success'
                : row.lastTestStatus === 'failed'
                  ? 'danger'
                  : 'info'
            }
            effect="light"
            round
          >
            {testText[row.lastTestStatus]}
          </ElTag>
        )
      },
      {
        prop: 'updatedAt',
        label: '最近更新',
        minWidth: 150,
        formatter: (row) => formatWithDayjs(row.updatedAt) || '—'
      },
      ...(hasAuth('BffInterface:Edit') ||
      hasAuth('BffInterface:Validate') ||
      hasAuth('BffInterface:Test') ||
      hasAuth('BffInterface:Delete') ||
      hasAuth('BffRelease:View')
        ? [
            {
              prop: 'actions',
              label: '操作',
              width: 100,
              fixed: 'right',
              formatter: (row: InterfaceRecord) => (
                <BusinessTableRowActions>
                  {hasAuth('BffInterface:Edit') && (
                    <ArtButtonTable
                      type="edit"
                      label="编辑接口草稿"
                      permission="BffInterface:Edit"
                      onClick={() => openEdit(row)}
                    />
                  )}
                  <ArtButtonMore
                    list={moreActions(row)}
                    onClick={(item: ButtonMoreItem) => handleMoreClick(item, row)}
                  />
                </BusinessTableRowActions>
              )
            } satisfies ColumnOption<InterfaceRecord>
          ]
        : [])
    ]
  }
</script>
