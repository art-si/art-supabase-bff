import { createServer } from 'node:http'
import { once } from 'node:events'
import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { config } from './config'
import { handleApi, handleAuthEntry } from './app'
import { startAlertWorker } from './alert-worker'
import { startResourceCleanup } from './resources'

let vite: import('vite').ViteDevServer | undefined
let viteReady: Promise<import('vite').ViteDevServer> | undefined
let stopAlertWorker: (() => void) | undefined
let stopResourceCleanup: (() => void) | undefined

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/')) {
    void handleApi(req, res)
    return
  }
  if (handleAuthEntry(req, res)) return
  if (!config.production) {
    void (async () => {
      try {
        await viteReady
        if (!vite) throw new Error('Frontend is not ready')
        vite.middlewares(req, res)
      } catch {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('页面暂时无法加载，请稍后重试。')
      }
    })()
    return
  }
  const root = path.resolve(config.browserOutputDir)
  let file: string
  try {
    file = path.resolve(
      root,
      `.${decodeURIComponent(new URL(req.url || '/', config.origin).pathname)}`
    )
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  if (!file.startsWith(`${root}${path.sep}`) && file !== root) {
    res.writeHead(403)
    res.end()
    return
  }
  if (!existsSync(file) || !statSync(file).isFile()) file = path.join(root, 'index.html')
  if (!existsSync(file)) {
    res.writeHead(503)
    res.end('Build the application first.')
    return
  }
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.json': 'application/json'
  }
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream')
  createReadStream(file).pipe(res)
})
try {
  const started = performance.now()
  const listening = once(server, 'listening')
  server.listen(config.port, config.host)
  await listening
  stopResourceCleanup = startResourceCleanup()
  console.log(`BFF platform: ${config.origin}`)
  stopAlertWorker = startAlertWorker()
  if (!config.production) {
    console.log('[BFF] 认证服务已就绪，正在准备前端开发服务…')
    viteReady = import('vite').then(({ createServer }) =>
      createServer({ server: { middlewareMode: true, ws: { server } }, appType: 'spa' })
    )
    vite = await viteReady
    console.log(`[BFF] 前端已就绪 (${((performance.now() - started) / 1000).toFixed(1)}s)`)
  }
} catch (error) {
  stopAlertWorker?.()
  stopAlertWorker = undefined
  stopResourceCleanup?.()
  stopResourceCleanup = undefined
  if (server.listening) server.close()
  await vite?.close()
  if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
    console.error(
      `[BFF] 端口 ${config.port} 已被占用。若 BFF 已在运行，请直接访问 ${config.origin}；需要重新启动时，请先在原终端按 Ctrl+C 停止旧服务。`
    )
  } else {
    console.error('[BFF] 服务启动失败，请检查本地配置。', {
      kind: error instanceof Error ? error.name : 'UnknownError'
    })
  }
  process.exitCode = 1
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    stopAlertWorker?.()
    stopAlertWorker = undefined
    stopResourceCleanup?.()
    stopResourceCleanup = undefined
    server.close()
    void vite?.close()
  })
