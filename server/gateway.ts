import { hkdfSync, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { escapeRegExp } from 'lodash-es'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import type { InterfaceInputField, InterfaceScalar } from '../src/types/interface'
import type { GatewayResponse, PublishedExecution } from '../src/types/release'
import { requireMutation, type Member, type Session } from './auth'
import { config } from './config'
import { database } from './database/client'
import { interfaceInput, parseInterfaceSample } from './interface-definition'
import { runInterface } from './interface-runner'
import { body, HttpError, json } from './http'
import { decodePublishedTarget, type ReleaseUpstreamObservation } from './published-runtime'
import { digest, seal, unseal } from './security'

const appCodePattern = /^[a-z][a-z0-9-]{1,63}$/
const parameterPattern = /\{([A-Za-z][A-Za-z0-9_]{0,39})\}/g
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const gatewayPrefix = '/api/gateway/'

export interface GatewayMatch {
  published: PublishedExecution
  pathParams: Record<string, string>
}

function pathSegments(value: string): string[] {
  if (!value.startsWith('/') || value.startsWith('//') || value.length > 500)
    throw new HttpError(400, '调用路径格式有误')
  if (value === '/') return []
  const parts = value.slice(1).split('/')
  if (parts.some((part) => !part)) throw new HttpError(400, '调用路径格式有误')
  return parts.map((part) => {
    let decoded: string
    try {
      decoded = decodeURIComponent(part)
    } catch {
      throw new HttpError(400, '调用路径编码无效')
    }
    if (
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded.includes('%') ||
      decoded.length > 1024 ||
      Array.from(decoded).some((character) => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
      })
    )
      throw new HttpError(400, '调用路径包含无效参数')
    return decoded
  })
}

function matchSegment(
  template: string,
  incoming: string
): {
  params: Record<string, string>
  staticSegment: boolean
  literalLength: number
} | null {
  const parameters = [...template.matchAll(parameterPattern)]
  if (!parameters.length)
    return template === incoming
      ? { params: {}, staticSegment: true, literalLength: template.length }
      : null
  let pattern = '^'
  let cursor = 0
  let literalLength = 0
  for (const parameter of parameters) {
    const prefix = template.slice(cursor, parameter.index)
    pattern += `${escapeRegExp(prefix)}(.+?)`
    literalLength += prefix.length
    cursor = parameter.index + parameter[0].length
  }
  const suffix = template.slice(cursor)
  pattern += `${escapeRegExp(suffix)}$`
  literalLength += suffix.length
  const matched = new RegExp(pattern).exec(incoming)
  if (!matched) return null
  const params: Record<string, string> = {}
  let consistent = true
  parameters.forEach((parameter, index) => {
    const name = parameter[1]
    const value = matched[index + 1]
    if (Object.hasOwn(params, name) && params[name] !== value) consistent = false
    params[name] = value
  })
  if (!consistent) return null
  return { params, staticSegment: false, literalLength }
}

/** Static segments win over placeholders; input is decoded once and never treated as a URL. */
export function selectPublishedCandidate(
  candidates: readonly PublishedExecution[],
  requestedPath: string
): GatewayMatch | null {
  const incoming = pathSegments(requestedPath)
  const matches: Array<GatewayMatch & { staticCount: number; literalLength: number }> = []
  for (const published of candidates) {
    if (!published.path.startsWith('/') || published.path.length > 500) continue
    const template = published.path === '/' ? [] : published.path.slice(1).split('/')
    if (template.length !== incoming.length) continue
    const pathParams: Record<string, string> = {}
    let staticCount = 0
    let literalLength = 0
    let valid = true
    template.forEach((part, index) => {
      const segment = matchSegment(part, incoming[index])
      if (!segment) {
        valid = false
        return
      }
      Object.assign(pathParams, segment.params)
      if (segment.staticSegment) staticCount += 1
      literalLength += segment.literalLength
    })
    if (valid) matches.push({ published, pathParams, staticCount, literalLength })
  }
  matches.sort(
    (a, b) =>
      b.staticCount - a.staticCount ||
      b.literalLength - a.literalLength ||
      a.published.path.localeCompare(b.published.path) ||
      a.published.interfaceId.localeCompare(b.published.interfaceId)
  )
  return matches[0] ?? null
}

