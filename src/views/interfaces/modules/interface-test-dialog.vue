<template>
  <ArtDialog
    ref="dialogRef"
    :loading="running"
    :confirm-disabled="!canTest"
    @closed="resetAfterClose"
  >
    <div class="grid min-w-0 gap-4">
      <ArtEntitySummary
        compact
        icon="ri:flask-line"
        :title="record?.name || '接口测试'"
        :description="record ? `${record.method} ${record.path} · 草稿 v${record.version}` : ''"
      />
      <ElAlert
        title="测试会按步骤向真实上游发起请求；POST、PUT、PATCH、DELETE 可能写入上游业务数据。连接检测不能代替认证验证。"
        type="warning"
        :closable="false"
        show-icon
      />
      <ElAlert
        v-if="options && !options.networkPolicyConfigured"
        title="网络策略尚未配置，暂不能运行接口测试。"
        type="warning"
        :closable="false"
        show-icon
      />
      <ElAlert
        v-if="writeTestBlock"
        :title="writeTestBlock"
        type="warning"
        :closable="false"
        show-icon
      />
      <ArtForm
        ref="formRef"
        v-model="inputs"
        :items="formItems"
        :rules="rules"
        :span="12"
        :gutter="18"
        label-position="top"
      />
      <ElAlert v-if="testError" :title="testError" type="error" :closable="false" show-icon />
      <template v-if="result">
        <ElAlert
          :title="
            result.stale
              ? '草稿配置已变化，本次旧测试结果未应用，请重新测试。'
              : result.passed
                ? '测试通过'
                : '测试未通过'
          "
          :description="result.message"
          :type="result.stale ? 'warning' : result.passed ? 'success' : 'warning'"
          :closable="false"
          show-icon
        />
        <ArtSectionCard
          title="步骤结果"
          :subtitle="`总耗时 ${result.durationMs} 毫秒`"
          preserve-content-structure
        >
          <div class="grid gap-2 p-3">
            <div
              v-for="step in result.steps"
              :key="step.key"
              class="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-g-200 py-2 last:border-0"
            >
              <div class="min-w-0">
                <strong class="block truncate text-sm text-g-900">{{ step.name }}</strong>
                <span class="text-xs text-g-700">{{ step.message }}</span>
              </div>
              <div class="flex items-center gap-2">
                <ElTag
                  :type="
                    step.status === 'passed'
                      ? 'success'
                      : step.status === 'failed'
                        ? 'danger'
                        : 'info'
                  "
                  effect="light"
                  round
                >
                  {{
                    step.status === 'passed' ? '通过' : step.status === 'failed' ? '失败' : '跳过'
                  }}
                </ElTag>
                <span class="text-xs text-g-700"
                  >{{ step.statusCode ? `HTTP ${step.statusCode} · ` : ''
                  }}{{ step.durationMs }} ms</span
                >
              </div>
            </div>
          </div>
        </ArtSectionCard>
        <ArtSectionCard
          title="已映射输出"
          subtitle="仅显示草稿中明确声明的扁平字段"
          preserve-content-structure
        >
          <dl class="grid gap-2 p-3 sm:grid-cols-2">
            <div
              v-for="[key, value] in Object.entries(result.output)"
              :key="key"
              class="min-w-0 rounded border border-g-200 p-2"
            >
              <dt class="truncate font-mono text-xs text-g-700" :title="key">{{ key }}</dt>
              <dd class="mt-1 break-all text-sm text-g-900">{{
                value === null ? '空值' : String(value)
              }}</dd>
            </div>
            <div v-if="!Object.keys(result.output).length" class="text-sm text-g-700"
              >本次没有可展示的映射输出。</div
            >
          </dl>
        </ArtSectionCard>
      </template>
    </div>
  </ArtDialog>
</template>

