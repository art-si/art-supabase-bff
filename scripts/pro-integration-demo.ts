/** Local, operator-run Pro integration fixture. Never run against a production BFF. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { config } from '../server/config'
import { database, requireData } from '../server/database/client'
import { interfaceInput, validateInterfaceDefinition } from '../server/interface-definition'
import { runInterface } from '../server/interface-runner'
import { interfaceDto } from '../server/interfaces'
import { decodePublishedTarget } from '../server/published-runtime'
import { releaseDefinitionIssues, releaseRecordDto } from '../server/releases'
import { upstreamPolicy } from '../server/upstream-runtime'
import { upstreamInput, upstreamDto } from '../server/upstreams'
import type {
  InterfacePageResult,
  InterfaceRecord,
  InterfaceWriteInput
} from '../src/types/interface'

const issuer = 'https://ckbftoopuyophiebamwy.supabase.co/auth/v1'
const responderOrigin = 'http://127.0.0.1:33445'
const appCode = 'demo-pro-integration-workspace'
const kinds = ['java', 'supabase', 'cloudbase'] as const
type Kind = (typeof kinds)[number]
type DemoManifest = {
  marker: string
  actor: string
  tenant: string
  applicationId: string | null
  upstreamIds: Record<Kind, string>
  interfaceIds: Record<Kind, string>
}
const manifestPath = path.resolve('.artifacts/pro-integration-demo.json')
const uuidPattern = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

function record(value: unknown): Record<string, unknown> {
  if (!isObjectRecord(value)) throw new Error('Invalid BFF demo record')
  return value
}
function validUuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new Error('Invalid demo UUID')
  return value.toLowerCase()
}
function checked<T>(result: {
  data: T | null
  error: { code?: string; message?: string } | null
}): T {
  if (result.error)
    throw new Error(`BFF demo database operation failed: ${result.error.code || 'unknown'}`)
  if (result.data === null) throw new Error('BFF demo database record is missing')
  return result.data
}
function writeManifest(value: DemoManifest): void {
  mkdirSync(path.dirname(manifestPath), { recursive: true })
  const temporary = `${manifestPath}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' })
  renameSync(temporary, manifestPath)
}
function readManifest(actor: string, tenant: string): DemoManifest {
  if (!existsSync(manifestPath)) {
    const value: DemoManifest = {
      marker: randomUUID(),
      actor,
      tenant,
      applicationId: null,
      upstreamIds: { java: randomUUID(), supabase: randomUUID(), cloudbase: randomUUID() },
      interfaceIds: { java: randomUUID(), supabase: randomUUID(), cloudbase: randomUUID() }
    }
    writeManifest(value)
    return value
  }
  const value: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (
    !isObjectRecord(value) ||
    !isObjectRecord(value.upstreamIds) ||
    !isObjectRecord(value.interfaceIds)
  )
    throw new Error('BFF demo manifest is invalid')
  const upstreamIds = value.upstreamIds
  const interfaceIds = value.interfaceIds
  if (
    validUuid(value.marker) !== value.marker ||
    value.actor !== actor ||
    value.tenant !== tenant ||
    (value.applicationId !== null && validUuid(value.applicationId) !== value.applicationId) ||
    kinds.some(
      (kind) =>
        validUuid(upstreamIds[kind]) !== upstreamIds[kind] ||
        validUuid(interfaceIds[kind]) !== interfaceIds[kind]
    )
  )
    throw new Error('BFF demo manifest does not match this verified workspace')
  return value as DemoManifest
}
function markerText(manifest: DemoManifest): string {
  return `仅供本地 Pro 接入演示；demo-pro-integration:${manifest.marker}`
}
function assertLocalPolicy(): void {
  if (
    config.production ||
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.origin).hostname) ||
    new URL(config.databaseUrl).hostname !== 'bksbwnxdurmuolygiofh.supabase.co' ||
    !upstreamPolicy.allowLocalHttp ||
    !upstreamPolicy.allowedOrigins.includes(responderOrigin)
  )
    throw new Error('Demo requires local BFF, BFF database and explicit 33445 loopback allowlist')
}
async function activeAdmin(subject: string): Promise<{ id: string; tenant: string }> {
  const row = checked(
    await database
      .from('bff_members')
      .select('id,issuer,subject,tenant_id,role,enabled')
      .eq('issuer', issuer)
      .eq('subject', subject)
      .eq('enabled', true)
      .maybeSingle()
  )
  const member = record(row)
  if (
    member.issuer !== issuer ||
    member.subject !== subject ||
    member.role !== 'admin' ||
    member.enabled !== true
  )
    throw new Error('Verified Pro subject has no active BFF administrator membership')
  return { id: validUuid(member.id), tenant: validUuid(member.tenant_id) }
}
async function ownedApplication(manifest: DemoManifest): Promise<Record<string, unknown> | null> {
  const found = await database
    .from('bff_applications')
    .select('id,tenant_id,code,name,description,enabled,version,created_by')
    .eq('tenant_id', manifest.tenant)
    .eq('code', appCode)
    .maybeSingle()
  if (found.error) throw new Error(`BFF demo app lookup failed: ${found.error.code || 'unknown'}`)
  if (!found.data) return null
  const app = record(found.data)
  if (
    app.tenant_id !== manifest.tenant ||
    app.code !== appCode ||
    app.description !== markerText(manifest) ||
    app.created_by !== manifest.actor ||
    (manifest.applicationId && app.id !== manifest.applicationId)
  )
    throw new Error('Existing application code is not owned by this demo manifest')
  manifest.applicationId = validUuid(app.id)
  writeManifest(manifest)
  return app
}
async function ensureApplication(manifest: DemoManifest): Promise<string> {
  let app = await ownedApplication(manifest)
  if (!app) {
    app = record(
      requireData(
        await database.rpc('bff_save_application', {
          p_actor: manifest.actor,
          p_id: null,
          p_version: null,
          p_code: appCode,
          p_name: '本地集成演示',
          p_description: markerText(manifest),
          p_home_url: '',
          p_enabled: true
        })
      )
    )
    manifest.applicationId = validUuid(app.id)
    writeManifest(manifest)
  } else if (app.enabled === false) {
    checked(
      await database.rpc('bff_save_application', {
        p_actor: manifest.actor,
        p_id: manifest.applicationId,
        p_version: app.version,
        p_code: appCode,
        p_name: '本地集成演示',
        p_description: markerText(manifest),
        p_home_url: '',
        p_enabled: true
      })
    )
  }
  return validUuid(manifest.applicationId)
}
async function disableApplication(manifest: DemoManifest): Promise<void> {
  const app = await ownedApplication(manifest)
  if (!app || app.enabled === false) return
  checked(
    await database.rpc('bff_save_application', {
      p_actor: manifest.actor,
      p_id: manifest.applicationId,
      p_version: app.version,
      p_code: appCode,
      p_name: app.name,
      p_description: markerText(manifest),
      p_home_url: '',
      p_enabled: false
    })
  )
  console.log('Local demo application disabled; published APIs are hidden from the catalog.')
}
function sourceCode(kind: Kind): string {
  return `demo-pro-integration-${kind}`
}
async function ensureUpstream(
  manifest: DemoManifest,
  applicationId: string,
  kind: Kind
): Promise<{ id: string; configVersion: number }> {
  const id = manifest.upstreamIds[kind]
  const code = sourceCode(kind)
  const existing = await database
    .from('bff_upstream_services')
    .select(
      'id,tenant_id,application_id,code,description,created_by,base_url,auth_type,status,config_version,version'
    )
    .eq('tenant_id', manifest.tenant)
    .eq('code', code)
    .maybeSingle()
  if (existing.error)
    throw new Error(`BFF demo upstream lookup failed: ${existing.error.code || 'unknown'}`)
  if (existing.data) {
    const row = record(existing.data)
    if (
      row.id !== id ||
      row.application_id !== applicationId ||
      row.tenant_id !== manifest.tenant ||
      row.created_by !== manifest.actor ||
      row.description !== markerText(manifest) ||
      row.base_url !== responderOrigin ||
      row.auth_type !== 'none'
    )
      throw new Error(`Existing upstream ${code} is not this demo fixture`)
    if (row.status !== 'active') {
      const changed = upstreamDto(
        requireData(
          await database.rpc('bff_write_upstream', {
            p_actor: manifest.actor,
            p_operation: 'status',
            p_id: id,
            p_version: row.version,
            p_definition: { status: 'active' },
            p_credential: null
          })
        )
      )
      return { id, configVersion: changed.configVersion }
    }
    return { id, configVersion: Number(row.config_version) }
  }
  const definition = upstreamInput(
    {
      applicationId,
      code,
      name: `${kind} 本地示例`,
      description: markerText(manifest),
      environment: 'development',
      baseUrl: responderOrigin,
      authType: 'none',
      headerName: '',
      timeoutMs: 5000
    },
    true
  )
  const created = upstreamDto(
    requireData(
      await database.rpc('bff_write_upstream', {
        p_actor: manifest.actor,
        p_operation: 'create',
        p_id: id,
        p_version: null,
        p_definition: definition,
        p_credential: null
      })
    )
  )
  const active = upstreamDto(
    requireData(
      await database.rpc('bff_write_upstream', {
        p_actor: manifest.actor,
        p_operation: 'status',
        p_id: id,
        p_version: created.version,
        p_definition: { status: 'active' },
        p_credential: null
      })
    )
  )
  return { id, configVersion: active.configVersion }
}
export function demoDefinition(
  applicationId: string,
  upstreamId: string,
  configVersion: number,
  kind: Kind,
  marker: string
): InterfaceWriteInput {
  const business =
    kind === 'java'
      ? { mode: 'business' as const, codePointer: '/code', dataPointer: '/data', successCodes: [0] }
      : kind === 'cloudbase'
        ? {
            mode: 'business' as const,
            codePointer: '/result/code',
            dataPointer: '/result/data',
            successCodes: [0]
          }
        : undefined
  return interfaceInput({
    applicationId,
    environment: 'development',
    code: sourceCode(kind),
    name: `${kind} 统一列表`,
    description: `demo-pro-integration:${marker}`,
    method: 'GET',
    path: `/demo/${kind}`,
    definition: {
      inputs: [
        { key: 'current', label: '页码', location: 'query', type: 'number', required: true },
        { key: 'size', label: '页长', location: 'query', type: 'number', required: true }
      ],
      steps: [
        {
          key: 'load',
          name: '列表查询',
          upstreamId,
          configVersion,
          method: 'GET',
          path: `/${kind}`,
          pathParams: [],
          query: [],
          body: [],
          ...(business ? { responseContract: business } : {}),
          pagination: {
            mode: 'offset',
            currentInputKey: 'current',
            sizeInputKey: 'size',
            pageParameter: 'offset',
            sizeParameter: 'limit',
            exactCount: kind === 'supabase'
          }
        }
      ],
      outputs: [],
      page: {
        stepKey: 'load',
        recordsPointer: kind === 'java' ? '/records' : kind === 'cloudbase' ? '/list' : '',
        totalSource: kind === 'supabase' ? 'content-range' : 'body',
        totalPointer: kind === 'supabase' ? '' : '/total',
        currentInputKey: 'current',
        sizeInputKey: 'size',
        fields: [
          { target: 'id', label: '编号', pointer: '/id', type: 'string', required: true },
          { target: 'name', label: '名称', pointer: '/name', type: 'string', required: true }
        ]
      }
    }
  })
}
async function ensureInterface(
  manifest: DemoManifest,
  applicationId: string,
  kind: Kind,
  upstream: { id: string; configVersion: number }
): Promise<InterfaceRecord> {
  const id = manifest.interfaceIds[kind]
  const code = sourceCode(kind)
  const existing = await database
    .from('bff_interfaces')
    .select('id,tenant_id,application_id,code,description,created_by,environment,method,path')
    .eq('tenant_id', manifest.tenant)
    .eq('code', code)
    .maybeSingle()
  if (existing.error)
    throw new Error(`BFF demo interface lookup failed: ${existing.error.code || 'unknown'}`)
  if (existing.data) {
    const row = record(existing.data)
    if (
      row.id !== id ||
      row.tenant_id !== manifest.tenant ||
      row.application_id !== applicationId ||
      row.created_by !== manifest.actor ||
      row.description !== `demo-pro-integration:${manifest.marker}` ||
      row.environment !== 'development' ||
      row.method !== 'GET' ||
      row.path !== `/demo/${kind}`
    )
      throw new Error(`Existing interface ${code} is not this demo fixture`)
    return interfaceDto(
      requireData(
        await database.rpc(
          'bff_interface_target',
          {
            p_actor: manifest.actor,
            p_id: id,
            p_permission: 'BffInterface:Test'
          },
          { get: true }
        )
      )
    )
  }
  const input = demoDefinition(
    applicationId,
    upstream.id,
    upstream.configVersion,
    kind,
    manifest.marker
  )
  const issues = validateInterfaceDefinition(input)
  if (issues.length) throw new Error(`Demo interface invalid: ${issues[0]}`)
  return interfaceDto(
    requireData(
      await database.rpc('bff_write_interface', {
        p_actor: manifest.actor,
        p_operation: 'create',
        p_id: id,
        p_version: null,
        p_definition: input
      })
    )
  )
}
async function verifyAndPublish(
  manifest: DemoManifest,
  kind: Kind,
  item: InterfaceRecord
): Promise<void> {
  const runInput = { current: 1, size: 2 }
  const definitionIssues = validateInterfaceDefinition(item)
  if (definitionIssues.length) throw new Error(`Demo validation failed: ${definitionIssues[0]}`)
  const validation = interfaceDto(
    requireData(
      await database.rpc('bff_record_interface_validation', {
        p_actor: manifest.actor,
        p_id: item.id,
        p_version: item.version,
        p_issues: []
      })
    )
  )
  if (validation.validationStatus !== 'valid') throw new Error('Demo validation was not recorded')
  const prepared = record(
    requireData(
      await database.rpc(
        'bff_release_prepare_snapshot',
        {
          p_actor: manifest.actor,
          p_interface: item.id,
          p_purpose: 'publish'
        },
        { get: true }
      )
    )
  )
  const snapshot = interfaceInput(record(prepared.snapshot))
  const targets = prepared.targets
  if (
    !Array.isArray(targets) ||
    targets.length !== 1 ||
    !isObjectRecord(targets[0]) ||
    targets[0].readinessCode !== 'ready' ||
    releaseDefinitionIssues(snapshot).length
  )
    throw new Error('Demo release target is not ready')
  const step = snapshot.definition.steps[0]
  if (step.upstreamId !== manifest.upstreamIds[kind]) throw new Error('Demo step target changed')
  const target = decodePublishedTarget(
    { tenant_id: manifest.tenant },
    snapshot,
    step,
    targets[0],
    true
  )
  const tested = await runInterface(
    { ...snapshot, id: item.id, version: item.version },
    runInput,
    async () => target
  )
  const output = tested.output as InterfacePageResult
  if (
    !tested.passed ||
    !Array.isArray(output.records) ||
    output.records.length !== 2 ||
    output.total !== 2 ||
    output.current !== 1 ||
    output.size !== 2 ||
    output.records.some((row) => Object.keys(row).sort().join(',') !== 'id,name')
  )
    throw new Error(`Demo ${kind} did not return the expected safe two-row page`)
  const recorded = record(
    requireData(
      await database.rpc('bff_record_interface_test', {
        p_actor: manifest.actor,
        p_id: item.id,
        p_version: item.version,
        p_passed: tested.passed,
        p_upstream_versions: [
          {
            id: target.observed.id,
            configVersion: target.observed.configVersion,
            credentialVersion: target.observed.credentialVersion
          }
        ]
      })
    )
  )
  if (recorded.stale === true) throw new Error('Demo upstream changed during test')
  const ready = record(
    requireData(
      await database.rpc(
        'bff_release_prepare_snapshot',
        {
          p_actor: manifest.actor,
          p_interface: item.id,
          p_purpose: 'publish'
        },
        { get: true }
      )
    )
  )
  const release = releaseRecordDto(record(ready.record))
  const observations = [target.observed]
  const scopedReady = checked(
    await database.rpc(
      'bff_release_targets_ready',
      {
        p_interface: item.id,
        p_version_id: null,
        p_observed: observations,
        p_publish: true
      },
      { get: true }
    )
  )
  if (
    ready.routeConflict !== false ||
    ready.validatedVersion !== item.version ||
    release.validationStatus !== 'valid' ||
    release.lastTestStatus !== 'passed' ||
    release.lastTestVersion !== item.version ||
    !scopedReady
  )
    throw new Error('Demo release readiness did not pass')
  if (release.deployment?.enabled) return
  checked(
    await database.rpc('bff_write_release', {
      p_actor: manifest.actor,
      p_operation: 'publish',
      p_interface: item.id,
      p_draft_version: item.version,
      p_deployment_version: release.deployment?.version ?? 0,
      p_target_version: null,
      p_notes: '本地演示：真实两行试运行后发布',
      p_upstream_versions: observations
    })
  )
  console.log(`Published local ${kind} page with two safe rows.`)
}
function demoResponder() {
  return createServer((req, res) => {
    const url = new URL(req.url || '/', responderOrigin)
    if (
      req.method !== 'GET' ||
      !kinds.some((kind) => url.pathname === `/${kind}`) ||
      url.searchParams.get('offset') !== '0' ||
      url.searchParams.get('limit') !== '2' ||
      req.headers.authorization ||
      req.headers.cookie
    ) {
      res.writeHead(400).end()
      return
    }
    const kind = url.pathname.slice(1) as Kind
    const rows = [1, 2].map((number) => ({
      id: `${kind}-${number}`,
      name: `${kind} 示例 ${number}`
    }))
    const value =
      kind === 'java'
        ? { code: 0, data: { records: rows, total: 2 } }
        : kind === 'cloudbase'
          ? { result: { code: 0, data: { list: rows, total: 2 } } }
          : rows
    if (kind === 'supabase' && req.headers.prefer !== 'count=exact') {
      res.writeHead(400).end()
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      ...(kind === 'supabase' ? { 'Content-Range': '0-1/2' } : {})
    })
    res.end(JSON.stringify(value))
  })
}
async function main(): Promise<void> {
  assertLocalPolicy()
  const subject = validUuid(process.env.BFF_DEMO_ADMIN_SUB)
  const actor = await activeAdmin(subject)
  if (process.argv[2] === '--stop' && !existsSync(manifestPath))
    throw new Error('No local demo manifest exists to stop')
  const manifest = readManifest(actor.id, actor.tenant)
  if (process.argv[2] === '--stop') {
    await disableApplication(manifest)
    return
  }
  if (process.argv.length > 2) throw new Error('Only --stop is supported')
  const responder = demoResponder()
  responder.listen(33445, '127.0.0.1')
  await once(responder, 'listening')
  try {
    const applicationId = await ensureApplication(manifest)
    for (const kind of kinds) {
      const upstream = await ensureUpstream(manifest, applicationId, kind)
      const item = await ensureInterface(manifest, applicationId, kind, upstream)
      await verifyAndPublish(manifest, kind, item)
    }
    const catalog: unknown = requireData(
      await database.rpc(
        'bff_pro_consumer_catalog',
        {
          p_actor: manifest.actor
        },
        { get: true }
      )
    )
    if (
      !Array.isArray(catalog) ||
      kinds.some(
        (kind) =>
          !catalog.some(
            (entry) =>
              isObjectRecord(entry) &&
              entry.applicationCode === appCode &&
              entry.code === sourceCode(kind)
          )
      )
    )
      throw new Error('Demo APIs missing from scoped catalog')
    console.log(
      'Three published local APIs are ready in Pro. Press Ctrl+C to disable the demo application.'
    )
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  } finally {
    try {
      await disableApplication(manifest)
    } finally {
      responder.closeAllConnections()
      await new Promise<void>((resolve) => responder.close(() => resolve()))
    }
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  await main()