function scalarFromUrl(field: InterfaceInputField, value: string): InterfaceScalar {
  if (field.type === 'string') return value
  if (field.type === 'boolean') {
    if (value !== 'true' && value !== 'false')
      throw new HttpError(400, `「${field.label}」需为 true 或 false`)
    return value === 'true'
  }
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    throw new HttpError(400, `「${field.label}」需为有效数字`)
  const number = Number(value)
  if (!Number.isFinite(number) || Math.abs(number) > 1e12)
    throw new HttpError(400, `「${field.label}」超出允许范围`)
  return number
}

export function parseGatewayInput(
  published: PublishedExecution,
  pathParams: Record<string, string>,
  query: URLSearchParams,
  bodyValue: Record<string, unknown>
): Record<string, InterfaceScalar> {
  const fields = published.definition.inputs
  const supplied: Record<string, unknown> = {}
  const pathFields = new Map(
    fields.filter((field) => field.location === 'path').map((field) => [field.key, field])
  )
  const queryFields = new Map(
    fields.filter((field) => field.location === 'query').map((field) => [field.key, field])
  )
  const bodyFields = new Set(
    fields.filter((field) => field.location === 'body').map((field) => field.key)
  )
  for (const [key, value] of Object.entries(pathParams)) {
    const field = pathFields.get(key)
    if (!field) throw new HttpError(400, '调用路径包含未声明的参数')
    supplied[key] = scalarFromUrl(field, value)
  }
  const queryKeys = new Set<string>()
  for (const [key, value] of query) {
    const field = queryFields.get(key)
    if (!field || queryKeys.has(key)) throw new HttpError(400, '查询参数未声明或重复')
    queryKeys.add(key)
    supplied[key] = scalarFromUrl(field, value)
  }
  for (const [key, value] of Object.entries(bodyValue)) {
    if (!bodyFields.has(key)) throw new HttpError(400, '请求体包含未声明的参数')
    supplied[key] = value
  }
  return parseInterfaceSample(fields, supplied)
}

export function gatewayInputHash(
  published: PublishedExecution,
  input: Record<string, InterfaceScalar>
): string {
  return digest(
    JSON.stringify({
      versionId: published.versionId,
      method: published.method,
      path: published.path,
      input: published.definition.inputs
        .filter((field) => Object.hasOwn(input, field.key))
        .map((field) => [field.key, input[field.key]])
    })
  )
}

function replayKey(encodedSessionKey: string): string {
  const sessionKey = Buffer.from(encodedSessionKey, 'base64')
  if (sessionKey.length !== 32) throw new Error('Gateway replay key source is invalid')
  return Buffer.from(
    hkdfSync('sha256', sessionKey, Buffer.from('art-supabase-bff'), 'bff-gateway-replay-v1', 32)
  ).toString('base64')
}

function replayAad(member: Member, published: PublishedExecution, requestId: string): string {
  return JSON.stringify({
    purpose: 'bff-gateway-replay-v1',
    tenantId: member.tenant_id,
    memberId: member.id,
    applicationId: published.applicationId,
    requestId,
    versionId: published.versionId,
    deploymentVersion: published.deploymentVersion
  })
}

export function sealGatewayReplay(
  session: Session,
  published: PublishedExecution,
  result: GatewayResponse,
  encodedSessionKey = config.sessionKey
): string {
  return sealGatewayReplayForMember(session.member, published, result, encodedSessionKey)
}

function sealGatewayReplayForMember(
  member: Member,
  published: PublishedExecution,
  result: GatewayResponse,
  encodedSessionKey = config.sessionKey
): string {
  return seal(result, replayKey(encodedSessionKey), replayAad(member, published, result.requestId))
}

export function openGatewayReplay(
  session: Session,
  published: PublishedExecution,
  requestId: string,
  ciphertext: string,
  encodedSessionKey = config.sessionKey
): GatewayResponse {
  return openGatewayReplayForMember(
    session.member,
    published,
    requestId,
    ciphertext,
    encodedSessionKey
  )
}

