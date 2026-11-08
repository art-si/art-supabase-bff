<template>
  <ArtDialog
    ref="dialogRef"
    :loading="saving"
    :confirm-disabled="optionsPending || Boolean(optionsLoadError)"
    @closed="resetAfterClose"
  >
    <div class="grid min-w-0 gap-4">
      <ArtEntitySummary
        compact
        icon="ri:flow-chart"
        :title="record?.name || '新增接口草稿'"
        :description="
          record
            ? `${record.application.name} · ${record.code}`
            : '定义输入、上游调用顺序与可公开的输出字段。'
        "
      />
      <ElAlert
        v-if="optionsPending"
        title="正在加载应用与上游选项，当前草稿可先查看。"
        type="info"
        :closable="false"
        show-icon
      />
      <ElAlert
        v-else-if="optionsLoadError"
        :title="optionsLoadError"
        description="请关闭弹窗后重试，选项就绪前不会提交草稿。"
        type="warning"
        :closable="false"
        show-icon
      />
      <ElAlert
        title="草稿不会对外提供访问入口；请先验证定义，再在受控环境中测试。测试会真实请求上游服务。"
        type="info"
        :closable="false"
        show-icon
      />
      <ElTabs v-model="activeTab" class="min-w-0">
        <ElTabPane label="基础定义" name="basic">
          <ArtForm
            ref="basicFormRef"
            v-model="form"
            :items="basicItems"
            :rules="basicRules"
            :span="12"
            :gutter="18"
            label-width="100px"
          />
        </ElTabPane>
        <ElTabPane :label="`输入字段（${form.definition.inputs.length}）`" name="inputs">
          <div class="grid gap-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-sm text-g-700"
                >声明调用方需要填写的字段，路径字段应对应接口地址中的变量。</p
              >
              <ElButton
                type="primary"
                plain
                :disabled="form.definition.inputs.length >= 32"
                @click="addInput"
                ><ArtSvgIcon icon="ri:add-line" />新增输入</ElButton
              >
            </div>
            <p v-if="!form.definition.inputs.length" class="text-sm text-g-700"
              >尚未定义输入字段。</p
            >
            <ArtSectionCard
              v-for="(_, index) in form.definition.inputs"
              :key="index"
              :title="`输入 ${index + 1}`"
              preserve-content-structure
            >
              <template #actions>
                <ElButton link type="danger" @click="removeInput(index)"
                  ><ArtSvgIcon icon="ri:delete-bin-line" />移除</ElButton
                >
              </template>
              <ArtForm
                v-model="form.definition.inputs[index]"
                :items="inputItems(index)"
                :span="12"
                :gutter="12"
                label-position="top"
                root-class="p-0!"
              />
            </ArtSectionCard>
          </div>
        </ElTabPane>
        <ElTabPane :label="`编排步骤（${form.definition.steps.length}）`" name="steps">
          <div class="grid gap-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-sm text-g-700"
                >按顺序调用同一应用、同一环境的上游；后续步骤可读取前序步骤结果。</p
              >
              <ElButton
                type="primary"
                plain
                :disabled="form.definition.steps.length >= 8"
                @click="addStep"
              >
                <ArtSvgIcon icon="ri:add-line" />新增步骤
              </ElButton>
            </div>
            <ElAlert
              v-if="!availableUpstreams.length"
              title="当前应用与环境尚无上游服务。请先登记该环境的上游，再保存编排草稿。"
              type="warning"
              :closable="false"
              show-icon
            />
            <ArtSectionCard
              v-for="(step, index) in form.definition.steps"
              :key="index"
              :data-testid="`interface-step-${index + 1}`"
              :title="`${index + 1}. ${step.name || step.key || '未命名步骤'}`"
              preserve-content-structure
            >
              <template #actions>
                <div class="flex items-center gap-1">
                  <ElButton link :disabled="index === 0" @click="moveStep(index, -1)"
                    ><ArtSvgIcon icon="ri:arrow-up-line" />上移</ElButton
                  >
                  <ElButton
                    link
                    :disabled="index === form.definition.steps.length - 1"
                    @click="moveStep(index, 1)"
                    ><ArtSvgIcon icon="ri:arrow-down-line" />下移</ElButton
                  >
                  <ElButton
                    link
                    type="danger"
                    :disabled="form.definition.steps.length <= 1"
                    @click="removeStep(index)"
                    ><ArtSvgIcon icon="ri:delete-bin-line" />移除</ElButton
                  >
                </div>
              </template>
              <div class="grid min-w-0 gap-4">
                <ArtForm
                  v-model="form.definition.steps[index]"
                  :items="stepItems(index)"
                  :span="12"
                  :gutter="12"
                  label-position="top"
                  root-class="p-0!"
                />
                <p class="text-xs text-g-700">
                  当前草稿绑定配置 v{{
                    step.configVersion || '—'
                  }}；草稿或停用服务可用于设计，执行测试须先启用。
                  <ElButton
                    v-if="
                      latestConfigVersion(step.upstreamId) &&
                      latestConfigVersion(step.upstreamId) !== step.configVersion
                    "
                    link
                    type="primary"
                    @click="step.configVersion = latestConfigVersion(step.upstreamId)"
                    ><ArtSvgIcon icon="ri:refresh-line" />使用最新配置</ElButton
                  >
                </p>
                <BindingEditor
                  :model-value="step.pathParams"
                  label="路径参数"
                  description="模板中的 {变量} 必须各有一条同名目标映射。"
                  target-label="变量名"
                  :inputs="form.definition.inputs"
                  :steps="form.definition.steps.slice(0, index)"
                  @update:model-value="(value) => (step.pathParams = value)"
                />
                <BindingEditor
                  :model-value="step.query"
                  label="查询参数"
                  description="仅映射需要追加到上游请求 URL 的字段。"
                  :inputs="form.definition.inputs"
                  :steps="form.definition.steps.slice(0, index)"
                  @update:model-value="(value) => (step.query = value)"
                />
                <BindingEditor
                  v-if="step.method !== 'GET'"
                  :model-value="step.body"
                  label="请求体字段"
                  description="按目标键生成扁平请求体；GET 不发送请求体。"
                  :inputs="form.definition.inputs"
                  :steps="form.definition.steps.slice(0, index)"
                  @update:model-value="(value) => (step.body = value)"
                />
                <ArtSectionCard
                  title="响应解析"
                  subtitle="只读取声明的 JSON Pointer；业务码不匹配视为上游失败。"
                  preserve-content-structure
                >
                  <ArtForm
                    v-model="contractDrafts[index]"
                    :items="responseItems(index)"
                    :span="12"
                    :gutter="12"
                    label-position="top"
                    root-class="p-0!"
                  />
                </ArtSectionCard>
                <ArtSectionCard
                  v-if="step.method === 'GET'"
                  title="上游分页"
                  subtitle="分页参数由已声明的数字输入控制，不能覆盖显式查询映射。"
                  preserve-content-structure
                >
                  <ArtForm
                    v-model="contractDrafts[index]"
                    :items="paginationItems(index)"
                    :span="12"
                    :gutter="12"
                    label-position="top"
                    root-class="p-0!"
                  />
                </ArtSectionCard>
              </div>
            </ArtSectionCard>
          </div>
        </ElTabPane>
        <ElTabPane :label="`输出映射（${form.definition.outputs.length}）`" name="outputs">
          <div class="grid min-w-0 gap-4">
            <ArtForm
              v-model="outputModeForm"
              :items="outputModeItems"
              :span="24"
              label-position="top"
              root-class="p-0!"
            />
            <BindingEditor
              v-if="outputModeForm.mode === 'scalar'"
              :model-value="form.definition.outputs"
              label="对调用方公开的输出"
              description="仅输出明确映射的扁平字段，不暴露上游原始响应、请求头或凭据。"
              :inputs="form.definition.inputs"
              :steps="form.definition.steps"
              @update:model-value="(value) => (form.definition.outputs = value)"
            />
            <ArtSectionCard
              v-else
              title="分页结果"
              subtitle="结果仅包含 records、total、current、size，记录字段必须逐项声明。"
              preserve-content-structure
            >
              <div class="grid min-w-0 gap-4">
                <ArtForm
                  v-model="pageDraft"
                  :items="pageItems"
                  :span="12"
                  :gutter="12"
                  label-position="top"
                  root-class="p-0!"
                />
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <p class="text-sm text-g-700">记录白名单字段（最多 32 项）</p>
                  <ElButton
                    type="primary"
                    plain
                    :disabled="pageDraft.fields.length >= 32"
                    @click="addPageField"
                    ><ArtSvgIcon icon="ri:add-line" />新增字段</ElButton
                  >
                </div>
                <ArtSectionCard
                  v-for="(_, index) in pageDraft.fields"
                  :key="index"
                  :title="`记录字段 ${index + 1}`"
                  preserve-content-structure
                >
                  <template #actions>
                    <ElButton link type="danger" @click="removePageField(index)"
                      ><ArtSvgIcon icon="ri:delete-bin-line" />移除</ElButton
                    >
                  </template>
                  <ArtForm
                    v-model="pageDraft.fields[index]"
                    :items="pageFieldItems(index)"
                    :span="12"
                    :gutter="12"
                    label-position="top"
                    root-class="p-0!"
                  />
                </ArtSectionCard>
              </div>
            </ArtSectionCard>
          </div>
        </ElTabPane>
      </ElTabs>
      <ElAlert v-if="saveError" :title="saveError" type="error" :closable="false" show-icon />
    </div>
  </ArtDialog>
