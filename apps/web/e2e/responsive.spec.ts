import { test, expect, type Page } from '@playwright/test';

/**
 * The 2026-10-07 responsive audit, as assertions, at the five widths it measured.
 *
 * The operator's standard is "responsive across phone, tablet, laptop and wide desktop" — not a
 * phone layout stretched, not a desktop layout squeezed. So each check runs at every width:
 *
 *   - Nothing pushes the page sideways (lanes scroll inside their own scroller; the page never does).
 *   - Sign-out is reachable. It lived only in the rail, which is not rendered below 900px, so on a
 *     phone or a tablet there was no way to sign out at all — the audit's one P1.
 *   - A tablet sees the pipeline: at 768px Plan showed one 744px lane and hid four stages.
 *   - A wide screen is used: at 1920px Operate was a 742px column, 40% of the screen.
 */

const BOARD_KEY = 'superpipeline.boardId';
const API = 'http://localhost:8787';
const TENANT = { 'X-Tenant-Id': 'tnt_dev', 'Content-Type': 'application/json' };
const STAGES = [
  { key: 'backlog', name: 'Backlog', order: 0 },
  { key: 'ready', name: 'Ready', order: 1 },
  { key: 'in-progress', name: 'In Progress', order: 2, wipLimit: 3 },
  { key: 'review', name: 'Review', order: 3, gate: 'approval' },
  { key: 'done', name: 'Done', order: 4 },
];
const WIDTHS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];

let boardId: string;
test.beforeEach(async ({ page, request }) => {
  const res = await request.post(`${API}/v1/boards`, { headers: TENANT, data: { name: 'Responsive E2E', stages: STAGES } });
  boardId = ((await res.json()) as { boardId: string }).boardId;
  for (const title of ['Draft the onboarding checklist', 'Fix the websocket reconnect', 'Write the release notes']) {
    await request.post(`${API}/v1/boards/${boardId}/cards`, { headers: TENANT, data: { title, ownerUserId: 'usr_dev' } });
  }
  await page.addInitScript(([key, id]) => window.localStorage.setItem(key, id), [BOARD_KEY, boardId]);
});

async function pageScrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
}

for (const vp of WIDTHS) {
  test.describe(`at ${vp.width}px`, () => {
    test.use({ viewport: vp });

    test('no page scrolls sideways', async ({ page }) => {
      for (const path of ['', '/operate', '/operate/telemetry', '/settings']) {
        await page.goto(`/b/${boardId}${path}`);
        await expect(page.getByText('Responsive E2E').first()).toBeVisible();
        expect(await pageScrollsSideways(page), `/b/:id${path}`).toBe(false);
      }
      await page.goto('/workspace/agents');
      await expect(page.getByRole('tab', { name: 'Agents' })).toBeVisible();
      expect(await pageScrollsSideways(page), '/workspace/agents').toBe(false);
      await page.goto('/workspace/needs-you');
      await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();
      expect(await pageScrollsSideways(page), '/workspace/needs-you').toBe(false);
    });

    test('sign-out and the theme are reachable', async ({ page }) => {
      await page.goto(`/b/${boardId}`);
      await expect(page.getByText('Draft the onboarding checklist').first()).toBeVisible();

      if (vp.width < 900) {
        // The bottom nav's fourth item is a menu holding both.
        await page.getByRole('button', { name: 'You' }).click();
        await expect(page.getByRole('menuitem', { name: /sign out/i })).toBeInViewport();
        await page.getByRole('menuitem', { name: /theme/i }).click();
      } else {
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeInViewport();
        await page.getByRole('button', { name: /toggle theme/i }).click();
      }
      await expect(page.locator('html')).toHaveAttribute('data-theme', /light|dark/);

      // And from the palette, at every width.
      await page.keyboard.press('Control+k');
      await page.getByPlaceholder(/jump to/i).fill('sign out');
      // Scoped to the palette: at 900px and up the rail's own Sign out button would satisfy a bare query.
      await expect(page.getByRole('dialog', { name: 'Command palette' }).getByRole('button', { name: /sign out/i })).toBeVisible();
    });

    if (vp.width === 768) {
      test('a tablet sees at least two lanes side by side', async ({ page }) => {
        await page.goto(`/b/${boardId}`);
        await expect(page.getByText('Draft the onboarding checklist').first()).toBeVisible();
        const whole = await page.locator('[data-lane]').evaluateAll((lanes) =>
          lanes.filter((l) => {
            const r = l.getBoundingClientRect();
            return r.left >= 0 && r.right <= window.innerWidth && r.width > 0;
          }).length,
        );
        expect(whole).toBeGreaterThanOrEqual(2);
      });
    }

    if (vp.width === 1920) {
      test('Operate uses most of a wide screen', async ({ page }) => {
        await page.goto(`/b/${boardId}/operate`);
        await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();
        const span = await page.locator('main section').evaluateAll((els) => {
          const rs = els.map((e) => e.getBoundingClientRect());
          return Math.max(...rs.map((r) => r.right)) - Math.min(...rs.map((r) => r.left));
        });
        expect(span).toBeGreaterThanOrEqual(0.6 * 1920);
      });
    }
  });
}
