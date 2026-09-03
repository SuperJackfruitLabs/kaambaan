import { test, expect, type Page } from '@playwright/test';

/**
 * The 2026-09-03 UI audit's findings, as assertions.
 *
 * The audit measured rather than described, so its acceptance criteria can be a test rather than a
 * paragraph somebody checks by eye. Three of them:
 *
 *   - Nothing sits past the right edge. At 390px the topbar row was 813px wide with
 *     `flex-wrap: nowrap` and no scroll, so seven controls — including Agents, the only door to
 *     capabilities, members, tokens and the fleet link — were clipped off the page entirely.
 *   - Every interactive target meets WCAG 2.2's 24x24 floor. Eight were under it, including the
 *     two added FOR accessibility: the move control at 15x11 and the compose expander at 15x16.
 *   - Focus is visible. Computed `outline-style` was `none` on every button and every card tile,
 *     which made the Alt+arrow card movement unusable by the people it was built for.
 *
 * This file is committed while it still fails. It is the definition of done for the shell slice,
 * not a regression guard bolted on afterwards.
 */

const BOARD_KEY = 'kaambaan.boardId';
const API = 'http://localhost:8787';
const TENANT = { 'X-Tenant-Id': 'tnt_dev', 'Content-Type': 'application/json' };

const PIPELINE = [
  { key: 'intake', name: 'Intake', order: 0, ownerKind: 'human' },
  { key: 'plan', name: 'Plan', order: 1, ownerKind: 'capability', owner: 'planning' },
  { key: 'build', name: 'Build', order: 2, ownerKind: 'capability', owner: 'code', wipLimit: 3 },
  { key: 'review', name: 'Security review', order: 3, ownerKind: 'capability', owner: 'security' },
  { key: 'sign-off', name: 'Sign-off', order: 4, ownerKind: 'human', gate: 'approval' },
  { key: 'shipped', name: 'Shipped', order: 5, ownerKind: 'human' },
];

/** Six stages and a few cards — the shape that made the density findings visible. */
let boardId: string;
test.beforeEach(async ({ page, request }) => {
  const res = await request.post(`${API}/v1/boards`, { headers: TENANT, data: { name: 'Reachable E2E', stages: PIPELINE } });
  boardId = (await res.json()).boardId as string;
  for (const title of ['Rotate the appservice token', 'Cost bar measures nothing', 'Draft the platform note']) {
    await request.post(`${API}/v1/boards/${boardId}/cards`, { headers: TENANT, data: { title } });
  }
  await page.addInitScript(([key, id]) => window.localStorage.setItem(key, id), [BOARD_KEY, boardId]);
});

/**
 * Elements that are past the right edge AND cannot be reached by scrolling to them.
 *
 * The distinction is the whole finding. The board's lanes extend past the viewport by design —
 * they live in a horizontal scroller, and paging through them is how a pipeline is read on a
 * phone. The topbar's controls extended past it inside an ancestor with `overflow: visible`, on a
 * page that does not scroll sideways, so they were not off-screen-but-reachable; they were gone.
 *
 * So: walk up from each offending element and ask whether anything above it scrolls horizontally.
 */
async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const scrollableAncestor = (el: Element): boolean => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth + 1) return true;
      }
      return false;
    };
    return [...document.querySelectorAll('*')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.right > window.innerWidth + 1 && !scrollableAncestor(el);
      })
      .slice(0, 10)
      .map((el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`);
  });
}

/** Interactive targets under the WCAG 2.2 floor. Hidden elements cannot be tapped and are skipped. */
async function tooSmall(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24))
      .map(({ el, r }) => `${(el.getAttribute('aria-label') || el.textContent || '?').trim().slice(0, 24)} ${Math.round(r.width)}x${Math.round(r.height)}`),
  );
}

/** Rendered focusables with no focus indicator. `display:none` cannot be focused, so it is excluded. */
async function withoutFocusRing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      el.focus();
      if (getComputedStyle(el).outlineStyle === 'none') {
        out.push((el.getAttribute('aria-label') || el.textContent || '?').trim().slice(0, 28));
      }
    }
    (document.activeElement as HTMLElement | null)?.blur();
    return out;
  });
}

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

for (const [name, size] of [['a phone', PHONE], ['a desktop', DESKTOP]] as const) {
  test.describe(`on ${name}`, () => {
    test.use({ viewport: size });

    test('nothing is clipped off the right edge', async ({ page }) => {
      await page.goto(`/b/${boardId}`);
      await expect(page.getByText('Intake', { exact: true })).toBeVisible();

      expect(await overflowing(page)).toEqual([]);
      // The body must not scroll sideways either — clipped and scrollable are different failures,
      // and the audit found the first, which is the one with no recovery.
      const scrolls = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(scrolls).toBe(false);
    });

    test('every interactive target meets the 24px floor', async ({ page }) => {
      await page.goto(`/b/${boardId}`);
      await expect(page.getByText('Intake', { exact: true })).toBeVisible();
      expect(await tooSmall(page)).toEqual([]);
    });

    test('every rendered control shows focus', async ({ page }) => {
      await page.goto(`/b/${boardId}`);
      await expect(page.getByText('Intake', { exact: true })).toBeVisible();
      expect(await withoutFocusRing(page)).toEqual([]);
    });

    test('the management surface is reachable', async ({ page }) => {
      // The audit's severe finding in one assertion: on a phone, Agents was off-screen, and with
      // it capabilities, members, tokens and the fleet link.
      await page.goto(`/b/${boardId}`);
      const workspace = page.getByRole('link', { name: /workspace/i }).or(page.getByRole('button', { name: /workspace|agents/i })).first();
      await expect(workspace).toBeVisible();
      await workspace.click();
      await expect(page.getByRole('heading', { name: /agents/i }).or(page.getByText(/capabilit/i)).first()).toBeVisible();
    });

    test('every stage is reachable', async ({ page }) => {
      // At 1440px only four of six stages fitted and the fourth was cut through its title. On a
      // phone the lanes were a squeezed desktop layout.
      await page.goto(`/b/${boardId}`);
      for (const stage of ['Intake', 'Plan', 'Build', 'Security review', 'Sign-off', 'Shipped']) {
        await expect(page.getByText(stage, { exact: true }).first()).toBeAttached();
      }
    });
  });
}
