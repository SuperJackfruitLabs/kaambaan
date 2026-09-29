import { test, expect } from '@playwright/test';

/**
 * The card drawer as a modal dialog.
 *
 * It had no role, no `aria-modal`, nothing labelling it and no focus management: opening a card
 * left focus on `<body>`, and the first Tab landed on "superpipeline home" — the navigation
 * BEHIND the drawer. Its controls, a gate's Approve among them, were reachable only after tabbing
 * through the whole board.
 */
const API = 'http://localhost:8787';
const TENANT = { 'X-Tenant-Id': 'tnt_dev', 'Content-Type': 'application/json' };
const PIPELINE = [{ key: 'intake', name: 'Intake', order: 0, ownerKind: 'human' }];

async function boardWithACard(request: import('@playwright/test').APIRequestContext) {
  const board = await (
    await request.post(`${API}/v1/boards`, { headers: TENANT, data: { name: 'Drawer demo', stages: PIPELINE } })
  ).json();
  await request.post(`${API}/v1/boards/${board.boardId}/cards`, {
    headers: TENANT,
    data: { title: 'A card to open', ownerUserId: 'usr_a' },
  });
  return board.boardId as string;
}

test('opening a card announces a dialog and takes focus into it', async ({ page, request }) => {
  const boardId = await boardWithACard(request);
  await page.goto(`/b/${boardId}`);

  await page.getByRole('button', { name: /^A card to open, in/ }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Labelled by the card's own title, so a screen reader says which card opened rather than
  // "dialog".
  await expect(dialog).toHaveAccessibleName(/A card to open/);

  const focusInside = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return !!d && (d === document.activeElement || d.contains(document.activeElement));
  });
  expect(focusInside, 'focus must move into the dialog, not stay on <body>').toBe(true);
});

test('Tab stays inside the dialog rather than walking the board behind it', async ({ page, request }) => {
  const boardId = await boardWithACard(request);
  await page.goto(`/b/${boardId}`);
  await page.getByRole('button', { name: /^A card to open, in/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  // Far more presses than the dialog has controls: a trap that only holds for one cycle is not
  // a trap, and the failure it hides is focus escaping after the last control.
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      return !!d && (d === document.activeElement || d.contains(document.activeElement));
    });
    expect(inside, `focus escaped the dialog on Tab ${i + 1}`).toBe(true);
  }
});

test('closing returns focus to the card that opened it', async ({ page, request }) => {
  const boardId = await boardWithACard(request);
  await page.goto(`/b/${boardId}`);

  const tile = page.getByRole('button', { name: /^A card to open, in/ });
  await tile.click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  // Returning focus to the top of the document would lose a keyboard user their place on a board
  // that may be many columns wide.
  const backOnTile = await page.evaluate(
    () => document.activeElement?.getAttribute('aria-label')?.includes('A card to open') ?? false,
  );
  expect(backOnTile).toBe(true);
});

test('a card tile exposes one button for itself, not a button inside a button', async ({ page, request }) => {
  const boardId = await boardWithACard(request);
  await page.goto(`/b/${boardId}`);
  await expect(page.getByText('Intake', { exact: true })).toBeVisible();

  // The tile used to be `role="button"` wrapping a real button and, with a reference, an anchor.
  // An element with a button role may not contain interactive descendants.
  const nested = await page.evaluate(() =>
    [...document.querySelectorAll('[role="button"], button')].filter((el) =>
      el.querySelector('button, a[href], [role="button"]'),
    ).length,
  );
  expect(nested, 'no interactive element may contain another').toBe(0);
});
