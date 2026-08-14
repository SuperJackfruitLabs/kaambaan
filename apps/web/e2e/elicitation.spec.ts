import { test, expect } from '@playwright/test';

// The UI talks to the API as tenant 'tnt_dev' (see src/lib/api.ts), so the E2E drives the agent
// under the same tenant and answers its question from the board.
const API = 'http://localhost:8787';
const TENANT = { 'X-Tenant-Id': 'tnt_dev', 'Content-Type': 'application/json' };
const AGENT = { ...TENANT, 'X-Agent-Id': 'agt_r' };

const PIPELINE = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'publish', name: 'Publish', order: 1, ownerKind: 'capability', owner: 'publish' },
];

test('a human answers a blocked agent’s question from the board', async ({ page, request }) => {
  // 1. An agent claims a card and stops on a permission prompt it cannot answer itself.
  const board = await (
    await request.post(`${API}/v1/boards`, { headers: TENANT, data: { name: 'Question demo', stages: PIPELINE } })
  ).json();
  const boardId = board.boardId as string;

  await request.post(`${API}/v1/boards/${boardId}/cards`, {
    headers: TENANT,
    data: { title: 'Add the OAuth flow', ownerUserId: 'usr_a' },
  });
  const claim = await (
    await request.post(`${API}/v1/boards/${boardId}/claims`, { headers: AGENT, data: { capabilities: ['research'] } })
  ).json();
  await request.post(`${API}/v1/boards/${boardId}/runs/${claim.runId}/activities`, {
    headers: AGENT,
    data: {
      leaseEpoch: claim.leaseEpoch,
      type: 'elicitation',
      body: 'May I run the test suite?',
      signal: 'select',
      parameter: { options: [{ name: 'run_them', title: 'Run the tests' }, { name: 'skip', title: 'Skip them' }] },
    },
  });

  // 2. The board shows the card is waiting on a human, and the drawer carries the question.
  await page.addInitScript((id) => window.localStorage.setItem('kaambaan.boardId', id), boardId);
  await page.goto('/');

  const tile = page.locator('.tile', { hasText: 'Add the OAuth flow' });
  await expect(tile).toBeVisible();
  await tile.getByRole('button', { name: /Answer agt_r/ }).click();
  const panel = page.locator('.elicitation');
  await expect(panel).toContainText('awaiting your answer');
  await expect(panel).toContainText('May I run the test suite?');

  // 3. Answering unblocks the agent: the card returns to `working` and the run carries the decision.
  await panel.getByRole('button', { name: 'Run the tests' }).click();

  await expect
    .poll(async () => {
      const snap = await (await request.get(`${API}/v1/boards/${boardId}`, { headers: TENANT })).json();
      return snap.cards[0].state;
    })
    .toBe('working');

  const run = await (await request.get(`${API}/v1/boards/${boardId}/runs/${claim.runId}`, { headers: AGENT })).json();
  expect(run.elicitations[0].status).toBe('answered');
  expect(run.elicitations[0].answer.option).toBe('run_them');
});