function openGatewayReplayForMember(
  member: Member,
  published: PublishedExecution,
  requestId: string,
  ciphertext: string,
  encodedSessionKey = config.sessionKey
): GatewayResponse {
  const value: unknown = unseal(
    ciphertext,
    replayKey(encodedSessionKey),
    replayAad(member, published, requestId)
  )
  if (
    !isObjectRecord(value) ||
    value.requestId !== requestId ||
    value.version !== published.versionNumber ||
    !isObjectRecord(value.data)
  )
    throw new Error('Invalid gateway replay')
  const scalar = (item: unknown): item is InterfaceScalar =>
    item === null ||
    typeof item === 'boolean' ||
    (typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1e12) ||
    (typeof item === 'string' && item.length <= 1024)
  let data: GatewayResponse['data']
  if (published.definition.page) {
    const page = value.data
    const fields = published.definition.page.fields.map((field) => field.target)
    if (
      !Array.isArray(page.records) ||
      page.records.length > 100 ||
      !Number.isSafeInteger(page.total) ||
      typeof page.total !== 'number' ||
      page.total < 0 ||
      page.total > 1e12 ||
      !Number.isSafeInteger(page.current) ||
      typeof page.current !== 'number' ||
      page.current < 1 ||
      page.current > 1_000_000 ||
      !Number.isSafeInteger(page.size) ||
      typeof page.size !== 'number' ||
      page.size < 1 ||
      page.size > 100 ||
      page.records.length > page.size ||
      Object.keys(page).some((key) => !['records', 'total', 'current', 'size'].includes(key)) ||
      page.records.some(
        (row: unknown) =>
          !isObjectRecord(row) ||
          Object.keys(row).length !== fields.length ||
          Object.keys(row).some((key) => !fields.includes(key) || !scalar(row[key]))
      ) ||
      Buffer.byteLength(JSON.stringify(page), 'utf8') > 64 * 1024
    )
      throw new Error('Invalid gateway replay page')
    data = page as GatewayResponse['data']
  } else {
    if (Object.keys(value.data).length > 32) throw new Error('Invalid gateway replay data')
    const mapped: Record<string, InterfaceScalar> = {}
    for (const [key, item] of Object.entries(value.data)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key) || !scalar(item))
        throw new Error('Invalid gateway replay data')
      mapped[key] = item
    }
    data = mapped
  }
  if (value.code !== undefined && value.code !== 200) throw new Error('Invalid gateway replay code')
  if (value.msg !== undefined && value.msg !== '成功')
    throw new Error('Invalid gateway replay message')
  return {
    requestId,
    version: published.versionNumber,
    data,
    ...(value.code === 200 ? { code: 200 as const } : {}),
    ...(value.msg === '成功' ? { msg: '成功' } : {})
  }
}

function publishedExecution(value: unknown): PublishedExecution {
  if (
    !isObjectRecord(value) ||
    typeof value.interfaceId !== 'string' ||
    !uuidPattern.test(value.interfaceId) ||
    typeof value.versionId !== 'string' ||
    !uuidPattern.test(value.versionId) ||
    !Number.isSafeInteger(value.versionNumber) ||
    Number(value.versionNumber) < 1 ||
    !Number.isSafeInteger(value.deploymentVersion) ||
    Number(value.deploymentVersion) < 1
  )
    throw new Error('Invalid published interface')
  let definition: ReturnType<typeof interfaceInput>
  try {
    definition = interfaceInput(value)
  } catch {
    throw new HttpError(503, '发布定义暂不可用，请稍后重试', 'GATEWAY_UNAVAILABLE')
  }
  return {
    ...definition,
    interfaceId: value.interfaceId,
    versionId: value.versionId,
    versionNumber: Number(value.versionNumber),
    deploymentVersion: Number(value.deploymentVersion)
  }
}

