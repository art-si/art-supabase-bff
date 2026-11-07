<template>
  <ArtDialog ref="dialogRef" :loading="loading" @closed="handleClosed">
    <div class="grid min-w-0 gap-4">
      <ArtEntitySummary
        compact
        icon="ri:history-line"
        :title="history?.record.name || record?.name || '版本历史'"
        :description="record ? `${record.application.name} · ${record.code}` : ''"
      >
        <template #aside>
          <ElTag
            :type="history?.record.deployment?.enabled ? 'success' : 'info'"
            effect="light"
            round
          >
            {{
              history?.record.deployment
                ? `当前 V${history.record.deployment.activeVersionNumber}`
                : '尚未发布'
            }}
          </ElTag>
        </template>
      </ArtEntitySummary>
      <ElAlert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon>
        <ElButton link type="primary" :loading="loading" @click="loadHistory">重新加载</ElButton>
      </ElAlert>
      <template v-if="history && !loadError">
        <ArtSectionCard
          title="不可修改的版本快照"
          :subtitle="`${history.versionsTotal} 个版本 · 回滚保持当前启停状态，草稿保持独立`"
          preserve-content-structure
        >
          <div v-if="!history.versions.length" class="p-4 text-sm text-g-700">
            暂无已发布版本。请在列表中完成发布前检查后发布当前草稿。
          </div>
          <div
            v-else
            class="flex min-w-0 gap-2 overflow-x-auto p-3"
            role="group"
            aria-label="历史版本"
          >
            <ElButton
              v-for="version in history.versions"
              :key="version.id"
              :type="selectedVersionId === version.id ? 'primary' : 'default'"
              :plain="selectedVersionId !== version.id"
              @click="selectedVersionId = version.id"
            >
              V{{ version.number }}
              <span v-if="history.record.deployment?.activeVersionId === version.id">· 当前</span>
            </ElButton>
          </div>
          <ElPagination
            v-if="history.versionsTotal > history.size"
            class="px-3 pb-3"
            small
            background
            layout="prev, pager, next, total"
            :current-page="versionPage"
            :page-size="history.size"
            :total="history.versionsTotal"
            @current-change="changeVersionPage"
          />
        </ArtSectionCard>
        <ElTabs v-if="selectedVersion || history.events.length" v-model="activeTab" class="min-w-0">
          <ElTabPane label="版本快照" name="snapshot">
            <div v-if="selectedVersion" class="grid min-w-0 gap-3">
              <ArtSectionCard title="接口定义" preserve-content-structure>
                <dl class="grid gap-3 p-3 sm:grid-cols-2">
                  <div
                    ><dt class="text-xs text-g-700">版本与来源草稿</dt
                    ><dd class="mt-1 font-medium text-g-900"
                      >V{{ selectedVersion.number }} · 草稿 v{{ selectedVersion.draftVersion }}</dd
                    ></div
                  >
                  <div
                    ><dt class="text-xs text-g-700">创建人 / 时间</dt
                    ><dd class="mt-1 text-sm text-g-900"
                      >{{ selectedVersion.createdByName }} ·
                      {{ formatTime(selectedVersion.createdAt) }}</dd
                    ></div
                  >
                  <div class="sm:col-span-2"
                    ><dt class="text-xs text-g-700">对外请求</dt
                    ><dd class="mt-1 break-all font-mono text-sm text-g-900"
                      >{{ selectedVersion.method }} {{ selectedVersion.path }}</dd
                    ></div
                  >
                  <div class="sm:col-span-2"
                    ><dt class="text-xs text-g-700">版本说明</dt
                    ><dd class="mt-1 text-sm text-g-900">{{ selectedVersion.notes }}</dd></div
                  >
                </dl>
              </ArtSectionCard>
              <ArtSectionCard title="输入与输出" preserve-content-structure>
                <div class="grid gap-3 p-3 sm:grid-cols-2">
                  <div
                    ><strong class="text-sm text-g-900"
                      >输入字段（{{ selectedVersion.definition.inputs.length }}）</strong
                    >
                    <ul class="mt-2 grid gap-1 text-xs text-g-700"
                      ><li v-for="field in selectedVersion.definition.inputs" :key="field.key"
                        >{{ field.label || field.key }} · {{ field.key }} · {{ field.location }} ·
                        {{ field.type }}{{ field.required ? ' · 必填' : '' }}</li
                      ></ul
                    >
                  </div>
                  <div
                    ><strong class="text-sm text-g-900"
                      >公开输出（{{ selectedVersion.definition.outputs.length }}）</strong
                    >
                    <ul class="mt-2 grid gap-1 text-xs text-g-700"
                      ><li v-for="output in selectedVersion.definition.outputs" :key="output.target"
                        >{{ output.target }} ←
                        {{
                          output.source === 'step'
                            ? `${output.stepKey}${output.pointer || '/'} `
                            : output.source === 'input'
                              ? output.inputKey
                              : '固定值'
                        }}</li
                      ></ul
                    >
                  </div>
                </div>
              </ArtSectionCard>
              <ArtSectionCard title="有序上游步骤" preserve-content-structure>
                <ol class="grid gap-2 p-3">
                  <li
                    v-for="(step, index) in selectedVersion.definition.steps"
                    :key="step.key"
                    class="flex min-w-0 items-center gap-3 rounded border border-g-200 p-2"
                  >
                    <ElTag type="primary" effect="plain" round>{{ index + 1 }}</ElTag>
                    <div class="min-w-0"
                      ><strong class="block truncate text-sm text-g-900">{{
                        step.name || step.key
                      }}</strong
                      ><span class="text-xs text-g-700"
                        >{{ step.method }} {{ step.path }} · 上游配置 v{{
                          step.configVersion
                        }}</span
                      ></div
                    >
                  </li>
                </ol>
              </ArtSectionCard>
              <div class="flex justify-end">
                <ElButton
                  v-if="
                    hasAuth('BffRelease:Rollback') &&
                    history.record.deployment &&
                    history.record.deployment.activeVersionId !== selectedVersion.id
                  "
                  type="primary"
                  plain
                  @click="requestRollback"
                  >回滚到 V{{ selectedVersion.number }}</ElButton
                >
              </div>
            </div>
          </ElTabPane>
          <ElTabPane :label="`发布事件（${history.eventsTotal}）`" name="events">
            <ArtSectionCard title="变更记录" preserve-content-structure>
              <div v-if="!history.events.length" class="p-4 text-sm text-g-700">尚无发布事件。</div>
              <ol v-else class="grid gap-3 p-3">
                <li
                  v-for="event in history.events"
                  :key="event.id"
                  class="grid min-w-0 gap-2 border-b border-g-200 pb-3 last:border-0"
                >
                  <div class="flex flex-wrap items-center justify-between gap-2"
                    ><strong class="text-sm text-g-900"
                      >{{ actionText[event.action] }} · V{{ event.toVersionNumber }}</strong
                    ><span class="text-xs text-g-700"
                      >{{ formatTime(event.createdAt) }} · {{ event.actorName }}</span
                    ></div
                  >
                  <p class="text-xs text-g-700">{{ event.notes }}</p>
                  <small class="text-xs text-g-700"
                    >运行指针 v{{ event.deploymentVersion
                    }}{{
                      event.fromVersionNumber ? ` · 原 V${event.fromVersionNumber}` : ''
                    }}</small
                  >
                </li>
              </ol>
              <ElPagination
                v-if="history.eventsTotal > history.size"
                class="px-3 pb-3"
                small
                background
                layout="prev, pager, next, total"
                :current-page="eventPage"
                :page-size="history.size"
                :total="history.eventsTotal"
                @current-change="changeEventPage"
              />
            </ArtSectionCard>
          </ElTabPane>
        </ElTabs>
      </template>
    </div>
  </ArtDialog>
