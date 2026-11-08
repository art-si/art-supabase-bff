import { performance } from 'node:perf_hooks'
import { get, isPlainObject } from 'lodash-es'
import { decodeResponseContract } from 'art-supabase-pro/src/utils/http/response-contract'
import type {
  InterfaceExecutionDefinition,
  InterfaceErrorClass,
  InterfacePageDefinition,
  InterfacePageResult,
  InterfaceScalar,
  InterfaceStep,
  InterfaceTestResult,
  InterfaceTestStep
} from '../src/types/interface'
import { HttpError } from './http'
import {
  mappedFields,
  pointerSegments,
  stepPath,
  validateInterfaceDefinition
} from './interface-definition'
import { executeUpstreamRequest, type UpstreamNetworkPolicy } from './upstream-network'
import { upstreamPolicy } from './upstream-runtime'

export interface InterfaceStepTarget {
  baseUrl: string
  timeoutMs: number
  credential?: { headerName: string; value: string }
}
export type InterfaceTargetLoader = (
  step: InterfaceStep,
  remainingMs: number
) => Promise<InterfaceStepTarget>
export interface InterfaceRunOptions {
  policy?: UpstreamNetworkPolicy
  /** One authorized snapshot before any outbound request; each step still reloads its target. */
  preflight?: (
    steps: readonly InterfaceStep[],
    remainingMs: number
  ) => Promise<InterfaceStepTarget[]>
}

function networkMessage(code: string): string {
  switch (code) {
    case 'target_not_allowed':
      return '目标源站未列入允许访问范围，请配置网络策略'
    case 'target_blocked':
      return '目标地址被网络安全策略阻止'
    case 'timeout':
      return '调用超时，请检查上游状态或调整编排'
    case 'redirect_blocked':
      return '上游返回重定向，请配置最终地址'
    case 'response_too_large':
      return '上游响应超过允许大小'
    case 'invalid_response':
      return '上游未返回有效的 JSON 对象或数组'
    case 'upstream_error':
      return '上游返回非成功状态，请核对业务参数与认证配置'
    case 'business_error':
      return '上游业务状态未成功，请核对业务参数'
    default:
      return '上游调用未完成，请检查网络、证书或服务状态'
  }
}
export function classifyExecutionCode(
  code: string,
  statusCode: number | null = null
): InterfaceErrorClass {
  if (code === 'timeout') return 'timeout'
  if (code === 'upstream_error') {
    if (statusCode === 401 || statusCode === 403) return 'authorization'
    if (statusCode === 429) return 'rate_limited'
    if (statusCode !== null && statusCode >= 400 && statusCode < 500) return 'validation'
    return 'upstream'
  }
  if (code === 'business_error' || code === 'invalid_contract') return 'upstream'
  if (
    [
      'invalid_url',
      'invalid_policy',
      'invalid_timeout',
      'target_not_allowed',
      'target_blocked'
    ].includes(code)
  )
    return 'validation'
  if (code === 'response_too_large' || code === 'invalid_response' || code === 'redirect_blocked')
    return 'upstream'
  return 'unknown'
}

export function classifyExecutionError(error: unknown): InterfaceErrorClass {
  if (error instanceof HttpError) {
    if (
      ['RESULT_UNKNOWN', 'UPSTREAM_CHANGED', 'DEPLOYMENT_CHANGED', 'GATEWAY_UNAVAILABLE'].includes(
        error.code
      )
    )
      return 'unknown'
    if (error.code === 'RATE_LIMITED' || error.code === 'CONCURRENCY_LIMIT') return 'rate_limited'
    if (error.code === 'INVALID_RESPONSE_CONTRACT') return 'upstream'
    if (error.code === 'FORBIDDEN' || error.code === 'ACCESS_NOT_GRANTED') return 'authorization'
    if (error.status === 408 || error.status === 504) return 'timeout'
    if (error.status === 401 || error.status === 403) return 'authorization'
    if (error.status === 429) return 'rate_limited'
    if (error.status >= 400 && error.status < 500) return 'validation'
  }
  return 'unknown'
}

function pageInteger(value: InterfaceScalar | undefined, label: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw new HttpError(400, `${label}须为 1–${max} 的整数`)
  return value
}

function pageScalar(value: unknown, type: 'string' | 'number' | 'boolean'): InterfaceScalar {
  if (value === null) return null
  if (type === 'string' && typeof value === 'string' && value.length <= 1024) return value
  if (
    type === 'number' &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= 1e12
  )
    return value
  if (type === 'boolean' && typeof value === 'boolean') return value
  throw new HttpError(502, '上游分页字段类型与发布定义不符', 'INVALID_PAGE_RESULT')
}

