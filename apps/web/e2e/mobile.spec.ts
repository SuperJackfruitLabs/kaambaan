/**
 * The board on a phone.
 *
 * Written after following a Matrix approval link on an iPhone and landing in
 * a desktop-shaped app with a 208px rail nailed to the side of a 390px screen.
 *
 * These run at a real phone viewport rather than asserting on classes: a
 * `md:hidden` that is present but overridden reads the same in the markup and
 * completely different to a person.
 */
import { test, expect } from '@playwright/test';

const BOARD_KEY = 'kaambaan.boardId';
const API = 'http://localhost:8787';
const TENANT = { 'X-Tenant-Id': 'tnt_dev', 'Content-Type': 'application/json' };
const STAGES = [
  { key: 'backlog', name: 'Backlog', order: 0 },
  { key: 'review', name: 'Review', order: 1, gate: 'approval' },
  { key: 'done', name: 'Done', order: 2 },
];

async function board(request: import('@playwright/test').APIRequestContext, name: string) {
  const res = await request.post(`${API}/v1/boards`, { headers: TENANT, data: { name, stages: STAGES } });
  return ((await res.json()) as { boardId: string }).boardId;
}

test.describe('on a phone', () => {
  // Viewport only, not `devices[...]`: `isMobile` and `hasTouch` can only be
  // set at the top level of a file, and the thing under test here is width.
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page, request }) => {
    const id = await board(request, 'Mobile E2E');
    await page.request.post(`${API}/v1/boards/${id}/cards`, {
      headers: TENANT,
      data: { title: 'Visible on a phone', ownerUserId: 'usr_dev' },
    });
    await page.addInitScript(
      ([key, boardId]) => window.localStorage.setItem(key as string, boardId as string),
      [BOARD_KEY, id],
    );
  });

  test('the rail is out of the way entirely', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Visible on a phone').first()).toBeVisible();

    // The rail is what ate the screen. Below 900px it is not rendered at all — the bottom bar is
    // the navigation, so there is exactly one <nav> rather than one hidden behind another.
    const navs = page.getByRole('navigation', { name: 'Main' });
    await expect(navs).toHaveCount(1);
    const box = await navs.boundingBox();
    expect(box!.width).toBeGreaterThan(300); // the bottom bar spans the screen; the rail was 84px
  });

  test('the board is not pushed off the side by a rail', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Visible on a phone').first()).toBeVisible();
    const scrolls = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(scrolls).toBe(false);
  });

  test('the three destinations are on screen, and each one goes somewhere', async ({ page }) => {
    // Replaces three tests of a hamburger drawer, removed in the 2026-09-03 restructure. The
    // drawer existed because a 208px rail could not fit beside a 390px board; the fix was not a
    // better drawer but a bottom bar, so the assertions move to it rather than being deleted.
    await page.goto('/');
    await expect(page.getByText('Backlog', { exact: true })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const name of ['Plan', 'Operate', 'Workspace']) {
      await expect(nav.getByRole('link', { name })).toBeVisible();
    }

    await nav.getByRole('link', { name: 'Operate' }).click();
    await expect(page).toHaveURL(/\/operate$/);
    await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();

    await nav.getByRole('link', { name: 'Workspace' }).click();
    await expect(page).toHaveURL(/\/workspace\/agents$/);

    await nav.getByRole('link', { name: 'Plan' }).click();
    await expect(page.getByText('Backlog', { exact: true })).toBeVisible();
  });

  test('every navigation target clears the touch floor', async ({ page }) => {
    // The audit measured eight controls under 24x24. A bottom bar whose targets are hard to hit
    // is the same failure wearing a different layout.
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const name of ['Plan', 'Operate', 'Workspace']) {
      const box = await nav.getByRole('link', { name }).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('the board fits the screen rather than being pushed off it', async ({ page }) => {
    // The actual complaint. A 208px rail on a 390px screen leaves 182px of
    // board, so this asserts the first column is genuinely reachable.
    await page.goto('/');
    const column = page.getByText('Backlog', { exact: true }).first();
    await expect(column).toBeInViewport();
  });
});

test.describe('on a desktop', () => {
  test('the rail is still simply there, and the bottom bar is not', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Backlog', { exact: true })).toBeVisible();
    // One navigation at a time: the rail above 900px, the bottom bar below it. Both at once was
    // the shape of the `max-[900px]:`/`min-[900px]:` bug the restructure was careful to avoid.
    const links = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Plan' });
    await expect(links).toHaveCount(1);
    await expect(links).toBeVisible();
  });
});