export function parseGatewayRoute(req: Pick<IncomingMessage, 'url' | 'method'>): {
  appCode: string
  environment: 'development' | 'staging' | 'production'
  path: string
  query: URLSearchParams
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
} {
  const raw = req.url || ''
  if (
    raw.length > 8192 ||
    raw.includes('#') ||
    /%(?![0-9a-f]{2})/i.test(raw) ||
    Array.from(raw).some((character) => character.charCodeAt(0) < 32)
  )
    throw new HttpError(400, '调用地址格式有误', 'INVALID_INPUT')
  const separator = raw.indexOf('?')
  const rawPath = separator === -1 ? raw : raw.slice(0, separator)
  const rawQuery = separator === -1 ? '' : raw.slice(separator + 1)
  if (!rawPath.startsWith(gatewayPrefix)) throw new HttpError(404, '接口地址不存在', 'NOT_FOUND')
  const parts = rawPath.slice(gatewayPrefix.length).split('/')
  const appCode = parts.shift() || ''
  const environment = parts.shift() || ''
  const path = `/${parts.join('/')}`
  if (
    !appCodePattern.test(appCode) ||
    !['development', 'staging', 'production'].includes(environment) ||
    parts.length === 0
  )
    throw new HttpError(400, '调用地址格式有误', 'INVALID_INPUT')
  pathSegments(path)
  const method = req.method
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method || ''))
    throw new HttpError(405, '调用方法不受支持', 'METHOD_NOT_ALLOWED')
  if (environment !== 'development' && environment !== 'staging' && environment !== 'production')
    throw new HttpError(400, '运行环境无效', 'INVALID_INPUT')
  if (
    method !== 'GET' &&
    method !== 'POST' &&
    method !== 'PUT' &&
    method !== 'PATCH' &&
    method !== 'DELETE'
  )
    throw new HttpError(405, '调用方法不受支持', 'METHOD_NOT_ALLOWED')
  return { appCode, environment, path, query: new URLSearchParams(rawQuery), method }
}

function rpcFailure(error: { code?: string; message?: string } | null): void {
  if (!error) return
  const messages: Record<string, [number, string, string]> = {
    BFF_FORBIDDEN: [403, '当前账号没有调用此接口的权限', 'FORBIDDEN'],
    BFF_NOT_FOUND: [404, '接口不存在或当前账号不可访问', 'NOT_FOUND'],
    BFF_CONFLICT: [409, '发布版本已变化，请重新发起调用', 'DEPLOYMENT_CHANGED'],
    BFF_GATEWAY_RATE_LIMIT: [429, '调用过于频繁，请稍后重试', 'RATE_LIMITED'],
    BFF_GATEWAY_CONCURRENCY_LIMIT: [429, '当前并发调用较多，请稍后重试', 'CONCURRENCY_LIMIT'],
    BFF_IDEMPOTENCY_REQUIRED: [400, '写请求须提供请求编号', 'INVALID_INPUT'],
    BFF_IDEMPOTENCY_CONFLICT: [
      409,
      '该请求编号已用于其他调用，请换用新编号',
      'IDEMPOTENCY_CONFLICT'
    ],
    BFF_INVALID_REQUEST: [400, '调用内容格式有误', 'INVALID_INPUT'],
    BFF_INVALID_RESULT: [503, '调用结果暂不可确认，请稍后核对', 'RESULT_UNKNOWN'],
    BFF_INVALID_STEP_KEYS: [503, '发布步骤暂不可用，请稍后重试', 'GATEWAY_UNAVAILABLE'],
    BFF_RELEASE_UPSTREAM_CHANGED: [409, '上游配置或凭据已变化，请核对后再操作', 'UPSTREAM_CHANGED']
  }
  const known =
    error.message && Object.hasOwn(messages, error.message) ? messages[error.message] : undefined
  if (known) throw new HttpError(known[0], known[1], known[2])
  throw new HttpError(503, '网关暂时无法完成权限或配额检查，请稍后重试', 'GATEWAY_UNAVAILABLE')
}

function asGatewayKind(value: unknown): {
  kind: 'started' | 'running' | 'replay' | 'unknown'
  requestId: string
  versionNumber: number
  resultPayload?: string
} {
  if (
    !isObjectRecord(value) ||
    !['started', 'running', 'replay', 'unknown'].includes(String(value.kind)) ||
    typeof value.requestId !== 'string' ||
    !uuidPattern.test(value.requestId) ||
    !Number.isSafeInteger(value.versionNumber) ||
    Number(value.versionNumber) < 1 ||
    (value.resultPayload !== undefined &&
      value.resultPayload !== null &&
      typeof value.resultPayload !== 'string')
  )
    throw new HttpError(503, '网关调用状态暂不可用，请稍后重试', 'GATEWAY_UNAVAILABLE')
  const kind = value.kind
  if (kind !== 'started' && kind !== 'running' && kind !== 'replay' && kind !== 'unknown')
    throw new HttpError(503, '网关调用状态暂不可用，请稍后重试', 'GATEWAY_UNAVAILABLE')
  return {
    kind,
    requestId: value.requestId,
    versionNumber: Number(value.versionNumber),
    ...(typeof value.resultPayload === 'string' ? { resultPayload: value.resultPayload } : {})
  }
}

