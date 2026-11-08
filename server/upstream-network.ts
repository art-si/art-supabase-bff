import { lookup as dnsLookup } from 'node:dns/promises'
import { Agent as HttpAgent, request as httpRequest, type ClientRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { performance } from 'node:perf_hooks'
import { MIMEType, TextDecoder } from 'node:util'

export interface UpstreamNetworkPolicy {
  allowedOrigins: readonly string[]
  allowedCidrs: readonly string[]
  allowLocalHttp: boolean
  production: boolean
}

export type UpstreamProbeCode =
  | 'reachable'
  | 'invalid_url'
  | 'invalid_policy'
  | 'invalid_timeout'
  | 'target_not_allowed'
  | 'target_blocked'
  | 'dns_failed'
  | 'connection_failed'
  | 'timeout'
  | 'redirect_blocked'
  | 'response_too_large'

export interface UpstreamProbeResult {
  status: 'reachable' | 'failed'
  code: UpstreamProbeCode
  statusCode: number | null
  durationMs: number
}

export type UpstreamExecutionCode = UpstreamProbeCode | 'invalid_response' | 'upstream_error'
export interface UpstreamExecutionRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  query: Record<string, string>
  body?: Record<string, unknown>
  credential?: { headerName: string; value: string }
  exactCount?: boolean
}
export interface UpstreamExecutionResult {
  ok: boolean
  code: UpstreamExecutionCode
  statusCode: number | null
  durationMs: number
  body: unknown | null
  contentRange?: string
}

interface ResolvedAddress {
  address: string
  family: number
}

/** The optional resolver is for isolated tests; production uses the OS resolver once. */
export type UpstreamResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>

class NetworkPolicyError extends Error {
  constructor(readonly code: UpstreamProbeCode) {
    super('上游地址或网络策略不符合安全要求')
  }
}

const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_EXECUTION_RESPONSE_BYTES = 256 * 1024
const MAX_REQUEST_BODY_BYTES = 64 * 1024
const MAX_EXECUTION_URL_LENGTH = 8 * 1024
const MAX_URL_LENGTH = 2048

function reject(code: UpstreamProbeCode): never {
  throw new NetworkPolicyError(code)
}

function rangeList(ranges: readonly (readonly [string, number])[]): BlockList {
  const list = new BlockList()
  for (const [network, prefix] of ranges) {
    list.addSubnet(network, prefix, isIP(network) === 4 ? 'ipv4' : 'ipv6')
  }
  return list
}

// Node's BlockList checks IPv4-mapped IPv6 addresses against IPv4 subnets too.
const metadata = rangeList([
  ['169.254.0.0', 16],
  ['168.63.129.16', 32],
  ['fe80::', 10],
  ['fd00:ec2::254', 128]
])
const loopback = rangeList([
  ['127.0.0.0', 8],
  ['::1', 128]
])
const privateNetworks = rangeList([
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['fc00::', 7]
])
const publicIpv6 = rangeList([['2000::', 3]])
const reserved = rangeList([
  ['0.0.0.0', 8],
  ['100.64.0.0', 10],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20]
])

function checkedAddress(address: string, family: number): ResolvedAddress {
  if (address.includes('%') || isIP(address) !== family) reject('target_blocked')
  return { address, family }
}

function addressType(address: ResolvedAddress): 'ipv4' | 'ipv6' {
  return address.family === 4 ? 'ipv4' : 'ipv6'
}

function matches(list: BlockList, address: ResolvedAddress): boolean {
  return list.check(address.address, addressType(address))
}

function trustedCidrs(policy: UpstreamNetworkPolicy): BlockList {
  const list = new BlockList()
  for (const cidr of policy.allowedCidrs) {
    const [network, prefixText, extra] = cidr.split('/')
    const family = isIP(network)
    const prefix = Number(prefixText)
    if (
      !network ||
      !prefixText ||
      extra !== undefined ||
      !/^\d{1,3}$/.test(prefixText) ||
      !family ||
      network.includes('%') ||
      prefix > (family === 4 ? 32 : 128)
    )
      reject('invalid_policy')
    list.addSubnet(network, prefix, family === 4 ? 'ipv4' : 'ipv6')
  }
  return list
}

