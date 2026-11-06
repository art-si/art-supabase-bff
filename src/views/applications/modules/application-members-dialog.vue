<template>
  <ArtDialog ref="dialogRef" :loading="members.loading">
    <ArtSectionCard
      :subtitle="members.application?.name"
      :error="members.error"
      :empty="!members.loading && !members.rows.length"
      empty-title="暂无可授权成员"
      empty-description="请先为统一账号开通 BFF 平台访问权限。"
      @retry="load"
    >
      <p class="mb-4 text-sm text-g-700"
        >管理员可管理本租户全部应用；普通成员只能看到启用且已授权的应用。</p
      >
      <ArtTable :data="members.rows" :columns="columns" row-key="id" />
    </ArtSectionCard>
  </ArtDialog>
</template>
<script setup lang="tsx">
  import { ElSwitch } from 'element-plus'
  import type { ColumnOption } from '@/types'
  import { fetchApplicationMembers, setApplicationMember, BffApiError } from '@/api/bff'
  import type { ApplicationMember, BffApplication } from '@/types/bff'
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
      label: '成员',
      minWidth: 180,
      formatter: (row) => (
        <div>
          <p class="font-medium">{row.name || row.email}</p>
          <p class="text-xs text-g-700">{row.email}</p>
        </div>
      )
    },
    {
      prop: 'role',
      label: '角色',
      width: 100,
      formatter: (row) => (row.role === 'admin' ? '管理员' : '成员')
    },
    {
      prop: 'granted',
      label: '应用访问',
      width: 140,
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
