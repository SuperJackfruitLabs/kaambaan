import { test, expect } from '@playwright/test';

// A card its agent blocked shows in Needs you with the agent's own reason, and a person resumes it
// from the row with a comment — which the next claim carries as feedback.
const API = 'http://localhost:8787';
const TENANT = { 'X-Tenant-Id': 'tnt_dev', 'Content-Type': 'application/json' };
const AGENT = { ...TENANT, 'X-Agent-Id': 'agt_b' };

const PIPELINE = [
  { key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
];

test('a person resumes a blocked card from Needs you, and the agent reads the comment', async ({ page, request }) => {
  const board = await (await request.post(`${API}/v1/boards`, { headers: TENANT, data: { name: 'Resume demo', stages: PIPELINE } })).json();
  const boardId = board.boardId as string;
  await request.post(`${API}/v1/boards/${boardId}/cards`, { headers: TENANT, data: { title: 'Rotate the keys', ownerUserId: 'usr_a' } });
  const claim = await (await request.post(`${API}/v1/boards/${boardId}/claims`, { headers: AGENT, data: { capabilities: ['build'] } })).json();
  await request.post(`${API}/v1/boards/${boardId}/runs/${claim.runId}/block`, {
    headers: AGENT,
    data: { leaseEpoch: claim.leaseEpoch, reason: 'the vault is sealed' },
  });

  await page.goto(`/b/${boardId}/operate`);
  const row = page.locator('[data-attention-row="blocked"]', { hasText: 'Rotate the keys' });
  await expect(row).toContainText('the vault is sealed');
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Resume' }).click();
  await page.getByLabel(/what changed/i).fill('Unsealed it — go ahead.');
  await page.getByRole('button', { name: 'Send back to work' }).click();

  await expect
    .poll(async () => (await (await request.get(`${API}/v1/boards/${boardId}`, { headers: TENANT })).json()).cards[0].state)
    .toBe('submitted');
  const next = await (await request.post(`${API}/v1/boards/${boardId}/claims`, { headers: AGENT, data: { capabilities: ['build'] } })).json();
  expect(next.handoff.feedback).toBe('Unsealed it — go ahead.');
  await expect(page.getByText('the vault is sealed')).toHaveCount(0);
});