</template>

<script setup lang="ts">
  import type { ArtDialogExpose } from '@/components/core/dialogs/art-dialog/types'
  import ArtSectionCard from '@/components/core/surfaces/art-section-card/index.vue'
  import { formatWithDayjs } from '@/utils/time'
  import { BffApiError } from '@bff/api/bff'
  import { fetchReleaseHistory } from '@bff/api/releases'
  import { useAuth } from '@/hooks/core/useAuth'
  import type { ReleaseHistory, ReleaseRecord, ReleaseVersion } from '@bff/types/release'

  const emit = defineEmits<{ rollback: [record: ReleaseRecord, version: ReleaseVersion] }>()
  const { hasAuth } = useAuth()
  const dialogRef = ref<ArtDialogExpose<ReleaseRecord>>()
  const record = shallowRef<ReleaseRecord>()
  const history = shallowRef<ReleaseHistory>()
  const selectedVersionId = ref('')
  const activeTab = ref('snapshot')
  const versionPage = ref(1)
  const eventPage = ref(1)
  const pageSize = 20
  const loading = ref(false)
  const loadError = ref('')
  const pendingRollback = shallowRef<{ record: ReleaseRecord; version: ReleaseVersion }>()
  const selectedVersion = computed(() =>
    history.value?.versions.find((item) => item.id === selectedVersionId.value)
  )
  const actionText = { publish: '发布', rollback: '回滚', enable: '启用', disable: '停用' } as const
  const formatTime = (value: string): string => formatWithDayjs(value) || '—'

  async function loadHistory(): Promise<void> {
    if (!record.value || loading.value) return
    loading.value = true
    loadError.value = ''
    try {
      history.value = await fetchReleaseHistory(record.value.interfaceId, {
        versionPage: versionPage.value,
        eventPage: eventPage.value,
        size: pageSize
      })
      selectedVersionId.value =
        history.value.record.deployment?.activeVersionId || history.value.versions[0]?.id || ''
    } catch (error) {
      loadError.value =
        error instanceof BffApiError ? error.message : '版本历史加载失败，请稍后重试'
    } finally {
      loading.value = false
    }
  }
  function changeVersionPage(page: number): void {
    versionPage.value = page
    void loadHistory()
  }
  function changeEventPage(page: number): void {
    eventPage.value = page
    void loadHistory()
  }
  function requestRollback(): void {
    const current = history.value?.record
    const version = selectedVersion.value
    if (!current || !version || !hasAuth('BffRelease:Rollback')) return
    pendingRollback.value = { record: current, version }
    dialogRef.value?.handleClose()
  }
  function handleClosed(): void {
    const pending = pendingRollback.value
    pendingRollback.value = undefined
    history.value = undefined
    record.value = undefined
    selectedVersionId.value = ''
    versionPage.value = 1
    eventPage.value = 1
    loadError.value = ''
    if (pending) emit('rollback', pending.record, pending.version)
  }
  async function handleOpen(current: ReleaseRecord): Promise<void> {
    if (loading.value) return
    record.value = current
    history.value = undefined
    selectedVersionId.value = ''
    versionPage.value = 1
    eventPage.value = 1
    activeTab.value = 'snapshot'
    loadError.value = ''
    await dialogRef.value?.handleOpen(current, {
      title: '版本历史',
      size: 'xl',
      contentMaxHeight: '72vh',
      showConfirmButton: false,
      cancelText: '关闭'
    })
    await loadHistory()
  }
  defineExpose({ handleOpen })
</script>
