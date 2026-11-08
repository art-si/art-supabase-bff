import type { UpstreamApplication, UpstreamEnvironment } from './upstream'

export type InterfaceMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type InterfaceScalarType = 'string' | 'number' | 'boolean'
export type InterfaceScalar = string | number | boolean | null

export interface InterfaceInputField {
  key: string
  label: string
  location: 'path' | 'query' | 'body'
  type: InterfaceScalarType
  required: boolean
}

/** Declarative field mapping; source-specific unused fields are normalized away. */
export interface InterfaceBinding {
  target: string
  source: 'input' | 'step' | 'literal'
  inputKey: string
  stepKey: string
  pointer: string
  literalType: InterfaceScalarType
  literalValue: string
}

export interface InterfaceStep {
  key: string
  name: string
  upstreamId: string
  configVersion: number
  method: InterfaceMethod
  path: string
  pathParams: InterfaceBinding[]
  query: InterfaceBinding[]
  body: InterfaceBinding[]
  responseContract?: {
    mode: 'http' | 'business'
    codePointer: string
    dataPointer: string
    successCodes: Array<string | number>
  }
  pagination?: {
    mode: 'page' | 'offset'
    currentInputKey: string
    sizeInputKey: string
    pageParameter: string
    sizeParameter: string
    exactCount: boolean
  }
}

export interface InterfacePageField {
  target: string
  label: string
  pointer: string
  type: InterfaceScalarType
  required: boolean
}

export interface InterfacePageDefinition {
  stepKey: string
  recordsPointer: string
  totalSource: 'body' | 'content-range'
  totalPointer: string
  currentInputKey: string
  sizeInputKey: string
  fields: InterfacePageField[]
}

export interface InterfacePageResult {
  records: Array<Record<string, InterfaceScalar>>
  total: number
  current: number
  size: number
}

export interface InterfaceDefinition {
  inputs: InterfaceInputField[]
  steps: InterfaceStep[]
  outputs: InterfaceBinding[]
  page?: InterfacePageDefinition
}

export interface InterfaceWriteInput {
  applicationId: string
  environment: UpstreamEnvironment
  code: string
  name: string
  description: string
  method: InterfaceMethod
  path: string
  definition: InterfaceDefinition
  version?: number
}

export interface InterfaceRecord extends InterfaceWriteInput {
  id: string
  application: UpstreamApplication
  version: number
  validationStatus: 'unvalidated' | 'valid' | 'invalid'
  validatedVersion: number | null
  validationIssues: string[]
  lastValidatedAt: string | null
  lastTestStatus: 'not_tested' | 'passed' | 'failed' | 'stale'
  lastTestVersion: number | null
  lastTestAt: string | null
  createdAt: string
  updatedAt: string
}

export interface InterfaceExecutionDefinition extends InterfaceWriteInput {
  id: string
  version: number
}

export interface InterfaceListQuery {
  current: number
  size: number
  name?: string
  applicationId?: string
  environment?: UpstreamEnvironment
  validationStatus?: InterfaceRecord['validationStatus']
  recordId?: string
}

export interface InterfaceList {
  records: InterfaceRecord[]
  total: number
  current: number
  size: number
  summary: { total: number; valid: number; unvalidated: number; tested: number }
}

export interface InterfaceUpstreamOption {
  id: string
  applicationId: string
  environment: UpstreamEnvironment
  code: string
  name: string
  status: 'draft' | 'active' | 'disabled'
  configVersion: number
  authType: 'none' | 'bearer' | 'api_key_header'
  credentialConfigured: boolean
}

export interface InterfaceOptions {
  applications: UpstreamApplication[]
  environments: Array<{ label: string; value: UpstreamEnvironment }>
  upstreams: InterfaceUpstreamOption[]
  networkPolicyConfigured: boolean
  writeTestsConfigured: boolean
}

export interface InterfaceTestStep {
  key: string
  name: string
  status: 'passed' | 'failed' | 'skipped'
  statusCode: number | null
  durationMs: number
  code: string | null
  errorClass: InterfaceErrorClass | null
  message: string
}

export type InterfaceErrorClass =
  'timeout' | 'upstream' | 'unknown' | 'authorization' | 'validation' | 'rate_limited'

export interface InterfaceTestResult {
  interfaceId: string
  version: number
  passed: boolean
  stale: boolean
  output: Record<string, InterfaceScalar> | InterfacePageResult
  steps: InterfaceTestStep[]
  durationMs: number
  errorClass: InterfaceErrorClass | null
  message: string
}
