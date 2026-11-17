import { defineConfig, devices } from '@playwright/test';

import { siteURL } from './tests/support/env';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  // One worker, so every test shares the one team, channel and user the worker creates.
  workers: 1,
  // No retries: a test that passes only on a second attempt is reported as failing.
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // No HTML report in CI: it records the values typed into the page, passwords included.
  reporter: process.env.CI ? [['list']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: siteURL,
    // Traces and videos record the passwords typed and the session tokens sent, so neither is kept.
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
