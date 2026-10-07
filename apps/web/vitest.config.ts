import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

/**
 * Unit tests only — `src/**`.
 *
 * `e2e/` holds Playwright specs, which use the same words (`test`, `beforeEach`)
 * from a different runner. Vitest picks them up by default and they fail with
 * "Playwright Test did not expect test() to be called here", which reads like a
 * broken test rather than the wrong runner having opened the file.
 *
 * The e2e suite runs from its own `e2e` script, in its own CI job.
 *
 * Component tests (`*.svelte.test.ts`) render real Svelte components in jsdom. They need the
 * SvelteKit plugin (for `$lib` and the compiler) and the `browser` export condition, or Svelte
 * resolves to its server build and `mount` refuses to run.
 */
export default defineConfig({
  plugins: [sveltekit()],
  resolve: { conditions: ['browser'] },
  test: {
    include: ['src/**/*.{test,spec}.{js,ts}'],
    environment: 'node',
  },
});
