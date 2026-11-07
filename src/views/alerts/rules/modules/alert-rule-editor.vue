<template>
  <ArtDialog ref="dialogRef" :loading="saving" :confirm-disabled="!options">
    <div class="grid min-w-0 gap-4">
      <ArtEntitySummary
        compact
        :icon="rule ? 'ri:edit-2-line' : 'ri:add-circle-line'"
        :title="rule?.name || '创建告警规则'"
        :description="
          rule
            ? `${rule.applicationName} · ${rule.interfaceName || '全部接口'}`
            : '指定作用范围与触发条件，保存后再按需启用。'
        "
      />
      <ArtForm
        ref="formRef"
        v-model="form"
        :items="formItems"
        :rules="validationRules"
        :span="12"
        :gutter="18"
        label-width="112px"
      />
      <ElAlert
        v-if="form.metric === 'failure_rate'"
        title="失败率只用已确认完成的成功与失败调用作为分母；执行中与结果未知的调用不计入。"
        type="info"
        :closable="false"
        show-icon
      />
      <ElAlert
        v-if="form.metric === 'unknown_count'"
        title="结果未知可能已在上游执行。此指标直接按未知次数判断，不使用最少已确认调用门槛。"
        type="warning"
        :closable="false"
        show-icon
      />
      <ElAlert v-if="saveError" :title="saveError" type="error" :closable="false" show-icon />
    </div>
  </ArtDialog>
</template>

