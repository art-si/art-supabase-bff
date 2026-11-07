<template>
  <div class="business-workspace-page art-full-height">
    <BusinessWorkspaceHeader
      eyebrow="VERSION GOVERNANCE"
      title="版本发布"
      description="校验草稿后生成不可修改的发布快照；回滚切换版本，保持当前启停状态与独立草稿。"
      icon="ri:git-commit-line"
      :metrics="metrics"
      :tags="[
        { label: '发布前就绪检查', type: 'primary', effect: 'plain' },
        { label: '版本与事件可追溯', type: 'success', effect: 'light' }
      ]"
    >
      <template #actions><BusinessTableWorkspaceActions :table="tableQueryRef" /></template>
    </BusinessWorkspaceHeader>
    <ElAlert v-if="optionsError" type="warning" :closable="false" show-icon>
      <template #title>应用与环境选项暂时无法加载</template>
      列表仍可浏览；筛选选项恢复后可重新查询。
      <ElButton link type="primary" :loading="optionsLoading" @click="loadOptions"
        >重新加载</ElButton
      >
    </ElAlert>
    <div class="release-page__workspace min-h-0 flex-1">
      <ArtTableQuery
        ref="tableQueryRef"
        v-model="filters"
        v-model:show-search-bar="showSearchBar"
        class="h-full"
        focusable
        focus-scope-selector=".release-page__workspace"
        :api-fn="loadReleases"
        :columns-factory="columnsFactory"
        :search-items="searchItems"
        :enable-cache="false"
        :search-bar-props="{ showExpand: false, span: 6 }"
        :table-header-props="{ layout: 'refresh,size' }"
        :table-props="{
          rowKey: 'interfaceId',
          stripe: false,
          emptyText: '暂无符合条件的接口版本',
          emptyDescription: '可调整筛选条件；接口草稿在接口编排中创建。'
        }"
      >
        <template #header-left>
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
    <ReleaseCommandDialog ref="commandDialogRef" @success="handleChanged" @stale="refreshData" />
    <ReleaseHistoryDialog ref="historyDialogRef" @rollback="handleRollback" />
  </div>
</template>