/** Copy only declared scalar columns from a bounded upstream page. */
export function projectInterfacePage(
  definition: InterfacePageDefinition,
  source: unknown,
  contentRange: string | undefined,
  input: Record<string, InterfaceScalar>,
  isProtected: (value: InterfaceScalar) => boolean = () => false
): InterfacePageResult {
  const current = pageInteger(input[definition.currentInputKey], '当前页', 1_000_000)
  const size = pageInteger(input[definition.sizeInputKey], '每页数量', 100)
  const at = (value: unknown, pointer: string): unknown =>
    pointer === '' ? value : get(value, pointerSegments(pointer))
  const records: unknown = at(source, definition.recordsPointer)
  if (!Array.isArray(records) || records.length > 100)
    throw new HttpError(502, '上游分页记录缺失或超过 100 条', 'INVALID_PAGE_RESULT')
  let total: unknown
  if (definition.totalSource === 'body') total = at(source, definition.totalPointer)
  else {
    const match = /^(?:[0-9]+-[0-9]+|\*)\/([0-9]+)$/.exec(contentRange || '')
    if (!match) throw new HttpError(502, '上游未返回可确认的分页总数', 'INVALID_PAGE_RESULT')
    total = Number(match[1])
  }
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || total > 1e12)
    throw new HttpError(502, '上游分页总数无效', 'INVALID_PAGE_RESULT')
  const projected = records.map((row) => {
    if (!isPlainObject(row)) throw new HttpError(502, '上游分页记录格式无效', 'INVALID_PAGE_RESULT')
    const item: Record<string, InterfaceScalar> = {}
    for (const field of definition.fields) {
      const value = at(row, field.pointer)
      if (value === undefined && field.required)
        throw new HttpError(502, '上游分页必填字段缺失', 'INVALID_PAGE_RESULT')
      const scalar = value === undefined ? null : pageScalar(value, field.type)
      if (isProtected(scalar))
        throw new HttpError(502, '分页结果包含受保护内容', 'INVALID_PAGE_RESULT')
      item[field.target] = scalar
    }
    return item
  })
  const result = { records: projected, total, current, size }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 64 * 1024)
    throw new HttpError(502, '分页结果超过输出大小限制', 'INVALID_PAGE_RESULT')
  return result
}
/** Sequential, bounded business composition; no scripts, retries, headers or raw bodies are exposed. */
export async function runInterface(
  definition: InterfaceExecutionDefinition,
  input: Record<string, InterfaceScalar>,
  loadTarget: InterfaceTargetLoader,
  options: InterfaceRunOptions = {}
): Promise<InterfaceTestResult> {
  const started = performance.now()
  const deadline = started + 30_000
  const trace: InterfaceTestStep[] = []
  const responses: Record<string, unknown> = {}
  const contentRanges: Record<string, string | undefined> = {}
  const protectedValues: string[] = []
  const remaining = (): number => {
    const budget = Math.floor(deadline - performance.now())
    if (budget < 100) throw new HttpError(408, '编排总执行时间超过 30 秒，请减少步骤或检查服务')
    return budget
  }
  const result: InterfaceTestResult = {
    interfaceId: definition.id,
    version: definition.version,
    passed: false,
    stale: false,
    output: {},
    steps: trace,
    durationMs: 0,
    errorClass: null,
    message: ''
  }
  function rememberCredential(target: InterfaceStepTarget): void {
    if (!target.credential) return
    protectedValues.push(target.credential.value)
    if (target.credential.value.startsWith('Bearer '))
      protectedValues.push(target.credential.value.slice(7))
  }
  function protectedValue(value: InterfaceScalar): boolean {
    return (
      value !== null && protectedValues.some((secret) => secret && String(value).includes(secret))
    )
  }
  try {
    const issues = validateInterfaceDefinition(definition)
    if (issues.length) throw new HttpError(400, '接口定义尚未通过校验，请先修复编排')
    // Resolve every target before the first external side effect. Each step rechecks authority below.
    if (options.preflight) {
      const targets = await options.preflight(definition.definition.steps, remaining())
      if (targets.length !== definition.definition.steps.length)
        throw new HttpError(503, '上游就绪检查未返回完整目标，请稍后重试')
      targets.forEach(rememberCredential)
    } else {
      for (const step of definition.definition.steps)
        rememberCredential(await loadTarget(step, remaining()))
    }
    for (const step of definition.definition.steps) {
      if (trace.some((item) => item.status === 'failed')) {
        trace.push({
          key: step.key,
          name: step.name,
          status: 'skipped',
          statusCode: null,
          durationMs: 0,
          code: null,
          errorClass: null,
          message: '前序步骤失败，未发送请求'
        })
        continue
      }
      const stepStarted = performance.now()
      try {
        const target = await loadTarget(step, remaining())
        rememberCredential(target)
        const pathValues = mappedFields(step.pathParams, input, responses)
        const queryValues = mappedFields(step.query, input, responses)
        const query = Object.fromEntries(
          Object.entries(queryValues).map(([name, value]) => [
            name,
            value === null ? '' : String(value)
          ])
        )
        if (step.pagination) {
          const pagination = step.pagination
          const current = pageInteger(input[pagination.currentInputKey], '当前页', 1_000_000)
          const size = pageInteger(input[pagination.sizeInputKey], '每页数量', 100)
          if (
            Object.hasOwn(query, pagination.pageParameter) ||
            Object.hasOwn(query, pagination.sizeParameter)
          )
            throw new HttpError(400, '分页参数与查询映射冲突')
          query[pagination.pageParameter] = String(
            pagination.mode === 'offset' ? (current - 1) * size : current
          )
          query[pagination.sizeParameter] = String(size)
        }
        const body = step.method === 'GET' ? undefined : mappedFields(step.body, input, responses)
        const response = await executeUpstreamRequest(
          target.baseUrl,
          {
            method: step.method,
            path: stepPath(step, pathValues),
            query,
            body,
            credential: target.credential,
            exactCount: step.pagination?.exactCount
          },
          Math.min(target.timeoutMs, remaining()),
          options.policy ?? upstreamPolicy
        )
        let decoded: { ok: boolean; data: unknown } | null = null
        if (response.ok) {
          try {
            decoded = decodeResponseContract(response.body, step.responseContract)
          } catch {
            throw new HttpError(502, '上游响应与发布合同不符', 'INVALID_RESPONSE_CONTRACT')
          }
        }
        const stepPassed = response.ok && decoded?.ok === true
        trace.push({
          key: step.key,
          name: step.name,
          status: stepPassed ? 'passed' : 'failed',
          statusCode: response.statusCode,
          durationMs: response.durationMs,
          code: stepPassed ? null : response.ok ? 'business_error' : response.code,
          errorClass: stepPassed
            ? null
            : classifyExecutionCode(
                response.ok ? 'business_error' : response.code,
                response.statusCode
              ),
          message: stepPassed
            ? '调用成功'
            : networkMessage(response.ok ? 'business_error' : response.code)
        })
        if (stepPassed && decoded) {
          responses[step.key] = decoded.data
          contentRanges[step.key] = response.contentRange
        }
      } catch (error) {
        trace.push({
          key: step.key,
          name: step.name,
          status: 'failed',
          statusCode: null,
          durationMs: Math.round(performance.now() - stepStarted),
          code: error instanceof HttpError ? error.code : 'STEP_FAILED',
          errorClass: classifyExecutionError(error),
          message: error instanceof HttpError ? error.message : '步骤执行失败，请检查输入与服务配置'
        })
      }
    }
    if (trace.some((item) => item.status === 'failed')) {
      result.errorClass = trace.find((item) => item.status === 'failed')?.errorClass ?? 'unknown'
      result.message = '试运行未通过，请查看步骤摘要；未执行后续步骤'
    } else {
      if (definition.definition.page) {
        const page = definition.definition.page
        result.output = projectInterfacePage(
          page,
          responses[page.stepKey],
          contentRanges[page.stepKey],
          input,
          protectedValue
        )
      } else {
        const output = mappedFields(definition.definition.outputs, input, responses)
        if (Object.keys(output).length !== definition.definition.outputs.length)
          throw new HttpError(400, '输出映射未找到对应字段，请核对上游结果路径')
        if (Object.values(output).some(protectedValue))
          throw new HttpError(400, '输出映射包含受保护的凭据内容，已阻止返回')
        result.output = output
      }
      result.passed = true
      result.message = '试运行通过；仅返回已声明的映射字段'
    }
  } catch (error) {
    result.errorClass = classifyExecutionError(error)
    result.message = error instanceof HttpError ? error.message : '试运行未完成，请稍后重试'
    for (const step of definition.definition.steps.slice(trace.length))
      trace.push({
        key: step.key,
        name: step.name,
        status: 'skipped',
        statusCode: null,
        durationMs: 0,
        code: null,
        errorClass: null,
        message: '就绪检查未通过，未发送请求'
      })
  }
  result.durationMs = Math.round(performance.now() - started)
  return result
}
