import { test, expect } from '@playwright/test';

/**
 * Nothing in the card drawer may push a phone screen sideways.
 *
 * The drawer renders text nobody on this side wrote — a handoff, a tool's arguments, a reference,
 * an agent's own words — and any of it can be one long unbroken token. An agent reported
 * `{"artifact_commit_readback":"passed","github_commit_public":"verified"}` as a handoff value,
 * which has no space in it to break at, and the line ran 324px past the right edge of an iPhone.
 *
 * `break-word` does not fix that: it will not break INSIDE a word. `overflow-wrap: anywhere` will,
 * and it also lets the box shrink below its longest word, which is what stops the panel scrolling
 * sideways. The rule is set on the drawer body so a new section cannot forget it, and this holds
 * it there.
 */
const API = 'http://localhost:8787';
const TENANT = { 'X-Tenant-Id': 'tnt_dev', 'Content-Type': 'application/json' };
const PIPELINE = [{ key: 'intake', name: 'Intake', order: 0, ownerKind: 'human' }];

/** A phone, and the width the report came from. */
const PHONE = { width: 390, height: 844 };

/** No spaces, no hyphens, nothing to break at — the shape that actually overflowed. */
const UNBREAKABLE =
  '{"artifact_commit_readback":"passed","github_commit_public":"verified","public_citation_links":"18/18_returned_HTTP_200","remote_branch_matches_local":true}';

test('a handoff value with no spaces in it wraps instead of overflowing', async ({ page, request }) => {
  const board = await (
    await request.post(`${API}/v1/boards`, { headers: TENANT, data: { name: 'Overflow demo', stages: PIPELINE } })
  ).json();
  const card = await (
    await request.post(`${API}/v1/boards/${board.boardId}/cards`, {
      headers: TENANT,
      data: { title: 'Wide handoff', ownerUserId: 'usr_a', spec: { description: UNBREAKABLE } },
    })
  ).json();

  await page.setViewportSize(PHONE);
  await page.goto(`/b/${board.boardId}/c/${card.card.id}`);

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // Every element in the drawer, `pre` excepted — those scroll on purpose.
  const worst = await page.evaluate(() => {
    const body = document.querySelector('.dw-body');
    if (!body) return { found: false, over: 0, what: '' };
    let over = 0;
    let what = '';
    for (const el of body.querySelectorAll('*')) {
      if (el.tagName === 'PRE') continue;
      const d = el.scrollWidth - el.clientWidth;
      if (el.clientWidth > 0 && d > over) {
        over = d;
        what = `${el.tagName}.${String(el.className).slice(0, 30)}`;
      }
    }
    return { found: true, over, what };
  });

  expect(worst.found).toBe(true);
  expect(worst.over, `${worst.what} overflows its box by ${worst.over}px at ${PHONE.width}px`).toBeLessThanOrEqual(2);
});

test('the page itself never scrolls sideways on a phone', async ({ page, request }) => {
  const board = await (
    await request.post(`${API}/v1/boards`, { headers: TENANT, data: { name: 'Overflow demo 2', stages: PIPELINE } })
  ).json();
  await request.post(`${API}/v1/boards/${board.boardId}/cards`, {
    headers: TENANT,
    data: { title: UNBREAKABLE, ownerUserId: 'usr_a' },
  });

  await page.setViewportSize(PHONE);
  await page.goto(`/b/${board.boardId}`);
  await expect(page.getByRole('button', { name: /in Intake/ }).first()).toBeVisible();

  // A card TITLE with no spaces is the same hazard one level out: the board, not the drawer.
  const horizontal = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(horizontal.scrollWidth).toBeLessThanOrEqual(horizontal.clientWidth + 2);
});