<script setup lang="tsx">
  import { ElButton, ElMessage, ElTag } from 'element-plus'
  import { useAuth } from '@/hooks/core/useAuth'
  import { notifyFriendlyError } from '@/hooks/core/useArtFeedback'
  import { formatWithDayjs } from '@/utils/time'
  import { copyTextToClipboard } from '@/utils/file/clipboard'
  import type { ColumnOption } from '@/types'
  import type { SearchFormItem } from '@/components/core/forms/art-search-bar/index.vue'
  import type { ArtTableQueryExpose } from '@/components/core/tables/art-table-query/index.vue'
  import BusinessWorkspaceHeader, {
    type BusinessWorkspaceMetric
  } from '@/components/business/business-workspace-header/index.vue'
  import BusinessTableWorkspaceActions from '@/components/business/business-table-workspace-actions/index.vue'
  import BusinessTableRowActions from '@/components/business/business-table-row-actions/index.vue'
  import ArtButtonMore, {
    type ButtonMoreItem
  } from '@/components/core/forms/art-button-more/index.vue'
  import { BffApiError } from '@bff/api/bff'
  import { fetchReleaseOptions, fetchReleases } from '@bff/api/releases'
  import type {
    ReleaseList,
    ReleaseListQuery,
    ReleaseOptions,
    ReleaseRecord,
    ReleaseVersion
  } from '@bff/types/release'
  import ReleaseCommandDialog from './modules/release-command-dialog.vue'
  import ReleaseHistoryDialog from './modules/release-history-dialog.vue'

  defineOptions({ name: 'BffReleases' })
  const route = useRoute()
  const router = useRouter()
  const { hasAuth } = useAuth()
  const tableQueryRef = ref<ArtTableQueryExpose>()
  const commandDialogRef = ref<InstanceType<typeof ReleaseCommandDialog>>()
  const historyDialogRef = ref<InstanceType<typeof ReleaseHistoryDialog>>()
  const options = shallowRef<ReleaseOptions>()
  const optionsLoading = ref(false)
  const optionsError = ref('')
  const summary = shallowRef<ReleaseList['summary']>({
    total: 0,
    enabled: 0,
    disabled: 0,
    unpublished: 0
  })
  const records = shallowRef<ReleaseRecord[]>([])
  const loaded = ref(false)
  const showSearchBar = ref(true)
  const filters = ref({ name: '', applicationId: '', environment: '', status: '' })
  const locatedRecordId = computed(() =>
    typeof route.query.recordId === 'string' ? route.query.recordId : ''
  )
  const locatedRecordLabel = computed(
    () =>
      records.value.find((item) => item.interfaceId === locatedRecordId.value)?.name || '指定接口'
  )
  watch(locatedRecordId, () => {
    filters.value = { name: '', applicationId: '', environment: '', status: '' }
    void tableQueryRef.value?.refreshCreate()
  })
  function clearLocate(): void {
    void router.replace({ query: { ...route.query, recordId: undefined }, hash: route.hash })
  }
  const metrics = computed<BusinessWorkspaceMetric[]>(() => [
    {
      key: 'total',
      label: '接口定义',
      value: summary.value.total,
      description: '当前租户草稿总数',
      icon: 'ri:flow-chart',
      tone: 'primary',
      loading: !loaded.value
    },
    {
      key: 'enabled',
      label: '已启用',
      value: summary.value.enabled,
      description: '当前可调用的版本',
      icon: 'ri:play-circle-line',
      tone: 'success',
      loading: !loaded.value
    },
    {
      key: 'disabled',
      label: '已停用',
      value: summary.value.disabled,
      description: '保留历史快照',
      icon: 'ri:pause-circle-line',
      tone: 'warning',
      loading: !loaded.value
    },
    {
      key: 'unpublished',
      label: '尚未发布',
      value: summary.value.unpublished,
      description: '仅存在独立草稿',
      icon: 'ri:draft-line',
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
          { label: '未发布', value: 'unpublished' },
          { label: '已启用', value: 'enabled' },
          { label: '已停用', value: 'disabled' }
        ]
      }
    }
  ])
  async function loadOptions(): Promise<void> {
    if (optionsLoading.value) return
    optionsLoading.value = true
    optionsError.value = ''
    try {
      options.value = await fetchReleaseOptions()
    } catch (error) {
      optionsError.value =
        error instanceof BffApiError ? error.message : '筛选选项加载失败，请稍后重试'
    } finally {
      optionsLoading.value = false
    }
  }
  onMounted(() => {
    void loadOptions()
  })
  async function loadReleases(params: Record<string, unknown>) {
    const environment = params.environment
    const status = params.status
    const query: ReleaseListQuery = {
      current: Math.max(1, Number(params.current) || 1),
      size: Math.max(1, Number(params.size) || 20),
      name: typeof params.name === 'string' ? params.name : '',
      applicationId: typeof params.applicationId === 'string' ? params.applicationId : '',
      environment:
        environment === 'development' || environment === 'staging' || environment === 'production'
          ? environment
          : undefined,
      status:
        status === 'unpublished' || status === 'enabled' || status === 'disabled'
          ? status
          : undefined,
      recordId: locatedRecordId.value || undefined
    }
    const result = await fetchReleases(query)
    summary.value = result.summary
    records.value = result.records
    loaded.value = true
    return result
  }
  function refreshData(): void {
    void tableQueryRef.value?.refreshData()
  }
  function handleChanged(): void {
    refreshData()
  }
  function handleRollback(record: ReleaseRecord, version: ReleaseVersion): void {
    void commandDialogRef.value?.handleOpen(record, 'rollback', version)
  }
  function handleMore(item: ButtonMoreItem, record: ReleaseRecord): void {
    if (item.key === 'history') void historyDialogRef.value?.handleOpen(record)
    if (item.key === 'status')
      void commandDialogRef.value?.handleOpen(
        record,
        record.deployment?.enabled ? 'disable' : 'enable'
      )
  }
  function rowActions(record: ReleaseRecord): ButtonMoreItem[] {
    return [
      { key: 'history', label: '版本历史', icon: 'ri:history-line', auth: 'BffRelease:View' },
      ...(record.deployment
        ? [
            {
              key: 'status',
              label: record.deployment.enabled ? '停用接口' : '启用接口',
              icon: record.deployment.enabled ? 'ri:pause-circle-line' : 'ri:play-circle-line',
              auth: 'BffRelease:ChangeStatus'
            }
          ]
        : [])
    ]
  }
  const environmentLabel = (value: ReleaseRecord['environment']): string =>
    options.value?.environments.find((item) => item.value === value)?.label ??
    { development: '开发', staging: '预发布', production: '生产' }[value]
  const runtimePath = (record: ReleaseRecord): string | undefined =>
    record.deployment
      ? `/api/gateway/${record.application.code}/${record.environment}${record.deployment.path}`
      : undefined
  async function copyRuntimePath(record: ReleaseRecord): Promise<void> {
    const path = runtimePath(record)
    if (!path) return
    try {
      await copyTextToClipboard(path, { legacyFallback: true })
      ElMessage.success('同源调用路径已复制')
    } catch (error) {
      notifyFriendlyError(error, '复制失败，请手动选中路径复制')
    }
  }
  function columnsFactory(): ColumnOption<ReleaseRecord>[] {
    return [
      {
        prop: 'name',
        label: '接口',
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
        minWidth: 175,
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
        prop: 'deployment',
        label: '运行版本',
        minWidth: 115,
        formatter: (row) =>
          row.deployment ? (
            <div class="grid gap-1">
              <strong class="text-g-900">V{row.deployment.activeVersionNumber}</strong>
              <ElTag size="small" type={row.deployment.enabled ? 'success' : 'info'} effect="light">
                {row.deployment.enabled ? '已启用' : '已停用'}
              </ElTag>
            </div>
          ) : (
            <ElTag type="info" effect="light">
              未发布
            </ElTag>
          )
      },
      {
        prop: 'draftVersion',
        label: '当前草稿',
        minWidth: 120,
        formatter: (row) => (
          <div class="grid gap-1">
            <strong class="text-g-900">草稿 v{row.draftVersion}</strong>
            <span class="text-xs text-g-700">
              {row.validationStatus === 'valid'
                ? '结构已验证'
                : row.validationStatus === 'invalid'
                  ? '验证未通过'
                  : '待验证'}{' '}
              ·{' '}
              {row.lastTestStatus === 'passed' && row.lastTestVersion === row.draftVersion
                ? '测试通过'
                : '待测试'}
            </span>
          </div>
        )
      },
      {
        prop: 'versionCount',
        label: '快照数',
        minWidth: 85,
        formatter: (row) => `${row.versionCount} 个`
      },
      {
        prop: 'endpoint',
        label: '同源调用路径',
        minWidth: 250,
        formatter: (row) =>
          runtimePath(row) ? (
            <div class="flex min-w-0 items-center gap-2">
              <div class="min-w-0">
                <code class="block truncate text-xs text-g-900" title={runtimePath(row)}>
                  {runtimePath(row)}
                </code>
                <small class="text-xs text-g-700">需登录会话与调用权限</small>
              </div>
              <ElButton
                link
                type="primary"
                aria-label={`复制${row.name}的调用路径`}
                onClick={() => void copyRuntimePath(row)}
              >
                复制
              </ElButton>
            </div>
          ) : (
            '待发布'
          )
      },
      {
        prop: 'updatedAt',
        label: '运行更新',
        minWidth: 150,
        formatter: (row) =>
          row.deployment?.updatedAt ? formatWithDayjs(row.deployment.updatedAt) : '—'
      },
      {
        prop: 'actions',
        label: '操作',
        width: 188,
        fixed: 'right',
        formatter: (row) => (
          <BusinessTableRowActions>
            {hasAuth('BffRelease:Publish') && (
              <ElButton
                link
                type="primary"
                onClick={() => void commandDialogRef.value?.handleOpen(row, 'publish')}
              >
                发布草稿
              </ElButton>
            )}
            <ArtButtonMore
              list={rowActions(row)}
              onClick={(item: ButtonMoreItem) => handleMore(item, row)}
            />
          </BusinessTableRowActions>
        )
      }
    ]
  }
</script>
