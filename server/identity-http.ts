import type { CustomFetch } from 'openid-client'
import { remoteFetch } from './remote-http'

/** Normalize SDK byte buffers at the TypeScript 6 Fetch boundary. */
export const oidcIdentityFetch: CustomFetch = (url, options) =>
  remoteFetch(url, {
    ...options,
    body: options.body instanceof Uint8Array ? new Uint8Array(options.body) : options.body
  })
