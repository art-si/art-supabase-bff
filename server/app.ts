import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
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
import { provisionMember } from './member-provision'
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
import {
  listReleases,
  releaseOptions,
  releaseHistory,
  releaseReadiness,
  writeRelease
} from './releases'
import { handleBridgeGateway, handleGateway } from './gateway'
import { authenticateProBridge } from './pro-bridge'
import { authorizeProIntegrationOrigin, readProDispatchPreflight } from './pro-transport'
import { brandingDto, readBranding, writeBranding } from './branding'
import { generateBrandWordmark } from './wordmark'
import {
  acknowledgeAlert,
  alertDetail,
  alertOptions,
  callDetail,
  callOptions,
  changeAlertRuleStatus,
  evaluateAlertRule,
  listAlertRules,
  listAlerts,
  listCalls,
  writeAlertRule
} from './observability'
import {
  listResources,
  uploadResource,
  renameResource,
  deleteResource,
  resourceReferences,
  resourceDisplayNames,
  serveResource
} from './resources'
import TreeUtils from 'art-supabase-pro/src/utils/tree.ts'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  let url: URL
  try {
    url = new URL(req.url || '/', config.origin)
  } catch {
    json(res, { code: 'INVALID_URL', message: '请求地址格式有误' }, 400)
    return
  }
  const requestId = url.pathname.startsWith('/api/gateway/') ? randomUUID() : undefined
  if (requestId) res.setHeader('X-Request-Id', requestId)
  try {
    if (['/api/health', '/api/health/'].includes(url.pathname) && req.method === 'GET') {
      json(res, {
        status: 'ok',
        authenticationConfigured: authReady(),
        capabilities: [
          'upstreams',
          'interfaces',
          'branding',
          'resources',
          'releases',
          'calls',
          'alerts',
          'response-contracts',
          'pro-integration'
        ]
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
    if (url.pathname === '/api/integrations/pro') {
      if (req.method !== 'POST') throw new HttpError(405, 'Pro 接入仅支持 POST 请求')
      const bridge = await authenticateProBridge(req)
      await handleBridgeGateway(req, res, bridge.member, bridge.invocation, randomUUID())
      return
    }
    const isProPreflight = url.pathname === '/api/integrations/pro/dispatch-preflight'
    if (isProPreflight) {
      authorizeProIntegrationOrigin(req, res)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Max-Age': '300'
        })
        res.end()
        return
      }
      if (req.method !== 'GET') throw new HttpError(405, '综合核验仅提供只读查询')
    }
    const session = await authenticate(req)
    if (isProPreflight) {
      json(res, await readProDispatchPreflight(session, url))
      return
    }
    if (requestId) {
      await handleGateway(req, res, session, url, requestId)
      return
    }
    if (url.pathname === '/api/auth/session' && req.method === 'GET') {
      const snapshot = await database.rpc(
        'bff_session_context',
        { p_actor: session.member.id },
        { get: true }
      )
      controlFailure(snapshot.error)
      const context: unknown = snapshot.data
      if (
        !isObjectRecord(context) ||
        !Array.isArray(context.navigation) ||
        !context.navigation.every(isObjectRecord) ||
        !Array.isArray(context.permissions) ||
        !context.permissions.every((value: unknown) => typeof value === 'string')
      )
        throw new Error('Invalid session context')
      const nodes = context.navigation
      const permissions = context.permissions
      json(res, {
        user: {
          id: session.member.id,
          name: session.member.display_name,
          email: session.member.email,
          role: session.member.role,
          tenantId: session.member.tenant_id
        },
        csrfToken: session.row.csrf_token,
        permissions,
        branding: brandingDto(context.branding),
        menu: new TreeUtils({ parentKey: 'parentId' }).listToTree(nodes)
      })
      return
    }
    if (url.pathname === '/api/resources' && req.method === 'GET') {
      json(res, await listResources(session, url))
      return
    }
    if (url.pathname === '/api/resources/upload' && req.method === 'POST') {
      json(res, await uploadResource(req, session), 201)
      return
    }
    if (url.pathname === '/api/resources/names' && req.method === 'GET') {
      json(res, await resourceDisplayNames(session, url))
      return
    }
    if (url.pathname === '/api/resources/references' && req.method === 'POST') {
      json(res, await resourceReferences(req, session))
      return
    }
    const resource = /^\/api\/resources\/([^/]+)(?:\/(name|content))?$/.exec(url.pathname)
    if (resource) {
      if (resource[2] === 'content' && req.method === 'GET') {
        await serveResource(req, res, session, resource[1])
        return
      }
      if (resource[2] === 'name' && req.method === 'PUT') {
        json(res, await renameResource(req, session, resource[1]))
        return
      }
      if (!resource[2] && req.method === 'DELETE') {
        json(res, await deleteResource(req, session, resource[1]))
        return
      }
    }
    if (url.pathname === '/api/control/menus' && req.method === 'GET') {
      json(res, await readMenus(session, url.searchParams.get('catalog') === '1'))
      return
    }
    if (url.pathname === '/api/control/organizations' && req.method === 'GET') {
      // BFF roles currently belong to the workspace; no organization records are provisioned.
      json(res, [])
      return
    }
    if (url.pathname === '/api/control/branding/wordmark' && req.method === 'POST') {
      json(res, await generateBrandWordmark(req, session))
      return
    }
    if (url.pathname === '/api/control/branding') {
      if (req.method === 'GET') {
        json(res, await readBranding(session))
        return
      }
      if (req.method === 'POST') {
        json(res, await writeBranding(req, session))
        return
      }
    }
    if (url.pathname === '/api/calls/options' && req.method === 'GET') {
      json(res, await callOptions(session))
      return
    }
    if (url.pathname === '/api/calls' && req.method === 'GET') {
      json(res, await listCalls(session, url))
      return
    }
    const callResource = /^\/api\/calls\/([^/]+)$/.exec(url.pathname)
    if (callResource && req.method === 'GET') {
      json(res, await callDetail(session, callResource[1]))
      return
    }
    if (url.pathname === '/api/alerts/options' && req.method === 'GET') {
      json(res, await alertOptions(session))
      return
    }
    if (url.pathname === '/api/alerts/rules') {
      if (req.method === 'GET') {
        json(res, await listAlertRules(session, url))
        return
      }
      if (req.method === 'POST') {
        json(res, await writeAlertRule(req, session, 'create'), 201)
        return
      }
    }
    const alertRuleResource =
      /^\/api\/alerts\/rules\/([^/]+)(?:\/(status|archive|evaluate))?$/.exec(url.pathname)
    if (alertRuleResource) {
      const [, id, action] = alertRuleResource
      if (!action && req.method === 'PUT') {
        json(res, await writeAlertRule(req, session, 'update', id))
        return
      }
      if (action === 'status' && req.method === 'POST') {
        json(res, await changeAlertRuleStatus(req, session, id))
        return
      }
      if (action === 'archive' && req.method === 'POST') {
        json(res, await writeAlertRule(req, session, 'archive', id))
        return
      }
      if (action === 'evaluate' && req.method === 'POST') {
        json(res, await evaluateAlertRule(req, session, id))
        return
      }
    }
    if (url.pathname === '/api/alerts' && req.method === 'GET') {
      json(res, await listAlerts(session, url))
      return
    }
    const alertResource = /^\/api\/alerts\/([^/]+)(?:\/(ack))?$/.exec(url.pathname)
    if (alertResource) {
      const [, id, action] = alertResource
      if (!action && req.method === 'GET') {
        json(res, await alertDetail(session, id))
        return
      }
      if (action === 'ack' && req.method === 'POST') {
        json(res, await acknowledgeAlert(req, session, id))
        return
      }
    }
    if (url.pathname === '/api/releases/options' && req.method === 'GET') {
      json(res, await releaseOptions(session))
      return
    }
    if (url.pathname === '/api/releases' && req.method === 'GET') {
      json(res, await listReleases(session, url))
      return
    }
    const releaseResource =
      /^\/api\/releases\/([^/]+)\/(history|readiness|publish|rollback|status)$/.exec(url.pathname)
    if (releaseResource) {
      const [, id, operation] = releaseResource
      if (operation === 'history' && req.method === 'GET') {
        json(res, await releaseHistory(session, id, url))
        return
      }
      if (operation === 'readiness' && req.method === 'GET') {
        json(res, await releaseReadiness(session, id, url))
        return
      }
      if (
        (operation === 'publish' || operation === 'rollback' || operation === 'status') &&
        req.method === 'POST'
      ) {
        json(res, await writeRelease(req, session, id, operation))
        return
      }
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
    if (url.pathname === '/api/control/members/provision' && req.method === 'POST') {
      json(res, await provisionMember(req, session))
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
        path: requestId ? '/api/gateway/*' : url.pathname,
        ...(requestId ? { requestId } : {}),
        kind: error instanceof Error ? error.name : 'UnknownError'
      })
    if (url.pathname === '/api/auth/callback') {
      if (known && error.code === 'ACCESS_NOT_GRANTED') {
        redirect(res, '/api/auth/login?force_login=1&reason=access_denied')
        return
      }
      redirect(
        res,
        `/api/auth/login?restart=1&force_login=1&reason=${url.searchParams.get('error') === 'access_denied' ? 'authorization_cancelled' : 'login_failed'}`
      )
      return
    }
    if (url.pathname === '/api/auth/login') {
      json(
        res,
        {
          code: known ? error.code : 'AUTH_UNAVAILABLE',
          message: known ? error.message : '统一登录暂时无法连接，请稍后重试'
        },
        known ? error.status : 503
      )
      return
    }
    json(
      res,
      {
        code: known ? error.code : 'INTERNAL_ERROR',
        message: known ? error.message : '服务暂时不可用，请稍后重试',
        ...(url.pathname === '/api/integrations/pro'
          ? { msg: known ? error.message : '服务暂时不可用，请稍后重试' }
          : {}),
        ...(requestId ? { requestId } : {})
      },
      known ? error.status : 500
    )
  }
}

export function handleAuthEntry(req: IncomingMessage, res: ServerResponse): boolean {
  let pageUrl: URL
  try {
    pageUrl = new URL(req.url || '/', config.origin)
  } catch {
    res.writeHead(400)
    res.end()
    return true
  }
  if (req.method === 'GET' && (pageUrl.pathname === '/' || pageUrl.pathname === '/auth/login')) {
    const error = pageUrl.searchParams.get('error')
    const query = new URLSearchParams({
      returnTo: safeReturnPath(pageUrl.searchParams.get('returnTo'))
    })
    if (error === 'access_denied') {
      query.set('force_login', '1')
      query.set('reason', error)
    }
    if (error) query.set('restart', '1')
    if (error === 'login_failed' || error === 'authorization_cancelled') {
      query.set('force_login', '1')
      query.set('reason', error)
    }
    if (pageUrl.searchParams.get('signed_out') === '1') query.set('force_login', '1')
    redirect(res, `/api/auth/login?${query}`)
    return true
  }
  return false
}
