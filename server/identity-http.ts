import type { CustomFetch } from 'openid-client'

/** Retry a transient identity-server GET once; code/token POSTs are never replayed. */
export const identityFetch: typeof fetch = async (input, init) => {
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (method !== 'GET') return fetch(input, init)
  const upstream = init?.signal || (input instanceof Request ? input.signal : undefined)
  const request = () =>
    fetch(input, {
      ...init,
      signal: upstream
        ? AbortSignal.any([upstream, AbortSignal.timeout(8000)])
        : AbortSignal.timeout(8000)
    })
  try {
    return await request()
  } catch (error) {
    if (
      upstream?.aborted ||
      !(
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === 'TimeoutError')
      )
    )
      throw error
    return request()
  }
}

/** Normalize SDK byte buffers at the TypeScript 6 Fetch boundary. */
export const oidcIdentityFetch: CustomFetch = (url, options) =>
  identityFetch(url, {
    ...options,
    body: options.body instanceof Uint8Array ? new Uint8Array(options.body) : options.body
  })
