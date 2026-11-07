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
        <div class="rounded-lg bg-g-100 px-3 py-2 text-sm leading-6 text-g-700">
          <p>管理员默认拥有全部应用的访问权限。</p>
          <p>普通成员需开启授权，且应用处于启用状态后才可访问。</p>
        </div>
        <div class="min-w-0">
          <ArtTable :data="members.rows" :columns="columns" row-key="id" :max-height="320" />
        </div>
      </div>
    </ArtSectionCard>
  </ArtDialog>
</template>
<script setup lang="tsx">
  import { ElSwitch } from 'element-plus'
  import ArtDictDisplay from '@/components/core/base/art-dict-display/index.vue'
  import { BFF_DICTIONARIES } from '@bff/config/dictionaries'
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
      label: '成员',
      minWidth: 84,
      formatter: (row) => (
        <div class="min-w-0 py-1">
          <p class="truncate font-medium leading-6 text-g-900" title={row.name || row.email}>
            {row.name || row.email}
          </p>
          <p class="truncate text-xs leading-5 text-g-700" title={row.email}>
            {row.email}
          </p>
        </div>
      )
    },
    {
      prop: 'role',
      label: '平台身份',
      width: 104,
      align: 'center',
      headerAlign: 'center',
      formatter: (row) => (
        <ArtDictDisplay dictCode={BFF_DICTIONARIES.members.role} value={row.role} display="tag" />
      )
    },
    {
      prop: 'granted',
      label: '应用访问',
      width: 80,
      align: 'center',
      headerAlign: 'center',
      formatter: (row) => (
        <span
          class="inline-flex items-center"
          title={
            row.role === 'admin'
              ? '管理员默认拥有访问权限'
              : !row.enabled
                ? '该成员已停用，无法调整授权'
                : '修改后立即生效'
          }
        >
          <ElSwitch
            modelValue={row.role === 'admin' || row.granted}
            disabled={row.role === 'admin' || !row.enabled}
            loading={members.saving === row.id}
            aria-label={`授权 ${row.name || row.email} 访问应用`}
            onChange={(value) => void change(row, Boolean(value))}
          />
        </span>
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