/** Validate deploy-time egress policy before the server accepts traffic. */
export function validateUpstreamPolicy(policy: UpstreamNetworkPolicy): void {
  if (
    !policy ||
    typeof policy.production !== 'boolean' ||
    typeof policy.allowLocalHttp !== 'boolean' ||
    !Array.isArray(policy.allowedOrigins) ||
    !Array.isArray(policy.allowedCidrs) ||
    policy.allowedOrigins.some((origin) => typeof origin !== 'string') ||
    policy.allowedCidrs.some((cidr) => typeof cidr !== 'string') ||
    (policy.production && policy.allowLocalHttp)
  )
    reject('invalid_policy')
  for (const origin of policy.allowedOrigins) {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      reject('invalid_policy')
    }
    if (
      origin !== parsed.origin ||
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      (parsed.protocol === 'http:' &&
        (!policy.allowLocalHttp || !isLoopbackHost(parsed.hostname.replace(/^\[|\]$/g, ''))))
    )
      reject('invalid_policy')
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
    const family = isIP(hostname)
    if (
      (policy.production && isLoopbackHost(hostname)) ||
      (family !== 0 && matches(metadata, { address: hostname, family }))
    )
      reject('invalid_policy')
  }
  trustedCidrs(policy)
}

function addressAllowed(
  address: ResolvedAddress,
  policy: UpstreamNetworkPolicy,
  trusted: BlockList
): boolean {
  if (matches(metadata, address)) return false
  if (matches(loopback, address))
    return !policy.production && (policy.allowLocalHttp || matches(trusted, address))
  if (matches(privateNetworks, address)) return matches(trusted, address)
  if (matches(reserved, address)) return false
  return address.family === 4 || matches(publicIpv6, address)
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost') return true
  const family = isIP(hostname)
  return family !== 0 && matches(loopback, { address: hostname, family })
}

export function normalizeUpstreamUrl(value: string, policy?: UpstreamNetworkPolicy): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_URL_LENGTH ||
    value.includes('\\') ||
    Array.from(value).some((character) => character.charCodeAt(0) <= 32) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|2f|5c)/i.test(value)
  )
    reject('invalid_url')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    reject('invalid_url')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname ||
    url.hostname.includes('%')
  )
    reject('invalid_url')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (policy) {
    validateUpstreamPolicy(policy)
    if (!policy.allowedOrigins.includes(url.origin)) reject('target_not_allowed')
    if (url.protocol === 'http:' && (!policy.allowLocalHttp || !isLoopbackHost(hostname)))
      reject('target_blocked')
  } else if (url.protocol !== 'https:') {
    reject('target_blocked')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.href
}

/** Shared with upstream configuration validation; only managed bearer auth may use Authorization. */
export function isSafeCredentialHeader(name: string, allowAuthorization = false): boolean {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name)) return false
  if (name.toLowerCase() === 'authorization') return allowAuthorization
  return !/^(accept|accept-encoding|content-type|cookie|set-cookie|host|content-length|connection|origin|referer|user-agent|expect|proxy-.*|transfer-encoding|te|trailer|upgrade|forwarded|x-forwarded-.*)$/i.test(
    name
  )
}

function executionTarget(
  baseUrl: string,
  request: UpstreamExecutionRequest
): {
  url: URL
  headers: Record<string, string>
  body: Buffer | null
} {
  const base = new URL(baseUrl)
  const path = request.path
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.length > 2048 ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#') ||
    Array.from(path).some((character) => character.charCodeAt(0) <= 32)
  )
    reject('invalid_url')
  for (const segment of path.split('/').slice(1)) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      reject('invalid_url')
    }
    if (
      (segment === '' && path !== '/') ||
      segment === '.' ||
      segment === '..' ||
      decoded === '.' ||
      decoded === '..' ||
      /[/%\\?#]/.test(decoded) ||
      Array.from(decoded).some((character) => character.charCodeAt(0) < 32)
    )
      reject('invalid_url')
  }
  const prefix = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '')
  const url = new URL(base)
  url.pathname = `${prefix}${path}`
  if (url.origin !== base.origin || !url.pathname.startsWith(`${prefix}/`)) reject('invalid_url')

  if (
    !request.query ||
    typeof request.query !== 'object' ||
    Array.isArray(request.query) ||
    Object.keys(request.query).length > 32
  )
    reject('invalid_url')
  for (const [key, value] of Object.entries(request.query)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) ||
      typeof value !== 'string' ||
      value.length > 2048 ||
      Array.from(value).some((character) => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
      })
    )
      reject('invalid_url')
    url.searchParams.append(key, value)
  }
  if (url.href.length > MAX_EXECUTION_URL_LENGTH) reject('invalid_url')

  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) reject('invalid_policy')
  if (request.method === 'GET' && request.body !== undefined) reject('invalid_policy')
  if (request.exactCount && request.method !== 'GET') reject('invalid_policy')
  let body: Buffer | null = null
  if (request.body !== undefined) {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body))
      reject('invalid_policy')
    try {
      body = Buffer.from(JSON.stringify(request.body), 'utf8')
    } catch {
      reject('invalid_policy')
    }
    if (body.length > MAX_REQUEST_BODY_BYTES) reject('invalid_policy')
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Encoding': 'identity'
  }
  if (request.exactCount) headers.Prefer = 'count=exact'
  if (body) {
    headers['Content-Type'] = 'application/json; charset=utf-8'
    headers['Content-Length'] = String(body.length)
  }
  if (request.credential) {
    const { headerName, value } = request.credential
    if (
      !isSafeCredentialHeader(headerName, true) ||
      typeof value !== 'string' ||
      (headerName.toLowerCase() === 'authorization'
        ? !/^Bearer [\x21-\x7e]{1,8192}$/.test(value)
        : !/^[\x21-\x7e]{1,8192}$/.test(value))
    )
      reject('invalid_policy')
    headers[headerName] = value
  }
  return { url, headers, body }
}

