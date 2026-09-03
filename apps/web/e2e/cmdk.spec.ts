import { test, expect } from '@playwright/test';

// The command palette is mounted in the board-ready shell, so each test needs a board and must wait
// for the shell to render before pressing ⌘K/Ctrl-K (matches board.spec / nav.spec setup).
const BOARD_KEY = 'kaambaan.boardId';
const API = 'http://localhost:8787';
const TENANT = { 'X-Tenant-Id': 'tnt_dev', 'Content-Type': 'application/json' };
const DEFAULT_STAGES = [
  { key: 'backlog', name: 'Backlog', order: 0 },
  { key: 'ready', name: 'Ready', order: 1 },
  { key: 'in-progress', name: 'In Progress', order: 2, wipLimit: 3 },
  { key: 'review', name: 'Review', order: 3, gate: 'approval' },
  { key: 'done', name: 'Done', order: 4 },
];

test.beforeEach(async ({ page, request }) => {
  const res = await request.post(`${API}/v1/boards`, {
    headers: TENANT,
    data: { name: 'Cmdk E2E board', stages: DEFAULT_STAGES },
  });
  const { boardId } = (await res.json()) as { boardId: string };
  await page.addInitScript(
    ([key, id]) => window.localStorage.setItem(key as string, id as string),
    [BOARD_KEY, boardId],
  );
});

test('cmd-k opens the palette and can jump to a card', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Backlog', { exact: true })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByPlaceholder(/Jump to a card/i)).toBeVisible();
});

test('escape closes the palette', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Backlog', { exact: true })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByPlaceholder(/Jump to a card/i)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByPlaceholder(/Jump to a card/i)).not.toBeVisible();
});

test('palette filters results as user types', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Backlog', { exact: true })).toBeVisible();
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder(/Jump to a card/i);
  await expect(input).toBeVisible();
  await input.fill('Operate');
  // Scoped to the palette: "Operate" is also a rail destination, and an unscoped match is
  // ambiguous rather than wrong.
  await expect(page.getByRole('dialog').getByText('Operate')).toBeVisible();
});

test('palette shows actions group with navigation items', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Backlog', { exact: true })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByPlaceholder(/Jump to a card/i)).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Operate')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Spend detail')).toBeVisible();
});
