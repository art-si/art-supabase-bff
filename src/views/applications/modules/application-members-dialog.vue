<template>
  <ArtDialog ref="dialogRef" :loading="members.loading">
    <ArtSectionCard
      title="成员访问范围"
      :subtitle="members.application?.name"
      :loading="members.loading"
      :error="members.error"
      :empty="!members.loading && !members.rows.length"
      empty-title="暂无可授权成员"
      empty-description="请先为统一账号开通 BFF 平台访问权限。"
      @retry="load"
    >
      <div class="grid min-w-0 gap-3">
        <p class="text-sm text-g-700"
          >管理员可管理本租户全部应用；普通成员只能看到启用且已授权的应用。</p
        >
        <div class="h-64 min-w-0">
          <ArtTable :data="members.rows" :columns="columns" row-key="id" />
        </div>
      </div>
    </ArtSectionCard>
  </ArtDialog>
</template>
<script setup lang="tsx">
  import { ElSwitch } from 'element-plus'
  import type { ColumnOption } from '@/types'
  import { fetchApplicationMembers, setApplicationMember, BffApiError } from '@bff/api/bff'
  import type { ApplicationMember, BffApplication } from '@bff/types/bff'
  import type { ArtDialogExpose } from '@/components/core/dialogs/art-dialog/types'
  const dialogRef = ref<ArtDialogExpose>()
  const members = reactive<{
    application?: BffApplication
    rows: ApplicationMember[]
    loading: boolean
    error: string
    saving: string
  }>({ rows: [], loading: false, error: '', saving: '' })
  const columns: ColumnOption<ApplicationMember>[] = [
    {
      prop: 'name',
      label: '成员 / 角色',
      minWidth: 168,
      formatter: (row) => (
        <div class="min-w-0">
          <div class="flex min-w-0 items-center gap-2">
            <p class="min-w-0 flex-1 truncate font-medium text-g-900" title={row.name || row.email}>
              {row.name || row.email}
            </p>
            <span class="shrink-0 text-xs text-g-700">
              {row.role === 'admin' ? '管理员' : '成员'}
            </span>
          </div>
          <p class="truncate text-xs text-g-700" title={row.email}>
            {row.email}
          </p>
        </div>
      )
    },
    {
      prop: 'granted',
      label: '应用访问',
      width: 104,
      formatter: (row) => (
        <ElSwitch
          modelValue={row.role === 'admin' || row.granted}
          disabled={row.role === 'admin' || !row.enabled}
          loading={members.saving === row.id}
          aria-label={`授权 ${row.name || row.email} 访问应用`}
          onChange={(value) => void change(row, Boolean(value))}
        />
      )
    }
  ]
  async function load(): Promise<void> {
    if (!members.application) return
    Object.assign(members, { loading: true, error: '' })
    try {
      members.rows = await fetchApplicationMembers(members.application.id)
    } catch (error) {
      members.error = error instanceof BffApiError ? error.message : '成员加载失败，请重试'
    } finally {
      members.loading = false
    }
  }
  async function change(member: ApplicationMember, granted: boolean): Promise<void> {
    if (!members.application || members.saving) return
    Object.assign(members, { saving: member.id, error: '' })
    try {
      await setApplicationMember(members.application.id, member.id, granted)
      member.granted = granted
    } catch (error) {
      members.error = error instanceof BffApiError ? error.message : '授权保存失败，请重试'
    } finally {
      members.saving = ''
    }
  }
  async function handleOpen(application: BffApplication): Promise<void> {
    Object.assign(members, { application, rows: [], error: '' })
    await dialogRef.value?.handleOpen(
      {},
      {
        title: '成员授权',
        size: 'md',
        showConfirmButton: false,
        cancelText: '关闭',
        contentMaxHeight: '65vh'
      }
    )
    await load()
  }
  defineExpose({ handleOpen })
</script>
