import { defineConfig } from 'vitest/config';

/**
 * Unit tests only — `src/**`.
 *
 * `e2e/` holds Playwright specs, which use the same words (`test`, `beforeEach`)
 * from a different runner. Vitest picks them up by default and they fail with
 * "Playwright Test did not expect test() to be called here", which reads like a
 * broken test rather than the wrong runner having opened the file.
 *
 * The e2e suite runs from its own `e2e` script, in its own CI job.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{js,ts}'],
    environment: 'node',
  },
});