async function resolveHost(
  hostname: string,
  resolver: UpstreamResolver
): Promise<readonly ResolvedAddress[]> {
  const family = isIP(hostname)
  return family ? [{ address: hostname, family }] : resolver(hostname)
}

interface TransportRequest {
  url: URL
  method: UpstreamExecutionRequest['method']
  headers: Record<string, string>
  body: Buffer | null
  mode: 'probe' | 'execute'
}

interface TransportOutcome {
  code: UpstreamExecutionCode
  statusCode: number | null
  durationMs: number
  body: unknown | null
  contentRange?: string
}

function outcome(
  code: UpstreamExecutionCode,
  started: number,
  statusCode: number | null = null,
  body: unknown | null = null,
  contentRange?: string
): TransportOutcome {
  return {
    code,
    statusCode,
    body,
    ...(contentRange ? { contentRange } : {}),
    durationMs: Math.max(0, Math.round(performance.now() - started))
  }
}

function jsonResponse(contentType: string | undefined, chunks: Buffer[]): unknown | null {
  let media: MIMEType
  try {
    media = new MIMEType(contentType || '')
  } catch {
    return null
  }
  const charset = media.params.get('charset')?.toLowerCase()
  if (
    !(
      media.essence === 'application/json' || /^application\/[a-z0-9.-]+\+json$/.test(media.essence)
    ) ||
    (charset && charset !== 'utf-8' && charset !== 'utf8')
  )
    return null
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    )
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function networkRequest(
  prepared: TransportRequest,
  address: ResolvedAddress,
  timeoutMs: number,
  started: number,
  onRequest: (request: ClientRequest) => void
): Promise<TransportOutcome> {
  const { url, method, headers, body, mode } = prepared
  const secure = url.protocol === 'https:'
  // A fresh agent with an empty proxy environment cannot inherit --use-env-proxy.
  const agent = secure
    ? new HttpsAgent({ keepAlive: false, proxyEnv: {} })
    : new HttpAgent({ keepAlive: false, proxyEnv: {} })
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  return new Promise((resolve) => {
    let settled = false
    const finish = (
      code: UpstreamExecutionCode,
      statusCode: number | null = null,
      responseBody: unknown | null = null,
      contentRange?: string
    ) => {
      if (settled) return
      settled = true
      resolve(outcome(code, started, statusCode, responseBody, contentRange))
    }
    const request = (secure ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname,
        port: Number(url.port || (secure ? 443 : 80)),
        path: `${url.pathname}${url.search}`,
        method,
        agent,
        family: address.family,
        lookup: (_host, _options, callback) => callback(null, address.address, address.family),
        ...(secure ? { servername: isIP(hostname) ? '' : hostname, rejectUnauthorized: true } : {}),
        headers,
        maxHeaderSize: 16 * 1024
      },
      (response) => {
        response.on('error', () => finish('connection_failed'))
        const statusCode = response.statusCode ?? null
        if (
          statusCode === null ||
          !Number.isInteger(statusCode) ||
          statusCode < 100 ||
          statusCode > 599
        ) {
          response.destroy()
          finish('connection_failed')
          return
        }
        if (statusCode >= 300 && statusCode < 400) {
          response.destroy()
          finish('redirect_blocked', statusCode)
          return
        }
        if (mode === 'execute' && (statusCode < 200 || statusCode >= 300)) {
          response.destroy()
          finish('upstream_error', statusCode)
          return
        }
        if (mode === 'execute') {
          const encoding = response.headers['content-encoding']?.toLowerCase()
          if (encoding && encoding !== 'identity') {
            response.destroy()
            finish('invalid_response', statusCode)
            return
          }
        }
        let received = 0
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > (mode === 'probe' ? MAX_RESPONSE_BYTES : MAX_EXECUTION_RESPONSE_BYTES)) {
            response.destroy()
            finish('response_too_large', statusCode)
          } else if (mode === 'execute') {
            chunks.push(chunk)
          }
        })
        response.on('end', () => {
          if (mode === 'probe') {
            finish('reachable', statusCode)
            return
          }
          if ((statusCode === 204 || statusCode === 205) && received === 0) {
            finish('reachable', statusCode, {})
            return
          }
          const rawRange = response.headers['content-range']
          const contentRange =
            typeof rawRange === 'string' && /^(?:[0-9]+-[0-9]+|\*)\/(?:[0-9]+|\*)$/.test(rawRange)
              ? rawRange
              : undefined
          const parsed = jsonResponse(response.headers['content-type'], chunks)
          if (parsed === null) finish('invalid_response', statusCode)
          else finish('reachable', statusCode, parsed, contentRange)
        })
      }
    )
    onRequest(request)
    request.setTimeout(timeoutMs, () => {
      request.destroy()
      finish('timeout')
    })
    request.on('error', () => finish('connection_failed'))
    request.end(body ?? undefined)
  })
}

