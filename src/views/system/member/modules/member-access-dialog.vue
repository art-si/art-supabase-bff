<template>
  <ArtDialog ref="dialogRef" :loading="saving" :confirm-disabled="!canSubmit">
    <div class="grid min-w-0 gap-4">
      <ArtEntitySummary
        compact
        icon="ri:shield-user-line"
        :title="member?.displayName || member?.email || '未选择成员'"
        :description="member?.email || '统一账号'"
      >
        <template #aside>
          <ElTag :type="member?.role === 'admin' ? 'primary' : 'info'" effect="light" round>
            {{ member?.role === 'admin' ? '平台管理员' : '普通成员' }}
          </ElTag>
        </template>
      </ArtEntitySummary>

      <ArtForm v-model="form" :items="formItems" :span="24" label-position="top" />

      <ElAlert
        title="登录账号和密码由统一身份中心管理。此处调整平台访问权限。"
        type="info"
        :closable="false"
        show-icon
      />
      <ElAlert v-if="saveError" :title="saveError" type="error" :closable="false" show-icon />
    </div>
  </ArtDialog>
</template>

<script setup lang="ts">
  import { ElMessage } from 'element-plus'
  import { useArtFeedback } from '@/hooks/core/useArtFeedback'
  import type { FormItem } from '@/components/core/forms/art-form/index.vue'
  import type { ArtDialogExpose } from '@/components/core/dialogs/art-dialog/types'
  import { BffApiError, bffSession } from '@bff/api/bff'
  import { updateMemberAccess } from '@bff/api/members'
  import type { MemberBaseRole, MemberRecord, MemberSnapshot } from '@bff/types/member'

  const emit = defineEmits<{ success: [snapshot: MemberSnapshot] }>()
  const { confirmAction } = useArtFeedback()
  const dialogRef = ref<ArtDialogExpose<MemberRecord>>()
  const member = shallowRef<MemberRecord>()
  const collectionRevision = ref(0)
  const form = ref<{ enabled: boolean; role: MemberBaseRole }>({ enabled: true, role: 'viewer' })
  const saving = ref(false)
  const saveError = ref('')

  const isBaseAdmin = computed(() => bffSession.value?.user.role === 'admin')
  const canSubmit = computed(() => {
    const original = member.value
    return Boolean(
      original &&
      (original.role === 'viewer' || isBaseAdmin.value) &&
      original.id !== bffSession.value?.user.id &&
      !saving.value &&
      (isBaseAdmin.value || form.value.role === original.role) &&
      (original.role === 'admin' || form.value.enabled || form.value.role !== 'admin') &&
      (form.value.enabled !== original.enabled || form.value.role !== original.role)
    )
  })
  watch(canSubmit, (value) => dialogRef.value?.setOptions({ confirmDisabled: !value }))

  const formItems = computed<FormItem[]>(() => [
    {
      key: 'enabled',
      label: '平台访问状态',
      type: 'segment',
      span: 24,
      options: [
        { label: '启用', value: true },
        { label: '停用', value: false }
      ],
      props: { disabled: saving.value },
      description:
        member.value?.role === 'admin' && !form.value.enabled && form.value.role === 'admin'
          ? '停用会撤销会话和授权；再次启用后仍具有管理员身份。'
          : !member.value?.enabled && form.value.enabled
            ? '重新启用不会恢复原有业务角色或应用授权，请按职责重新分配。'
            : '停用后该成员将无法访问 BFF 平台。'
    },
    {
      key: 'role',
      label: '平台身份',
      type: 'segment',
      span: 24,
      options: [
        { label: '普通成员', value: 'viewer' },
        { label: '平台管理员', value: 'admin' }
      ],
      props: { disabled: saving.value || !isBaseAdmin.value },
      description: !isBaseAdmin.value
        ? '平台身份只能由当前租户的管理员调整。业务角色在角色管理中单独分配。'
        : !form.value.enabled
          ? '先启用成员，再授予管理员身份。业务角色在角色管理中单独分配。'
          : '管理员可管理本租户的基础配置和成员访问。业务角色在角色管理中单独分配。'
    }
  ])

  async function confirmImpact(original: MemberRecord): Promise<boolean> {
    if (
      original.role === 'admin' &&
      original.enabled &&
      !form.value.enabled &&
      form.value.role === 'admin'
    ) {
      try {
        await confirmAction(
          `停用「${original.displayName || original.email}」后，其 BFF 会话、应用授权和业务角色将被移除。再次启用时仍会恢复管理员身份，需重新分配其他授权。`,
          '停用管理员访问',
          { confirmButtonText: '确认停用', confirmButtonType: 'danger' }
        )
      } catch {
        return false
      }
      return true
    }
    if (original.role === 'admin' && form.value.role === 'viewer') {
      try {
        await confirmAction(
          form.value.enabled
            ? `「${original.displayName || original.email}」将失去本租户 BFF 平台管理员权限。请确认仍有其他管理员可以维护平台。`
            : `「${original.displayName || original.email}」将被降为普通成员并停用访问；其 BFF 会话、应用授权和业务角色将被移除。再次启用时需要重新授权。`,
          form.value.enabled ? '撤销管理员权限' : '停用管理员访问',
          {
            confirmButtonText: form.value.enabled ? '确认撤销' : '确认停用',
            confirmButtonType: 'danger'
          }
        )
      } catch {
        return false
      }
      return true
    }
    if (original.enabled && !form.value.enabled) {
      try {
        await confirmAction(
          `停用「${original.displayName || original.email}」后，其 BFF 会话、应用授权和业务角色将被移除。再次启用时需要重新授权。`,
          '停用成员访问',
          { confirmButtonText: '确认停用', confirmButtonType: 'danger' }
        )
      } catch {
        return false
      }
    }
    if (original.role !== 'admin' && form.value.role === 'admin') {
      try {
        await confirmAction(
          `「${original.displayName || original.email}」将获得本租户 BFF 平台管理员权限。请确认其管理职责。`,
          '授予管理员权限',
          { confirmButtonText: '确认授权' }
        )
      } catch {
        return false
      }
    }
    return true
  }

  async function handleSubmit(): Promise<boolean> {
    const original = member.value
    if (!original || !canSubmit.value) return false
    if (!isBaseAdmin.value && form.value.role !== original.role) return false
    if (!(await confirmImpact(original))) return false
    saving.value = true
    saveError.value = ''
    try {
      const result = await updateMemberAccess({
        operation: 'update',
        revision: collectionRevision.value,
        definition: {
          id: original.id,
          version: original.version,
          enabled: form.value.enabled,
          role: form.value.role
        }
      })
      emit('success', result)
      ElMessage.success('成员访问设置已保存')
      return true
    } catch (error) {
      saveError.value = error instanceof BffApiError ? error.message : '保存失败，请稍后重试'
      return false
    } finally {
      saving.value = false
    }
  }

  async function handleOpen(record: MemberRecord, revision: number): Promise<void> {
    if (
      saving.value ||
      (record.role === 'admin' && !isBaseAdmin.value) ||
      record.id === bffSession.value?.user.id
    )
      return
    member.value = record
    collectionRevision.value = revision
    form.value = { enabled: record.enabled, role: record.role }
    saveError.value = ''
    await dialogRef.value?.handleOpen(record, {
      title: '调整成员访问',
      size: 'md',
      confirmText: '保存设置',
      contentMaxHeight: '65vh',
      onConfirm: handleSubmit
    })
  }

  defineExpose({ handleOpen })
</script>
