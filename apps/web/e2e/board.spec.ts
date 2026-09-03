import { test, expect } from '@playwright/test';

// Composing is a sheet now, opened by the header's one primary action. The old inline field plus
// a 15x16px `+` popover put priority, due date and description behind a control below the WCAG
// target-size floor; they are first-class fields in the sheet.

const BOARD_KEY = 'kaambaan.boardId';
const API = 'http://localhost:8787';
// The app talks to the API as the dev workspace (tnt_dev) when the server runs with DEV_AUTH on.
const TENANT = { 'X-Tenant-Id': 'tnt_dev', 'Content-Type': 'application/json' };
const DEFAULT_STAGES = [
  { key: 'backlog', name: 'Backlog', order: 0 },
  { key: 'ready', name: 'Ready', order: 1 },
  { key: 'in-progress', name: 'In Progress', order: 2, wipLimit: 3 },
  { key: 'review', name: 'Review', order: 3, gate: 'approval' },
  { key: 'done', name: 'Done', order: 4 },
];

// Each test gets its own fresh board (created via the API) and points the app at it, so tests are
// isolated and don't depend on the onboarding/auto-pick path.
let boardId: string;
test.beforeEach(async ({ page, request }) => {
  const res = await request.post(`${API}/v1/boards`, { headers: TENANT, data: { name: 'E2E board', stages: DEFAULT_STAGES } });
  boardId = (await res.json()).boardId as string;
  await page.addInitScript(([key, id]) => window.localStorage.setItem(key, id), [BOARD_KEY, boardId]);
});

test('renders the pipeline columns and connects live', async ({ page }) => {
  await page.goto('/');
  for (const col of ['Backlog', 'Ready', 'In Progress', 'Review', 'Done']) {
    await expect(page.getByText(col, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('live', { exact: true })).toBeVisible();
});

test('creates a card via the composer', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New card' }).click();
  await page.getByLabel('Card title').fill('Write the launch post');
  await page.getByRole('button', { name: 'Dispatch' }).click();
  await expect(page.getByText('Write the launch post')).toBeVisible();
});

test('moves a card to another column via drag', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New card' }).click();
  await page.getByLabel('Card title').fill('Draggable task');
  await page.getByRole('button', { name: 'Dispatch' }).click();

  const card = page.locator('.tile', { hasText: 'Draggable task' });
  await expect(card).toBeVisible();

  const ready = page.locator('section').filter({ has: page.getByText('Ready', { exact: true }) });
  await card.dragTo(ready);

  await expect(ready.locator('.tile', { hasText: 'Draggable task' })).toBeVisible();
});

test('streams a new card to a second client in real time', async ({ browser }) => {
  const a = await browser.newPage();
  await a.addInitScript(([key, id]) => window.localStorage.setItem(key, id), [BOARD_KEY, boardId]);
  await a.goto('/');
  await expect(a.getByText('Backlog', { exact: true })).toBeVisible();

  // Second client opens the SAME board, then subscribes to its live feed.
  const b = await browser.newPage();
  await b.addInitScript(([key, id]) => window.localStorage.setItem(key, id), [BOARD_KEY, boardId]);
  await b.goto('/');
  await expect(b.getByText('Backlog', { exact: true })).toBeVisible();

  await a.getByRole('button', { name: 'New card' }).click();
  await a.getByLabel('Card title').fill('Realtime card');
  await a.getByRole('button', { name: 'Dispatch' }).click();

  await expect(b.getByText('Realtime card')).toBeVisible({ timeout: 10_000 });
});
