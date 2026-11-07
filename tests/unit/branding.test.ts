import assert from 'node:assert/strict'
import test from 'node:test'
import { brandingDto, brandingInput } from '../../server/branding'
import { BFF_BRANDING_DEFAULTS } from '../../src/types/branding'

test('branding normalizes the full shared website configuration and safe image addresses', () => {
  const sample = {
    ...BFF_BRANDING_DEFAULTS,
    siteName: ' BFF运维平台 ',
    logoUrl: 'https://assets.example.test/logo.png',
    faviconUrl: '/favicon.svg',
    wordmarkLightUrl: '/api/resources/11/content',
    wordmarkDarkUrl: '/api/resources/12/content',
    wordmarkImageEnabled: true,
    loginTitle: ' BFF 登录 ',
    maintenanceEnabled: true,
    maintenanceMessage: '正在维护',
    authChannels: [
      {
        key: 'github',
        label: 'GitHub',
        provider: 'github',
        icon: 'ri:github-fill',
        enabled: true,
        allowLinking: false
      }
    ]
  }
  assert.equal(brandingInput(sample).siteName, 'BFF运维平台')
  assert.equal(brandingInput(sample).loginTitle, 'BFF 登录')
  assert.equal(brandingInput(sample).authChannels[0]?.provider, 'github')
  assert.equal(brandingInput(sample).wordmarkDarkUrl, '/api/resources/12/content')
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
  assert.equal(brandingInput({ ...sample, registerEnabled: false }).registerEnabled, false)
  assert.throws(() => brandingInput({ ...sample, registerEnabled: 'false' }))
  assert.throws(() => brandingInput({ ...sample, captchaMaxAttempts: 21 }))
  assert.throws(() => brandingInput({ ...sample, defaultLanguage: 'other' }))
  assert.throws(() => brandingInput({ ...sample, wordmarkDarkUrl: 'javascript:alert(1)' }))
  assert.throws(() =>
    brandingInput({ ...sample, authChannels: [{ ...sample.authChannels[0], clientSecret: 'x' }] })
  )
  assert.throws(() =>
    brandingInput({ ...sample, authChannels: [sample.authChannels[0], sample.authChannels[0]] })
  )
  assert.throws(() =>
    brandingInput({
      ...sample,
      authChannels: [
        { ...sample.authChannels[0], queryParamName: 'client_secret', queryParamValue: 'x' }
      ]
    })
  )
  assert.throws(() => brandingInput({ ...sample, maintenanceMessage: '' }))
  assert.throws(() =>
    brandingInput({ ...sample, watermarkContentType: 'custom', watermarkCustomText: '' })
  )
  assert.equal(
    brandingInput({ ...sample, watermarkContentType: 'custom', watermarkCustomText: '内部使用' })
      .watermarkCustomText,
    '内部使用'
  )
})

test('branding DTO fills a legacy eight-field record with shared defaults and excludes server fields', () => {
  const value = {
    id: 'fc57087c-fb19-4bf9-84c8-58b5b570cfc9',
    version: 0,
    config: {
      siteName: '旧 BFF',
      siteShortName: '旧',
      siteDescription: '',
      logoUrl: '',
      faviconUrl: '',
      watermarkEnabled: true,
      watermarkContentType: 'username',
      watermarkCustomText: ''
    },
    createdAt: null,
    updatedAt: null,
    updatedByName: '',
    secretKey: 'must-not-leak'
  }
  const dto = brandingDto(value)
  assert.equal(dto.config.siteName, '旧 BFF')
  assert.equal(dto.config.loginTitle, BFF_BRANDING_DEFAULTS.loginTitle)
  assert.equal(dto.config.authChannels.length, BFF_BRANDING_DEFAULTS.authChannels.length)
  assert.ok(!JSON.stringify(dto).includes('must-not-leak'))
  assert.throws(() => brandingDto({ ...value, version: -1 }))
  assert.throws(() => brandingDto({ ...value, config: { serviceKey: 'forged' } }))
})
