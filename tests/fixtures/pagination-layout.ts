import { expect, type Page } from '@playwright/test'

/** Measure the footer against its card, not against the last data row. */
export async function expectPaginationAtBottom(page: Page): Promise<void> {
  const card = page.locator('.art-table-query .art-table-card').first()
  await expect(card.locator('.pagination')).toBeVisible()
  await expect
    .poll(async () =>
      card.evaluate((element) => {
        const footer = element.querySelector('.pagination')!
        return Math.round(
          element.getBoundingClientRect().bottom - footer.getBoundingClientRect().bottom
        )
      })
    )
    .toBeLessThanOrEqual(28)
  await expect
    .poll(async () =>
      card.evaluate((element) => {
        const footer = element.querySelector('.pagination')!
        return Math.round(
          element.getBoundingClientRect().bottom - footer.getBoundingClientRect().bottom
        )
      })
    )
    .toBeGreaterThanOrEqual(0)
}

export async function checkPaginationLayouts(page: Page, route: string): Promise<void> {
  await page.goto(route)
  await expect(page.locator('.art-table-query .el-table__row').first()).toBeVisible()
  for (const viewport of [
    { width: 1920, height: 878 },
    { width: 1440, height: 900 },
    { width: 1280, height: 800 }
  ]) {
    await page.setViewportSize(viewport)
    await expectPaginationAtBottom(page)
  }
  await page
    .locator('.el-switch')
    .filter({ has: page.getByRole('switch', { name: '进入专注模式' }) })
    .click()
  await expect(page.getByRole('button', { name: '退出专注模式' })).toBeVisible()
  await expectPaginationAtBottom(page)
  await page.keyboard.press('Escape')
  await expectPaginationAtBottom(page)
  if (await page.getByText('知道了', { exact: true }).count())
    await page.getByText('知道了', { exact: true }).click()
  await page.getByRole('button', { name: '使用流程', exact: true }).click()
  await expect(page.getByRole('heading', { name: '接口接入流程', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: '接口接入流程', exact: true })).toHaveCount(0)
  await expectPaginationAtBottom(page)
  await page.screenshot({ path: `.artifacts/ui/pagination-${route.slice(1)}.png` })
}
