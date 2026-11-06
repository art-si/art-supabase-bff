import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: 'list',
  outputDir: '../.artifacts/playwright-member',
  use: {
    baseURL: process.env.BFF_TEST_ORIGIN || 'http://localhost:3012',
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 }
  }
})
