<template>
  <div class="business-workspace-page art-full-height">
    <BusinessWorkspaceHeader
      title="应用管理"
      eyebrow="APPLICATION WORKSPACE"
      description="登记接入应用，维护应用状态与成员访问范围。"
      icon="ri:apps-2-line"
      density="compact"
      :tags="[
        { label: '统一身份认证', type: 'primary' },
        { label: '独立应用授权', type: 'info' }
      ]"
    >
      <template #actions><BusinessTableWorkspaceActions :table="tableQueryRef" /></template>
    </BusinessWorkspaceHeader>
    <ArtTableQuery
      ref="tableQueryRef"
      v-model="table.search"
      class="min-h-0 flex-1"
      :api-fn="loadApplications"
      :columns-factory="columnsFactory"
      :search-items="table.searchItems"
      :header-actions="table.actions"
      :enable-cache="false"
      :search-bar-props="{ showExpand: false, span: 8 }"
      :table-header-props="{ layout: 'refresh,size' }"
      :table-props="{ rowKey: 'id', stripe: false }"
    />
    <ApplicationDialog ref="applicationDialogRef" @success="tableQueryRef?.refreshData()" />
    <ApplicationMembersDialog ref="membersDialogRef" />
  </div>
</template>
<script setup lang="tsx">
  import { ElButton, ElTag } from 'element-plus'
  import { fetchApplications } from '@bff/api/bff'
  import { useAuth } from '@/hooks/core/useAuth'
  import BusinessTableRowActions from '@/components/business/business-table-row-actions/index.vue'
  import type { BffApplication } from '@bff/types/bff'
  import type { ColumnOption } from '@/types'
  import type {
    ArtTableQueryExpose,
    ArtTableQueryHeaderAction
  } from '@/components/core/tables/art-table-query/index.vue'
  import type { SearchFormItem } from '@/components/core/forms/art-search-bar/index.vue'
  import ApplicationDialog from './modules/application-dialog.vue'
  import ApplicationMembersDialog from './modules/application-members-dialog.vue'
  import type { ApplicationDialogExpose, ApplicationMembersDialogExpose } from './modules/types'
  const { hasAuth } = useAuth()
  const tableQueryRef = ref<ArtTableQueryExpose>(),
    applicationDialogRef = ref<ApplicationDialogExpose>(),
    membersDialogRef = ref<ApplicationMembersDialogExpose>()
  const table = reactive<{
    search: { name: string }
    searchItems: SearchFormItem[]
    actions: ArtTableQueryHeaderAction[]
  }>({
    search: { name: '' },
    searchItems: [
      {
        key: 'name',
        label: '应用名称',
        type: 'input',
        props: { placeholder: '搜索应用名称', clearable: true }
      }
    ],
    actions: [
      {
        type: 'add',
        label: '登记应用',
        permission: 'BffApplication:Add',
        onClick: () => applicationDialogRef.value?.handleOpen()
      }
    ]
  })
  async function loadApplications(params: Record<string, unknown>) {
    return fetchApplications({
      current: Number(params.current) || 1,
      size: Number(params.size) || 20,
      name: typeof params.name === 'string' ? params.name : ''
    })
  }
  function columnsFactory(): ColumnOption<BffApplication>[] {
    return [
      {
        prop: 'name',
        label: '应用',
        minWidth: 220,
        formatter: (row) => (
          <div class="py-1">
            <p class="font-semibold text-g-900">{row.name}</p>
            <p class="mt-1 font-mono text-xs text-g-700">{row.code}</p>
          </div>
        )
      },
      {
        prop: 'description',
        label: '说明',
        minWidth: 220,
        showOverflowTooltip: true,
        formatter: (row) => row.description || '—'
      },
      {
        prop: 'homeUrl',
        label: '应用地址',
        minWidth: 220,
        showOverflowTooltip: true,
        formatter: (row) =>
          row.homeUrl ? (
            <a class="text-theme" href={row.homeUrl} target="_blank" rel="noopener noreferrer">
              {row.homeUrl}
            </a>
          ) : (
            '尚未设置'
          )
      },
      {
        prop: 'enabled',
        label: '状态',
        width: 100,
        formatter: (row) => (
          <ElTag type={row.enabled ? 'success' : 'info'} effect="light">
            {row.enabled ? '启用' : '停用'}
          </ElTag>
        )
      },
      {
        prop: 'updatedAt',
        label: '最近更新',
        minWidth: 160,
        formatter: (row) => new Date(row.updatedAt).toLocaleString('zh-CN', { hour12: false })
      },
      ...(hasAuth('BffApplication:Edit') || hasAuth('BffApplication:Grant')
        ? [
            {
              prop: 'actions',
              label: '操作',
              width: 150,
              fixed: 'right',
              formatter: (row: BffApplication) => (
                <BusinessTableRowActions>
                  {hasAuth('BffApplication:Edit') && (
                    <ElButton
                      link
                      type="primary"
                      onClick={() => applicationDialogRef.value?.handleOpen(row)}
                    >
                      编辑
                    </ElButton>
                  )}
                  {hasAuth('BffApplication:Grant') && (
                    <ElButton
                      link
                      type="primary"
                      onClick={() => membersDialogRef.value?.handleOpen(row)}
                    >
                      成员授权
                    </ElButton>
                  )}
                </BusinessTableRowActions>
              )
            } satisfies ColumnOption<BffApplication>
          ]
        : [])
    ]
  }
</script>
