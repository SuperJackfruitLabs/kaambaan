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
      miniflare: {
        bindings: {
          DEV_AUTH: 'true',
          // Enforcement is ON in wrangler.jsonc — it is production's posture —
          // and OFF here, because this suite tests board mechanics rather than
          // authorization. With it on, every test that queues a card without a
          // token gets it parked: 110 of 369 failed that way, all of them
          // faithfully.
          //
          // The tests that DO test the control pair turn it on themselves
          // (test/control-pair-claim.test.ts), which is the right shape: opt in
          // where it is the subject, off where it is scenery.
          ENFORCE_CONTROL_PAIR: 'false',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