</template>

<script setup lang="ts">
  import { useDictionaryOptions } from '@/hooks/core/useDictionaryOptions'
  import { BFF_DICTIONARIES } from '@bff/config/dictionaries'
  const environmentOptions = useDictionaryOptions(BFF_DICTIONARIES.common.environment)
  const methodOptions = useDictionaryOptions(BFF_DICTIONARIES.interfaces.method)
  const inputLocationOptions = useDictionaryOptions(BFF_DICTIONARIES.interfaces.inputLocation)
  const valueTypeOptions = useDictionaryOptions(BFF_DICTIONARIES.interfaces.valueType)
  const upstreamStatusOptions = useDictionaryOptions(BFF_DICTIONARIES.upstreams.status)
  const responseModeOptions = useDictionaryOptions('bffResponseContractMode')
  const paginationModeOptions = useDictionaryOptions('bffPaginationMode')
  const totalSourceOptions = useDictionaryOptions('bffPageTotalSource')
  import type { FormRules } from 'element-plus'
  import { validateArtFormForSubmit } from '@/utils/form/validate-art-form'
  import type ArtForm from '@/components/core/forms/art-form/index.vue'
  import type { FormItem } from '@/components/core/forms/art-form/index.vue'
  import type { ArtDialogExpose } from '@/components/core/dialogs/art-dialog/types'
  import ArtSectionCard from '@/components/core/surfaces/art-section-card/index.vue'
  import { cloneDeep, omit } from 'lodash-es'
  import { BffApiError } from '@bff/api/bff'
  import { createInterface, updateInterface } from '@bff/api/interfaces'
  import type {
    InterfaceBinding,
    InterfaceOptions,
    InterfacePageDefinition,
    InterfaceRecord,
    InterfaceStep,
    InterfaceWriteInput
  } from '@bff/types/interface'
  import BindingEditor from './binding-editor.vue'

  const emit = defineEmits<{ success: [] }>()
  const dialogRef = ref<ArtDialogExpose<InterfaceRecord | undefined>>()
  const basicFormRef = ref<InstanceType<typeof ArtForm>>()
  const record = shallowRef<InterfaceRecord>()
  const options = shallowRef<InterfaceOptions>()
  const activeTab = ref('basic')
  const saving = ref(false)
  const optionsPending = ref(false)
  const optionsLoadError = ref('')
  const saveError = ref('')
  const keyPattern = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
  interface ContractDraft {
    responseEnabled: boolean
    responseMode: 'http' | 'business'
    codePointer: string
    dataPointer: string
    successCodesText: string
    paginationEnabled: boolean
    paginationMode: 'page' | 'offset'
    currentInputKey: string
    sizeInputKey: string
    pageParameter: string
    sizeParameter: string
    exactCount: boolean
  }
  const contractDrafts = ref<ContractDraft[]>([])
  const outputModeForm = ref<{ mode: 'scalar' | 'page' }>({ mode: 'scalar' })
  const emptyPage = (): InterfacePageDefinition => ({
    stepKey: '',
    recordsPointer: '',
    totalSource: 'body',
    totalPointer: '',
    currentInputKey: '',
    sizeInputKey: '',
    fields: []
  })
  const pageDraft = ref<InterfacePageDefinition>(emptyPage())

  function contractDraft(step: InterfaceStep): ContractDraft {
    return {
      responseEnabled: Boolean(step.responseContract),
      responseMode: step.responseContract?.mode ?? 'http',
      codePointer: step.responseContract?.codePointer ?? '/code',
      dataPointer: step.responseContract?.dataPointer ?? '/data',
      successCodesText: JSON.stringify(step.responseContract?.successCodes ?? [0]),
      paginationEnabled: Boolean(step.pagination),
      paginationMode: step.pagination?.mode ?? 'page',
      currentInputKey: step.pagination?.currentInputKey ?? '',
      sizeInputKey: step.pagination?.sizeInputKey ?? '',
      pageParameter: step.pagination?.pageParameter ?? 'page',
      sizeParameter: step.pagination?.sizeParameter ?? 'size',
      exactCount: step.pagination?.exactCount ?? false
    }
  }

  function newBinding(
    target: string,
    source: InterfaceBinding['source'],
    key: string
  ): InterfaceBinding {
    return {
      target,
      source,
      inputKey: source === 'input' ? key : '',
      stepKey: source === 'step' ? key : '',
      pointer: source === 'step' ? '/status' : '',
      literalType: 'string',
      literalValue: ''
    }
  }
  function initialForm(
    applicationId = '',
    environment: InterfaceWriteInput['environment'] = 'development'
  ): InterfaceWriteInput {
    return {
      applicationId,
      environment,
      code: '',
      name: '',
      description: '',
      method: 'GET',
      path: '/orders/{orderId}',
      definition: {
        inputs: [
          { key: 'orderId', label: '订单编号', location: 'path', type: 'string', required: true }
        ],
        steps: [
          {
            key: 'fetchOrder',
            name: '查询订单',
            upstreamId: '',
            configVersion: 0,
            method: 'GET',
            path: '/orders/{orderId}',
            pathParams: [newBinding('orderId', 'input', 'orderId')],
            query: [],
            body: []
          }
        ],
        outputs: [newBinding('status', 'step', 'fetchOrder')]
      }
    }
  }
  const form = ref<InterfaceWriteInput>(initialForm())

  const availableUpstreams = computed(() =>
    (options.value?.upstreams ?? []).filter(
      (item) =>
        item.applicationId === form.value.applicationId &&
        item.environment === form.value.environment
    )
  )
  function latestConfigVersion(upstreamId: string): number {
    return availableUpstreams.value.find((item) => item.id === upstreamId)?.configVersion ?? 0
  }
  function resetUpstreamSelection(): void {
    for (const step of form.value.definition.steps) {
      step.upstreamId = ''
      step.configVersion = 0
    }
  }

  const basicRules: FormRules = {
    applicationId: [{ required: true, message: '请选择所属应用', trigger: 'change' }],
    code: [
      { required: true, message: '请输入接口编码', trigger: 'blur' },
      {
        pattern: /^[a-z][a-z0-9-]{1,63}$/,
        message: '使用 2–64 位小写字母、数字或连字符，以字母开头',
        trigger: 'blur'
      }
    ],
    name: [
      { required: true, message: '请输入接口名称', trigger: 'blur' },
      { max: 100, message: '名称不能超过 100 字', trigger: 'blur' }
    ],
    path: [
      { required: true, message: '请输入接口地址', trigger: 'blur' },
      {
        validator: (_rule, value: string, callback) =>
          callback(
            /^\/(?!\/)(?!.*(?:\.\.|%|\?|#|\\)).{0,499}$/.test(value)
              ? undefined
              : new Error('请输入以 / 开头、无查询串的接口路径')
          ),
        trigger: 'blur'
      }
    ]
  }
  const basicItems = computed<FormItem[]>(() => [
    {
      key: 'applicationId',
      label: '所属应用',
      type: 'select',
      span: 12,
      props: {
        disabled: Boolean(record.value),
        filterable: true,
        placeholder: '选择应用',
        options: (options.value?.applications ?? []).map((item) => ({
          label: `${item.name}（${item.code}）`,
          value: item.id,
          disabled: !item.enabled && item.id !== record.value?.applicationId
        })),
        onChange: resetUpstreamSelection
      }
    },
    {
      key: 'environment',
      label: '运行环境',
      type: 'select',
      span: 12,
      props: {
        disabled: Boolean(record.value),
        options: environmentOptions,
        onChange: resetUpstreamSelection
      }
    },
    {
      key: 'code',
      label: '接口编码',
      type: 'input',
      span: 12,
      props: { disabled: Boolean(record.value), maxlength: 64, placeholder: '例如：order-detail' }
    },
    {
      key: 'name',
      label: '接口名称',
      type: 'input',
      span: 12,
      props: { maxlength: 100, placeholder: '例如：订单详情查询' }
    },
    {
      key: 'method',
      label: '对外方法',
      type: 'select',
      span: 12,
      props: { options: methodOptions }
    },
    {
      key: 'path',
      label: '对外路径',
      type: 'input',
      span: 12,
      props: { maxlength: 500, placeholder: '/orders/{orderId}' },
      description: '路径模板用于标识接口，草稿不提供对外访问入口。'
    },
    {
      key: 'description',
      label: '接口说明',
      type: 'input',
      span: 24,
      props: {
        type: 'textarea',
        rows: 3,
        maxlength: 1000,
        showWordLimit: true,
        placeholder: '说明接口用途、输入和输出边界'
      }
    }
  ])

  function inputItems(index: number): FormItem[] {
    const label = `输入 ${index + 1}`
    return [
      {
        key: 'key',
        label: '字段键',
        type: 'input',
        span: 12,
        props: { maxlength: 40, placeholder: 'orderId', 'aria-label': `${label} 字段键` }
      },
      {
        key: 'label',
        label: '显示名称',
        type: 'input',
        span: 12,
        props: { maxlength: 50, placeholder: '订单编号', 'aria-label': `${label} 显示名称` }
      },
      {
        key: 'location',
        label: '位置',
        type: 'select',
        span: 12,
        props: {
          'aria-label': `${label} 位置`,
          options: inputLocationOptions
        }
      },
      {
        key: 'type',
        label: '类型',
        type: 'select',
        span: 12,
        props: {
          'aria-label': `${label} 类型`,
          options: valueTypeOptions
        }
      },
      {
        key: 'required',
        label: '必填字段',
        type: 'switch',
        span: 24,
        props: { 'aria-label': `${label} 是否必填` }
      }
    ]
  }

  function stepItems(index: number): FormItem[] {
    const label = `步骤 ${index + 1}`
    return [
      {
        key: 'key',
        label: '步骤键',
        type: 'input',
        span: 12,
        props: { maxlength: 40, placeholder: 'fetchOrder', 'aria-label': `${label} 键` }
      },
      {
        key: 'name',
        label: '步骤名称',
        type: 'input',
        span: 12,
        props: { maxlength: 80, placeholder: '查询订单', 'aria-label': `${label} 名称` }
      },
      {
        key: 'upstreamId',
        label: '上游服务',
        type: 'select',
        span: 24,
        props: {
          filterable: true,
          placeholder: '选择同应用、同环境的上游',
          'aria-label': `${label} 上游服务`,
          options: availableUpstreams.value.map((item) => ({
            label: `${item.name}（${item.code} · 配置 v${item.configVersion} · ${upstreamStatusOptions.find((option) => option.value === item.status)?.label ?? '状态待核对'}）`,
            value: item.id
          })),
          onChange: (value: unknown) => selectUpstream(index, value)
        }
      },
      {
        key: 'method',
        label: '请求方法',
        type: 'select',
        span: 12,
        props: {
          'aria-label': `${label} 请求方法`,
          options: methodOptions,
          onChange: () => handleStepMethod(index)
        }
      },
      {
        key: 'path',
        label: '相对路径',
        type: 'input',
        span: 12,
        props: {
          maxlength: 500,
          placeholder: '/orders/{orderId}',
          'aria-label': `${label} 相对路径`
        }
      }
    ]
  }

  const numberInputOptions = computed(() =>
    form.value.definition.inputs
      .filter((field) => field.location === 'query' && field.type === 'number' && field.required)
      .map((field) => ({ label: `${field.label || field.key}（${field.key}）`, value: field.key }))
  )
  const outputModeItems: FormItem[] = [
    {
      key: 'mode',
      label: '对外输出形式',
      type: 'segment',
      span: 24,
      options: [
        { label: '普通字段', value: 'scalar' },
        { label: '分页记录', value: 'page' }
      ],
      description: '分页模式仅返回明确列出的记录字段，不会透传上游响应。'
    }
  ]
  function responseItems(index: number): FormItem[] {
    const draft = contractDrafts.value[index]
    return [
      {
        key: 'responseEnabled',
        label: '解析统一响应',
        type: 'switch',
        span: 24,
        props: { 'aria-label': `步骤 ${index + 1} 解析统一响应` },
        description: '关闭时保留原始成功响应的既有解析行为；旧版本快照不受影响。'
      },
      {
        key: 'responseMode',
        label: '成功判定',
        type: 'select',
        span: 12,
        hidden: () => !draft?.responseEnabled,
        props: { options: responseModeOptions, 'aria-label': `步骤 ${index + 1} 成功判定` }
      },
      {
        key: 'dataPointer',
        label: '数据 JSON Pointer',
        type: 'input',
        span: 12,
        hidden: () => !draft?.responseEnabled,
        props: { maxlength: 256, placeholder: '/data', 'aria-label': `步骤 ${index + 1} 数据指针` },
        description: '留空表示响应根节点；只接受 JSON Pointer，不执行表达式。'
      },
      {
        key: 'codePointer',
        label: '业务码 JSON Pointer',
        type: 'input',
        span: 12,
        hidden: () => !draft?.responseEnabled || draft.responseMode !== 'business',
        props: {
          maxlength: 256,
          placeholder: '/code',
          'aria-label': `步骤 ${index + 1} 业务码指针`
        }
      },
      {
        key: 'successCodesText',
        label: '成功业务码',
        type: 'input',
        span: 12,
        hidden: () => !draft?.responseEnabled || draft.responseMode !== 'business',
        props: {
          maxlength: 512,
          placeholder: '["0", 200]',
          'aria-label': `步骤 ${index + 1} 成功业务码`
        },
        description: 'JSON 数组；字符串与数字严格区分，如 ["0", 200]。'
      }
    ]
  }
  function paginationItems(index: number): FormItem[] {
    const draft = contractDrafts.value[index]
    return [
      {
        key: 'paginationEnabled',
        label: '启用受控分页',
        type: 'switch',
        span: 24,
        props: { 'aria-label': `步骤 ${index + 1} 启用受控分页` },
        description: '仅用于 GET；页码和每页条数取自调用方声明的必填数字输入。'
      },
      {
        key: 'paginationMode',
        label: '分页方式',
        type: 'select',
        span: 12,
        hidden: () => !draft?.paginationEnabled,
        props: { options: paginationModeOptions, 'aria-label': `步骤 ${index + 1} 分页方式` }
      },
      {
        key: 'currentInputKey',
        label: '页码输入',
        type: 'select',
        span: 12,
        hidden: () => !draft?.paginationEnabled,
        props: { options: numberInputOptions.value, 'aria-label': `步骤 ${index + 1} 页码输入` }
      },
      {
        key: 'sizeInputKey',
        label: '条数输入',
        type: 'select',
        span: 12,
        hidden: () => !draft?.paginationEnabled,
        props: { options: numberInputOptions.value, 'aria-label': `步骤 ${index + 1} 条数输入` }
      },
      {
        key: 'pageParameter',
        label: '上游页码参数',
        type: 'input',
        span: 12,
        hidden: () => !draft?.paginationEnabled,
        props: {
          maxlength: 40,
          placeholder: 'page',
          'aria-label': `步骤 ${index + 1} 上游页码参数`
        },
        description:
          draft?.paginationMode === 'offset' ? '该参数将收到 (current - 1) × size。' : undefined
      },
      {
        key: 'sizeParameter',
        label: '上游条数参数',
        type: 'input',
        span: 12,
        hidden: () => !draft?.paginationEnabled,
        props: {
          maxlength: 40,
          placeholder: 'size',
          'aria-label': `步骤 ${index + 1} 上游条数参数`
        }
      },
      {
        key: 'exactCount',
        label: '请求精确总数',
        type: 'switch',
        span: 24,
        hidden: () => !draft?.paginationEnabled,
        description: '只发送受控的 Prefer: count=exact；其他响应头不进入输出。'
      }
    ]
  }
  const pageItems = computed<FormItem[]>(() => [
    {
      key: 'stepKey',
      label: '记录来源步骤',
      type: 'select',
      span: 12,
      props: {
        options: form.value.definition.steps.map((step) => ({
          label: step.name || step.key,
          value: step.key
        }))
      }
    },
    {
      key: 'recordsPointer',
      label: '记录数组 JSON Pointer',
      type: 'input',
      span: 12,
      props: { maxlength: 256, placeholder: '/records' },
      description: '相对于已解析的数据节点；留空表示根数组（如 Supabase）。'
    },
    {
      key: 'totalSource',
      label: '总数来源',
      type: 'select',
      span: 12,
      props: { options: totalSourceOptions }
    },
    {
      key: 'totalPointer',
      label: '总数 JSON Pointer',
      type: 'input',
      span: 12,
      hidden: () => pageDraft.value.totalSource !== 'body',
      props: { maxlength: 256, placeholder: '/total' },
      description: '相对于已解析的数据节点；Content-Range 模式无需填写。'
    },
    {
      key: 'currentInputKey',
      label: '当前页输入',
      type: 'select',
      span: 12,
      props: { options: numberInputOptions.value, 'aria-label': '当前页输入' }
    },
    {
      key: 'sizeInputKey',
      label: '每页条数输入',
      type: 'select',
      span: 12,
      props: { options: numberInputOptions.value, 'aria-label': '每页条数输入' }
    }
  ])
  function pageFieldItems(index: number): FormItem[] {
    return [
      {
        key: 'target',
        label: '输出键',
        type: 'input',
        span: 12,
        props: {
          maxlength: 40,
          placeholder: 'orderId',
          'aria-label': `记录字段 ${index + 1} 输出键`
        }
      },
      {
        key: 'label',
        label: '显示名称',
        type: 'input',
        span: 12,
        props: {
          maxlength: 50,
          placeholder: '订单编号',
          'aria-label': `记录字段 ${index + 1} 显示名称`
        }
      },
      {
        key: 'pointer',
        label: '字段 JSON Pointer',
        type: 'input',
        span: 12,
        props: { maxlength: 256, placeholder: '/id', 'aria-label': `记录字段 ${index + 1} 指针` },
        description: '相对于单条记录；只公开列出的标量字段。'
      },
      {
        key: 'type',
        label: '字段类型',
        type: 'select',
        span: 12,
        props: { options: valueTypeOptions, 'aria-label': `记录字段 ${index + 1} 类型` }
      },
      {
        key: 'required',
        label: '必填字段',
        type: 'switch',
        span: 24
      }
    ]
  }
  function addPageField(): void {
    if (pageDraft.value.fields.length >= 32) return
    pageDraft.value.fields.push({
      target: '',
      label: '',
      pointer: '',
      type: 'string',
      required: false
    })
  }
  function removePageField(index: number): void {
    pageDraft.value.fields.splice(index, 1)
  }

  function addInput(): void {
    if (form.value.definition.inputs.length >= 32) return
    form.value.definition.inputs.push({
      key: '',
      label: '',
      location: 'query',
      type: 'string',
      required: false
    })
  }
  function removeInput(index: number): void {
    form.value.definition.inputs.splice(index, 1)
  }
  function addStep(): void {
    if (form.value.definition.steps.length >= 8) return
    const step: InterfaceStep = {
      key: '',
      name: '',
      upstreamId: '',
      configVersion: 0,
      method: 'GET',
      path: '/',
      pathParams: [],
      query: [],
      body: []
    }
    form.value.definition.steps.push(step)
    contractDrafts.value.push(contractDraft(step))
  }
  function removeStep(index: number): void {
    if (form.value.definition.steps.length > 1) {
      form.value.definition.steps.splice(index, 1)
      contractDrafts.value.splice(index, 1)
    }
  }
  function moveStep(index: number, direction: -1 | 1): void {
    const target = index + direction
    const steps = form.value.definition.steps
    if (target < 0 || target >= steps.length) return
    const current = steps[index]
    if (!current) return
    steps.splice(index, 1)
    steps.splice(target, 0, current)
    const draft = contractDrafts.value.splice(index, 1)[0]
    if (draft) contractDrafts.value.splice(target, 0, draft)
  }
  function selectUpstream(index: number, value: unknown): void {
    if (typeof value !== 'string') return
    const option = availableUpstreams.value.find((item) => item.id === value)
    const step = form.value.definition.steps[index]
    if (!step || !option) return
    step.upstreamId = option.id
    step.configVersion = option.configVersion
  }
  function handleStepMethod(index: number): void {
    const step = form.value.definition.steps[index]
    if (step?.method === 'GET') step.body = []
    else if (contractDrafts.value[index]) contractDrafts.value[index].paginationEnabled = false
  }

  function validateBindings(
    bindings: InterfaceBinding[],
    priorStepKeys: string[]
  ): string | undefined {
    if (bindings.length > 32) return '每组映射最多 32 项'
    const targets = new Set<string>()
    for (const binding of bindings) {
      if (!keyPattern.test(binding.target)) return '映射目标键需以字母开头，长度不超过 40 位'
      if (targets.has(binding.target)) return '同组映射的目标键不能重复'
      targets.add(binding.target)
      if (
        binding.source === 'input' &&
        !form.value.definition.inputs.some((field) => field.key === binding.inputKey)
      )
        return '映射引用的输入字段不存在'
      if (
        binding.source === 'step' &&
        (!priorStepKeys.includes(binding.stepKey) || binding.pointer.length > 256)
      )
        return '映射只能引用前序步骤，并使用不超过 256 位的 JSON Pointer'
      if (binding.source === 'literal' && binding.literalValue.length > 1024)
        return '固定值不能超过 1024 字符'
    }
    return undefined
  }
  function validPointer(value: string): boolean {
    return value.length <= 256 && /^(?:\/(?:[^~]|~[01])*)*$/.test(value)
  }
  function parseSuccessCodes(value: string): Array<string | number> | undefined {
    try {
      const parsed: unknown = JSON.parse(value)
      if (
        !Array.isArray(parsed) ||
        parsed.length < 1 ||
        parsed.length > 12 ||
        parsed.some(
          (item: unknown) =>
            !(
              (typeof item === 'string' && item.length > 0 && item.length <= 64) ||
              (typeof item === 'number' && Number.isFinite(item))
            )
        )
      )
        return undefined
      return parsed as Array<string | number>
    } catch {
      return undefined
    }
  }
  function validNumberInput(key: string): boolean {
    return form.value.definition.inputs.some(
      (field) =>
        field.key === key && field.location === 'query' && field.type === 'number' && field.required
    )
  }
  function validateDefinition(): { tab: string; message: string } | undefined {
    const definition = form.value.definition
    if (
      definition.inputs.length > 32 ||
      definition.inputs.some((field) => !keyPattern.test(field.key) || !field.label.trim())
    )
      return { tab: 'inputs', message: '输入字段键需以字母开头，名称不能为空，最多 32 项' }
    if (new Set(definition.inputs.map((field) => field.key)).size !== definition.inputs.length)
      return { tab: 'inputs', message: '输入字段键不能重复' }
    if (!definition.steps.length || definition.steps.length > 8)
      return { tab: 'steps', message: '请配置 1–8 个编排步骤' }
    const stepKeys: string[] = []
    for (const [index, step] of definition.steps.entries()) {
      if (!keyPattern.test(step.key) || !step.name.trim() || step.name.length > 80)
        return { tab: 'steps', message: `步骤 ${index + 1} 的键或名称无效` }
      if (stepKeys.includes(step.key)) return { tab: 'steps', message: '步骤键不能重复' }
      if (
        !availableUpstreams.value.some(
          (item) => item.id === step.upstreamId && item.configVersion >= step.configVersion
        ) ||
        step.configVersion < 1
      )
        return { tab: 'steps', message: `步骤 ${index + 1} 需要选择同应用、同环境的上游配置版本` }
      if (!step.path.startsWith('/') || step.path.length > 500 || /\.\.|[%?#\\]/.test(step.path))
        return { tab: 'steps', message: `步骤 ${index + 1} 的相对路径无效` }
      if (step.method === 'GET' && step.body.length)
        return { tab: 'steps', message: `步骤 ${index + 1} 的 GET 请求不能配置请求体` }
      const contract = contractDrafts.value[index]
      if (!contract) return { tab: 'steps', message: `步骤 ${index + 1} 的响应配置未就绪` }
      if (contract.responseEnabled) {
        if (!validPointer(contract.dataPointer))
          return { tab: 'steps', message: `步骤 ${index + 1} 的数据指针不是有效 JSON Pointer` }
        if (
          contract.responseMode === 'business' &&
          (!validPointer(contract.codePointer) ||
            !contract.codePointer ||
            !parseSuccessCodes(contract.successCodesText))
        )
          return { tab: 'steps', message: `步骤 ${index + 1} 的业务码指针或成功码数组无效` }
      }
      if (contract.paginationEnabled) {
        if (step.method !== 'GET')
          return { tab: 'steps', message: `步骤 ${index + 1} 只有 GET 能配置分页` }
        if (
          !validNumberInput(contract.currentInputKey) ||
          !validNumberInput(contract.sizeInputKey) ||
          contract.currentInputKey === contract.sizeInputKey
        )
          return { tab: 'steps', message: `步骤 ${index + 1} 需要两个不同的必填数字查询输入` }
        if (
          !keyPattern.test(contract.pageParameter) ||
          !keyPattern.test(contract.sizeParameter) ||
          contract.pageParameter === contract.sizeParameter ||
          step.query.some(
            (binding) =>
              binding.target === contract.pageParameter || binding.target === contract.sizeParameter
          )
        )
          return { tab: 'steps', message: `步骤 ${index + 1} 的分页参数无效或与查询映射冲突` }
      }
      for (const [group, bindings] of [
        ['路径参数', step.pathParams],
        ['查询参数', step.query],
        ['请求体', step.body]
      ] as const) {
        const failure = validateBindings(bindings, stepKeys)
        if (failure) return { tab: 'steps', message: `步骤 ${index + 1} ${group}：${failure}` }
      }
      const placeholders = [...step.path.matchAll(/\{([A-Za-z][A-Za-z0-9_]{0,39})\}/g)].map(
        (match) => match[1]
      )
      if (placeholders.some((key) => !step.pathParams.some((binding) => binding.target === key)))
        return { tab: 'steps', message: `步骤 ${index + 1} 的路径变量尚未全部绑定` }
      stepKeys.push(step.key)
    }
    if (outputModeForm.value.mode === 'page') {
      const page = pageDraft.value
      const sourceIndex = definition.steps.findIndex((step) => step.key === page.stepKey)
      const source = contractDrafts.value[sourceIndex]
      if (sourceIndex < 0 || !source?.paginationEnabled)
        return { tab: 'outputs', message: '分页输出需选择已配置受控分页的步骤' }
      if (
        !validPointer(page.recordsPointer) ||
        (page.totalSource === 'body' && (!page.totalPointer || !validPointer(page.totalPointer)))
      )
        return { tab: 'outputs', message: '记录数组或总数指针无效' }
      if (
        page.currentInputKey !== source.currentInputKey ||
        page.sizeInputKey !== source.sizeInputKey ||
        (page.totalSource === 'content-range' && !source.exactCount)
      )
        return { tab: 'outputs', message: '分页输出输入须与来源步骤一致；响应头总数需启用精确计数' }
      if (!page.fields.length || page.fields.length > 32)
        return { tab: 'outputs', message: '请配置 1–32 个记录白名单字段' }
      const targets = new Set<string>()
      for (const field of page.fields) {
        if (
          !keyPattern.test(field.target) ||
          targets.has(field.target) ||
          !field.label.trim() ||
          !field.pointer ||
          !validPointer(field.pointer)
        )
          return { tab: 'outputs', message: '记录字段键、名称或 JSON Pointer 无效或重复' }
        targets.add(field.target)
      }
    } else {
      if (!definition.outputs.length || definition.outputs.length > 32)
        return { tab: 'outputs', message: '请配置 1–32 个公开输出字段' }
      const outputFailure = validateBindings(definition.outputs, stepKeys)
      if (outputFailure) return { tab: 'outputs', message: `输出映射：${outputFailure}` }
    }
    return undefined
  }

  async function handleSubmit(): Promise<boolean> {
    if (saving.value || optionsPending.value || optionsLoadError.value) return false
    try {
      if (!(await validateArtFormForSubmit(basicFormRef.value))) {
        activeTab.value = 'basic'
        return false
      }
    } catch {
      activeTab.value = 'basic'
      saveError.value = '基础定义校验未完成，请检查填写内容'
      return false
    }
    const problem = validateDefinition()
    if (problem) {
      activeTab.value = problem.tab
      saveError.value = problem.message
      return false
    }
    saving.value = true
    saveError.value = ''
    try {
      const definition = cloneDeep(form.value.definition)
      definition.steps = definition.steps.map((step, index) => {
        const draft = contractDrafts.value[index]!
        return {
          ...omit(step, ['responseContract', 'pagination']),
          ...(draft.responseEnabled
            ? {
                responseContract: {
                  mode: draft.responseMode,
                  codePointer: draft.responseMode === 'business' ? draft.codePointer : '',
                  dataPointer: draft.dataPointer,
                  successCodes:
                    draft.responseMode === 'business'
                      ? (parseSuccessCodes(draft.successCodesText) ?? [])
                      : []
                }
              }
            : {}),
          ...(draft.paginationEnabled
            ? {
                pagination: {
                  mode: draft.paginationMode,
                  currentInputKey: draft.currentInputKey,
                  sizeInputKey: draft.sizeInputKey,
                  pageParameter: draft.pageParameter,
                  sizeParameter: draft.sizeParameter,
                  exactCount: draft.exactCount
                }
              }
            : {})
        }
      })
      if (outputModeForm.value.mode === 'page') {
        definition.outputs = []
        definition.page = cloneDeep(pageDraft.value)
      } else delete definition.page
      const input: InterfaceWriteInput = {
        ...form.value,
        code: form.value.code.trim(),
        name: form.value.name.trim(),
        description: form.value.description.trim(),
        path: form.value.path.trim(),
        definition,
        ...(record.value ? { version: record.value.version } : {})
      }
      if (record.value) await updateInterface(record.value.id, input)
      else await createInterface(input)
      emit('success')
      return true
    } catch (error) {
      saveError.value =
        error instanceof BffApiError ? error.message : '接口草稿保存失败，请稍后重试'
      return false
    } finally {
      saving.value = false
    }
  }

  function resetAfterClose(): void {
    form.value = initialForm()
    contractDrafts.value = []
    outputModeForm.value.mode = 'scalar'
    pageDraft.value = emptyPage()
    options.value = undefined
    optionsPending.value = false
    optionsLoadError.value = ''
    record.value = undefined
    saveError.value = ''
  }
  async function handleOpen(
    currentOptions: InterfaceOptions,
    current?: InterfaceRecord,
    pending = false
  ): Promise<void> {
    if (saving.value) return
    options.value = currentOptions
    optionsPending.value = pending
    optionsLoadError.value = ''
    record.value = current
    const applicationId =
      current?.applicationId ?? currentOptions.applications.find((item) => item.enabled)?.id ?? ''
    const environment =
      current?.environment ?? currentOptions.environments[0]?.value ?? 'development'
    form.value = current
      ? {
          applicationId: current.applicationId,
          environment: current.environment,
          code: current.code,
          name: current.name,
          description: current.description,
          method: current.method,
          path: current.path,
          definition: cloneDeep(toRaw(current.definition))
        }
      : initialForm(applicationId, environment)
    contractDrafts.value = form.value.definition.steps.map(contractDraft)
    outputModeForm.value.mode = current?.definition.page ? 'page' : 'scalar'
    pageDraft.value = current?.definition.page
      ? cloneDeep(toRaw(current.definition.page))
      : emptyPage()
    activeTab.value = 'basic'
    saveError.value = ''
    await nextTick()
    basicFormRef.value?.clearValidate()
    await dialogRef.value?.handleOpen(current, {
      title: current ? '编辑接口草稿' : '新增接口草稿',
      size: 'lg',
      width: 'min(1100px, 94vw)',
      contentMaxHeight: '72vh',
      confirmText: '保存草稿',
      onConfirm: handleSubmit
    })
  }
  function updateOptions(currentOptions: InterfaceOptions, rowId: string): void {
    if (record.value?.id === rowId) {
      options.value = currentOptions
      optionsPending.value = false
      optionsLoadError.value = ''
    }
  }
  function setOptionsError(rowId: string, message: string): void {
    if (record.value?.id !== rowId) return
    optionsPending.value = false
    optionsLoadError.value = message || '接口选项加载失败，请稍后重试'
  }
  defineExpose({ handleOpen, updateOptions, setOptionsError })
</script>
