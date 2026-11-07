/** Trusted identity/database transport. Retry a failed GET once; writes never replay. */
export const remoteFetch: typeof fetch = async (input, init) => {
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const upstream = init?.signal || (input instanceof Request ? input.signal : undefined)
  const request = () =>
    fetch(input, {
      ...init,
      signal: upstream
        ? AbortSignal.any([upstream, AbortSignal.timeout(method === 'GET' ? 8000 : 30_000)])
        : AbortSignal.timeout(method === 'GET' ? 8000 : 30_000)
    })
  try {
    return await request()
  } catch (error) {
    if (
      method !== 'GET' ||
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
