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

  test('the rail is out of the way until asked for', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Visible on a phone').first()).toBeVisible();

    // The rail is what ate the screen. It must not be on it by default.
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();
  });

  test('the menu button reveals it, and the scrim puts it away', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Visible on a phone').first()).toBeVisible();

    await page.getByRole('button', { name: 'Navigation' }).click();
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(rail).toBeVisible();

    // Tapped where the scrim is actually visible. The rail is 208px of a
    // 390px screen, so the scrim's own centre is underneath it — a
    // centre-click would land on the rail, which is not what a person does.
    await expect(page.getByRole('button', { name: 'Close navigation' })).toBeVisible();
    await page.mouse.click(330, 400);
    await expect(rail).toBeHidden();
  });

  test('choosing a screen closes the rail behind you', async ({ page }) => {
    // The most common version of this bug: a nav panel that stays open over
    // the thing you just navigated to.
    await page.goto('/');
    await page.getByRole('button', { name: 'Navigation' }).click();
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(rail).toBeVisible();

    await rail.getByRole('button', { name: /Triage/i }).click();
    await expect(rail).toBeHidden();
    await expect(page.getByText(/Needs You/i).first()).toBeVisible();
  });

  test('escape closes it too', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Navigation' }).click();
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(rail).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(rail).toBeHidden();
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
  test('the rail is still simply there', async ({ page, request }) => {
    // The whole change is a narrow-screen behaviour. If it alters the desktop
    // layout at all, it has overreached.
    const id = await board(request, 'Desktop unchanged E2E');
    await page.addInitScript(
      ([key, boardId]) => window.localStorage.setItem(key as string, boardId as string),
      [BOARD_KEY, id],
    );
    await page.goto('/');

    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    // And no button offering to reveal what is already revealed.
    await expect(page.getByRole('button', { name: 'Navigation' })).toBeHidden();
  });
});
