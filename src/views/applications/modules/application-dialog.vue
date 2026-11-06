<template>
  <ArtDialog ref="dialogRef"
    ><ArtForm
      ref="formRef"
      v-model="form.data"
      :items="form.items"
      :rules="form.rules"
      :span="12"
      :show-submit="false"
      :show-reset="false"
      label-position="top" /><ElAlert
      v-if="form.error"
      :title="form.error"
      type="error"
      :closable="false"
      show-icon
  /></ArtDialog>
</template>
<script setup lang="ts">
  import { saveApplication, BffApiError } from '@/api/bff'
  import type { ApplicationInput, BffApplication } from '@/types/bff'
  import type { FormItem } from '@/components/core/forms/art-form/index.vue'
  import type { ArtDialogExpose } from '@/components/core/dialogs/art-dialog/types'
  import type ArtForm from '@/components/core/forms/art-form/index.vue'
  import type { FormRules } from 'element-plus'
  const dialogRef = ref<ArtDialogExpose>(),
    formRef = ref<InstanceType<typeof ArtForm>>()
  const emit = defineEmits<{ success: [] }>()
  const defaults = (): ApplicationInput => ({
    name: '',
    code: '',
    description: '',
    homeUrl: '',
    enabled: true,
    version: undefined
  })
  const form = reactive<{
    data: ApplicationInput
    id?: string
    items: FormItem[]
    rules: FormRules
    error: string
  }>({
    data: defaults(),
    id: undefined,
    error: '',
    items: [],
    rules: {
      name: [
        { required: true, message: '请填写应用名称', trigger: 'blur' },
        { max: 100, message: '应用名称不能超过 100 字', trigger: 'blur' }
      ],
      code: [
        { required: true, message: '请填写应用编码', trigger: 'blur' },
        {
          pattern: /^[a-z][a-z0-9-]{1,63}$/,
          message: '使用 2–64 位小写字母、数字或连字符，以字母开头',
          trigger: 'blur'
        }
      ],
      homeUrl: [
        {
          validator: (_rule, value: string, callback) => {
            if (!value) {
              callback()
              return
            }
            try {
              const url = new URL(value)
              callback(
                ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
                  ? undefined
                  : new Error('请输入完整 HTTP 或 HTTPS 地址')
              )
            } catch {
              callback(new Error('请输入完整 HTTP 或 HTTPS 地址'))
            }
          },
          trigger: 'blur'
        }
      ]
    }
  })
  async function handleOpen(application?: BffApplication): Promise<void> {
    Object.assign(form, {
      id: application?.id,
      error: '',
      data: application
        ? {
            name: application.name,
            code: application.code,
            description: application.description,
            homeUrl: application.homeUrl,
            enabled: application.enabled,
            version: application.version
          }
        : defaults()
    })
    form.items = [
      {
        key: 'name',
        label: '应用名称',
        type: 'input',
        props: { maxlength: 100, placeholder: '例如：采购工作台' }
      },
      {
        key: 'code',
        label: '应用编码',
        type: 'input',
        props: {
          disabled: Boolean(application),
          maxlength: 64,
          placeholder: '例如：purchase-workbench'
        },
        description: application ? '编码创建后保持不变。' : '用于稳定标识应用，创建后不可修改。'
      },
      {
        key: 'homeUrl',
        label: '应用地址',
        type: 'input',
        span: 24,
        props: { maxlength: 2000, placeholder: 'https://app.example.com' }
      },
      {
        key: 'enabled',
        label: '应用状态',
        type: 'segment',
        span: 24,
        options: [
          { label: '启用', value: true },
          { label: '停用', value: false }
        ],
        description: '停用后，普通成员将无法在应用列表中访问此应用。'
      },
      {
        key: 'description',
        label: '应用说明',
        type: 'input',
        span: 24,
        props: {
          type: 'textarea',
          rows: 3,
          maxlength: 1000,
          showWordLimit: true,
          placeholder: '说明应用用途和服务对象'
        }
      }
    ]
    await dialogRef.value?.handleOpen(
      {},
      {
        title: application ? '编辑应用' : '登记应用',
        size: 'md',
        confirmText: '保存应用',
        contentMaxHeight: '65vh',
        onConfirm: async () => {
          form.error = ''
          try {
            await formRef.value?.validate()
            await saveApplication(form.data, form.id)
            emit('success')
            return true
          } catch (error) {
            if (error instanceof BffApiError) form.error = error.message
            else if (error instanceof Error) form.error = '保存失败，请稍后重试'
            return false
          }
        }
      }
    )
  }
  defineExpose({ handleOpen })
</script>
