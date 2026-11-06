/** Isolated browser QA fixture. Uses synthetic data in memory; never calls Supabase. */
import { createServer } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import path from 'node:path'
import type { ApplicationInput, BffApplication, BffSession } from '../../src/types/bff'

const administrator = '11111111-1111-4111-8111-111111111111'
const viewer = '22222222-2222-4222-8222-222222222222'
const session: BffSession = {
  user: {
    id: administrator,
    name: '布局验证用户',
    email: 'admin@example.test',
    role: 'admin',
    tenantId: '33333333-3333-4333-8333-333333333333'
  },
  csrfToken: 'synthetic-ui-fixture',
  permissions: [
    'BffApplication:View',
    'BffApplication:Add',
    'BffApplication:Edit',
    'BffApplication:Grant'
  ],
  menu: [
    {
      path: '/applications',
      name: 'BffApplications',
      component: '/bff/applications/index',
      meta: { title: '布局验证', icon: 'ri:apps-2-line' }
    }
  ]
}
let rows: BffApplication[] = [
  {
    id: '44444444-4444-4444-8444-444444444444',
    code: 'purchase-workbench',
    name: '示例采购工作台',
    description: '仅用于页面布局验证的示例数据',
    homeUrl: 'https://example.test/purchase',
    enabled: true,
    version: 1,
    createdAt: '2026-11-06T06:00:00Z',
    updatedAt: '2026-11-06T06:00:00Z'
  }
]
let granted = false
const root = path.resolve('dist')
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost:3020')
  const reply = (value: unknown, status = 200): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(value))
  }
  if (url.pathname === '/api/auth/session') {
    reply(session)
    return
  }
  if (url.pathname === '/api/health') {
    reply({ authenticationConfigured: true })
    return
  }
  if (url.pathname === '/api/control/dictionaries') {
    reply({ revision: 1, types: [], items: [] })
    return
  }
  if (url.pathname === '/api/auth/logout') {
    reply({ signedOut: true })
    return
  }
  if (url.pathname.endsWith('/members') && req.method === 'GET') {
    reply([
      {
        id: administrator,
        name: '测试管理员',
        email: 'admin@example.test',
        role: 'admin',
        enabled: true,
        granted: true
      },
      {
        id: viewer,
        name: '测试成员',
        email: 'viewer@example.test',
        role: 'viewer',
        enabled: true,
        granted
      }
    ])
    return
  }
  if (url.pathname.includes(`/members/${viewer}`) && req.method === 'PUT') {
    granted = !granted
    reply({ saved: true })
    return
  }
  if (url.pathname === '/api/applications' && req.method === 'GET') {
    const selected = rows.filter((row) => row.name.includes(url.searchParams.get('name') || ''))
    reply({ records: selected, total: selected.length, current: 1, size: 20 })
    return
  }
  if (url.pathname.startsWith('/api/applications') && ['POST', 'PUT'].includes(req.method || '')) {
    let raw = ''
    for await (const chunk of req) raw += chunk.toString()
    const input = JSON.parse(raw) as ApplicationInput
    if (req.method === 'POST')
      rows = [
        {
          ...input,
          id: crypto.randomUUID(),
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        ...rows
      ]
    else
      rows = rows.map((row) =>
        url.pathname.endsWith(row.id)
          ? { ...row, ...input, version: row.version + 1, updatedAt: new Date().toISOString() }
          : row
      )
    reply({ saved: true })
    return
  }
  let file = path.resolve(root, `.${url.pathname}`)
  if (!file.startsWith(`${root}${path.sep}`) && file !== root) {
    res.writeHead(403)
    res.end()
    return
  }
  if (!existsSync(file) || !path.extname(file)) file = path.join(root, 'index.html')
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2'
  }
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream')
  createReadStream(file).pipe(res)
})
server.listen(3020, '127.0.0.1', () =>
  console.log('Synthetic UI verification server: http://localhost:3020')
)
