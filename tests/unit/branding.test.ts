import assert from 'node:assert/strict'
import test from 'node:test'
import { brandingDto, brandingInput } from '../../server/branding'
import { BFF_BRANDING_DEFAULTS } from '../../src/types/branding'

test('branding accepts only product identity fields and safe image addresses', () => {
  const sample = {
    ...BFF_BRANDING_DEFAULTS,
    siteName: ' BFF运维平台 ',
    logoUrl: 'https://assets.example.test/logo.png',
    faviconUrl: '/favicon.svg'
  }
  assert.equal(brandingInput(sample).siteName, 'BFF运维平台')
  for (const url of [
    'javascript:alert(1)',
    '//outside.test/logo.png',
    'https://user:secret@example.test/logo.png',
    'https://assets.example.test/logo?token=secret',
    '/logos/../secret.svg',
    'data:image/svg+xml,<svg/>'
  ])
    assert.throws(() => brandingInput({ ...sample, logoUrl: url }))
  assert.throws(() => brandingInput({ ...sample, serviceKey: 'forged' }))
  assert.throws(() => brandingInput({ ...sample, registerEnabled: true }))
  assert.throws(() =>
    brandingInput({ ...sample, watermarkContentType: 'custom', watermarkCustomText: '' })
  )
  assert.equal(
    brandingInput({ ...sample, watermarkContentType: 'custom', watermarkCustomText: '内部使用' })
      .watermarkCustomText,
    '内部使用'
  )
})

test('branding DTO provides defaults at revision zero and excludes unexpected server fields', () => {
  const value = {
    id: 'fc57087c-fb19-4bf9-84c8-58b5b570cfc9',
    version: 0,
    config: {},
    createdAt: null,
    updatedAt: null,
    updatedByName: '',
    secretKey: 'must-not-leak'
  }
  const dto = brandingDto(value)
  assert.equal(dto.config.siteName, 'BFF平台')
  assert.ok(!JSON.stringify(dto).includes('must-not-leak'))
  assert.throws(() => brandingDto({ ...value, version: -1 }))
  assert.throws(() => brandingDto({ ...value, config: { authChannels: [] } }))
})
