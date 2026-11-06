import assert from 'node:assert/strict'
import test from 'node:test'
import { dictionaryInput, idsInput, menuInput, revisionInput } from '../../server/control-plane'

const id = '11111111-1111-4111-8111-111111111111'
const menu = {
  name: 'ExampleMenu',
  type: 'menu',
  path: '/example',
  component: '/bff/applications/index',
  meta: { title: '示例入口', isEnable: true }
}
test('menu input accepts installed pages and strips client authority fields', () => {
  const result = menuInput({
    ...menu,
    tenantId: id,
    builtin: true,
    createBy: id,
    meta: { ...menu.meta, roles: ['admin'], tenantId: id }
  })
  assert.equal(result.tenantId, undefined)
  assert.equal(result.builtin, undefined)
  assert.equal(result.createBy, undefined)
  assert.deepEqual(result.meta, {
    ...menu.meta,
    icon: '',
    showTextBadge: '',
    activePath: '',
    link: ''
  })
  assert.throws(() => menuInput({ ...menu, id }), /版本/)
  assert.equal(menuInput({ ...menu, id, version: 3 }).version, 3)
})
test('menu input rejects arbitrary components, unsafe paths and external credentials', () => {
  for (const component of ['/system/user', '../../secrets', '/missing/page'])
    assert.throws(() => menuInput({ ...menu, component }), /尚未安装/)
  for (const path of ['//other.test', '/a?x=1', '/a#frag', '/a\\b', '/a\nb'])
    assert.throws(() => menuInput({ ...menu, path }), /路由地址/)
  for (const link of ['javascript:alert(1)', 'https://user:password@example.test'])
    assert.throws(() => menuInput({ ...menu, meta: { ...menu.meta, link } }), /外部链接/)
})
test('dictionary input preserves disabled status and normalizes optional references', () => {
  const value = dictionaryInput('item', {
    typeId: id,
    label: '开发环境',
    value: 'development',
    status: '2',
    parentId: '',
    cascadeParentId: null,
    color: '#09ac',
    tagType: 'info'
  })
  assert.equal(value.status, '2')
  assert.equal(value.parentId, null)
  assert.equal(value.cascadeParentId, null)
  assert.throws(
    () => dictionaryInput('item', { typeId: id, label: 'x', value: 'x', color: '#12345' }),
    /颜色/
  )
  assert.throws(
    () => dictionaryInput('type', { nodeType: 'dictionary', code: 'bad code', name: 'x' }),
    /编码/
  )
})
test('control commands require bounded distinct IDs and a positive exact revision', () => {
  assert.deepEqual(idsInput([id]), [id])
  for (const ids of [[], [id, id], [1], Array(501).fill(id)]) assert.throws(() => idsInput(ids))
  for (const revision of [0, -1, '1', undefined, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => revisionInput(revision))
  assert.equal(revisionInput(4), 4)
})