async function readGatewayBody(
  req: IncomingMessage,
  method: string
): Promise<Record<string, unknown>> {
  if (method === 'GET') {
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0)
      throw new HttpError(400, 'GET 调用不能包含请求体', 'INVALID_INPUT')
    return {}
  }
  if (!req.headers['transfer-encoding'] && Number(req.headers['content-length'] || 0) === 0)
    return {}
  return body(req, 64 * 1024)
}

function sameObservation(a: ReleaseUpstreamObservation, b: ReleaseUpstreamObservation): boolean {
  return (
    a.id === b.id &&
    a.configVersion === b.configVersion &&
    a.currentConfigVersion === b.currentConfigVersion &&
    a.credentialVersion === b.credentialVersion
  )
}

/** Persist only bounded SQL-safe step codes; runner/network labels remain unchanged. */
export function gatewayStepCode(code: string | null): string | null {
  if (!code) return null
  const normalized = code.toUpperCase()
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(normalized) ? normalized : 'STEP_FAILED'
}

export type ProBridgeInvocation =
  | { operation: 'catalog' }
  | {
      operation: 'invoke'
      applicationCode: string
      environment: 'development' | 'staging' | 'production'
      path: string
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
      query: Record<string, InterfaceScalar>
      body: Record<string, InterfaceScalar>
      idempotencyKey?: string
    }

function bridgeRequest(value: ProBridgeInvocation): {
  route: ReturnType<typeof parseGatewayRoute>
  supplied: Record<string, unknown>
  idempotencyKey: string | undefined
} {
  if (
    value.operation !== 'invoke' ||
    typeof value.path !== 'string' ||
    !appCodePattern.test(value.applicationCode) ||
    !['development', 'staging', 'production'].includes(value.environment) ||
    !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(value.method) ||
    !isObjectRecord(value.query) ||
    !isObjectRecord(value.body) ||
    Object.keys(value.query).length > 32 ||
    Object.keys(value.body).length > 32 ||
    (value.idempotencyKey !== undefined &&
      (typeof value.idempotencyKey !== 'string' || !uuidPattern.test(value.idempotencyKey))) ||
    (value.method === 'GET' && Object.keys(value.body).length > 0)
  )
    throw new HttpError(400, '桥接调用内容格式有误', 'INVALID_INPUT')
  pathSegments(value.path)
  const query = new URLSearchParams()
  for (const [key, item] of Object.entries(value.query)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key) ||
      (item !== null &&
        typeof item !== 'string' &&
        typeof item !== 'number' &&
        typeof item !== 'boolean') ||
      (typeof item === 'number' && (!Number.isFinite(item) || Math.abs(item) > 1e12)) ||
      (typeof item === 'string' && item.length > 1024)
    )
      throw new HttpError(400, '桥接查询参数格式有误', 'INVALID_INPUT')
    query.append(key, item === null ? '' : String(item))
  }
  for (const [key, item] of Object.entries(value.body)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key) ||
      (item !== null &&
        typeof item !== 'string' &&
        typeof item !== 'number' &&
        typeof item !== 'boolean') ||
      (typeof item === 'number' && (!Number.isFinite(item) || Math.abs(item) > 1e12)) ||
      (typeof item === 'string' && item.length > 1024)
    )
      throw new HttpError(400, '桥接请求体格式有误', 'INVALID_INPUT')
  }
  return {
    route: {
      appCode: value.applicationCode,
      environment: value.environment,
      path: value.path,
      method: value.method,
      query
    },
    supplied: value.body,
    idempotencyKey: value.idempotencyKey
  }
}