<script setup lang="ts">
  import type { FormRules } from 'element-plus'
  import { validateArtFormForSubmit } from '@/utils/form/validate-art-form'
  import type ArtForm from '@/components/core/forms/art-form/index.vue'
  import type { FormItem } from '@/components/core/forms/art-form/index.vue'
  import type { ArtDialogExpose } from '@/components/core/dialogs/art-dialog/types'
  import { BffApiError } from '@bff/api/bff'
  import { createAlertRule, updateAlertRule } from '@bff/api/observability'
  import type { AlertOptions, AlertRule, AlertRuleWriteInput } from '@bff/types/observability'

  const emit = defineEmits<{ success: [] }>()
  const dialogRef = ref<ArtDialogExpose<AlertRule | undefined>>()
  const formRef = ref<InstanceType<typeof ArtForm>>()
  const options = shallowRef<AlertOptions>()
  const rule = shallowRef<AlertRule>()
  const saving = ref(false)
  const saveError = ref('')
  const defaults = (current: AlertOptions): AlertRuleWriteInput => ({
    applicationId: current.applications.find((item) => item.enabled)?.id ?? '',
    environment: current.environments[0]?.value ?? 'development',
    interfaceId: null,
    name: '',
    metric: 'failure_count',
    windowMinutes: 15,
    threshold: 5,
    minCalls: 10,
    severity: 'warning',
    enabled: false,
    quietMinutes: 15
  })
  const form = ref<AlertRuleWriteInput>(
    defaults({
      applications: [],
      environments: [],
      interfaces: [],
      metrics: [],
      severities: [],
      statuses: [],
      errorClasses: []
    })
  )
  const validationRules = computed<FormRules>(() => ({
    applicationId: [{ required: true, message: '请选择所属应用', trigger: 'change' }],
    environment: [{ required: true, message: '请选择环境', trigger: 'change' }],
    name: [
      { required: true, message: '请输入规则名称', trigger: 'blur' },
      { max: 100, message: '名称不能超过 100 字', trigger: 'blur' }
    ],
    metric: [{ required: true, message: '请选择检测指标', trigger: 'change' }],
    threshold: [
      {
        required: true,
        type: 'number',
        min: form.value.metric === 'failure_rate' ? 0.1 : 1,
        max: form.value.metric === 'failure_rate' ? 100 : 1000000,
        message:
          form.value.metric === 'failure_rate' ? '失败率阈值应为 0.1–100%' : '阈值应为 1–1000000',
        trigger: 'change'
      }
    ],
    minCalls: [
      {
        required: true,
        type: 'number',
        min: 1,
        max: 1000000,
        message: '最少调用数应为 1–1000000',
        trigger: 'change'
      }
    ],
    quietMinutes: [
      {
        required: true,
        type: 'number',
        min: 0,
        max: 1440,
        message: '静默时间应为 0–1440 分钟',
        trigger: 'change'
      }
    ]
  }))
  const formItems = computed<FormItem[]>(() => [
    { key: 'scope', label: '监测范围', type: 'divider', span: 24 },
    {
      key: 'name',
      label: '规则名称',
      type: 'input',
      span: 12,
      props: { maxlength: 100, placeholder: '例如：生产订单接口失败率' }
    },
    {
      key: 'applicationId',
      label: '所属应用',
      type: 'select',
      span: 12,
      props: {
        disabled: Boolean(rule.value),
        filterable: true,
        placeholder: '选择应用',
        options: (options.value?.applications ?? []).map((item) => ({
          label: item.name,
          value: item.id,
          disabled: !item.enabled && item.id !== rule.value?.applicationId
        }))
      }
    },
    {
      key: 'environment',
      label: '环境',
      type: 'select',
      span: 12,
      props: { disabled: Boolean(rule.value), options: options.value?.environments ?? [] }
    },
    {
      key: 'interfaceId',
      label: '指定接口',
      type: 'select',
      span: 12,
      props: {
        clearable: true,
        filterable: true,
        placeholder: '全部接口',
        options: (options.value?.interfaces ?? [])
          .filter(
            (item) =>
              item.applicationId === form.value.applicationId &&
              item.environment === form.value.environment
          )
          .map((item) => ({ label: `${item.name}（${item.code}）`, value: item.id }))
      },
      description: '不选择时，监测该应用与环境的全部接口。'
    },
    { key: 'condition', label: '触发条件', type: 'divider', span: 24 },
    {
      key: 'metric',
      label: '检测指标',
      type: 'select',
      span: 12,
      props: { options: options.value?.metrics ?? [] }
    },
    {
      key: 'windowMinutes',
      label: '时间窗口',
      type: 'select',
      span: 12,
      props: {
        options: [
          { label: '5 分钟', value: 5 },
          { label: '15 分钟', value: 15 },
          { label: '60 分钟', value: 60 }
        ]
      }
    },
    {
      key: 'threshold',
      label: form.value.metric === 'failure_rate' ? '阈值（%）' : '阈值（次）',
      type: 'number',
      span: 8,
      props: {
        min: form.value.metric === 'failure_rate' ? 0.1 : 1,
        max: form.value.metric === 'failure_rate' ? 100 : 1000000,
        precision: form.value.metric === 'failure_rate' ? 2 : 0,
        controlsPosition: 'right'
      }
    },
    {
      key: 'minCalls',
      label: '最少调用数',
      type: 'number',
      span: 8,
      hidden: form.value.metric === 'unknown_count',
      props: { min: 1, max: 1000000, precision: 0, controlsPosition: 'right' },
      description: '仅统计已确认的成功与失败调用；结果未知不计入。'
    },
    {
      key: 'quietMinutes',
      label: '静默时间（分）',
      type: 'number',
      span: 8,
      props: { min: 0, max: 1440, precision: 0, controlsPosition: 'right' },
      description: '同一规则重复触发的抑制时间。'
    },
    {
      key: 'severity',
      label: '告警级别',
      type: 'segment',
      span: 12,
      options: [
        { label: '警告', value: 'warning' },
        { label: '严重', value: 'critical' }
      ]
    },
    {
      key: 'enabled',
      label: '运行状态',
      type: 'segment',
      span: 12,
      options: [
        { label: '启用', value: true },
        { label: '停用', value: false }
      ]
    }
  ])
  watch(
    () => [form.value.applicationId, form.value.environment],
    () => {
      if (
        form.value.interfaceId &&
        !(options.value?.interfaces ?? []).some(
          (item) =>
            item.id === form.value.interfaceId &&
            item.applicationId === form.value.applicationId &&
            item.environment === form.value.environment
        )
      )
        form.value.interfaceId = null
    }
  )
  async function handleSubmit(): Promise<boolean> {
    if (saving.value || !options.value) return false
    saveError.value = ''
    try {
      if (!(await validateArtFormForSubmit(formRef.value))) return false
    } catch {
      saveError.value = '表单校验未完成，请检查内容后重试'
      return false
    }
    saving.value = true
    try {
      const payload: AlertRuleWriteInput = {
        ...form.value,
        name: form.value.name.trim(),
        interfaceId: form.value.interfaceId || null
      }
      if (rule.value)
        await updateAlertRule(rule.value.id, { ...payload, version: rule.value.version })
      else await createAlertRule(payload)
      emit('success')
      return true
    } catch (cause) {
      saveError.value = cause instanceof BffApiError ? cause.message : '规则保存失败，请稍后重试'
      return false
    } finally {
      saving.value = false
    }
  }
  async function handleOpen(current: AlertOptions, row?: AlertRule): Promise<void> {
    options.value = current
    rule.value = row
    saveError.value = ''
    form.value = row
      ? {
          applicationId: row.applicationId,
          environment: row.environment,
          interfaceId: row.interfaceId,
          name: row.name,
          metric: row.metric,
          windowMinutes: row.windowMinutes,
          threshold: row.threshold,
          minCalls: row.minCalls,
          severity: row.severity,
          enabled: row.enabled,
          quietMinutes: row.quietMinutes
        }
      : defaults(current)
    await nextTick()
    formRef.value?.clearValidate()
    await dialogRef.value?.handleOpen(row, {
      title: row ? '编辑告警规则' : '创建告警规则',
      size: 'lg',
      confirmText: row ? '保存规则' : '创建规则',
      contentMaxHeight: '72vh',
      onConfirm: handleSubmit
    })
  }
  defineExpose({ handleOpen })
</script>
