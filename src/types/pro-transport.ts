export interface ProDispatchAdvisory {
  subjectLabel: string
  message: string
}

export interface ProCertificateRisk {
  riskKind: 'expired' | 'revoked'
  subjectType: 'vehicle' | 'driver'
  subjectId: string
  subjectLabel: string
  certificateType: string
  expiresOn: string | null
}

export interface ProDispatchPreflight {
  requestId: string
  checkedAt: string
  advisories: ProDispatchAdvisory[]
  certificateRisks: ProCertificateRisk[]
  certificateBlocked: boolean
  canOverrideCertificateRisk: boolean
}
