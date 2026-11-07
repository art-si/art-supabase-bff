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
  expect(restarted?.searchParams.get('returnTo')).toBe(
    '/applications?name=orders&_bff_auth_retry=1'
  )
  expect(restarted?.searchParams.get('restart')).toBe('1')
})

test('a persistent bootstrap failure cannot create an OAuth redirect loop', async ({ page }) => {
  let restarts = 0
  await page.route('**/api/auth/session', (route) => route.abort('failed'))
  await page.route('**/api/auth/login?**', async (route) => {
    restarts++
    const resume = new URL(route.request().url()).searchParams.get('returnTo')
    await route.fulfill({ status: 303, headers: { location: resume || '/applications' } })
  })
  await page.goto('/applications?name=orders')
  await expect(page.getByText('统一登录暂时不可用，请稍后重试。', { exact: true })).toBeVisible()
  expect(restarts).toBe(1)
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/applications?name=orders')
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
