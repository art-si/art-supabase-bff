import { expect, test } from '@playwright/test'

test('session bootstrap failure restarts OAuth with the original local destination', async ({
  page
}) => {
  let restarted: URL | undefined
  await page.route('**/api/auth/session', (route) => route.abort('failed'))
  await page.route('**/api/auth/login?**', async (route) => {
    restarted = new URL(route.request().url())
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>OAuth restart captured</title>'
    })
  })
  await page.goto('/applications?name=orders')
  await expect.poll(() => restarted?.pathname).toBe('/api/auth/login')
  expect(restarted?.searchParams.get('returnTo')).toBe('/applications?name=orders')
  expect(restarted?.searchParams.get('restart')).toBe('1')
})

test('old transient login URL restarts once while terminal login failure stays visible', async ({
  request
}) => {
  const transient = await request.get(
    '/auth/login?error=service_unavailable&returnTo=%2Fapplications%3Fname%3Dorders',
    { maxRedirects: 0 }
  )
  expect(transient.status()).toBe(303)
  const restart = new URL(transient.headers().location, 'http://localhost')
  expect(restart.pathname).toBe('/api/auth/login')
  expect(restart.searchParams.get('returnTo')).toBe('/applications?name=orders')
  expect(restart.searchParams.get('restart')).toBe('1')

  const terminal = await request.get('/auth/login?error=login_unavailable', {
    maxRedirects: 0
  })
  expect(terminal.status()).toBe(200)
  expect(terminal.headers().location).toBeUndefined()
})
