import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests run against the REAL stack:
 *   - the FastAPI backend on :8000 (must be seeded/running)
 *   - the Vite dev server in live mode
 *
 * Both servers are reused if already running, otherwise Playwright starts them.
 * Run:  npx playwright install chromium && npx playwright test
 */

const API = process.env.TRIPWIRE_API_BASE_URL ?? 'http://localhost:8000';
const APP = process.env.TRIPWIRE_APP_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // The demo mutates one shared backend, so the specs must not interleave.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: APP,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1500, height: 950 } },
    },
  ],
  webServer: [
    {
      command: 'node server.js',
      cwd: '../mock-backend',
      url: 'http://127.0.0.1:8787/api/health',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'npm run dev',
      url: APP,
      reuseExistingServer: true,
      timeout: 90_000,
      env: {
        VITE_API_MODE: 'live',
        VITE_API_BASE_URL: API,
      },
    },
  ],
});
