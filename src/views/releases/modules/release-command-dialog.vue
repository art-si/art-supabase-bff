<template>
  <ArtDialog
    ref="dialogRef"
    :loading="checking || saving"
    :confirm-disabled="!canSubmit"
    @closed="resetAfterClose"
  >
    <div class="grid min-w-0 gap-4">
      <ArtEntitySummary
        compact
        icon="ri:git-commit-line"
        :title="record?.name || '版本操作'"
        :description="
          record
            ? `${record.application.name} · ${record.code} · ${environmentText(record.environment)}`
            : ''
        "
      >
        <template #aside>
          <ElTag type="primary" effect="light" round>
            {{
              action === 'publish'
                ? `草稿 v${record?.draftVersion ?? '—'}`
                : target
                  ? `目标 V${target.number}`
                  : record?.deployment
                    ? `当前 V${record.deployment.activeVersionNumber}`
                    : '未发布'
            }}
          </ElTag>
        </template>
      </ArtEntitySummary>
      <ElAlert
        :title="actionDescription"
        :type="action === 'disable' ? 'warning' : 'info'"
        :closable="false"
        show-icon
      />
      <ArtSectionCard
        v-if="action !== 'disable'"
        :title="`${actionLabel}前检查`"
        :subtitle="
          action === 'publish'
            ? '提交前重新检查当前草稿、上游状态和调用边界。'
            : '检查所选发布快照及其依赖；修改草稿不会改变已发布快照。'
        "
        preserve-content-structure
      >
        <div class="grid gap-2 p-3">
          <p v-if="readiness" class="text-sm font-medium text-g-900" role="status">
            {{ readiness.ready ? '检查通过，可以继续操作' : `还有 ${failedChecks} 项条件需要处理` }}
          </p>
          <div v-for="check in checks" :key="check.key" class="flex min-w-0 items-start gap-3 py-1">
            <ElTag :type="check.passed ? 'success' : 'danger'" effect="light" round>
              {{ check.passed ? '通过' : '阻止' }}
            </ElTag>
            <div class="min-w-0">
              <strong class="block text-sm text-g-900">{{ check.label }}</strong>
              <p class="mt-1 text-xs text-g-700">{{ check.message }}</p>
              <RouterLink
                v-if="check.destination"
                :to="check.destination.to"
                class="mt-1 inline-flex min-h-6 items-center text-sm text-theme underline underline-offset-4"
                @click="closeForNavigation"
              >
                {{ check.destination.label }}
              </RouterLink>
            </div>
          </div>
          <ElAlert
            v-if="readiness && !readiness.ready"
            title="存在未满足的发布条件，请按上方提示处理后重新检查。"
            type="warning"
            :closable="false"
            show-icon
          />
          <ElButton
            v-if="!conflicted && (readinessError || !readiness?.ready)"
            link
            type="primary"
            :loading="checking"
            @click="loadReadiness"
            >重新检查</ElButton
          >
        </div>
      </ArtSectionCard>
      <ElAlert
        v-if="readinessError"
        :title="readinessError"
        type="error"
        :closable="false"
        show-icon
      />
      <ArtForm
        ref="notesFormRef"
        v-model="form"
        :items="notesItems"
        :rules="notesRules"
        :span="24"
        label-position="top"
      />
      <ElAlert v-if="submitError" :title="submitError" type="error" :closable="false" show-icon />
      <ElButton v-if="conflicted" @click="closeForNavigation">关闭并查看最新记录</ElButton>
    </div>
  </ArtDialog>
</template>

