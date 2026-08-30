/**
 * A card has an address, and the address survives being followed.
 *
 * Written after a Matrix approval card's "open on the board" link returned 404
 * on a phone: the schema had carried a `deep_link` for a page that never
 * existed, and every test until now asserted the field was *present* rather
 * than that it *resolved*. These go the other way — they follow the link.
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

async function makeBoard(request: import('@playwright/test').APIRequestContext, name: string) {
  const res = await request.post(`${API}/v1/boards`, {
    headers: TENANT,
    data: { name, stages: STAGES },
  });
  return ((await res.json()) as { boardId: string }).boardId;
}

async function makeCard(
  request: import('@playwright/test').APIRequestContext,
  boardId: string,
  title: string,
) {
  const res = await request.post(`${API}/v1/boards/${boardId}/cards`, {
    headers: TENANT,
    data: { title, ownerUserId: 'usr_dev' },
  });
  return ((await res.json()) as { card: { id: string } }).card.id;
}

test('a card url opens the board with that card', async ({ page, request }) => {
  const boardId = await makeBoard(request, 'Addressable E2E');
  const cardId = await makeCard(request, boardId, 'Findable by address');

  await page.goto(`/b/${boardId}/c/${cardId}`);

  // `.first()` deliberately: when the drawer is open, "Backlog" is both the
  // column header and the drawer's stage label. That ambiguity is what a
  // successful open looks like.
  await expect(page.getByText('Backlog', { exact: true }).first()).toBeVisible();
  // The drawer, showing the card the URL named.
  await expect(page.getByText('Findable by address').first()).toBeVisible();
});

test('the url a link was sent for wins over the board last used', async ({ page, request }) => {
  // The ordering that makes addressable cards worth having. Getting it the
  // other way round produces a link that appears to work — it loads a board —
  // while showing the wrong one.
  const remembered = await makeBoard(request, 'Remembered board');
  const linked = await makeBoard(request, 'Linked board');
  const cardId = await makeCard(request, linked, 'On the linked board');

  await page.addInitScript(
    ([key, id]) => window.localStorage.setItem(key as string, id as string),
    [BOARD_KEY, remembered],
  );

  await page.goto(`/b/${linked}/c/${cardId}`);
  await expect(page.getByText('On the linked board').first()).toBeVisible();
});

test('a stale card id opens the board rather than erroring', async ({ page, request }) => {
  // The normal case, not an edge case: a gate lives in a Matrix room forever
  // and the card it names can be finished, archived or deleted long after.
  const boardId = await makeBoard(request, 'Stale link E2E');
  await makeCard(request, boardId, 'Still here');

  await page.goto(`/b/${boardId}/c/card_deadbeefdeadbeef`);

  await expect(page.getByText('Backlog', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Still here').first()).toBeVisible();
});

test('a board id from nowhere falls back instead of breaking', async ({ page, request }) => {
  // A board id belonging to another tenant resolves to a different Durable
  // Object and answers 404 exactly as a nonexistent one does — the isolation
  // is inherited from `${tenantId}:${boardId}` naming, not added here. Either
  // way the app must land somewhere usable.
  const remembered = await makeBoard(request, 'Fallback E2E');
  await makeCard(request, remembered, 'Fallback card');
  await page.addInitScript(
    ([key, id]) => window.localStorage.setItem(key as string, id as string),
    [BOARD_KEY, remembered],
  );

  await page.goto('/b/brd_0000000000000000/c/card_0000000000000000');

  await expect(page.getByText('Backlog', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Fallback card').first()).toBeVisible();
});

test('opening a card puts its address in the bar, so the link is copyable', async ({
  page,
  request,
}) => {
  // The half without which a link works when followed and lies the moment the
  // reader clicks anything.
  const boardId = await makeBoard(request, 'Address bar E2E');
  const cardId = await makeCard(request, boardId, 'Click me open');
  await page.addInitScript(
    ([key, id]) => window.localStorage.setItem(key as string, id as string),
    [BOARD_KEY, boardId],
  );

  await page.goto('/');
  await expect(page.getByText('Backlog', { exact: true }).first()).toBeVisible();
  await page.getByText('Click me open').first().click();

  await expect(page).toHaveURL(new RegExp(`/b/${boardId}/c/${cardId}$`));
});
