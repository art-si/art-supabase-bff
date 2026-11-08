/** Synthetic local upstreams; contains no database or authentication credentials. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const responderOrigin = 'http://127.0.0.1:33445'
const kinds = ['java', 'supabase', 'cloudbase'] as const
type Kind = (typeof kinds)[number]
export function demoResponder() {
  return createServer((req, res) => {
    const url = new URL(req.url || '/', responderOrigin)
    if (req.method === 'GET' && url.pathname === '/' && !url.search) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ready', synthetic: true }))
      return
    }
    const offsetText = url.searchParams.get('offset')
    const limitText = url.searchParams.get('limit')
    const offset = Number(offsetText)
    const limit = Number(limitText)
    if (
      req.method !== 'GET' ||
      !kinds.some((kind) => url.pathname === `/${kind}`) ||
      url.searchParams.size !== 2 ||
      !offsetText ||
      !/^(0|[1-9]\d*)$/.test(offsetText) ||
      !Number.isSafeInteger(offset) ||
      offset > 100_000_000 ||
      !limitText ||
      !/^[1-9]\d*$/.test(limitText) ||
      !Number.isSafeInteger(limit) ||
      limit > 100 ||
      req.headers.authorization ||
      req.headers.cookie
    ) {
      res.writeHead(400).end()
      return
    }
    const kind = url.pathname.slice(1) as Kind
    const rows = [1, 2]
      .map((number) => ({ id: `${kind}-${number}`, name: `${kind} 示例 ${number}` }))
      .slice(offset, offset + limit)
    const value =
      kind === 'java'
        ? { code: 0, data: { records: rows, total: 2 } }
        : kind === 'cloudbase'
          ? { result: { code: 0, data: { list: rows, total: 2 } } }
          : rows
    if (kind === 'supabase' && req.headers.prefer !== 'count=exact') {
      res.writeHead(400).end()
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      ...(kind === 'supabase'
        ? { 'Content-Range': rows.length ? `${offset}-${offset + rows.length - 1}/2` : '*/2' }
        : {})
    })
    res.end(JSON.stringify(value))
  })
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const server = demoResponder()
  server.listen(33445, '127.0.0.1')
  await once(server, 'listening')
  console.log('Local demo upstream ready at http://127.0.0.1:33445; test with current=1, size=20.')
  const stop = () => {
    server.closeAllConnections()
    server.close()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
