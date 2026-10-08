import { test, expect, type Page } from '@playwright/test';

/**
 * A handoff reads as a document, on a phone and on a desktop.
 *
 * The drawer used to print each handoff key and `JSON.stringify` its value, so a planning stage's
 * `approach.codeGrounding.existingCapabilities: […]` reached an iPhone as one wall of braces. This
 * drives a real agent run through the public contract with that shape — nested groups, lists, a
 * JSON document stored as a string, an unbroken path — and holds the drawer to labelled groups
 * and no sideways scroll at 390px and 1280px.
 */
const API = 'http://localhost:8787';
const TENANT = { 'X-Tenant-Id': 'tnt_dev', 'Content-Type': 'application/json' };
const PIPELINE = [
  { key: 'plan', name: 'Plan', order: 0, ownerKind: 'capability', owner: 'planning' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human' },
];

const LONG_PATH = '/home/agent/workspaces/' + 'card-d4fcd4ab9cb44de1-forge-first-checkpoint-recovery/'.repeat(4) + 'manifest.json';

const HANDOFF = {
  problem: 'Guild work is split between Forge, GitHub, local profile trees and card worktrees, so nobody can say where unfinished work lives.',
  approach: {
    decision: 'Forge is canonical; checkpoints go to card branches on the product repository.',
    codeGrounding: {
      inspectedRepository: 'SuperJackfruitLabs/agentpod at `apps/node/src/station.ts`',
      existingCapabilities: ['Station discovery, workspace paths and health', 'fs/terminal capabilities', 'Credential-exposure scanning'],
      demonstratedGaps: [
        { gap: 'No managed Git worktrees', evidence: `https://forge.superjackfruit.com/SuperJackfruitLabs/agentpod/src/${'branch/'.repeat(12)}station.ts` },
        { gap: 'No verified pushes', evidence: LONG_PATH },
      ],
    },
  },
  scope: {
    in: Array.from({ length: 12 }, (_, i) => `In-scope item ${i + 1}`),
    out: ['Minting keys or granting membership'],
  },
  alternatives: JSON.stringify([{ option: 'GitHub as fallback', rejected: 'no implicit public mirror' }]),
};

async function seed(request: import('@playwright/test').APIRequestContext, name: string) {
  const board = await (await request.post(`${API}/v1/boards`, { headers: TENANT, data: { name, stages: PIPELINE } })).json();
  const boardId = board.boardId as string;
  const created = await (
    await request.post(`${API}/v1/boards/${boardId}/cards`, {
      headers: TENANT,
      data: {
        title: 'Design Forge-first workspaces',
        ownerUserId: 'usr_a',
        spec: { description: 'Plan it.', scope: { in: ['Audit stations', LONG_PATH], out: ['Cutover'] } },
      },
    })
  ).json();
  const claim = await (
    await request.post(`${API}/v1/boards/${boardId}/claims`, { headers: { ...TENANT, 'X-Agent-Id': 'agt_plan' }, data: { capabilities: ['planning'] } })
  ).json();
  await request.post(`${API}/v1/boards/${boardId}/runs/${claim.runId}/activities`, {
    headers: TENANT,
    data: { leaseEpoch: claim.leaseEpoch, type: 'thought', body: 'Inspected the station code.' },
  });
  const done = await request.post(`${API}/v1/boards/${boardId}/runs/${claim.runId}/complete`, {
    headers: TENANT,
    data: { leaseEpoch: claim.leaseEpoch, handoff: HANDOFF },
  });
  expect(done.ok()).toBe(true);
  return { boardId, cardId: created.card.id as string };
}

async function worstOverflow(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector('.dw-body');
    let over = 0;
    let what = '';
    for (const el of body?.querySelectorAll('*') ?? []) {
      // The activity rows' tool payloads stay raw `pre` on purpose (and scroll in their own box).
      if (el.tagName === 'PRE' && el.closest('.act')) continue;
      const d = el.scrollWidth - el.clientWidth;
      if (el.clientWidth > 0 && d > over) {
        over = d;
        what = `${el.tagName}.${String(el.className).slice(0, 40)}`;
      }
    }
    return { found: !!body, over, what };
  });
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
]) {
  test(`a nested handoff reads as labelled groups with no sideways scroll at ${viewport.width}px`, async ({ page, request }) => {
    const { boardId, cardId } = await seed(request, `Readable handoff ${viewport.width}`);
    await page.setViewportSize(viewport);
    await page.goto(`/b/${boardId}/c/${cardId}`);
    await expect(page.getByRole('dialog')).toBeVisible();

    const carried = page.getByTestId('carried-handoff');
    await expect(carried).toBeVisible();
    await expect(carried.getByText('Code grounding')).toBeVisible();
    await expect(carried.getByText('Existing capabilities')).toBeVisible();
    await expect(carried.getByText('Credential-exposure scanning')).toBeVisible();
    // The JSON string stored by the agent is read, not printed.
    await expect(carried.getByText('GitHub as fallback')).toBeVisible();
    await expect(carried).not.toContainText('{"');
    // A long list folds.
    await expect(carried.getByRole('button', { name: 'Show all 12' })).toBeVisible();

    // Each stage's "handed on" uses the same renderer.
    const handedOn = page.locator('[data-testid^="handed-on-"]');
    await expect(handedOn.getByText('Code grounding')).toBeVisible();

    // Details reads the spec the same way.
    await expect(page.getByTestId('spec-value-scope').getByText('Audit stations')).toBeVisible();

    // And the raw JSON is one tap away, wrapped too.
    await carried.getByRole('button', { name: 'View raw JSON' }).click();
    await expect(carried.locator('pre')).toContainText('"codeGrounding"');

    const worst = await worstOverflow(page);
    expect(worst.found).toBe(true);
    expect(worst.over, `${worst.what} overflows its box by ${worst.over}px at ${viewport.width}px`).toBeLessThanOrEqual(2);
    const page_ = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(page_.sw).toBeLessThanOrEqual(page_.cw + 2);
  });
}
