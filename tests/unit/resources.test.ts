import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import test from 'node:test'
import {
  detectResourceMime,
  isResourceObjectKey,
  parseResourceUpload,
  resourceDto
} from '../../server/resources'

const tenantId = '11111111-1111-4111-8111-111111111111'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNVsAAAAASUVORK5CYII=',
  'base64'
)
const gif = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64')
const ico = readFileSync('node_modules/art-supabase-pro/src/assets/images/favicon.ico')

test('storage claim parser accepts SQL UUID path shape and rejects traversal', () => {
  const objectId = '22222222-2222-4222-8222-222222222222'
  assert.equal(isResourceObjectKey(`${tenantId}/${objectId}.png`, tenantId), true)
  assert.equal(isResourceObjectKey(`${tenantId}/../${objectId}.png`, tenantId), false)
  assert.equal(isResourceObjectKey(`${tenantId}/${objectId}.svg`, tenantId), false)
  assert.equal(isResourceObjectKey(`${objectId}/${objectId}.png`, tenantId), false)
})

test('resource MIME follows detected content and never trusts a mismatched extension', async () => {
  assert.equal(await detectResourceMime(png, 'png'), 'image/png')
  assert.equal(await detectResourceMime(gif, 'gif'), 'image/gif')
  assert.equal(await detectResourceMime(ico, 'ico'), 'image/x-icon')
  assert.equal(await detectResourceMime(png, 'jpg'), null)
  assert.equal(await detectResourceMime(Buffer.from('hello\0world'), 'txt'), null)
  assert.equal(await detectResourceMime(Buffer.from('{"ok":true}'), 'json'), 'application/json')
  assert.equal(await detectResourceMime(Buffer.from('{invalid'), 'json'), null)
})

test('public resource DTO strips storage internals and enforces tenant and URL', () => {
  const safe = resourceDto(
    {
      id: 42,
      tenantId,
      originName: 'logo.png',
      mimeType: 'image/png',
      suffix: 'png',
      sizeByte: png.length,
      sizeInfo: '68 B',
      url: '/api/resources/42/content',
      version: 1,
      createdAt: '2026-11-07T00:00:00Z',
      updatedAt: '2026-11-07T00:00:00Z',
      objectKey: 'secret-key',
      hash: 'secret-hash',
      uploadToken: 'secret-token'
    },
    tenantId
  )
  assert.equal(safe.id, 42)
  assert.ok(!JSON.stringify(safe).includes('secret-'))
  assert.throws(
    () => resourceDto({ ...safe, tenantId: '22222222-2222-4222-8222-222222222222' }, tenantId),
    /Invalid resource tenant/
  )
  assert.throws(
    () => resourceDto({ ...safe, url: 'https://evil.test/logo.png' }, tenantId),
    /Invalid resource URL/
  )
  assert.throws(
    () => resourceDto({ ...safe, sizeByte: 10 * 1024 * 1024 + 1 }, tenantId),
    /Invalid resource number/
  )
})

test('multipart parser accepts one verified image and rejects extra fields or spoofed names', async () => {
  async function request(form: FormData): Promise<IncomingMessage> {
    const payload = new Response(form)
    const data = Buffer.from(await payload.arrayBuffer())
    const incoming = new IncomingMessage(new Socket())
    incoming.headers = {
      'content-type': payload.headers.get('content-type') || '',
      'content-length': String(data.length)
    }
    incoming.push(data)
    incoming.push(null)
    return incoming
  }
  const valid = new FormData()
  valid.set('file', new File([Uint8Array.from(png)], 'logo.png', { type: 'image/png' }))
  const parsed = await parseResourceUpload(await request(valid))
  assert.equal(parsed.name, 'logo.png')
  assert.equal(parsed.mime, 'image/png')
  assert.deepEqual(parsed.data, png)
  valid.set('tenantId', 'forged')
  await assert.rejects(parseResourceUpload(await request(valid)), /每次只能上传一个文件/)
  const spoofed = new FormData()
  spoofed.set('file', new File([Uint8Array.from(gif)], 'logo.png', { type: 'image/png' }))
  await assert.rejects(parseResourceUpload(await request(spoofed)), /文件内容与扩展名不一致/)
})
