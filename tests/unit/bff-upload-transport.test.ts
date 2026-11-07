import assert from 'node:assert/strict'
import test from 'node:test'
import { bffSession, call } from '../../src/api/bff'

test('BFF multipart uses browser boundary and opaque-session CSRF, while JSON calls keep their type', async (t) => {
  const prior = bffSession.value
  bffSession.value = {
    user: {
      id: 'synthetic',
      name: '测试成员',
      email: 'member@example.test',
      role: 'viewer',
      tenantId: 'synthetic'
    },
    csrfToken: 'synthetic-upload-csrf',
    permissions: [],
    menu: []
  }
  const requests: RequestInit[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(init)
    return Response.json({ ok: true })
  })
  try {
    const form = new FormData()
    form.set('file', new File(['synthetic'], 'sample.txt', { type: 'text/plain' }))
    await call('/api/resources/upload', { method: 'POST', body: form })
    assert.equal(requests[0].credentials, 'same-origin')
    assert.equal(new Headers(requests[0].headers).has('Content-Type'), false)
    assert.equal(new Headers(requests[0].headers).get('X-CSRF-Token'), 'synthetic-upload-csrf')
    await call('/api/resources/1/name', {
      method: 'PUT',
      body: JSON.stringify({ version: 2, originName: 'sample.txt' })
    })
    assert.equal(new Headers(requests[1].headers).get('Content-Type'), 'application/json')
  } finally {
    bffSession.value = prior
  }
})
