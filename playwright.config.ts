import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  timeout: 30000,
  use: {
    baseURL: process.env.STAGING_URL || 'http://127.0.0.1:8080',
    headless: true,
  },
});
