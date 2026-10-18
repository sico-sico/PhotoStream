import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests drive the packaged renderer inside Electron.
 *
 * They exist for the one thing unit tests cannot check: that the real app
 * boots, scans a real folder through IPC, and reacts to real input. Everything
 * that can be asserted in isolation already is.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // Electron launches once and is driven through the Playwright Electron API,
  // so parallel workers would fight over the same app data directory.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure'
  }
})
