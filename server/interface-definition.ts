import { difference, get, uniq } from 'lodash-es'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import type {
  InterfaceBinding,
  InterfaceDefinition,
  InterfaceInputField,
  InterfaceMethod,
  InterfaceScalar,
  InterfaceScalarType,
  InterfaceStep,
  InterfaceWriteInput
} from '../src/types/interface'
import { text } from './control-plane'
import { uuid } from './applications'
import { HttpError } from './http'

const keyPattern = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
const sensitiveKey =
  /^(?:__proto__|prototype|constructor|authorization|cookie|password|secret|api_?key|access_?token|refresh_?token|service_?role)$/i
const methods: InterfaceMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

function invalid(message: string): never {
  throw new HttpError(400, message)
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!isObjectRecord(value)) invalid(`${label}格式有误`)
  return value
}
function list(value: unknown, label: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    invalid(`${label}需为 ${min}–${max} 项`)
  return value
}
function key(value: unknown, label: string, optional = false): string {
  const result = text(value, label, 40, !optional)
  if ((result || !optional) && (!keyPattern.test(result) || sensitiveKey.test(result)))
    invalid(`${label}需以字母开头，使用字母、数字或下划线，且不能使用敏感保留名称`)
  return result
}
function scalarType(value: unknown): InterfaceScalarType {
  if (value !== 'string' && value !== 'number' && value !== 'boolean')
    invalid('参数类型需为文本、数字或布尔值')
  return value
}
export function interfaceMethod(value: unknown): InterfaceMethod {
  if (!methods.includes(value as InterfaceMethod)) invalid('请选择有效的 HTTP 方法')
  return value as InterfaceMethod
}
export function interfacePath(value: unknown): string {
  const result = text(value, '接口路径', 500, true)
  if (
    !/^\/(?:[A-Za-z0-9_./~-]|\{[A-Za-z][A-Za-z0-9_]{0,39}\})*$/.test(result) ||
    result.includes('//') ||
    result.split('/').some((segment) => segment === '.' || segment === '..')
  )
    invalid('路径须以 / 开头，只能包含安全路径字符及 {参数名}，不得包含完整网址或上级目录')
  return result === '/' ? result : result.replace(/\/$/, '')
}
export function pointerSegments(value: string): string[] {
  if (
    value.length > 256 ||
    !/^(?:\/(?:[^~]|~[01])*)*$/.test(value) ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    invalid('结果字段路径需使用 JSON Pointer，例如 /data/orderNo')
  const segments =
    value === ''
      ? []
      : value
          .slice(1)
          .split('/')
          .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  if (segments.some((part) => sensitiveKey.test(part))) invalid('结果字段路径不能读取敏感保留字段')
  return segments
}
function binding(value: unknown): InterfaceBinding {
  const item = record(value, '字段映射')
  const source = item.source
  if (source !== 'input' && source !== 'step' && source !== 'literal') invalid('字段来源无效')
  const pointer = source === 'step' ? text(item.pointer, '结果字段路径', 256) : ''
  if (source === 'step') pointerSegments(pointer)
  const literalValue = source === 'literal' ? item.literalValue : ''
  if (typeof literalValue !== 'string' || literalValue.length > 1024)
    invalid('固定值不能超过 1024 字符')
  return {
    target: key(item.target, '目标字段'),
    source,
    inputKey: source === 'input' ? key(item.inputKey, '输入字段', true) : '',
    stepKey: source === 'step' ? key(item.stepKey, '来源步骤', true) : '',
    pointer,
    literalType: source === 'literal' ? scalarType(item.literalType) : 'string',
    literalValue
  }
}
function bindings(value: unknown, label: string, min = 0): InterfaceBinding[] {
  return list(value, label, min, 32).map(binding)
}
function inputField(value: unknown): InterfaceInputField {
  const item = record(value, '输入参数')
  const location = item.location
  if (location !== 'path' && location !== 'query' && location !== 'body') invalid('参数位置无效')
  if (typeof item.required !== 'boolean') invalid('参数必填状态无效')
  return {
    key: key(item.key, '参数名称'),
    label: text(item.label, '参数说明', 50, true),
    location,
    type: scalarType(item.type),
    required: item.required
  }
}
function step(value: unknown): InterfaceStep {
  const item = record(value, '调用步骤')
  if (!Number.isSafeInteger(item.configVersion) || Number(item.configVersion) < 1)
    invalid('请选择上游服务的有效配置版本')
  return {
    key: key(item.key, '步骤标识'),
    name: text(item.name, '步骤名称', 80, true),
    upstreamId: uuid(String(item.upstreamId)),
    configVersion: Number(item.configVersion),
    method: interfaceMethod(item.method),
    path: interfacePath(item.path),
    pathParams: bindings(item.pathParams, '路径参数映射'),
    query: bindings(item.query, '查询参数映射'),
    body: bindings(item.body, '请求体映射')
  }
}
export function normalizeInterfaceDefinition(value: unknown): InterfaceDefinition {
  const item = record(value, '接口定义')
  const result = {
    inputs: list(item.inputs, '输入参数', 0, 32).map(inputField),
    steps: list(item.steps, '调用步骤', 1, 8).map(step),
    outputs: bindings(item.outputs, '输出字段', 1)
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 49152)
    invalid('接口定义过长，请减少步骤或固定值内容')
  return result
}
export function interfaceInput(value: Record<string, unknown>): InterfaceWriteInput {
  const environment = value.environment
  if (environment !== 'development' && environment !== 'staging' && environment !== 'production')
    invalid('请选择有效的运行环境')
  const code = text(value.code, '接口编码', 64, true)
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(code))
    invalid('接口编码需为 2–64 位小写字母、数字或连字符，以字母开头')
  return {
    applicationId: uuid(String(value.applicationId)),
    environment,
    code,
    name: text(value.name, '接口名称', 100, true),
    description: text(value.description, '接口说明', 1000),
    method: interfaceMethod(value.method),
    path: interfacePath(value.path),
    definition: normalizeInterfaceDefinition(value.definition)
  }
}
function placeholders(path: string): string[] {
  return uniq([...path.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]))
}
function uniqueNames(names: string[], label: string, issues: string[]): void {
  if (uniq(names).length !== names.length) issues.push(`${label}存在重复名称`)
}
export function literalScalar(item: InterfaceBinding): InterfaceScalar {
  if (item.literalType === 'string') return item.literalValue
  if (item.literalType === 'boolean') {
    if (item.literalValue !== 'true' && item.literalValue !== 'false')
      invalid('布尔固定值需为 true 或 false')
    return item.literalValue === 'true'
  }
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(item.literalValue))
    invalid('数字固定值格式有误')
  const result = Number(item.literalValue)
  if (!Number.isFinite(result) || Math.abs(result) > 1e12) invalid('数字固定值超出允许范围')
  return result
}
/** Business validation is separate from safe draft storage. No user expressions are executed. */
export function validateInterfaceDefinition(input: InterfaceWriteInput): string[] {
  const issues: string[] = []
  const { inputs, steps, outputs } = input.definition
  uniqueNames(
    inputs.map((field) => field.key),
    '输入参数',
    issues
  )
  uniqueNames(
    steps.map((item) => item.key),
    '调用步骤',
    issues
  )
  const pathFields = inputs.filter((field) => field.location === 'path')
  if (
    difference(
      placeholders(input.path),
      pathFields.map((field) => field.key)
    ).length ||
    difference(
      pathFields.map((field) => field.key),
      placeholders(input.path)
    ).length ||
    pathFields.some((field) => !field.required)
  )
    issues.push('入口路径占位符需与必填路径参数逐一对应')
  if (input.method === 'GET' && inputs.some((field) => field.location === 'body'))
    issues.push('GET 入口不能声明请求体参数')
  const previousSteps: string[] = []
  function checkMappings(items: InterfaceBinding[], label: string): void {
    uniqueNames(
      items.map((item) => item.target),
      label,
      issues
    )
    for (const item of items) {
      if (item.source === 'input' && !inputs.some((field) => field.key === item.inputKey))
        issues.push(`${label}引用了未声明的输入参数`)
      if (item.source === 'step' && !previousSteps.includes(item.stepKey))
        issues.push(`${label}只能引用已执行的前序步骤`)
      if (item.source === 'literal') {
        try {
          literalScalar(item)
        } catch {
          issues.push(`${label}的固定值与类型不匹配`)
        }
      }
    }
  }
  for (const item of steps) {
    checkMappings(item.pathParams, `步骤「${item.name}」路径映射`)
    checkMappings(item.query, `步骤「${item.name}」查询映射`)
    checkMappings(item.body, `步骤「${item.name}」请求体映射`)
    if (
      difference(
        placeholders(item.path),
        item.pathParams.map((field) => field.target)
      ).length ||
      difference(
        item.pathParams.map((field) => field.target),
        placeholders(item.path)
      ).length
    )
      issues.push(`步骤「${item.name}」的路径占位符与映射不一致`)
    if (item.method === 'GET' && item.body.length)
      issues.push(`步骤「${item.name}」的 GET 请求不能携带请求体`)
    previousSteps.push(item.key)
  }
  checkMappings(outputs, '响应映射')
  return uniq(issues).slice(0, 40)
}
export function parseInterfaceSample(
  fields: InterfaceInputField[],
  value: unknown
): Record<string, InterfaceScalar> {
  const supplied = record(value, '试运行参数')
  if (Object.keys(supplied).some((name) => !fields.some((field) => field.key === name)))
    invalid('试运行包含未声明的参数，请核对输入')
  const result: Record<string, InterfaceScalar> = {}
  for (const field of fields) {
    const item = supplied[field.key]
    if (item === undefined || item === null || item === '') {
      if (field.required) invalid(`请填写「${field.label}」`)
      continue
    }
    if (field.type === 'string' && typeof item === 'string' && item.length <= 1024)
      result[field.key] = item
    else if (
      field.type === 'number' &&
      typeof item === 'number' &&
      Number.isFinite(item) &&
      Math.abs(item) <= 1e12
    )
      result[field.key] = item
    else if (field.type === 'boolean' && typeof item === 'boolean') result[field.key] = item
    else invalid(`「${field.label}」与声明类型不符或内容过长`)
  }
  return result
}
export function mappedScalar(
  item: InterfaceBinding,
  input: Record<string, InterfaceScalar>,
  responses: Record<string, unknown>
): InterfaceScalar | undefined {
  const value: unknown =
    item.source === 'literal'
      ? literalScalar(item)
      : item.source === 'input'
        ? input[item.inputKey]
        : item.pointer === ''
          ? responses[item.stepKey]
          : get(responses[item.stepKey], pointerSegments(item.pointer))
  if (value === undefined) return undefined
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12) ||
    (typeof value === 'string' && value.length <= 1024)
  )
    return value
  invalid('映射结果须为文本、数字、布尔值或空值，文本不超过 1024 字符')
}
export function mappedFields(
  items: InterfaceBinding[],
  input: Record<string, InterfaceScalar>,
  responses: Record<string, unknown>
): Record<string, InterfaceScalar> {
  const result: Record<string, InterfaceScalar> = {}
  for (const item of items) {
    const value = mappedScalar(item, input, responses)
    if (value !== undefined) result[item.target] = value
  }
  return result
}
export function stepPath(step: InterfaceStep, values: Record<string, InterfaceScalar>): string {
  return step.path.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = values[name]
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      value === '.' ||
      value === '..' ||
      /[/%\\?#]/.test(String(value)) ||
      Array.from(String(value)).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )
    )
      invalid('调用路径参数缺失或无效，请检查映射')
    return encodeURIComponent(String(value))
  })
}