<script setup lang="ts">
  import { ElMessage, type FormRules } from 'element-plus'
  import { useAuth } from '@/hooks/core/useAuth'
  import { useArtFeedback } from '@/hooks/core/useArtFeedback'
  import { validateArtFormForSubmit } from '@/utils/form/validate-art-form'
  import type ArtForm from '@/components/core/forms/art-form/index.vue'
  import type { FormItem } from '@/components/core/forms/art-form/index.vue'
  import type { ArtDialogExpose } from '@/components/core/dialogs/art-dialog/types'
  import ArtSectionCard from '@/components/core/surfaces/art-section-card/index.vue'
  import { BffApiError } from '@bff/api/bff'
  import {
    changeReleaseStatus,
    fetchReleaseReadiness,
    publishRelease,
    rollbackRelease
  } from '@bff/api/releases'
  import type {
    ReleaseHistory,
    ReleaseReadiness,
    ReleaseRecord,
    ReleaseVersion
  } from '@bff/types/release'

  type Action = 'publish' | 'rollback' | 'enable' | 'disable'
  const emit = defineEmits<{ success: [history: ReleaseHistory]; stale: [] }>()
  const { confirmAction } = useArtFeedback()
  const { hasAuth } = useAuth()
  const dialogRef = ref<ArtDialogExpose<ReleaseRecord>>()
  const notesFormRef = ref<InstanceType<typeof ArtForm>>()
  const record = shallowRef<ReleaseRecord>()
  const target = shallowRef<ReleaseVersion>()
  const action = ref<Action>('publish')
  const readiness = shallowRef<ReleaseReadiness>()
  const checking = ref(false)
  const saving = ref(false)
  const conflicted = ref(false)
  const readinessError = ref('')
  const submitError = ref('')
  const form = ref({ notes: '' })
  const notesItems: FormItem[] = [
    {
      key: 'notes',
      label: '操作说明',
      type: 'input',
      span: 24,
      props: {
        type: 'textarea',
        rows: 3,
        maxlength: 1000,
        showWordLimit: true,
        placeholder: '写明变更原因、影响范围和回退依据'
      },
      description: '此说明会进入不可修改的发布事件，便于后续追溯。'
    }
  ]
  const notesRules: FormRules = {
    notes: [{ required: true, message: '请填写操作说明', trigger: 'blur' }]
  }
  const actionLabel = computed(
    () => ({ publish: '发布', rollback: '回滚', enable: '启用', disable: '停用' })[action.value]
  )
  const actionDescription = computed(() => {
    if (action.value === 'publish')
      return '发布会生成不可修改的版本快照，并把当前运行指针指向新版本；正在编辑的草稿保持独立。'
    if (action.value === 'rollback')
      return record.value?.deployment?.enabled
        ? '回滚切换到选中的历史快照，不创建新版本；接口保持启用，当前草稿不变。'
        : '回滚切换到选中的历史快照，不创建新版本；接口保持停用，须单独启用后才能接收调用。'
    if (action.value === 'enable')
      return '启用前重新核对当前版本及其上游依赖；成功后已授权的同源调用方可使用接口。'
    return '停用会立即阻止新的接口调用；历史版本与事件仍保留，可在检查通过后再次启用。'
  })
  const canSubmit = computed(() =>
    Boolean(
      record.value &&
      form.value.notes.trim() &&
      !conflicted.value &&
      !saving.value &&
      !checking.value &&
      (action.value === 'disable' || readiness.value?.ready)
    )
  )
  watch(canSubmit, (value) => dialogRef.value?.setOptions({ confirmDisabled: !value }))
  const environmentText = (environment: ReleaseRecord['environment']): string =>
    ({ development: '开发', staging: '预发布', production: '生产' })[environment]
  const failedChecks = computed(
    () => readiness.value?.checks.filter((check) => !check.passed).length ?? 0
  )
  const checks = computed(() =>
    (readiness.value?.checks ?? []).map((check) => {
      const current = record.value
      let destination:
        { label: string; to: { path: string; query?: Record<string, string> } } | undefined
      if (!check.passed && current) {
        const query = { applicationId: current.applicationId, environment: current.environment }
        if (check.key === 'application' && hasAuth('BffApplication:View')) {
          destination = { label: '前往应用管理', to: { path: '/applications' } }
        } else if (check.key.startsWith('upstream:') && hasAuth('BffUpstream:View')) {
          destination = { label: '检查上游服务', to: { path: '/upstreams', query } }
        } else if (check.key === 'route' && hasAuth('BffRelease:View')) {
          destination = { label: '查看同环境发布接口', to: { path: '/releases', query } }
        } else if (
          action.value === 'publish' &&
          ['definition', 'validation', 'test', 'test-targets'].includes(check.key) &&
          hasAuth('BffInterface:View')
        ) {
          destination = {
            label: '处理接口草稿',
            to: {
              path: '/interfaces',
              query: { ...query, recordId: current.interfaceId }
            }
          }
        }
      }
      return { ...check, destination }
    })
  )
  function closeForNavigation(): void {
    void dialogRef.value?.handleClose()
  }

  async function loadReadiness(): Promise<void> {
    const current = record.value
    if (!current || conflicted.value || action.value === 'disable' || checking.value) return
    checking.value = true
    readinessError.value = ''
    try {
      readiness.value = await fetchReleaseReadiness(
        current.interfaceId,
        action.value,
        action.value === 'rollback' ? target.value?.id : undefined
      )
    } catch (error) {
      readiness.value = undefined
      readinessError.value =
        error instanceof BffApiError ? error.message : '发布条件检查失败，请稍后重试'
    } finally {
      checking.value = false
    }
  }

  async function handleSubmit(): Promise<boolean> {
    const current = record.value
    if (!current || !canSubmit.value) return false
    try {
      if (!(await validateArtFormForSubmit(notesFormRef.value))) return false
    } catch {
      submitError.value = '操作说明校验未完成，请重试'
      return false
    }
    if (action.value !== 'disable') {
      await loadReadiness()
      if (!readiness.value?.ready) return false
    }
    if (action.value === 'disable' || action.value === 'enable') {
      try {
        await confirmAction(
          action.value === 'disable'
            ? `停用「${current.name}」后，新请求将无法通过网关调用当前版本。`
            : `启用「${current.name}」后，同源且具备调用权限的请求可使用当前版本。`,
          `${actionLabel.value}接口`,
          {
            confirmButtonText: `确认${actionLabel.value}`,
            confirmButtonType: action.value === 'disable' ? 'danger' : 'primary'
          }
        )
      } catch {
        return false
      }
    }
    saving.value = true
    submitError.value = ''
    const deploymentVersion = current.deployment?.version ?? 0
    try {
      let history: ReleaseHistory
      if (action.value === 'publish') {
        history = await publishRelease(current.interfaceId, {
          draftVersion: current.draftVersion,
          deploymentVersion,
          notes: form.value.notes.trim()
        })
      } else if (action.value === 'rollback') {
        if (!target.value) return false
        history = await rollbackRelease(current.interfaceId, {
          targetVersionId: target.value.id,
          deploymentVersion,
          notes: form.value.notes.trim()
        })
      } else {
        history = await changeReleaseStatus(current.interfaceId, {
          enabled: action.value === 'enable',
          deploymentVersion,
          notes: form.value.notes.trim()
        })
      }
      emit('success', history)
      ElMessage.success(`${actionLabel.value}操作已完成`)
      return true
    } catch (error) {
      submitError.value =
        error instanceof BffApiError ? error.message : '版本操作失败，请刷新后重试'
      if (error instanceof BffApiError && error.status === 409) {
        conflicted.value = true
        submitError.value += '。请关闭窗口，从最新列表重新打开后再操作。'
        emit('stale')
      }
      return false
    } finally {
      saving.value = false
    }
  }

  function resetAfterClose(): void {
    record.value = undefined
    target.value = undefined
    readiness.value = undefined
    form.value = { notes: '' }
    readinessError.value = ''
    submitError.value = ''
    conflicted.value = false
  }
  async function handleOpen(
    current: ReleaseRecord,
    mode: Action,
    version?: ReleaseVersion
  ): Promise<void> {
    if (checking.value || saving.value) return
    record.value = current
    target.value = version
    action.value = mode
    readiness.value = undefined
    form.value = { notes: '' }
    readinessError.value = ''
    submitError.value = ''
    conflicted.value = false
    await dialogRef.value?.handleOpen(current, {
      title: `${actionLabel.value}接口`,
      size: 'md',
      contentMaxHeight: '68vh',
      confirmText: `确认${actionLabel.value}`,
      onConfirm: handleSubmit
    })
    if (mode !== 'disable') await loadReadiness()
  }
  defineExpose({ handleOpen })
</script>