<script setup lang="ts">
  import type { FormRules } from 'element-plus'
  import { useAuth } from '@/hooks/core/useAuth'
  import { useArtFeedback } from '@/hooks/core/useArtFeedback'
  import { validateArtFormForSubmit } from '@/utils/form/validate-art-form'
  import type ArtForm from '@/components/core/forms/art-form/index.vue'
  import type { FormItem } from '@/components/core/forms/art-form/index.vue'
  import type { ArtDialogExpose } from '@/components/core/dialogs/art-dialog/types'
  import { BffApiError } from '@bff/api/bff'
  import { testInterface } from '@bff/api/interfaces'
  import type {
    InterfaceOptions,
    InterfaceRecord,
    InterfaceScalar,
    InterfaceTestResult
  } from '@bff/types/interface'

  const emit = defineEmits<{ tested: [] }>()
  const { hasAuth } = useAuth()
  const { confirmAction } = useArtFeedback()
  const dialogRef = ref<ArtDialogExpose<InterfaceRecord>>()
  const formRef = ref<InstanceType<typeof ArtForm>>()
  const record = shallowRef<InterfaceRecord>()
  const options = shallowRef<InterfaceOptions>()
  const inputs = ref<Record<string, InterfaceScalar>>({})
  const running = ref(false)
  const testError = ref('')
  const result = shallowRef<InterfaceTestResult>()
  const isWriteFlow = computed(
    () => record.value?.definition.steps.some((step) => step.method !== 'GET') ?? false
  )
  const writeTestBlock = computed(() => {
    if (!isWriteFlow.value) return ''
    if (record.value?.environment === 'production') return '生产环境不执行写入测试。'
    if (!hasAuth('BffInterface:TestWrite')) return '当前账号没有写入测试权限。'
    if (!options.value?.writeTestsConfigured)
      return '尚未配置写入测试专用上游源站，暂不能运行包含写入步骤的测试。'
    return ''
  })
  const canTest = computed(() =>
    Boolean(
      record.value &&
      options.value?.networkPolicyConfigured &&
      !writeTestBlock.value &&
      !running.value
    )
  )
  watch(canTest, (value) => dialogRef.value?.setOptions({ confirmDisabled: !value }))
  watch(
    inputs,
    () => {
      result.value = undefined
    },
    { deep: true }
  )

  const formItems = computed<FormItem[]>(() =>
    (record.value?.definition.inputs ?? []).map((field) => ({
      key: field.key,
      label: field.label || field.key,
      type: field.type === 'number' ? 'number' : field.type === 'boolean' ? 'select' : 'input',
      span: 12,
      props:
        field.type === 'boolean'
          ? {
              clearable: !field.required,
              placeholder: '选择是或否',
              options: [
                { label: '是', value: true },
                { label: '否', value: false }
              ]
            }
          : field.type === 'number'
            ? { placeholder: '输入数字' }
            : { placeholder: `输入${field.label || field.key}` },
      description: `${{ path: '路径', query: '查询', body: '请求体' }[field.location]}字段 · ${field.required ? '必填' : '选填'}`
    }))
  )
  const rules = computed<FormRules>(() =>
    Object.fromEntries(
      (record.value?.definition.inputs ?? [])
        .filter((field) => field.required)
        .map((field) => [
          field.key,
          [{ required: true, message: `请填写${field.label || field.key}`, trigger: 'change' }]
        ])
    )
  )

  function resetAfterClose(): void {
    inputs.value = {}
    result.value = undefined
    testError.value = ''
    record.value = undefined
    options.value = undefined
  }
  async function handleSubmit(): Promise<boolean> {
    const current = record.value
    if (!current || !canTest.value) return false
    try {
      if (!(await validateArtFormForSubmit(formRef.value))) return false
    } catch {
      testError.value = '测试输入校验未完成，请检查必填字段'
      return false
    }
    if (isWriteFlow.value) {
      try {
        await confirmAction(
          '本次测试包含 POST、PUT、PATCH 或 DELETE 请求，可能写入真实上游数据。请确认已选择安全的测试环境和样例输入。',
          '确认执行真实上游请求',
          { confirmButtonText: '确认测试' }
        )
      } catch {
        return false
      }
    }
    running.value = true
    testError.value = ''
    result.value = undefined
    try {
      result.value = await testInterface(current.id, current.version, { ...inputs.value })
      emit('tested')
    } catch (error) {
      testError.value =
        error instanceof BffApiError ? error.message : '接口测试失败，请核对输入和上游服务状态'
    } finally {
      running.value = false
    }
    return false
  }
  async function handleOpen(
    current: InterfaceRecord,
    currentOptions: InterfaceOptions
  ): Promise<void> {
    if (running.value) return
    record.value = current
    options.value = currentOptions
    inputs.value = Object.fromEntries(
      current.definition.inputs.map((field) => [field.key, field.type === 'string' ? '' : null])
    )
    result.value = undefined
    testError.value = ''
    await dialogRef.value?.handleOpen(current, {
      title: '接口测试',
      size: 'lg',
      contentMaxHeight: '68vh',
      confirmText: '运行测试',
      onConfirm: handleSubmit
    })
  }
  defineExpose({ handleOpen })
</script>