/** Validate signed JSON payload without trusting TypeScript claims from the Edge caller. */
export function parseProBridgeInvocation(value: unknown): ProBridgeInvocation {
  if (!isObjectRecord(value)) throw new HttpError(400, '桥接调用内容格式有误', 'INVALID_INPUT')
  if (value.operation === 'catalog') {
    if (Object.keys(value).length !== 1)
      throw new HttpError(400, '接口目录请求不能包含其他参数', 'INVALID_INPUT')
    return { operation: 'catalog' }
  }
  if (
    value.operation !== 'invoke' ||
    Object.keys(value).some(
      (key) =>
        ![
          'operation',
          'applicationCode',
          'environment',
          'path',
          'method',
          'query',
          'body',
          'idempotencyKey'
        ].includes(key)
    )
  )
    throw new HttpError(400, '桥接调用内容格式有误', 'INVALID_INPUT')
  const invocation = value as ProBridgeInvocation
  bridgeRequest(invocation)
  return invocation
}

type GatewayPrincipal = { kind: 'cookie'; session: Session } | { kind: 'bridge'; member: Member }

/** Always responds with a server request ID. The caller has already authenticated the BFF session. */
export async function handleGateway(
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
  _url: URL,
  initialRequestId: string
): Promise<void> {
  await gatewayCore(req, res, { kind: 'cookie', session }, undefined, initialRequestId)
}

/** The caller must verify the signed pro assertion and consume its nonce first. */
export async function handleBridgeGateway(
  req: IncomingMessage,
  res: ServerResponse,
  member: Member,
  invocation: ProBridgeInvocation,
  requestId: string
): Promise<void> {
  if (invocation.operation === 'catalog') {
    res.setHeader('X-Request-Id', requestId)
    try {
      const result = await database.rpc(
        'bff_pro_consumer_catalog',
        { p_actor: member.id },
        { get: true }
      )
      rpcFailure(result.error)
      if (
        !Array.isArray(result.data) ||
        result.data.length > 500 ||
        Buffer.byteLength(JSON.stringify(result.data), 'utf8') > 2 * 1024 * 1024
      )
        throw new HttpError(503, '接口目录暂不可用', 'GATEWAY_UNAVAILABLE')
      json(res, { records: result.data })
    } catch (error) {
      const known = error instanceof HttpError
      const message = known ? error.message : '接口目录暂不可用，请稍后重试'
      json(
        res,
        { code: known ? error.code : 'GATEWAY_UNAVAILABLE', message, msg: message, requestId },
        known ? error.status : 503
      )
    }
    return
  }
  await gatewayCore(req, res, { kind: 'bridge', member }, invocation, requestId)
}

