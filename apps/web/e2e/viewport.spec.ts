import { test, expect, type Page } from '@playwright/test';

/**
 * The bottom of every screen is reachable on a phone, and the bottom nav is on the screen.
 *
 * Reported from an iPhone in Arc (2026-10-08): on a board's Operate tab the page would not scroll
 * past Activity, and the bottom nav — which carries the account menu, the only sign-out on a
 * phone — was nowhere. The app frame was `h-screen overflow-hidden`, and `100vh` on a phone is the
 * height with the toolbars HIDDEN; with Arc's toolbar showing, the frame's last ~180px were under
 * it and the frame itself could not scroll.
 *
 * Playwright has no browser toolbar, so `100vh` and `100dvh` are the same number here at any
 * viewport size, and these tests pass against the old frame too. What they hold is the shape of
 * the fix at both heights — a full phone (844) and one with ~180px of toolbar taken off (664):
 * the frame fits the viewport, the last thing on the page scrolls clear of the nav, the nav is
 * whole, and nothing scrolls sideways. The `vh` rule itself is held where it can fail, in
 * src/lib/viewport-units.test.ts.
 */
const BOARD_KEY = 'superpipeline.boardId';
const API = 'http://localhost:8787';
const TENANT = { 'X-Tenant-Id': 'tnt_dev', 'Content-Type': 'application/json' };
const STAGES = [
  { key: 'backlog', name: 'Backlog', order: 0 },
  { key: 'review', name: 'Review', order: 1, gate: 'approval' },
  { key: 'done', name: 'Done', order: 2 },
];

const HEIGHTS = [
  { name: 'a whole phone screen', height: 844 },
  { name: 'a phone with the browser toolbar showing', height: 664 },
];

let boardId: string;

test.beforeEach(async ({ page, request }) => {
  const res = await request.post(`${API}/v1/boards`, { headers: TENANT, data: { name: 'Viewport E2E', stages: STAGES } });
  boardId = ((await res.json()) as { boardId: string }).boardId;
  for (let i = 1; i <= 6; i++) {
    await request.post(`${API}/v1/boards/${boardId}/cards`, {
      headers: TENANT,
      data: { title: `Card ${i} on a short screen`, ownerUserId: 'usr_dev' },
    });
  }
  await page.addInitScript(([key, id]) => window.localStorage.setItem(key as string, id as string), [BOARD_KEY, boardId]);
});

/** The nav's box, the frame's height, and the page's sideways scroll, measured in the page. */
async function frame(page: Page) {
  return page.evaluate(() => {
    // The rail is also `nav[aria-label=Main]`, display:none below 900px: take the one with a box.
    const nav = [...document.querySelectorAll('nav[aria-label="Main"]')]
      .map((n) => n.getBoundingClientRect())
      .find((r) => r.height > 0)!;
    const shell = document.querySelector('.app-shell')!.getBoundingClientRect();
    return {
      innerHeight: window.innerHeight,
      navTop: nav.top,
      navBottom: nav.bottom,
      shellBottom: shell.bottom,
      sideways: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

for (const { name, height } of HEIGHTS) {
  test.describe(`on ${name} (390×${height})`, () => {
    test.use({ viewport: { width: 390, height } });

    test('the end of Operate scrolls clear of the bottom nav, and the nav is whole', async ({ page }) => {
      await page.goto(`/b/${boardId}/operate`);
      const activity = page.locator('section', { has: page.getByRole('heading', { name: 'Activity' }) });
      await expect(activity).toBeVisible();

      // Scroll the page's own scroller as far as it goes — what a thumb does — then look.
      await page.locator('main').last().evaluate((el) => el.scrollTo(0, el.scrollHeight));

      const f = await frame(page);
      expect(f.shellBottom, 'the app frame is taller than the viewport').toBeLessThanOrEqual(f.innerHeight + 0.5);
      expect(f.navTop, 'the bottom nav starts off the screen').toBeGreaterThanOrEqual(0);
      expect(f.navBottom, 'the bottom nav runs off the bottom of the screen').toBeLessThanOrEqual(f.innerHeight + 0.5);

      const end = (await activity.boundingBox())!;
      expect(end.y + end.height, 'the end of Activity is under the bottom nav').toBeLessThanOrEqual(f.navTop + 0.5);
      expect(f.sideways, 'the page scrolls sideways').toBeLessThanOrEqual(0);

      // The account menu — sign-out — is a tap away.
      await page.getByRole('navigation', { name: 'Main' }).getByRole('button').last().click();
      await expect(page.getByRole('menuitem', { name: /sign out/i })).toBeInViewport({ ratio: 1 });
    });

    for (const route of ['', '/settings', '/operate/telemetry']) {
      test(`the board${route || ' (Plan)'} keeps the nav on screen`, async ({ page }) => {
        await page.goto(`/b/${boardId}${route}`);
        await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
        await page.waitForLoadState('networkidle');
        const f = await frame(page);
        expect(f.shellBottom).toBeLessThanOrEqual(f.innerHeight + 0.5);
        expect(f.navBottom).toBeLessThanOrEqual(f.innerHeight + 0.5);
        expect(f.sideways).toBeLessThanOrEqual(0);
      });
    }

    test('the workspace keeps the nav on screen', async ({ page }) => {
      await page.goto('/workspace');
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
      await page.waitForLoadState('networkidle');
      const f = await frame(page);
      expect(f.shellBottom).toBeLessThanOrEqual(f.innerHeight + 0.5);
      expect(f.navBottom).toBeLessThanOrEqual(f.innerHeight + 0.5);
      expect(f.sideways).toBeLessThanOrEqual(0);
    });
  });
}
