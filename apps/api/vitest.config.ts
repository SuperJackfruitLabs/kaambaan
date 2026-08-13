import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// vitest-pool-workers (vitest 4 line) wires the Workers runtime via a Vite plugin that reads our
// wrangler config for bindings (DB, BOARD_DO) and the Worker entry (docs/09-testing-strategy.md §3).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Dev-mode auth is opt-in (it is NOT in wrangler.jsonc, so a bare `wrangler deploy` is safe).
      // The suite drives the API with the dev X-Tenant-Id headers, so it opts in here.
      miniflare: { bindings: { DEV_AUTH: 'true' } },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
