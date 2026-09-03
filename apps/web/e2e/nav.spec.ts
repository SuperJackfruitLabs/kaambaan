import { test, expect } from '@playwright/test';

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
    data: { name: 'Nav E2E board', stages: DEFAULT_STAGES },
  });
  const { boardId } = (await res.json()) as { boardId: string };
  await page.addInitScript(
    ([key, id]) => window.localStorage.setItem(key as string, id as string),
    [BOARD_KEY, boardId],
  );
});

/**
 * Triage and Telemetry were rail destinations. Operate absorbed both on 2026-09-03 — along with
 * the notification bell and the spend pill — which is the move that emptied the topbar. These
 * assertions follow them rather than being deleted.
 */
test('operate shows spend, and its detail view breaks it down', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Backlog', { exact: true })).toBeVisible();

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Operate' }).click();
  await expect(page.getByRole('heading', { name: 'Spend' })).toBeVisible();
  await expect(page.getByText('$0.00')).toBeVisible();

  // By-model and by-card moved to the sub-view; the summary answers "are we fine", and this
  // answers "where did it go".
  await page.getByRole('link', { name: 'detail' }).click();
  await expect(page).toHaveURL(/\/operate\/telemetry$/);
  await expect(page.getByText(/by agent/i).first()).toBeVisible();
});

test('operate shows what needs you, and says so plainly when nothing does', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Backlog', { exact: true })).toBeVisible();

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Operate' }).click();
  await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();
  // A fresh board has no gate, no question and no refusal.
  await expect(page.getByText('Nothing is waiting on you.')).toBeVisible();
});

test('the board log is reachable from the spend detail view', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Backlog', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Operate' }).click();
  await page.getByRole('link', { name: 'detail' }).click();
  await expect(page.getByText(/board log/i)).toBeVisible();
});
