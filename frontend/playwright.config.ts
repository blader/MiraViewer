import { defineConfig, devices } from '@playwright/test';
import { createHash } from 'node:crypto';

const owner = createHash('sha256')
  .update(import.meta.url)
  .digest('hex')
  .slice(0, 12);

// A disposable browser profile and a separately built origin. Never attach to a
// user's MRI database or reuse another workspace's running server.
export default defineConfig({
  testDir: './tests/browser',
  globalSetup: './tests/browser/checkBuild.ts',
  outputDir: './tmp/browser-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: './tmp/browser-results/results.json' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:43134',
    viewport: { width: 1440, height: 1000 },
    headless: true,
    actionTimeout: 15_000,
    launchOptions: { args: [`--miraviewer-browser-acceptance=${owner}-${process.pid}`] },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    // Exercise the regular browser implementation, not the separate headless shell.
    { name: 'workflow', testMatch: 'workflow.spec.ts', use: { channel: 'chromium' } },
    { name: 'gpu', testMatch: 'gpu.spec.ts' },
    { name: 'performance', testMatch: 'performance.spec.ts' },
    { name: 'inference', testMatch: 'inference.spec.ts' },
  ],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 43134 --strictPort --outDir tmp/browser-dist',
    url: 'http://127.0.0.1:43134',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
