import { lookup as dnsLookup } from 'node:dns/promises'
import { Agent as HttpAgent, request as httpRequest, type ClientRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { performance } from 'node:perf_hooks'

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

async function resolveHost(
  hostname: string,
  resolver: UpstreamResolver
): Promise<readonly ResolvedAddress[]> {
  const family = isIP(hostname)
  return family ? [{ address: hostname, family }] : resolver(hostname)
}

function result(
  code: UpstreamProbeCode,
  started: number,
  statusCode: number | null = null
): UpstreamProbeResult {
  return {
    status: code === 'reachable' ? 'reachable' : 'failed',
    code,
    statusCode,
    durationMs: Math.max(0, Math.round(performance.now() - started))
  }
}

function networkRequest(
  url: URL,
  address: ResolvedAddress,
  timeoutMs: number,
  started: number,
  onRequest: (request: ClientRequest) => void
): Promise<UpstreamProbeResult> {
  const secure = url.protocol === 'https:'
  // A fresh agent with an empty proxy environment cannot inherit --use-env-proxy.
  const agent = secure
    ? new HttpsAgent({ keepAlive: false, proxyEnv: {} })
    : new HttpAgent({ keepAlive: false, proxyEnv: {} })
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  return new Promise((resolve) => {
    let settled = false
    const finish = (code: UpstreamProbeCode, statusCode: number | null = null) => {
      if (settled) return
      settled = true
      resolve(result(code, started, statusCode))
    }
    const request = (secure ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname,
        port: Number(url.port || (secure ? 443 : 80)),
        path: url.pathname,
        method: 'GET',
        agent,
        family: address.family,
        lookup: (_host, _options, callback) => callback(null, address.address, address.family),
        ...(secure ? { servername: isIP(hostname) ? '' : hostname, rejectUnauthorized: true } : {}),
        headers: { Accept: '*/*' },
        maxHeaderSize: 16 * 1024
      },
      (response) => {
        const statusCode = response.statusCode ?? null
        if (
          statusCode === null ||
          !Number.isInteger(statusCode) ||
          statusCode < 100 ||
          statusCode > 599
        ) {
          response.on('error', () => finish('connection_failed'))
          response.destroy()
          finish('connection_failed')
          return
        }
        if (statusCode >= 300 && statusCode < 400) {
          response.destroy()
          finish('redirect_blocked', statusCode)
          return
        }
        let received = 0
        response.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > MAX_RESPONSE_BYTES) {
            response.destroy()
            finish('response_too_large', statusCode)
          }
        })
        response.on('end', () => finish('reachable', statusCode))
        response.on('error', () => finish('connection_failed', statusCode))
      }
    )
    onRequest(request)
    request.setTimeout(timeoutMs, () => {
      request.destroy()
      finish('timeout')
    })
    request.on('error', () => finish('connection_failed'))
    request.end()
  })
}

/** A connection-only check: any non-redirect HTTP response is reachable, including 401. */
export async function probeUpstream(
  baseUrl: string,
  timeoutMs: number,
  policy: UpstreamNetworkPolicy,
  resolver: UpstreamResolver = (hostname) => dnsLookup(hostname, { all: true, order: 'verbatim' })
): Promise<UpstreamProbeResult> {
  const started = performance.now()
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
    return result('invalid_timeout', started)
  let url: URL
  try {
    url = new URL(normalizeUpstreamUrl(baseUrl, policy))
  } catch (error) {
    return result(error instanceof NetworkPolicyError ? error.code : 'invalid_url', started)
  }
  let activeRequest: ClientRequest | undefined
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<UpstreamProbeResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      activeRequest?.destroy()
      resolve(result('timeout', started))
    }, timeoutMs)
  })
  const operation = (async (): Promise<UpstreamProbeResult> => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    let resolved: readonly ResolvedAddress[]
    try {
      resolved = await resolveHost(hostname, resolver)
    } catch {
      return result('dns_failed', started)
    }
    if (timedOut) return result('timeout', started)
    if (!resolved.length) return result('dns_failed', started)
    const trusted = trustedCidrs(policy)
    const addresses = resolved.map((entry) => checkedAddress(entry.address, entry.family))
    if (addresses.some((address) => !addressAllowed(address, policy, trusted)))
      return result('target_blocked', started)
    try {
      return await networkRequest(url, addresses[0], timeoutMs, started, (request) => {
        activeRequest = request
        if (timedOut) request.destroy()
      })
    } catch {
      return result('connection_failed', started)
    }
  })()
  try {
    return await Promise.race([operation, deadline])
  } catch {
    return result('target_blocked', started)
  } finally {
    clearTimeout(timer)
  }
}
