/**
 * The stage tabs follow the lane on screen.
 *
 * Reported from a phone: swiping between lanes left the selected tab where it was, so the strip
 * that exists to say "you are here" said "Backlog" over every lane. These swipe the real lane
 * scroller and read `aria-selected`, which is what both the highlight and a screen reader use.
 *
 * The cause was not the first board you open — that one worked — but the next. Switching boards
 * keeps the board screen mounted and replaces its lanes, and the stepper went on watching the old,
 * detached lanes, so nothing it observed could ever scroll again.
 */
import { test, expect, type Page } from '@playwright/test';

const BOARD_KEY = 'superpipeline.boardId';
const API = 'http://localhost:8787';
const TENANT = { 'X-Tenant-Id': 'tnt_dev', 'Content-Type': 'application/json' };
const STAGES = [
  { key: 'backlog', name: 'Backlog', order: 0 },
  { key: 'build', name: 'Build', order: 1 },
  { key: 'review', name: 'Review', order: 2 },
  { key: 'done', name: 'Done', order: 3 },
];

test.beforeEach(async ({ page, request }) => {
  const res = await request.post(`${API}/v1/boards`, { headers: TENANT, data: { name: 'Stage tabs E2E', stages: STAGES } });
  const id = ((await res.json()) as { boardId: string }).boardId;
  await page.request.post(`${API}/v1/boards/${id}/cards`, {
    headers: TENANT,
    data: { title: 'Swipe past me', ownerUserId: 'usr_dev' },
  });
  await page.addInitScript(
    ([key, boardId]) => window.localStorage.setItem(key as string, boardId as string),
    [BOARD_KEY, id],
  );
});

async function makeBoard(request: import('@playwright/test').APIRequestContext, name: string, keyPrefix: string) {
  const stages = STAGES.map((s) => ({ ...s, key: `${keyPrefix}-${s.key}`, name: `${s.name} ${keyPrefix}` }));
  const res = await request.post(`${API}/v1/boards`, { headers: TENANT, data: { name, stages } });
  return ((await res.json()) as { boardId: string }).boardId;
}

const tabs = (page: Page) => page.getByRole('tablist', { name: 'Stage' }).getByRole('tab');

/** The element that holds the lanes and scrolls sideways — found by geometry, not by class. */
async function scrollLanesTo(page: Page, lane: number): Promise<void> {
  await page.evaluate((i) => {
    const lanes = [...document.querySelectorAll<HTMLElement>('[data-lane]')];
    let el: HTMLElement | null = lanes[0].parentElement;
    while (el && el.scrollWidth <= el.clientWidth) el = el.parentElement;
    if (!el) throw new Error('no horizontal scroller around the lanes');
    // What a finger leaves behind: the scroller snapped to the lane.
    el.scrollLeft += lanes[i].getBoundingClientRect().left - el.getBoundingClientRect().left - 12;
  }, lane);
}

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('swiping to the second lane selects the second tab', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Swipe past me').first()).toBeVisible();
    await expect(tabs(page).nth(0)).toHaveAttribute('aria-selected', 'true');

    await scrollLanesTo(page, 1);

    await expect(tabs(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs(page).nth(0)).toHaveAttribute('aria-selected', 'false');
  });

  test('after switching boards, swiping to the second lane selects the second tab', async ({ page, request }) => {
    // Different stage keys, as two real pipelines have: the lanes are new elements, not reused.
    const tag = `${Date.now()}`;
    const first = await makeBoard(request, `First ${tag}`, 'one');
    await makeBoard(request, `Second ${tag}`, 'two');
    await page.goto(`/b/${first}`);
    await expect(page.getByRole('heading', { name: 'Backlog one', level: 2 })).toBeVisible();

    await page.getByRole('button', { name: `First ${tag}` }).click();
    await page.getByRole('menuitem', { name: `Second ${tag}` }).click();
    await expect(page.getByRole('heading', { name: 'Backlog two', level: 2 })).toBeVisible();
    await expect(tabs(page).nth(0)).toHaveAttribute('aria-selected', 'true');

    await scrollLanesTo(page, 1);
    await expect(tabs(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await scrollLanesTo(page, 2);
    await expect(tabs(page).nth(2)).toHaveAttribute('aria-selected', 'true');
  });

  test('swiping back selects the first tab again', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Swipe past me').first()).toBeVisible();
    await scrollLanesTo(page, 2);
    await expect(tabs(page).nth(2)).toHaveAttribute('aria-selected', 'true');
    await scrollLanesTo(page, 0);
    await expect(tabs(page).nth(0)).toHaveAttribute('aria-selected', 'true');
  });

  test('tapping a tab brings its lane on screen and selects it', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Swipe past me').first()).toBeVisible();
    await tabs(page).nth(3).click();
    await expect(page.getByRole('heading', { name: 'Done', level: 2 })).toBeInViewport({ ratio: 0.9 });
    await expect(tabs(page).nth(3)).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('on a tablet', () => {
  test.use({ viewport: { width: 744, height: 1133 } });

  test('the leftmost lane on screen is the selected tab', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Swipe past me').first()).toBeVisible();
    // Two lanes fit side by side; the first of them is "here".
    await expect(tabs(page).nth(0)).toHaveAttribute('aria-selected', 'true');

    await scrollLanesTo(page, 1);
    await expect(tabs(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  });
});
