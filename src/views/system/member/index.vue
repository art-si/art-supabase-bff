<template>
  <div class="business-workspace-page art-full-height">
    <BusinessWorkspaceHeader
      eyebrow="ACCESS GOVERNANCE"
      title="成员管理"
      description="查看本租户成员，按职责维护平台身份、业务角色与应用访问状态。"
      icon="ri:team-line"
      :tags="[
        { label: '统一身份认证', type: 'primary', effect: 'plain' },
        { label: '租户权限隔离', type: 'success', effect: 'light' }
      ]"
      :metrics="metrics"
    >
      <template #actions><BusinessTableWorkspaceActions :table="tableQueryRef" /></template>
    </BusinessWorkspaceHeader>

    <div class="member-page__workspace min-h-0 flex-1">
      <ArtTableQuery
        ref="tableQueryRef"
        v-model="filters"
        v-model:show-search-bar="showSearchBar"
        class="h-full"
        focusable
        focus-scope-selector=".member-page__workspace"
        :api-fn="loadMembers"
        :columns-factory="columnsFactory"
        :search-items="searchItems"
        :header-actions="headerActions"
        header-actions-placement="workspace"
        :enable-cache="false"
        :search-bar-props="{ showExpand: false, span: 8 }"
        :table-header-props="{ layout: 'refresh,size' }"
        :table-props="{
          rowKey: 'id',
          stripe: false,
          emptyText: '暂无符合条件的成员',
          emptyDescription: '可调整筛选条件；管理员可通过“开通成员”添加已有统一账号。'
        }"
      >
        <template #header-left>
          <div v-if="locatedMemberId" class="flex min-w-0 items-center gap-2" aria-live="polite">
            <ElTag type="primary" effect="plain" round>定位成员</ElTag>
            <span class="max-w-48 truncate text-xs text-g-700" :title="locatedMemberLabel">
              {{ locatedMemberLabel }}
            </span>
            <ElButton link type="primary" @click="clearLocate">查看全部成员</ElButton>
          </div>
        </template>
      </ArtTableQuery>
    </div>

    <MemberAccessDialog ref="accessDialogRef" @success="handleSaved" />
    <MemberProvisionDialog ref="provisionDialogRef" @success="handleSaved" />
  </div>
</template>

