import type {
  InterfaceBinding,
  InterfaceRecord,
  InterfaceWriteInput
} from '../../src/types/interface'

export function inputBinding(target: string, inputKey = target): InterfaceBinding {
  return {
    target,
    source: 'input',
    inputKey,
    stepKey: '',
    pointer: '',
    literalType: 'string',
    literalValue: ''
  }
}
export function stepBinding(target: string, stepKey: string, pointer: string): InterfaceBinding {
  return {
    target,
    source: 'step',
    inputKey: '',
    stepKey,
    pointer,
    literalType: 'string',
    literalValue: ''
  }
}
export function interfaceFixture(
  applicationId = '17ea39b4-e369-40da-a961-4c6c71066bc0',
  upstreamId = 'c0871925-e871-4804-b3f1-d1089754d520'
): InterfaceWriteInput {
  return {
    applicationId,
    environment: 'development',
    code: 'order-preview',
    name: '订单摘要预览',
    description: '合成数据',
    method: 'GET',
    path: '/orders/{orderId}',
    definition: {
      inputs: [
        { key: 'orderId', label: '订单编号', location: 'path', type: 'string', required: true }
      ],
      steps: [
        {
          key: 'order',
          name: '查询订单',
          upstreamId,
          configVersion: 1,
          method: 'GET',
          path: '/orders/{orderId}',
          pathParams: [inputBinding('orderId')],
          query: [],
          body: []
        },
        {
          key: 'customer',
          name: '汇总客户',
          upstreamId,
          configVersion: 1,
          method: 'GET',
          path: '/customers/{customerId}',
          pathParams: [stepBinding('customerId', 'order', '/customerId')],
          query: [],
          body: []
        }
      ],
      outputs: [
        stepBinding('orderNo', 'order', '/orderNo'),
        stepBinding('customerName', 'customer', '/name')
      ]
    }
  }
}
export function interfaceRecordFixture(): InterfaceRecord {
  return {
    ...interfaceFixture(),
    id: '9bb4fb4f-d14f-4215-b17b-3e3a659da5da',
    application: {
      id: '17ea39b4-e369-40da-a961-4c6c71066bc0',
      code: 'demo-app',
      name: '示例应用',
      enabled: true
    },
    version: 1,
    validationStatus: 'valid',
    validatedVersion: 1,
    validationIssues: [],
    lastValidatedAt: null,
    lastTestStatus: 'not_tested',
    lastTestVersion: null,
    lastTestAt: null,
    createdAt: '2026-11-07T00:00:00Z',
    updatedAt: '2026-11-07T00:00:00Z'
  }
}