async function throughPolicy(
  baseUrl: string,
  timeoutMs: number,
  policy: UpstreamNetworkPolicy,
  resolver: UpstreamResolver,
  prepare: (normalized: string) => TransportRequest
): Promise<TransportOutcome> {
  const started = performance.now()
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
    return outcome('invalid_timeout', started)
  let prepared: TransportRequest
  try {
    prepared = prepare(normalizeUpstreamUrl(baseUrl, policy))
  } catch (error) {
    return outcome(error instanceof NetworkPolicyError ? error.code : 'invalid_url', started)
  }
  let activeRequest: ClientRequest | undefined
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<TransportOutcome>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      activeRequest?.destroy()
      resolve(outcome('timeout', started))
    }, timeoutMs)
  })
  const operation = (async (): Promise<TransportOutcome> => {
    const hostname = prepared.url.hostname.replace(/^\[|\]$/g, '')
    let resolved: readonly ResolvedAddress[]
    try {
      resolved = await resolveHost(hostname, resolver)
    } catch {
      return outcome('dns_failed', started)
    }
    if (timedOut) return outcome('timeout', started)
    if (!resolved.length) return outcome('dns_failed', started)
    const trusted = trustedCidrs(policy)
    const addresses = resolved.map((entry) => checkedAddress(entry.address, entry.family))
    if (addresses.some((address) => !addressAllowed(address, policy, trusted)))
      return outcome('target_blocked', started)
    try {
      return await networkRequest(prepared, addresses[0], timeoutMs, started, (request) => {
        activeRequest = request
        if (timedOut) request.destroy()
      })
    } catch {
      return outcome('connection_failed', started)
    }
  })()
  try {
    return await Promise.race([operation, deadline])
  } catch {
    return outcome('target_blocked', started)
  } finally {
    clearTimeout(timer)
  }
}

/** A connection-only check: any non-redirect HTTP response is reachable, including 401. */
export async function probeUpstream(
  baseUrl: string,
  timeoutMs: number,
  policy: UpstreamNetworkPolicy,
  resolver: UpstreamResolver = (hostname) => dnsLookup(hostname, { all: true, order: 'verbatim' })
): Promise<UpstreamProbeResult> {
  const { code, statusCode, durationMs } = await throughPolicy(
    baseUrl,
    timeoutMs,
    policy,
    resolver,
    (normalized) => ({
      url: new URL(normalized),
      method: 'GET',
      headers: { Accept: '*/*' },
      body: null,
      mode: 'probe'
    })
  )
  return {
    status: code === 'reachable' ? 'reachable' : 'failed',
    code: code === 'invalid_response' || code === 'upstream_error' ? 'connection_failed' : code,
    statusCode,
    durationMs
  }
}

/** Server-only JSON exchange; callers must map successful bodies before responding to clients. */
export async function executeUpstreamRequest(
  baseUrl: string,
  request: UpstreamExecutionRequest,
  timeoutMs: number,
  policy: UpstreamNetworkPolicy,
  resolver: UpstreamResolver = (hostname) => dnsLookup(hostname, { all: true, order: 'verbatim' })
): Promise<UpstreamExecutionResult> {
  const { code, statusCode, durationMs, body, contentRange } = await throughPolicy(
    baseUrl,
    timeoutMs,
    policy,
    resolver,
    (normalized) => ({
      ...executionTarget(normalized, request),
      method: request.method,
      mode: 'execute'
    })
  )
  return {
    ok: code === 'reachable',
    code,
    statusCode,
    durationMs,
    body,
    ...(contentRange ? { contentRange } : {})
  }
}