<script setup lang="tsx">
  import { ElAvatar, ElButton, ElTag } from 'element-plus'
  import BusinessWorkspaceHeader, {
    type BusinessWorkspaceMetric
  } from '@/components/business/business-workspace-header/index.vue'
  import BusinessTableWorkspaceActions from '@/components/business/business-table-workspace-actions/index.vue'
  import BusinessTableRowActions from '@/components/business/business-table-row-actions/index.vue'
  import { useAuth } from '@/hooks/core/useAuth'
  import { formatWithDayjs } from '@/utils/time'
  import type { ColumnOption } from '@/types'
  import type { SearchFormItem } from '@/components/core/forms/art-search-bar/index.vue'
  import type {
    ArtTableQueryExpose,
    ArtTableQueryHeaderAction
  } from '@/components/core/tables/art-table-query/index.vue'
  import { bffSession } from '@bff/api/bff'
  import { fetchMembers } from '@bff/api/members'
  import type { MemberRecord, MemberSnapshot } from '@bff/types/member'
  import MemberAccessDialog from './modules/member-access-dialog.vue'
  import MemberProvisionDialog from './modules/member-provision-dialog.vue'

  defineOptions({ name: 'User' })

  const route = useRoute()
  const router = useRouter()
  const { hasAuth } = useAuth()
  const tableQueryRef = ref<ArtTableQueryExpose>()
  const accessDialogRef = ref<InstanceType<typeof MemberAccessDialog>>()
  const provisionDialogRef = ref<InstanceType<typeof MemberProvisionDialog>>()
  const snapshot = shallowRef<MemberSnapshot>({ revision: 0, records: [] })
  const loaded = ref(false)
  const headerActions = computed<ArtTableQueryHeaderAction[]>(() => [
    {
      type: 'add',
      label: '开通成员',
      icon: 'ri:user-add-line',
      permission: 'System:Member:Add',
      hidden: bffSession.value?.user.role !== 'admin',
      disabled: !loaded.value,
      onClick: () => provisionDialogRef.value?.handleOpen(snapshot.value.revision)
    }
  ])
  const showSearchBar = ref(true)
  const filters = ref({ keyword: '', status: '', role: '' })
  const locatedMemberId = computed(() =>
    typeof route.query.recordId === 'string' ? route.query.recordId : ''
  )
  const locatedMemberLabel = computed(() => {
    const record = snapshot.value.records.find((row) => row.id === locatedMemberId.value)
    return record?.displayName || record?.email || '指定成员'
  })

  watch(locatedMemberId, () => {
    filters.value = { keyword: '', status: '', role: '' }
    void tableQueryRef.value?.refreshCreate()
  })

  function clearLocate(): void {
    void router.replace({ query: { ...route.query, recordId: undefined } })
  }

  const metrics = computed<BusinessWorkspaceMetric[]>(() => {
    const records = snapshot.value.records
    const active = records.filter((row) => row.enabled)
    return [
      {
        key: 'members',
        label: '平台成员',
        value: records.length,
        description: '本租户已开通账号',
        icon: 'ri:team-line',
        tone: 'primary',
        loading: !loaded.value
      },
      {
        key: 'active',
        label: '已启用',
        value: active.length,
        description: '当前可访问 BFF',
        icon: 'ri:checkbox-circle-line',
        tone: 'success',
        loading: !loaded.value
      },
      {
        key: 'admins',
        label: '平台管理员',
        value: active.filter((row) => row.role === 'admin').length,
        description: '负责基础配置与授权',
        icon: 'ri:shield-user-line',
        tone: 'warning',
        loading: !loaded.value
      },
      {
        key: 'sessions',
        label: '有效会话',
        value: active.reduce((total, row) => total + row.sessionCount, 0),
        description: '成员当前登录会话',
        icon: 'ri:computer-line',
        tone: 'info',
        loading: !loaded.value
      }
    ]
  })

  const searchItems: SearchFormItem[] = [
    {
      key: 'keyword',
      label: '成员',
      type: 'input',
      props: { placeholder: '搜索姓名或邮箱', clearable: true }
    },
    {
      key: 'status',
      label: '访问状态',
      type: 'select',
      props: {
        placeholder: '全部状态',
        clearable: true,
        options: [
          { label: '已启用', value: 'enabled' },
          { label: '已停用', value: 'disabled' }
        ]
      }
    },
    {
      key: 'role',
      label: '平台身份',
      type: 'select',
      props: {
        placeholder: '全部身份',
        clearable: true,
        options: [
          { label: '平台管理员', value: 'admin' },
          { label: '普通成员', value: 'viewer' }
        ]
      }
    }
  ]

  async function loadMembers(params: Record<string, unknown>) {
    const result = await fetchMembers()
    snapshot.value = result
    loaded.value = true
    const keyword = typeof params.keyword === 'string' ? params.keyword.trim().toLowerCase() : ''
    const status = typeof params.status === 'string' ? params.status : ''
    const role = typeof params.role === 'string' ? params.role : ''
    const current = Math.max(1, Number(params.current) || 1)
    const size = Math.max(1, Number(params.size) || 20)
    const matching = result.records.filter(
      (row) =>
        (!keyword ||
          row.displayName.toLowerCase().includes(keyword) ||
          row.email.toLowerCase().includes(keyword)) &&
        (!status || (row.enabled ? status === 'enabled' : status === 'disabled')) &&
        (!role || row.role === role) &&
        (!locatedMemberId.value || row.id === locatedMemberId.value)
    )
    return {
      records: matching.slice((current - 1) * size, current * size),
      total: matching.length,
      current,
      size
    }
  }

  function canEdit(row: MemberRecord): boolean {
    return (
      hasAuth('System:Member:Edit') &&
      (row.role === 'viewer' || bffSession.value?.user.role === 'admin') &&
      row.id !== bffSession.value?.user.id
    )
  }

  function columnsFactory(): ColumnOption<MemberRecord>[] {
    return [
      {
        prop: 'displayName',
        label: '成员',
        minWidth: 245,
        formatter: (row) => (
          <div class="flex min-w-0 items-center gap-3 py-1">
            <ElAvatar size={34} class="shrink-0">
              {(row.displayName || row.email).slice(0, 1).toUpperCase() || 'U'}
            </ElAvatar>
            <div class="min-w-0">
              <strong class="block truncate font-medium text-g-900" title={row.displayName}>
                {row.displayName || '未设置姓名'}
              </strong>
              <span class="block truncate text-xs text-g-700" title={row.email}>
                {row.email || '暂无邮箱'}
              </span>
            </div>
          </div>
        )
      },
      {
        prop: 'role',
        label: '平台身份',
        minWidth: 125,
        formatter: (row) => (
          <ElTag type={row.role === 'admin' ? 'primary' : 'info'} effect="light" round>
            {row.role === 'admin' ? '管理员' : '普通成员'}
          </ElTag>
        )
      },
      {
        prop: 'enabled',
        label: '访问状态',
        minWidth: 105,
        formatter: (row) => (
          <ElTag type={row.enabled ? 'success' : 'info'} effect="light" round>
            {row.enabled ? '已启用' : '已停用'}
          </ElTag>
        )
      },
      {
        prop: 'roleNames',
        label: '业务角色',
        minWidth: 200,
        showOverflowTooltip: true,
        formatter: (row) => row.roleNames.join('、') || '尚未分配'
      },
      {
        prop: 'applicationCount',
        label: '应用授权',
        minWidth: 100,
        formatter: (row) => (row.role === 'admin' ? '全部应用' : `${row.applicationCount} 个`)
      },
      {
        prop: 'sessionCount',
        label: '有效会话',
        minWidth: 100,
        formatter: (row) => `${row.sessionCount} 个`
      },
      {
        prop: 'updatedAt',
        label: '最近变更',
        minWidth: 165,
        formatter: (row) => formatWithDayjs(row.updatedAt) || '—'
      },
      ...(hasAuth('System:Member:Edit')
        ? [
            {
              prop: 'actions',
              label: '操作',
              width: 120,
              fixed: 'right',
              formatter: (row: MemberRecord) => (
                <BusinessTableRowActions>
                  {canEdit(row) ? (
                    <ElButton
                      link
                      type="primary"
                      onClick={() =>
                        accessDialogRef.value?.handleOpen(row, snapshot.value.revision)
                      }
                    >
                      调整访问
                    </ElButton>
                  ) : (
                    <span class="text-xs text-g-700">
                      {row.id === bffSession.value?.user.id ? '当前账号' : '受保护'}
                    </span>
                  )}
                </BusinessTableRowActions>
              )
            } satisfies ColumnOption<MemberRecord>
          ]
        : [])
    ]
  }

  function handleSaved(result: MemberSnapshot): void {
    snapshot.value = result
    void tableQueryRef.value?.refreshData()
  }
</script>
