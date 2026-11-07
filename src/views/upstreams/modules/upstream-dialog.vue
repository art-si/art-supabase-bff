<template>
  <ArtDialog
    ref="dialogRef"
    :loading="saving"
    :confirm-disabled="optionsPending || Boolean(optionsLoadError)"
    @closed="clearCredential"
  >
    <div class="grid min-w-0 gap-4">
      <ArtEntitySummary
        compact
        :icon="upstream ? 'ri:server-line' : 'ri:add-circle-line'"
        :title="upstream?.name || '登记上游服务'"
        :description="
          upstream
            ? `${upstream.application.name} · ${upstream.code}`
            : '先登记服务定义，再检测连接并启用。'
        "
      />
      <ElAlert
        v-if="optionsPending"
        title="正在加载应用与环境选项，现有配置可先查看。"
        type="info"
        :closable="false"
        show-icon
      />
      <ElAlert
        v-else-if="optionsLoadError"
        :title="optionsLoadError"
        description="请关闭弹窗后重试，选项就绪前不会提交配置。"
        type="warning"
        :closable="false"
        show-icon
      />
      <ElAlert
        v-if="upstream && form.authType !== upstream.authType"
        title="切换认证方式会清除原凭据。保存后请到“管理凭据”重新配置。"
        type="warning"
        :closable="false"
        show-icon
      />
      <ElAlert
        v-else-if="upstream?.credentialConfigured"
        title="现有凭据已安全配置。编辑服务不会回显或改写凭据；如需轮换请使用“管理凭据”。"
        type="info"
        :closable="false"
        show-icon
      />
      <ElTabs v-model="activeTab" class="min-w-0">
        <ElTabPane label="服务身份" name="identity">
          <ArtForm
            ref="formRef"
            v-model="form"
            :items="identityItems"
            :rules="rules"
            :span="12"
            :gutter="18"
            label-position="top"
            root-class="p-0!"
          />
        </ElTabPane>
        <ElTabPane label="连接配置" name="connection">
          <ArtForm
            ref="connectionFormRef"
            v-model="form"
            :items="connectionItems"
            :rules="rules"
            :span="12"
            :gutter="18"
            label-position="top"
            root-class="p-0!"
          />
        </ElTabPane>
        <ElTabPane label="认证与凭据" name="auth">
          <ArtForm
            ref="authFormRef"
            v-model="form"
            :items="authItems"
            :rules="rules"
            :span="12"
            :gutter="18"
            label-position="top"
            root-class="p-0!"
          />
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
  const authTypeOptions = useDictionaryOptions(BFF_DICTIONARIES.upstreams.authType)
  import type { FormRules } from 'element-plus'
  import { useAuth } from '@/hooks/core/useAuth'
  import { validateArtFormForSubmit } from '@/utils/form/validate-art-form'
  import type { FormItem } from '@/components/core/forms/art-form/index.vue'
  import type ArtForm from '@/components/core/forms/art-form/index.vue'
  import type { ArtDialogExpose } from '@/components/core/dialogs/art-dialog/types'
  import { BffApiError } from '@bff/api/bff'
  import { createUpstream, updateUpstream } from '@bff/api/upstreams'
  import type {
    UpstreamAuthType,
    UpstreamCreateInput,
    UpstreamDefinition,
    UpstreamOptions,
    UpstreamService,
    UpstreamUpdateInput
  } from '@bff/types/upstream'

  interface UpstreamForm extends UpstreamCreateInput {
    credential: string
  }

  const emit = defineEmits<{ success: [] }>()
  const { hasAuth } = useAuth()
  const dialogRef = ref<ArtDialogExpose<UpstreamService | undefined>>()
  const formRef = ref<InstanceType<typeof ArtForm>>()
  const connectionFormRef = ref<InstanceType<typeof ArtForm>>()
  const authFormRef = ref<InstanceType<typeof ArtForm>>()
  const activeTab = ref('identity')
  const upstream = shallowRef<UpstreamService>()
  const options = shallowRef<UpstreamOptions>()
  const saving = ref(false)
  const optionsPending = ref(false)
  const optionsLoadError = ref('')
  const saveError = ref('')
  const canChangeCredentialPolicy = computed(() => hasAuth('BffUpstream:RotateSecret'))
  const reservedHeader =
    /^(accept|accept-encoding|content-type|origin|referer|user-agent|expect|authorization|cookie|set-cookie|host|content-length|connection|proxy-.*|transfer-encoding|te|trailer|upgrade|forwarded|x-forwarded-.*)$/i
  const form = ref<UpstreamForm>({
    applicationId: '',
    code: '',
    name: '',
    description: '',
    environment: 'development',
    baseUrl: '',
    authType: 'none',
    headerName: '',
    timeoutMs: 10_000,
    credential: ''
  })

  const rules = computed<FormRules>(() => ({
    applicationId: [{ required: true, message: '请选择所属应用', trigger: 'change' }],
    code: [
      { required: true, message: '请输入服务编码', trigger: 'blur' },
      {
        pattern: /^[a-z][a-z0-9-]{1,63}$/,
        message: '使用 2–64 位小写字母、数字或连字符，以字母开头',
        trigger: 'blur'
      }
    ],
    name: [
      { required: true, message: '请输入服务名称', trigger: 'blur' },
      { max: 100, message: '名称不能超过 100 字', trigger: 'blur' }
    ],
    baseUrl: [
      { required: true, message: '请输入上游服务地址', trigger: 'blur' },
      {
        validator: (_rule, value: string, callback) => {
          try {
            const url = new URL(value)
            callback(
              ['http:', 'https:'].includes(url.protocol) &&
                !url.username &&
                !url.password &&
                !url.search &&
                !url.hash
                ? undefined
                : new Error('请输入无账号、查询串和锚点的完整 HTTP 或 HTTPS 地址')
            )
          } catch {
            callback(new Error('请输入完整的 HTTP 或 HTTPS 地址'))
          }
        },
        trigger: 'blur'
      }
    ],
    timeoutMs: [
      { required: true, message: '请输入请求超时', trigger: 'change' },
      { type: 'number', min: 100, max: 30_000, message: '连接超时需为 100–30000 毫秒' }
    ],
    headerName:
      form.value.authType === 'api_key_header'
        ? [
            { required: true, message: '请输入 API Key 请求头名称', trigger: 'blur' },
            {
              validator: (_rule, value: string, callback) => {
                callback(
                  /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(value) && !reservedHeader.test(value)
                    ? undefined
                    : new Error('请使用独立的 API Key 请求头，不得覆盖认证、Cookie 或连接控制字段')
                )
              },
              trigger: 'blur'
            }
          ]
        : []
  }))

  const formItems = computed<FormItem[]>(() => [
    {
      key: 'applicationId',
      label: '所属应用',
      type: 'select',
      span: 12,
      props: {
        filterable: true,
        disabled: Boolean(upstream.value),
        placeholder: '选择已登记应用',
        options: (options.value?.applications ?? []).map((application) => ({
          label: `${application.name}（${application.code}）${application.enabled ? '' : ' · 已停用'}`,
          value: application.id,
          disabled: !application.enabled && application.id !== upstream.value?.applicationId
        }))
      }
    },
    {
      key: 'environment',
      label: '环境',
      type: 'select',
      span: 12,
      props: {
        disabled: Boolean(upstream.value),
        placeholder: '选择环境',
        options: environmentOptions
      }
    },
    {
      key: 'code',
      label: '服务编码',
      type: 'input',
      span: 12,
      props: {
        disabled: Boolean(upstream.value),
        maxlength: 64,
        placeholder: '例如：inventory-api'
      },
      description: '应用与环境内唯一，创建后保持不变。'
    },
    {
      key: 'name',
      label: '服务名称',
      type: 'input',
      span: 12,
      props: { maxlength: 100, placeholder: '例如：库存查询服务' }
    },
    {
      key: 'description',
      label: '服务说明',
      type: 'input',
      span: 24,
      props: {
        type: 'textarea',
        rows: 2,
        maxlength: 1000,
        showWordLimit: true,
        placeholder: '说明上游服务用途、负责人和调用边界'
      }
    },
    {
      key: 'baseUrl',
      label: '基础地址',
      type: 'input',
      span: 18,
      props: {
        disabled: Boolean(upstream.value?.credentialConfigured) && !canChangeCredentialPolicy.value,
        maxlength: 2000,
        placeholder: 'https://api.example.com/v1'
      },
      description:
        upstream.value?.credentialConfigured && !canChangeCredentialPolicy.value
          ? '已有凭据的服务需要凭据管理权限才能调整地址。'
          : '访问地址受服务端网络策略校验；此处不执行请求。'
    },
    {
      key: 'timeoutMs',
      label: '超时（毫秒）',
      type: 'number',
      span: 6,
      props: { min: 100, max: 30_000, step: 100, controlsPosition: 'right' }
    },
    {
      key: 'authType',
      label: '认证方式',
      type: 'segment',
      span: 24,
      props: {
        disabled:
          Boolean(upstream.value) &&
          (!canChangeCredentialPolicy.value || upstream.value?.status === 'active')
      },
      options: authTypeOptions,
      description:
        upstream.value?.status === 'active'
          ? '切换认证方式前请先停用服务。'
          : '切换认证方式会清除旧凭据，保存后需重新配置。'
    },
    {
      key: 'headerName',
      label: '请求头名称',
      type: 'input',
      span: 24,
      hidden: () => form.value.authType !== 'api_key_header',
      props: {
        disabled: Boolean(upstream.value) && !canChangeCredentialPolicy.value,
        maxlength: 64,
        placeholder: '例如：X-API-Key'
      },
      description: '只保存请求头名称；凭据值不会在列表或编辑页回显。'
    },
    {
      key: 'credential',
      label: '首次配置凭据',
      type: 'input',
      span: 24,
      hidden: () => Boolean(upstream.value) || form.value.authType === 'none',
      props: {
        disabled: !options.value?.credentialManagementReady,
        type: 'password',
        showPassword: true,
        autocomplete: 'new-password',
        maxlength: 8192,
        placeholder: '可先留空创建草稿，稍后单独配置凭据'
      },
      description: options.value?.credentialManagementReady
        ? '仅创建时写入；后续轮换或清除请使用“管理凭据”。'
        : '凭据保管服务待就绪，可先留空登记草稿。'
    }
  ])

  const identityItems = computed(() =>
    formItems.value.filter((item) =>
      ['applicationId', 'environment', 'code', 'name', 'description'].includes(item.key)
    )
  )
  const connectionItems = computed(() =>
    formItems.value.filter((item) => ['baseUrl', 'timeoutMs'].includes(item.key))
  )
  const authItems = computed(() =>
    formItems.value.filter((item) => ['authType', 'headerName', 'credential'].includes(item.key))
  )

  function clearCredential(): void {
    form.value.credential = ''
    upstream.value = undefined
    optionsPending.value = false
    optionsLoadError.value = ''
  }

  function buildDefinition(): UpstreamDefinition {
    const authType: UpstreamAuthType = form.value.authType
    return {
      name: form.value.name.trim(),
      description: form.value.description.trim(),
      baseUrl: form.value.baseUrl.trim(),
      authType,
      headerName:
        authType === 'api_key_header'
          ? form.value.headerName.trim()
          : authType === 'bearer'
            ? upstream.value?.authType === 'bearer'
              ? upstream.value.headerName
              : 'Authorization'
            : '',
      timeoutMs: form.value.timeoutMs
    }
  }

  async function handleSubmit(): Promise<boolean> {
    if (saving.value || !options.value || optionsPending.value || optionsLoadError.value)
      return false
    try {
      for (const [tab, currentForm] of [
        ['identity', formRef.value],
        ['connection', connectionFormRef.value],
        ['auth', authFormRef.value]
      ] as const) {
        if (!(await validateArtFormForSubmit(currentForm))) {
          activeTab.value = tab
          return false
        }
      }
    } catch {
      saveError.value = '表单校验未完成，请检查填写内容后重试'
      return false
    }
    saving.value = true
    saveError.value = ''
    try {
      const definition = buildDefinition()
      if (upstream.value) {
        const update: UpstreamUpdateInput = { ...definition, version: upstream.value.version }
        await updateUpstream(upstream.value.id, update)
      } else {
        const create: UpstreamCreateInput = {
          ...definition,
          applicationId: form.value.applicationId,
          code: form.value.code.trim(),
          environment: form.value.environment,
          ...(form.value.authType !== 'none' && form.value.credential.trim()
            ? { credential: form.value.credential }
            : {})
        }
        await createUpstream(create)
      }
      clearCredential()
      emit('success')
      return true
    } catch (error) {
      saveError.value = error instanceof BffApiError ? error.message : '服务保存失败，请稍后重试'
      return false
    } finally {
      saving.value = false
    }
  }

  async function handleOpen(
    currentOptions: UpstreamOptions,
    row?: UpstreamService,
    pending = false
  ): Promise<void> {
    if (saving.value) return
    options.value = currentOptions
    optionsPending.value = pending
    optionsLoadError.value = ''
    upstream.value = row
    activeTab.value = 'identity'
    saveError.value = ''
    form.value = {
      applicationId:
        row?.applicationId ?? currentOptions.applications.find((app) => app.enabled)?.id ?? '',
      code: row?.code ?? '',
      name: row?.name ?? '',
      description: row?.description ?? '',
      environment: row?.environment ?? currentOptions.environments[0]?.value ?? 'development',
      baseUrl: row?.baseUrl ?? '',
      authType: row?.authType ?? 'none',
      headerName: row?.headerName ?? '',
      timeoutMs: row?.timeoutMs ?? 10_000,
      credential: ''
    }
    await nextTick()
    formRef.value?.clearValidate()
    connectionFormRef.value?.clearValidate()
    authFormRef.value?.clearValidate()
    await dialogRef.value?.handleOpen(row, {
      title: row ? '编辑上游服务' : '登记上游服务',
      size: 'lg',
      confirmText: row ? '保存配置' : '创建草稿',
      contentMaxHeight: '70vh',
      onConfirm: handleSubmit
    })
  }

  function updateOptions(currentOptions: UpstreamOptions, rowId: string): void {
    if (upstream.value?.id === rowId) {
      options.value = currentOptions
      optionsPending.value = false
      optionsLoadError.value = ''
    }
  }

  function setOptionsError(rowId: string, message: string): void {
    if (upstream.value?.id !== rowId) return
    optionsPending.value = false
    optionsLoadError.value = message || '应用与环境选项加载失败，请稍后重试'
  }

  defineExpose({ handleOpen, updateOptions, setOptionsError })
</script>