async function gatewayCore(
  req: IncomingMessage,
  res: ServerResponse,
  principal: GatewayPrincipal,
  invocation: ProBridgeInvocation | undefined,
  initialRequestId: string
): Promise<void> {
  const member = principal.kind === 'cookie' ? principal.session.member : principal.member
  let requestId = uuidPattern.test(initialRequestId) ? initialRequestId : randomUUID()
  let writeStarted = false
  res.setHeader('X-Request-Id', requestId)
  try {
    const bridged = principal.kind === 'bridge' && invocation ? bridgeRequest(invocation) : null
    if (principal.kind === 'bridge' && !bridged)
      throw new HttpError(400, '桥接调用内容格式有误', 'INVALID_INPUT')
    const route = bridged?.route ?? parseGatewayRoute(req)
    if (principal.kind === 'cookie' && route.method !== 'GET')
      requireMutation(req, principal.session)
    const idempotencyKey =
      principal.kind === 'bridge' ? bridged?.idempotencyKey : req.headers['idempotency-key']
    if (
      route.method !== 'GET' &&
      (typeof idempotencyKey !== 'string' || !uuidPattern.test(idempotencyKey))
    )
      throw new HttpError(400, '写请求须提供 UUID 格式的 Idempotency-Key', 'INVALID_INPUT')
    if (
      principal.kind === 'cookie' &&
      route.method === 'GET' &&
      (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0)
    )
      throw new HttpError(400, 'GET 调用不能包含请求体', 'INVALID_INPUT')
    const candidates = await database.rpc(
      'bff_gateway_candidates',
      {
        p_actor: member.id,
        p_app_code: route.appCode,
        p_environment: route.environment,
        p_method: route.method,
        p_path: route.path
      },
      { get: true }
    )
    rpcFailure(candidates.error)
    if (!Array.isArray(candidates.data))
      throw new HttpError(503, '发布路由暂不可用，请稍后重试', 'GATEWAY_UNAVAILABLE')
    const published = candidates.data.map(publishedExecution)
    const selected = selectPublishedCandidate(published, route.path)
    if (!selected || selected.published.method !== route.method)
      throw new HttpError(404, '接口地址不存在', 'NOT_FOUND')
    const execution = selected.published
    if (route.method === 'GET' && execution.definition.steps.some((step) => step.method !== 'GET'))
      throw new HttpError(409, '发布接口包含写操作，暂不能通过 GET 调用', 'DEPLOYMENT_CHANGED')
    if (route.method !== 'GET') {
      const authorized = await database.rpc(
        'bff_actor_can',
        {
          p_actor: member.id,
          p_permission: 'BffInterface:InvokeWrite'
        },
        { get: true }
      )
      rpcFailure(authorized.error)
      if (authorized.data !== true) throw new HttpError(403, '当前账号没有写调用权限', 'FORBIDDEN')
    }
    const supplied = bridged?.supplied ?? (await readGatewayBody(req, route.method))
    const input = parseGatewayInput(execution, selected.pathParams, route.query, supplied)
    const inputHash = gatewayInputHash(execution, input)
    const idempotencyHash =
      route.method === 'GET' || typeof idempotencyKey !== 'string'
        ? null
        : digest(`${member.tenant_id}\0${member.id}\0${idempotencyKey.toLowerCase()}`)
    const beginAttemptAt = Date.now()
    const executionDeadline = beginAttemptAt + 30_000
    const begunResult = await database
      .rpc('bff_gateway_begin', {
        p_actor: member.id,
        p_interface: execution.interfaceId,
        p_version_id: execution.versionId,
        p_deployment_version: execution.deploymentVersion,
        p_request_id: requestId,
        p_idempotency_hash: idempotencyHash,
        p_input_hash: inputHash
      })
      .abortSignal(AbortSignal.timeout(30_000))
    rpcFailure(begunResult.error)
    const begun = asGatewayKind(begunResult.data)
    requestId = begun.requestId
    res.setHeader('X-Request-Id', requestId)
    if (begun.versionNumber !== execution.versionNumber)
      throw new HttpError(409, '发布版本已变化，请重新发起调用', 'DEPLOYMENT_CHANGED')
    if (begun.kind === 'running') {
      json(
        res,
        {
          code: 'IN_PROGRESS',
          message: '相同请求正在执行，请稍后查询结果',
          msg: '相同请求正在执行，请稍后查询结果',
          requestId
        },
        202
      )
      return
    }
    if (begun.kind === 'unknown')
      throw new HttpError(409, '原请求结果未确认；请根据请求编号核对结果后再操作', 'RESULT_UNKNOWN')
    if (begun.kind === 'replay') {
      if (!begun.resultPayload)
        throw new HttpError(503, '历史调用结果暂不可用，请联系管理员', 'REPLAY_UNAVAILABLE')
      let replay: GatewayResponse
      try {
        replay = openGatewayReplayForMember(member, execution, requestId, begun.resultPayload)
      } catch {
        throw new HttpError(503, '历史调用结果暂不可用，请联系管理员', 'REPLAY_UNAVAILABLE')
      }
      json(res, replay)
      return
    }
    writeStarted = route.method !== 'GET'

    const observations = new Map<string, ReleaseUpstreamObservation>()
    const budget = (requestedMs = 30_000): number => {
      const remaining = Math.min(requestedMs, executionDeadline - Date.now())
      if (remaining <= 0)
        throw new HttpError(504, '调用时间已用尽，请根据请求编号核对结果', 'RESULT_UNKNOWN')
      return Math.max(1, remaining)
    }
    const loadTargets = async (
      steps: readonly PublishedExecution['definition']['steps'][number][],
      remainingMs: number
    ) => {
      const targetStarted = Date.now()
      const current = await database
        .rpc(
          'bff_gateway_step_targets',
          {
            p_actor: member.id,
            p_interface: execution.interfaceId,
            p_version_id: execution.versionId,
            p_deployment_version: execution.deploymentVersion,
            p_step_keys: steps.map((step) => step.key)
          },
          { get: true }
        )
        .abortSignal(AbortSignal.timeout(budget(remainingMs)))
      rpcFailure(current.error)
      if (!Array.isArray(current.data) || current.data.length !== steps.length)
        throw new HttpError(503, '发布步骤暂不可用，请稍后重试', 'GATEWAY_UNAVAILABLE')
      const byKey = new Map<string, unknown>()
      for (const item of current.data) {
        if (!isObjectRecord(item) || typeof item.stepKey !== 'string' || byKey.has(item.stepKey))
          throw new HttpError(503, '发布步骤暂不可用，请稍后重试', 'GATEWAY_UNAVAILABLE')
        byKey.set(item.stepKey, item)
      }
      return steps.map((step) => {
        const target = decodePublishedTarget(member, execution, step, byKey.get(step.key))
        const previous = observations.get(target.observed.id)
        if (previous && !sameObservation(previous, target.observed))
          throw new HttpError(409, '上游配置或凭据已变化，本次调用结果不可确认', 'UPSTREAM_CHANGED')
        observations.set(target.observed.id, target.observed)
        return {
          ...target,
          timeoutMs: Math.min(target.timeoutMs, budget(remainingMs - (Date.now() - targetStarted)))
        }
      })
    }
    const loadTarget = async (
      step: PublishedExecution['definition']['steps'][number],
      remainingMs: number
    ) => (await loadTargets([step], remainingMs))[0]
    const executionResult = await runInterface(
      {
        id: execution.interfaceId,
        version: execution.versionNumber,
        applicationId: execution.applicationId,
        environment: execution.environment,
        code: execution.code,
        name: execution.name,
        description: execution.description,
        method: execution.method,
        path: execution.path,
        definition: execution.definition
      },
      input,
      loadTarget,
      { preflight: loadTargets }
    )
    const passed = executionResult.passed
    const gatewayResponse: GatewayResponse = {
      requestId,
      version: execution.versionNumber,
      code: 200,
      msg: '成功',
      data: executionResult.output
    }
    const status = passed ? 200 : 502
    const finished = await database
      .rpc('bff_gateway_finish', {
        p_actor: member.id,
        p_request_id: requestId,
        p_success: passed,
        p_http_status: status,
        p_duration_ms: executionResult.durationMs,
        p_error_code: passed ? null : 'UPSTREAM_FAILED',
        p_steps: executionResult.steps.map((step) => ({
          key: step.key,
          status: step.status,
          code: gatewayStepCode(step.code),
          errorClass: step.errorClass,
          statusCode: step.statusCode,
          durationMs: step.durationMs
        })),
        p_result_payload: passed
          ? sealGatewayReplayForMember(member, execution, gatewayResponse)
          : null,
        p_upstream_versions: [...observations.values()],
        p_error_class: passed ? null : (executionResult.errorClass ?? 'unknown')
      })
      .abortSignal(AbortSignal.timeout(10_000))
    rpcFailure(finished.error)
    if (!isObjectRecord(finished.data) || typeof finished.data.stale !== 'boolean')
      throw new HttpError(503, '调用结果暂不可确认，请稍后核对', 'RESULT_UNKNOWN')
    if (finished.data.stale)
      throw new HttpError(409, '发布或权限状态已变化，请根据请求编号核对调用结果', 'RESULT_UNKNOWN')
    if (!passed)
      throw new HttpError(502, '上游调用未完成，请根据请求编号核对调用日志', 'UPSTREAM_FAILED')
    json(res, gatewayResponse)
  } catch (error) {
    const known = error instanceof HttpError
    const resultUnknown = writeStarted
    const message = resultUnknown
      ? '上游可能已执行，请根据请求编号核对结果后再操作'
      : known
        ? error.message
        : '网关暂时无法完成调用，请稍后重试'
    json(
      res,
      {
        code: resultUnknown ? 'RESULT_UNKNOWN' : known ? error.code : 'GATEWAY_UNAVAILABLE',
        message,
        msg: message,
        requestId
      },
      resultUnknown ? 409 : known ? error.status : 503
    )
  }
}
