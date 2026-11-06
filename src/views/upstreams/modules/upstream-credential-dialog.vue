<template>
  <ArtDialog ref="dialogRef" :loading="saving" :confirm-disabled="!canSubmit" @closed="clearSecret">
    <div class="grid min-w-0 gap-4">
      <ArtEntitySummary
        compact
        icon="ri:key-2-line"
        :title="upstream?.name || '管理凭据'"
        :description="upstream ? `${upstream.application.name} · ${upstream.code}` : ''"
      >
        <template #aside>
          <ElTag
            :type="upstream?.credentialConfigured ? 'success' : 'warning'"
            effect="light"
            round
          >
            {{ upstream?.credentialConfigured ? '已安全配置' : '待配置' }}
          </ElTag>
        </template>
      </ArtEntitySummary>
      <ElAlert
        title="凭据仅写入服务端，不会回显。保存后平台后续调用使用新凭据，旧凭据的停用由上游服务管理。连接检测不验证认证。"
        type="info"
        :closable="false"
        show-icon
      />
      <ArtForm v-model="form" :items="formItems" :span="24" label-position="top" />
      <ElAlert v-if="saveError" :title="saveError" type="error" :closable="false" show-icon />
    </div>
  </ArtDialog>
</template>

<script setup lang="ts">
  import { ElMessage } from 'element-plus'
  import { useArtFeedback } from '@/hooks/core/useArtFeedback'
  import type { FormItem } from '@/components/core/forms/art-form/index.vue'
  import type { ArtDialogExpose } from '@/components/core/dialogs/art-dialog/types'
  import { BffApiError } from '@bff/api/bff'
  import { changeUpstreamCredential } from '@bff/api/upstreams'
  import type { UpstreamCredentialInput, UpstreamService } from '@bff/types/upstream'

  const emit = defineEmits<{ success: [] }>()
  const { confirmAction } = useArtFeedback()
  const dialogRef = ref<ArtDialogExpose<UpstreamService>>()
  const upstream = shallowRef<UpstreamService>()
  const form = ref<{ action: UpstreamCredentialInput['action']; credential: string }>({
    action: 'rotate',
    credential: ''
  })
  const saving = ref(false)
  const saveError = ref('')
  const canSubmit = computed(
    () =>
      !saving.value &&
      Boolean(upstream.value) &&
      (form.value.action === 'rotate'
        ? Boolean(form.value.credential.trim())
        : Boolean(upstream.value?.credentialConfigured) && upstream.value?.status !== 'active')
  )
  watch(canSubmit, (value) => dialogRef.value?.setOptions({ confirmDisabled: !value }))

  const formItems = computed<FormItem[]>(() => [
    {
      key: 'action',
      label: '操作',
      type: 'segment',
      span: 24,
      options: [
        { label: '轮换凭据', value: 'rotate' },
        { label: '清除凭据', value: 'clear' }
      ],
      description:
        upstream.value?.status === 'active'
          ? '清除凭据前请先停用服务；轮换凭据可在启用状态下进行。'
          : '清除后需要重新配置凭据，才能使用需要认证的上游服务。'
    },
    {
      key: 'credential',
      label: '新凭据',
      type: 'input',
      span: 24,
      hidden: () => form.value.action !== 'rotate',
      props: {
        type: 'password',
        showPassword: true,
        autocomplete: 'new-password',
        maxlength: 8192,
        placeholder: '输入新的 Bearer Token 或 API Key'
      },
      description: '旧凭据不会显示；请从上游服务的安全渠道取得新值。'
    }
  ])

  function clearSecret(): void {
    form.value.credential = ''
  }

  async function handleSubmit(): Promise<boolean> {
    const row = upstream.value
    if (!row || !canSubmit.value || saving.value) return false
    if (form.value.action === 'clear') {
      try {
        await confirmAction(
          `清除「${row.name}」的上游凭据后，该服务将无法使用当前认证方式。请确认调用方已做好切换安排。`,
          '清除上游凭据',
          { confirmButtonText: '确认清除', confirmButtonType: 'danger' }
        )
      } catch {
        return false
      }
    }
    saving.value = true
    saveError.value = ''
    try {
      await changeUpstreamCredential(row.id, {
        version: row.version,
        action: form.value.action,
        ...(form.value.action === 'rotate' ? { credential: form.value.credential } : {})
      })
      clearSecret()
      emit('success')
      ElMessage.success(form.value.action === 'rotate' ? '上游凭据已轮换' : '上游凭据已清除')
      return true
    } catch (error) {
      saveError.value = error instanceof BffApiError ? error.message : '凭据操作失败，请稍后重试'
      return false
    } finally {
      saving.value = false
    }
  }

  async function handleOpen(row: UpstreamService): Promise<void> {
    if (saving.value || row.authType === 'none') return
    upstream.value = row
    form.value = { action: 'rotate', credential: '' }
    saveError.value = ''
    await dialogRef.value?.handleOpen(row, {
      title: '管理上游凭据',
      size: 'md',
      confirmText: '保存凭据',
      contentMaxHeight: '60vh',
      onConfirm: handleSubmit
    })
  }

  defineExpose({ handleOpen })
</script>
