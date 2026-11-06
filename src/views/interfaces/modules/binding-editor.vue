<template>
  <section class="grid min-w-0 gap-3" :aria-label="label">
    <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <div class="min-w-0">
        <ArtSectionTitle :show-line="false">{{ label }}</ArtSectionTitle>
        <p class="mt-1 text-xs text-g-700">{{ description }}</p>
      </div>
      <ElButton type="primary" plain :disabled="modelValue.length >= maxRows" @click="addBinding">
        新增映射
      </ElButton>
    </div>
    <p v-if="!modelValue.length" class="text-sm text-g-700">暂无映射，按需添加。</p>
    <ArtSectionCard
      v-for="(binding, index) in modelValue"
      :key="index"
      :title="`映射 ${index + 1}`"
      preserve-content-structure
    >
      <template #actions>
        <ElButton link type="danger" @click="removeBinding(index)">移除</ElButton>
      </template>
      <ArtForm
        :model-value="binding"
        :items="bindingItems(binding, index)"
        :span="12"
        :gutter="12"
        label-position="top"
        class="p-3"
        @update:model-value="(value) => updateBinding(index, value)"
      />
    </ArtSectionCard>
  </section>
</template>

<script setup lang="ts">
  import type { FormItem } from '@/components/core/forms/art-form/index.vue'
  import ArtSectionTitle from '@/components/core/surfaces/art-section-title/index.vue'
  import ArtSectionCard from '@/components/core/surfaces/art-section-card/index.vue'
  import type { InterfaceBinding, InterfaceInputField } from '@bff/types/interface'

  const props = withDefaults(
    defineProps<{
      modelValue: InterfaceBinding[]
      label: string
      description: string
      targetLabel?: string
      inputs: InterfaceInputField[]
      steps: Array<{ key: string; name: string }>
      maxRows?: number
    }>(),
    { targetLabel: '目标字段', maxRows: 32 }
  )
  const emit = defineEmits<{ 'update:modelValue': [value: InterfaceBinding[]] }>()

  function bindingItems(binding: InterfaceBinding, index: number): FormItem[] {
    const label = `${props.label}第 ${index + 1} 项`
    return [
      {
        key: 'target',
        label: props.targetLabel,
        type: 'input',
        span: 12,
        props: {
          maxlength: 40,
          placeholder: '例如：orderId',
          'aria-label': `${label}${props.targetLabel}`
        }
      },
      {
        key: 'source',
        label: '来源',
        type: 'select',
        span: 12,
        props: {
          'aria-label': `${label}来源`,
          options: [
            { label: '接口输入', value: 'input' },
            { label: '前序步骤', value: 'step', disabled: !props.steps.length },
            { label: '固定值', value: 'literal' }
          ]
        }
      },
      {
        key: 'inputKey',
        label: '输入字段',
        type: 'select',
        span: 24,
        hidden: () => binding.source !== 'input',
        props: {
          filterable: true,
          placeholder: '选择已定义的输入字段',
          'aria-label': `${label}输入字段`,
          options: props.inputs
            .filter((item) => item.key)
            .map((item) => ({
              label: `${item.label || item.key}（${item.key}）`,
              value: item.key
            }))
        }
      },
      {
        key: 'stepKey',
        label: '前序步骤',
        type: 'select',
        span: 12,
        hidden: () => binding.source !== 'step',
        props: {
          placeholder: '选择前序步骤',
          'aria-label': `${label}前序步骤`,
          options: props.steps
            .filter((item) => item.key)
            .map((item) => ({
              label: `${item.name || item.key}（${item.key}）`,
              value: item.key
            }))
        }
      },
      {
        key: 'pointer',
        label: 'JSON Pointer',
        type: 'input',
        span: 12,
        hidden: () => binding.source !== 'step',
        props: { maxlength: 256, placeholder: '/data/id', 'aria-label': `${label} JSON Pointer` },
        description: '空值表示读取根标量；一般使用 /data/id 等字段路径。'
      },
      {
        key: 'literalType',
        label: '固定值类型',
        type: 'select',
        span: 12,
        hidden: () => binding.source !== 'literal',
        props: {
          'aria-label': `${label}固定值类型`,
          options: [
            { label: '文本', value: 'string' },
            { label: '数字', value: 'number' },
            { label: '布尔值', value: 'boolean' }
          ]
        }
      },
      {
        key: 'literalValue',
        label: '固定值',
        type: binding.literalType === 'boolean' ? 'select' : 'input',
        span: 12,
        hidden: () => binding.source !== 'literal',
        props:
          binding.literalType === 'boolean'
            ? {
                'aria-label': `${label}固定值`,
                options: [
                  { label: '是（true）', value: 'true' },
                  { label: '否（false）', value: 'false' }
                ]
              }
            : {
                maxlength: 1024,
                placeholder: binding.literalType === 'number' ? '例如：100' : '填写固定文本',
                'aria-label': `${label}固定值`
              }
      }
    ]
  }
  function updateBinding(index: number, value: Record<string, unknown>): void {
    const current = props.modelValue[index]
    if (!current) return
    const source = value.source
    const literalType = value.literalType
    if (
      typeof value.target !== 'string' ||
      (source !== 'input' && source !== 'step' && source !== 'literal') ||
      typeof value.inputKey !== 'string' ||
      typeof value.stepKey !== 'string' ||
      typeof value.pointer !== 'string' ||
      (literalType !== 'string' && literalType !== 'number' && literalType !== 'boolean') ||
      typeof value.literalValue !== 'string'
    )
      return
    const changedSource = current.source !== source
    const changedLiteralType = current.literalType !== literalType
    const next: InterfaceBinding = {
      target: value.target,
      source,
      inputKey: changedSource
        ? source === 'input'
          ? props.inputs[0]?.key || ''
          : ''
        : value.inputKey,
      stepKey: changedSource ? (source === 'step' ? props.steps[0]?.key || '' : '') : value.stepKey,
      pointer: changedSource ? '' : value.pointer,
      literalType,
      literalValue:
        changedSource || changedLiteralType
          ? literalType === 'boolean'
            ? 'true'
            : ''
          : value.literalValue
    }
    emit(
      'update:modelValue',
      props.modelValue.map((item, position) => (position === index ? next : item))
    )
  }
  function addBinding(): void {
    if (props.modelValue.length >= props.maxRows) return
    emit('update:modelValue', [
      ...props.modelValue,
      {
        target: '',
        source: 'input',
        inputKey: props.inputs[0]?.key || '',
        stepKey: '',
        pointer: '',
        literalType: 'string',
        literalValue: ''
      }
    ])
  }
  function removeBinding(index: number): void {
    emit(
      'update:modelValue',
      props.modelValue.filter((_, position) => position !== index)
    )
  }
</script>
