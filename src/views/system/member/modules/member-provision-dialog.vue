<template>
  <ArtDialog ref="dialogRef" :loading="form.saving">
    <div class="grid gap-6">
      <ArtEntitySummary
        compact
        icon="ri:user-add-line"
        title="开通 BFF 平台访问"
        description="使用已有统一账号加入当前租户的工作空间。"
      />
      <ArtForm v-model="form.data" :items="items" :span="24" label-position="top" />
      <ElAlert
        title="开通后为普通成员。业务角色和应用访问权可在开通后分配。"
        type="info"
        :closable="false"
        show-icon
      />
      <ElAlert v-if="form.error" :title="form.error" type="error" :closable="false" show-icon />
    </div>
  </ArtDialog>
</template>

<script setup lang="ts">
  import { ElMessage } from 'element-plus'
  import type { FormItem } from '@/components/core/forms/art-form/index.vue'
  import type { ArtDialogExpose } from '@/components/core/dialogs/art-dialog/types'
  import { BffApiError } from '@bff/api/bff'
  import { provisionMember } from '@bff/api/members'
  import type { MemberSnapshot } from '@bff/types/member'

  const emit = defineEmits<{ success: [snapshot: MemberSnapshot] }>()
  const dialogRef = ref<ArtDialogExpose>()
  const form = reactive({ data: { email: '' }, revision: 1, saving: false, error: '' })
  const items = computed<FormItem[]>(() => [
    {
      key: 'email',
      label: '统一账号邮箱',
      type: 'input',
      span: 24,
      props: { placeholder: '请输入已注册的账号邮箱', maxlength: 254, disabled: form.saving },
      description: '核验已有统一账号后加入当前 BFF 工作空间，不改变其在身份中心的租户归属。'
    }
  ])

  async function submit(): Promise<boolean> {
    if (form.saving) return false
    const email = form.data.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      form.error = '请输入完整的统一账号邮箱'
      return false
    }
    Object.assign(form, { saving: true, error: '' })
    try {
      const snapshot = await provisionMember({ email, revision: form.revision })
      emit('success', snapshot)
      ElMessage.success('成员已开通，可继续分配业务角色和应用访问权')
      return true
    } catch (error) {
      form.error = error instanceof BffApiError ? error.message : '开通失败，请稍后重试'
      return false
    } finally {
      form.saving = false
    }
  }

  async function handleOpen(revision: number): Promise<void> {
    Object.assign(form, { data: { email: '' }, revision, error: '' })
    await dialogRef.value?.handleOpen(undefined, {
      title: '开通成员',
      size: 'sm',
      confirmText: '核验并开通',
      onConfirm: submit
    })
  }
  defineExpose({ handleOpen })
</script>
