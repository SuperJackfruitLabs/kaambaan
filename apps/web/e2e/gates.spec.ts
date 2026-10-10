import { test, expect } from '@playwright/test';

// The UI talks to the API as tenant 'tnt_dev' (see src/lib/api.ts), so the E2E drives the agent
// under the same tenant and points the board at the resulting gate.
const API = 'http://localhost:8787';
const TENANT = { 'X-Tenant-Id': 'tnt_dev', 'Content-Type': 'application/json' };

const REVIEW_PIPELINE = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
  { key: 'publish', name: 'Publish', order: 2, ownerKind: 'capability', owner: 'publish' },
];

test('a human approves an agent-opened gate from the board', async ({ page, request }) => {
  // 1. Open an approval gate by driving a research agent through the public contract.
  const board = await (
    await request.post(`${API}/v1/boards`, { headers: TENANT, data: { name: 'Gate demo', stages: REVIEW_PIPELINE } })
  ).json();
  const boardId = board.boardId as string;

  await request.post(`${API}/v1/boards/${boardId}/cards`, {
    headers: TENANT,
    data: { title: 'Launch post', ownerUserId: 'usr_a' },
  });
  const claim = await (
    await request.post(`${API}/v1/boards/${boardId}/claims`, {
      headers: { ...TENANT, 'X-Agent-Id': 'agt_r' },
      data: { capabilities: ['research'] },
    })
  ).json();
  await request.post(`${API}/v1/boards/${boardId}/runs/${claim.runId}/complete`, {
    headers: TENANT,
    data: { leaseEpoch: claim.leaseEpoch, handoff: { summary: 'drafted' } },
  });

  // 2. Load that board in the UI — the card sits at the review gate with resolve actions.
  await page.addInitScript((id) => window.localStorage.setItem('superpipeline.boardId', id), boardId);
  await page.goto('/');

  const review = page.locator('section').filter({ has: page.getByText('Review', { exact: true }) });
  await expect(review.locator('.tile', { hasText: 'Launch post' })).toBeVisible();
  // The tile no longer decides (a decision there had no way to carry a note): it opens the drawer.
  await page.getByRole('button', { name: '⚑ Review' }).click();
  const note = page.getByLabel('Add a note (optional)');
  await expect(note).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();

  // 3. Approve with a note — the card advances past the gate into Publish, and the API stores the note.
  await note.fill('checked the diff');
  const resolved = page.waitForRequest((r) => /\/gates\/[^/]+\/resolve$/.test(r.url()));
  await page.getByRole('button', { name: 'Approve' }).click();
  const sent = await resolved;
  expect(sent.postDataJSON().comment).toBe('checked the diff');
  const gateId = sent.url().match(/\/gates\/([^/]+)\/resolve$/)![1];

  const publish = page.locator('section').filter({ has: page.getByText('Publish', { exact: true }) });
  await expect(publish.locator('.tile', { hasText: 'Launch post' })).toBeVisible();

  const { gate } = await (await request.get(`${API}/v1/boards/${boardId}/gates/${gateId}`, { headers: TENANT })).json();
  expect(gate.status).toBe('resolved');
  expect(gate.comment).toBe('checked the diff');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the note and the decision buttons are usable at 390px', async ({ page, request }) => {
    const board = await (
      await request.post(`${API}/v1/boards`, { headers: TENANT, data: { name: 'Gate phone', stages: REVIEW_PIPELINE } })
    ).json();
    const boardId = board.boardId as string;
    await request.post(`${API}/v1/boards/${boardId}/cards`, { headers: TENANT, data: { title: 'Phone post', ownerUserId: 'usr_a' } });
    const claim = await (
      await request.post(`${API}/v1/boards/${boardId}/claims`, { headers: { ...TENANT, 'X-Agent-Id': 'agt_r' }, data: { capabilities: ['research'] } })
    ).json();
    await request.post(`${API}/v1/boards/${boardId}/runs/${claim.runId}/complete`, {
      headers: TENANT,
      data: { leaseEpoch: claim.leaseEpoch, handoff: { summary: 'drafted' } },
    });
    await page.addInitScript((id) => window.localStorage.setItem('superpipeline.boardId', id), boardId);
    await page.goto('/');
    await page.getByRole('button', { name: '⚑ Review' }).click();

    const note = page.getByLabel('Add a note (optional)');
    await expect(note).toBeVisible();
    expect(await note.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    for (const name of ['Approve', 'Request changes', 'Reject']) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox();
      expect(box!.height, name).toBeGreaterThanOrEqual(44);
    }
    const nbox = await note.boundingBox();
    expect(nbox!.x + nbox!.width).toBeLessThanOrEqual(390);
  });
});
