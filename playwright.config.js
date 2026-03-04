import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 1,
  webServer: {
    command: 'python3 -m http.server 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://localhost:4173',
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  workers: 1,
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { viewport: { width: 375, height: 812 } } },
  ],
});
