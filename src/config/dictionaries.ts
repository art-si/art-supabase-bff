/** Dictionary codes owned by each BFF module; options come from pro's shared dictionary store. */
export const BFF_DICTIONARIES = {
  common: { boolean: 'commonBoolean', environment: 'bffRuntimeEnvironment' },
  applications: { status: 'bffApplicationStatus' },
  members: { role: 'bffMemberRole', accessStatus: 'bffMemberAccessStatus' },
  upstreams: {
    status: 'bffUpstreamStatus',
    authType: 'bffUpstreamAuthType',
    credentialAction: 'bffCredentialAction'
  },
  interfaces: {
    method: 'bffInterfaceMethod',
    validationStatus: 'bffInterfaceValidationStatus',
    inputLocation: 'bffInterfaceInputLocation',
    valueType: 'bffInterfaceValueType',
    bindingSource: 'bffInterfaceBindingSource',
    responseContractMode: 'bffResponseContractMode',
    paginationMode: 'bffPaginationMode',
    pageTotalSource: 'bffPageTotalSource'
  }
} as const
