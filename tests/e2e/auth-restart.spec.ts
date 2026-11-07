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
  let recovery: URL | undefined
  await page.route('**/api/auth/session', (route) => route.abort('failed'))
  await page.route('**/api/auth/login?**', async (route) => {
    restarts++
    const request = new URL(route.request().url())
    if (request.searchParams.get('reason') === 'service_unavailable') {
      recovery = request
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>Common identity login</title><p>Shared identity login recovery</p>'
      })
      return
    }
    const resume = request.searchParams.get('returnTo')
    await route.fulfill({ status: 303, headers: { location: resume || '/applications' } })
  })
  await page.goto('/applications?name=orders')
  await expect(page.getByText('Shared identity login recovery', { exact: true })).toBeVisible()
  expect(restarts).toBe(2)
  expect(recovery?.searchParams.get('returnTo')).toBe('/applications?name=orders')
  expect(recovery?.searchParams.get('force_login')).toBe('1')
  await expect(page.getByText('登录未完成', { exact: true })).toHaveCount(0)
})

test('all legacy local login pages redirect without rendering a BFF login card', async ({
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
  expect(terminal.status()).toBe(303)
  const next = new URL(terminal.headers().location, 'http://localhost')
  expect(next.pathname).toBe('/api/auth/login')
  expect(next.searchParams.get('restart')).toBe('1')
})
