import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    testMatch: '**/*.spec.js',
    timeout: 90000,       // vector queries + LLM calls can take a while
    expect: { timeout: 10000 },
    use: {
        baseURL: process.env.SILLYTAVERN_URL || 'http://100.102.50.77:7598',
        headless: false,  // headed so you can see ST and intervene if needed
        viewport: { width: 1280, height: 900 },
    },
    workers: 1,           // serial — tests share ST state
    reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
});
