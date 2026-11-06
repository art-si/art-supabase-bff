import { performance } from 'node:perf_hooks'
import type {
  InterfaceRecord,
  InterfaceScalar,
  InterfaceStep,
  InterfaceTestResult,
  InterfaceTestStep
} from '../src/types/interface'
import { HttpError } from './http'
import { mappedFields, stepPath, validateInterfaceDefinition } from './interface-definition'
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
    default:
      return '上游调用未完成，请检查网络、证书或服务状态'
  }
}
/** Sequential, bounded business composition; no scripts, retries, headers or raw bodies are exposed. */
export async function runInterface(
  definition: InterfaceRecord,
  input: Record<string, InterfaceScalar>,
  loadTarget: InterfaceTargetLoader,
  policy: UpstreamNetworkPolicy = upstreamPolicy
): Promise<InterfaceTestResult> {
  const started = performance.now()
  const deadline = started + 30_000
  const trace: InterfaceTestStep[] = []
  const responses: Record<string, unknown> = {}
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
    for (const step of definition.definition.steps)
      rememberCredential(await loadTarget(step, remaining()))
    for (const step of definition.definition.steps) {
      if (trace.some((item) => item.status === 'failed')) {
        trace.push({
          key: step.key,
          name: step.name,
          status: 'skipped',
          statusCode: null,
          durationMs: 0,
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
        const body = step.method === 'GET' ? undefined : mappedFields(step.body, input, responses)
        const response = await executeUpstreamRequest(
          target.baseUrl,
          {
            method: step.method,
            path: stepPath(step, pathValues),
            query,
            body,
            credential: target.credential
          },
          Math.min(target.timeoutMs, remaining()),
          policy
        )
        trace.push({
          key: step.key,
          name: step.name,
          status: response.ok ? 'passed' : 'failed',
          statusCode: response.statusCode,
          durationMs: response.durationMs,
          message: response.ok ? '调用成功' : networkMessage(response.code)
        })
        if (response.ok) responses[step.key] = response.body
      } catch (error) {
        trace.push({
          key: step.key,
          name: step.name,
          status: 'failed',
          statusCode: null,
          durationMs: Math.round(performance.now() - stepStarted),
          message: error instanceof HttpError ? error.message : '步骤执行失败，请检查输入与服务配置'
        })
      }
    }
    if (trace.some((item) => item.status === 'failed'))
      result.message = '试运行未通过，请查看步骤摘要；未执行后续步骤'
    else {
      const output = mappedFields(definition.definition.outputs, input, responses)
      if (Object.keys(output).length !== definition.definition.outputs.length)
        throw new HttpError(400, '输出映射未找到对应字段，请核对上游结果路径')
      if (Object.values(output).some(protectedValue))
        throw new HttpError(400, '输出映射包含受保护的凭据内容，已阻止返回')
      result.output = output
      result.passed = true
      result.message = '试运行通过；仅返回已声明的映射字段'
    }
  } catch (error) {
    result.message = error instanceof HttpError ? error.message : '试运行未完成，请稍后重试'
    for (const step of definition.definition.steps.slice(trace.length))
      trace.push({
        key: step.key,
        name: step.name,
        status: 'skipped',
        statusCode: null,
        durationMs: 0,
        message: '就绪检查未通过，未发送请求'
      })
  }
  result.durationMs = Math.round(performance.now() - started)
  return result
}
