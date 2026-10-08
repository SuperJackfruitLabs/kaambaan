import { test, expect } from '@playwright/test';

/**
 * The home-screen install files are served to anyone, signed in or not, with the right types.
 *
 * A phone fetches the manifest and icons before anyone has signed in to the installed app, and
 * an iOS home-screen app does not share Safari's cookies. If they sat behind the session check
 * the install would get the sign-in page instead, and the icon would be a screenshot. Checked on
 * both servers: the Vite dev server the suite drives, and the Worker (`wrangler dev`, serving the
 * built `apps/web/build`), which is what production is.
 */
const ORIGINS = ['http://localhost:5173', 'http://localhost:8787'];
const FILES: [string, RegExp][] = [
  ['/manifest.webmanifest', /^application\/manifest\+json/],
  ['/icon-192.png', /^image\/png/],
  ['/icon-512.png', /^image\/png/],
  ['/icon-maskable-512.png', /^image\/png/],
  ['/apple-touch-icon.png', /^image\/png/],
];

for (const origin of ORIGINS) {
  test(`install files are public on ${origin}`, async ({ playwright }) => {
    // A fresh context: no cookies, no dev-auth headers.
    const anon = await playwright.request.newContext();
    try {
      for (const [path, type] of FILES) {
        const res = await anon.get(`${origin}${path}`, { maxRedirects: 0 });
        expect(res.status(), path).toBe(200);
        expect(res.headers()['content-type'], path).toMatch(type);
      }
      const manifest = await (await anon.get(`${origin}/manifest.webmanifest`)).json();
      expect(manifest.display).toBe('standalone');
    } finally {
      await anon.dispose();
    }
  });
}
