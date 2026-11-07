import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { config, authReady } from './config'
import { authenticate, startLogin, finishLogin, logout } from './auth'
import {
  grantApplicationMember,
  listApplicationMembers,
  listApplications,
  saveApplication
} from './applications'
import { HttpError, json, redirect } from './http'
import { safeReturnPath } from './security'
import {
  readMenus,
  readDictionaries,
  writeControl,
  controlFailure,
  controlReferences,
  uniqueControlField,
  dictionaryDisplay,
  tableColumnRuntime
} from './control-plane'
import { database } from './database/client'
import { readRoles, writeRole, roleAssignments, readMembers, writeMember } from './access-control'
import {
  listUpstreams,
  upstreamOptions,
  saveUpstream,
  changeUpstream,
  testUpstream,
  upstreamReferences
} from './upstreams'
import {
  listInterfaces,
  interfaceOptions,
  saveInterface,
  deleteInterface,
  validateInterface,
  testInterface,
  interfaceReferences
} from './interfaces'
import TreeUtils from 'art-supabase-pro/src/utils/tree.ts'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'

let vite: import('vite').ViteDevServer | undefined
let viteReady: Promise<import('vite').ViteDevServer> | undefined

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', config.origin)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  try {
    if (url.pathname === '/api/health' && req.method === 'GET') {
      json(res, {
        status: 'ok',
        authenticationConfigured: authReady(),
        capabilities: ['upstreams', 'interfaces']
      })
      return
    }
    if (url.pathname === '/api/auth/login' && req.method === 'GET') {
      await startLogin(req, res, url)
      return
    }
    if (url.pathname === '/api/auth/callback' && req.method === 'GET') {
      await finishLogin(req, res, url)
      return
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      await logout(req, res)
      json(res, { signedOut: true })
      return
    }
    const session = await authenticate(req)
    if (url.pathname === '/api/auth/session' && req.method === 'GET') {
      const [permissions, navigation] = await Promise.all([
        database.rpc('bff_actor_permissions', { p_actor: session.member.id }),
        database.rpc('bff_navigation', { p_actor: session.member.id })
      ])
      controlFailure(permissions.error)
      controlFailure(navigation.error)
      const nodes: unknown = navigation.data
      if (!Array.isArray(nodes) || !nodes.every(isObjectRecord))
        throw new Error('Invalid navigation response')
      json(res, {
        user: {
          id: session.member.id,
          name: session.member.display_name,
          email: session.member.email,
          role: session.member.role,
          tenantId: session.member.tenant_id
        },
        csrfToken: session.row.csrf_token,
        permissions: permissions.data,
        menu: new TreeUtils({ parentKey: 'parentId' }).listToTree(
          nodes.map((node) =>
            node.component === '/shared/system/role'
              ? { ...node, props: { organizationScope: false } }
              : node
          )
        )
      })
      return
    }
    if (url.pathname === '/api/control/menus' && req.method === 'GET') {
      json(res, await readMenus(session, url.searchParams.get('catalog') === '1'))
      return
    }
    if (url.pathname === '/api/interfaces/options' && req.method === 'GET') {
      json(res, await interfaceOptions(session))
      return
    }
    if (url.pathname === '/api/interfaces') {
      if (req.method === 'GET') {
        json(res, await listInterfaces(session, url))
        return
      }
      if (req.method === 'POST') {
        json(res, await saveInterface(req, session), 201)
        return
      }
    }
    const interfaceResource = /^\/api\/interfaces\/([^/]+)(?:\/(validate|tests|references))?$/.exec(
      url.pathname
    )
    if (interfaceResource) {
      const [, id, operation] = interfaceResource
      if (!operation && req.method === 'PUT') {
        json(res, await saveInterface(req, session, id))
        return
      }
      if (!operation && req.method === 'DELETE') {
        json(res, await deleteInterface(req, session, id))
        return
      }
      if (operation === 'validate' && req.method === 'POST') {
        json(res, await validateInterface(req, session, id))
        return
      }
      if (operation === 'tests' && req.method === 'POST') {
        json(res, await testInterface(req, session, id))
        return
      }
      if (operation === 'references' && req.method === 'GET') {
        json(res, await interfaceReferences(session, id))
        return
      }
    }
    if (url.pathname === '/api/upstreams/options' && req.method === 'GET') {
      json(res, await upstreamOptions(session))
      return
    }
    if (url.pathname === '/api/upstreams') {
      if (req.method === 'GET') {
        json(res, await listUpstreams(session, url))
        return
      }
      if (req.method === 'POST') {
        json(res, await saveUpstream(req, session), 201)
        return
      }
    }
    const upstreamResource =
      /^\/api\/upstreams\/([^/]+)(?:\/(status|credential|health-tests|references))?$/.exec(
        url.pathname
      )
    if (upstreamResource) {
      const [, id, operation] = upstreamResource
      if (!operation && req.method === 'PUT') {
        json(res, await saveUpstream(req, session, id))
        return
      }
      if (!operation && req.method === 'DELETE') {
        json(res, await changeUpstream(req, session, id, 'delete'))
        return
      }
      if (operation === 'status' && req.method === 'POST') {
        json(res, await changeUpstream(req, session, id, 'status'))
        return
      }
      if (operation === 'credential' && req.method === 'PUT') {
        json(res, await changeUpstream(req, session, id, 'credential'))
        return
      }
      if (operation === 'health-tests' && req.method === 'POST') {
        json(res, await testUpstream(req, session, id))
        return
      }
      if (operation === 'references' && req.method === 'GET') {
        json(res, await upstreamReferences(session, id))
        return
      }
    }
    if (url.pathname === '/api/control/roles' && (req.method === 'GET' || req.method === 'POST')) {
      json(res, req.method === 'GET' ? await readRoles(session) : await writeRole(req, session))
      return
    }
    const roleResource = /^\/api\/control\/roles\/([^/]+)\/(menus|users)$/.exec(url.pathname)
    if (roleResource && (req.method === 'GET' || req.method === 'POST')) {
      json(
        res,
        await roleAssignments(
          req,
          session,
          roleResource[1],
          roleResource[2] === 'menus' ? 'menus' : 'users'
        )
      )
      return
    }
    if (
      url.pathname === '/api/control/members' &&
      (req.method === 'GET' || req.method === 'POST')
    ) {
      json(res, req.method === 'GET' ? await readMembers(session) : await writeMember(req, session))
      return
    }
    if (url.pathname === '/api/control/dictionaries' && req.method === 'GET') {
      json(res, await readDictionaries(session, url.searchParams.get('options') === '1'))
      return
    }
    if (url.pathname === '/api/control/references' && req.method === 'POST') {
      json(res, await controlReferences(req, session))
      return
    }
    if (url.pathname === '/api/control/unique' && req.method === 'POST') {
      json(res, await uniqueControlField(req, session))
      return
    }
    if (url.pathname === '/api/control/dictionary-display' && req.method === 'GET') {
      json(res, await dictionaryDisplay(session, url))
      return
    }
    if (url.pathname === '/api/control/table-columns' && req.method === 'GET') {
      json(res, await tableColumnRuntime(session, url))
      return
    }
    const controlResource = /^\/api\/control\/(menus|dictionary-types|dictionary-items)$/.exec(
      url.pathname
    )?.[1]
    if (
      req.method === 'POST' &&
      (controlResource === 'menus' ||
        controlResource === 'dictionary-types' ||
        controlResource === 'dictionary-items')
    ) {
      json(res, await writeControl(req, session, controlResource))
      return
    }
    if (url.pathname === '/api/applications') {
      if (req.method === 'GET') {
        json(res, await listApplications(session, url))
        return
      }
      if (req.method === 'POST') {
        json(res, await saveApplication(req, session), 201)
        return
      }
    }
    const match = /^\/api\/applications\/([^/]+)(?:\/members(?:\/([^/]+))?)?$/.exec(url.pathname)
    if (match) {
      if (url.pathname.endsWith('/members') && req.method === 'GET') {
        json(res, await listApplicationMembers(session, match[1]))
        return
      }
      if (match[2] && req.method === 'PUT') {
        json(res, await grantApplicationMember(req, session, match[1], match[2]))
        return
      }
      if (!url.pathname.includes('/members') && req.method === 'PUT') {
        json(res, await saveApplication(req, session, match[1]))
        return
      }
    }
    throw new HttpError(404, '请求的功能不存在')
  } catch (error) {
    const known = error instanceof HttpError
    if (!known)
      console.error('[bff] request failed', {
        path: url.pathname,
        kind: error instanceof Error ? error.name : 'UnknownError'
      })
    if (url.pathname === '/api/auth/callback') {
      if (known && error.code === 'ACCESS_NOT_GRANTED') {
        redirect(res, '/api/auth/login?force_login=1&reason=access_denied')
        return
      }
      redirect(
        res,
        `/auth/login?error=${known && error.code === 'ACCESS_NOT_GRANTED' ? 'access_denied' : url.searchParams.get('error') === 'access_denied' ? 'authorization_cancelled' : 'login_failed'}`
      )
      return
    }
    if (url.pathname === '/api/auth/login') {
      const query = new URLSearchParams({
        error: known && error.code === 'ACCESS_NOT_GRANTED' ? 'access_denied' : 'login_unavailable',
        returnTo: safeReturnPath(url.searchParams.get('returnTo'))
      })
      redirect(res, `/auth/login?${query}`)
      return
    }
    json(
      res,
      {
        code: known ? error.code : 'INTERNAL_ERROR',
        message: known ? error.message : '服务暂时不可用，请稍后重试'
      },
      known ? error.status : 500
    )
  }
}
const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/')) {
    void handleApi(req, res)
    return
  }
  const pageUrl = new URL(req.url || '/', config.origin)
  if (req.method === 'GET' && (pageUrl.pathname === '/' || pageUrl.pathname === '/auth/login')) {
    const error = pageUrl.searchParams.get('error')
    if (error === 'access_denied' || error === 'service_unavailable' || !error) {
      const query = new URLSearchParams({
        returnTo: safeReturnPath(pageUrl.searchParams.get('returnTo'))
      })
      if (error === 'access_denied') {
        query.set('force_login', '1')
        query.set('reason', error)
      }
      if (error === 'service_unavailable') query.set('restart', '1')
      if (pageUrl.searchParams.get('signed_out') === '1') query.set('force_login', '1')
      redirect(res, `/api/auth/login?${query}`)
      return
    }
  }
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
  const root = path.resolve('dist')
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
  server.listen(config.port, '127.0.0.1')
  await listening
  console.log(`BFF platform: ${config.origin}`)
  if (!config.production) {
    console.log('[BFF] 认证服务已就绪，正在准备前端开发服务…')
    viteReady = import('vite').then(({ createServer }) =>
      createServer({ server: { middlewareMode: true, ws: { server } }, appType: 'spa' })
    )
    vite = await viteReady
    console.log(`[BFF] 前端已就绪 (${((performance.now() - started) / 1000).toFixed(1)}s)`)
  }
} catch (error) {
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
    server.close()
    void vite?.close()
  })
