import type { IncomingMessage, ServerResponse } from 'node:http'
import { config } from './config'

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'REQUEST_FAILED',
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}
export function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(value))
}
export function redirect(res: ServerResponse, target: string): void {
  res.writeHead(303, { Location: target, 'Cache-Control': 'no-store' })
  res.end()
}
export function cookie(req: IncomingMessage, name: string): string {
  return (
    req.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${name}=`))
      ?.slice(name.length + 1) || ''
  )
}
export function setCookie(res: ServerResponse, name: string, value: string, maxAge: number): void {
  const current = res.getHeader('Set-Cookie')
  res.setHeader('Set-Cookie', [
    ...(Array.isArray(current) ? current : current ? [String(current)] : []),
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(config.origin).protocol === 'https:' ? '; Secure' : ''}`
  ])
}
export async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new HttpError(415, '请使用 JSON 格式提交')
  let text = ''
  for await (const chunk of req) {
    text += chunk.toString()
    if (Buffer.byteLength(text) > 16384) throw new HttpError(413, '提交内容过长')
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch {
    throw new HttpError(400, '提交内容格式有误')
  }
}
