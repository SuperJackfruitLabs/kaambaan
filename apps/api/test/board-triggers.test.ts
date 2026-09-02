import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';
import { githubSignatureHeader } from '../src/references/github-signature';

const PIPE: BoardInit['stages'] = [{ key: 'triage', name: 'Triage', order: 0 }];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

describe('BoardDO — inbound triggers (docs/05 §6)', () => {
  it('funnels a trigger into one card + a provenance reference', async () => {
    await runInDurableObject(stubFor('tr-funnel'), async (board: BoardDO) => {
      await board.init({ id: 'brd_tr', tenantId: 'tnt_a', name: 'TR', stages: PIPE });
      const r = await board.createCardFromTrigger({
        title: 'Investigate flaky CI',
        ownerUserId: 'usr_a',
        source: { url: 'https://github.com/org/repo/issues/7', provider: 'github', sourceType: 'issue', externalId: 'org/repo#7' },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.card.title).toBe('Investigate flaky CI');
      expect(r.value.reference?.externalId).toBe('org/repo#7');

      const snap = await board.getState();
      expect(snap.cards).toHaveLength(1);
      expect(snap.references).toHaveLength(1);
      expect(snap.references[0]!.cardId).toBe(r.value.card.id);
    });
  });

  it('creates a card from a GitHub issue when the issue trigger is enabled', async () => {
    await runInDurableObject(stubFor('tr-gh'), async (board: BoardDO) => {
      await board.init({ id: 'brd_gh', tenantId: 'tnt_a', name: 'GH', stages: PIPE });
      await board.setGithubConfig({ secret: 'hook', issueTrigger: true });
      const body = JSON.stringify({
        action: 'opened',
        issue: { number: 12, title: 'Login is broken', state: 'open', html_url: 'https://github.com/org/repo/issues/12' },
        repository: { full_name: 'org/repo' },
      });
      const r = await board.handleGithubWebhook({ rawBody: body, signature: await githubSignatureHeader('hook', body), deliveryId: 'd1', event: 'issues' });
      expect(r.ok).toBe(true);

      const snap = await board.getState();
      expect(snap.cards).toHaveLength(1);
      expect(snap.cards[0]!.title).toBe('Login is broken');
      expect(snap.references.find((ref) => ref.externalId === 'org/repo#12')).toBeDefined();
    });
  });

  it('does not create a duplicate card when the same issue is delivered again', async () => {
    await runInDurableObject(stubFor('tr-dup'), async (board: BoardDO) => {
      await board.init({ id: 'brd_dup', tenantId: 'tnt_a', name: 'DUP', stages: PIPE });
      await board.setGithubConfig({ secret: 'hook', issueTrigger: true });
      const body = JSON.stringify({
        action: 'opened',
        issue: { number: 12, title: 'Login is broken', state: 'open', html_url: 'https://github.com/org/repo/issues/12' },
        repository: { full_name: 'org/repo' },
      });
      const sig = await githubSignatureHeader('hook', body);
      await board.handleGithubWebhook({ rawBody: body, signature: sig, deliveryId: 'd1', event: 'issues' });
      await board.handleGithubWebhook({ rawBody: body, signature: sig, deliveryId: 'd2', event: 'issues' }); // fresh delivery, same issue
      expect((await board.getState()).cards).toHaveLength(1);
    });
  });

  it('creates the card but reports a dropped reference on a bad source url', async () => {
    await runInDurableObject(stubFor('tr-badsrc'), async (board: BoardDO) => {
      await board.init({ id: 'brd_bs', tenantId: 'tnt_a', name: 'BS', stages: PIPE });
      const r = await board.createCardFromTrigger({ title: 'x', ownerUserId: 'usr_a', source: { url: 'javascript:alert(1)' } });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.reference).toBeNull();
        expect(r.value.referenceError).toBe('INVALID_URL');
      }
      expect((await board.getState()).cards).toHaveLength(1); // the card is still created
    });
  });

  it('does not create a card from an issue when the trigger is off', async () => {
    await runInDurableObject(stubFor('tr-off'), async (board: BoardDO) => {
      await board.init({ id: 'brd_off', tenantId: 'tnt_a', name: 'OFF', stages: PIPE });
      await board.setGithubConfig({ secret: 'hook' }); // issueTrigger defaults off
      const body = JSON.stringify({
        action: 'opened',
        issue: { number: 1, title: 'x', state: 'open', html_url: 'u' },
        repository: { full_name: 'org/repo' },
      });
      await board.handleGithubWebhook({ rawBody: body, signature: await githubSignatureHeader('hook', body), deliveryId: 'd1', event: 'issues' });
      expect((await board.getState()).cards).toHaveLength(0);
    });
  });
});

/**
 * The audit's first still-broken finding: a card born from a GitHub issue carried
 * no grant, so under `ENFORCE_CONTROL_PAIR` it parked in `input-required` on its
 * first claim and stayed there. The automation path — the reason to wire a board
 * to a repository at all — was the one path with no human present to notice.
 *
 * The fix records the grant when the repository is wired, because that IS the act
 * of authorising automated dispatch, and it is the last moment a human is present
 * to be asked.
 */
describe('BoardDO — a trigger-born card carries authority', () => {
  const GRANT = ['prn_0123456789abcdef0123'];

  it('stamps the board grant onto a card the webhook creates', async () => {
    await runInDurableObject(stubFor('tg-webhook'), async (board: BoardDO) => {
      await board.init({ id: 'brd_tg1', tenantId: 'tnt_a', name: 'TG', stages: PIPE });
      await board.setGithubConfig({ secret: 'hook', issueTrigger: true, triggerGrant: GRANT });
      const body = JSON.stringify({
        action: 'opened',
        issue: { number: 3, title: 'Auto', state: 'open', html_url: 'https://github.com/org/repo/issues/3' },
        repository: { full_name: 'org/repo' },
      });
      await board.handleGithubWebhook({ rawBody: body, signature: await githubSignatureHeader('hook', body), deliveryId: 'tg1', event: 'issues' });

      const snap = await board.getState();
      expect(snap.cards).toHaveLength(1);
      expect(snap.cards[0]!.queuedGrant).toEqual(GRANT);
    });
  });

  it('prefers a grant the caller carried over the board default', async () => {
    await runInDurableObject(stubFor('tg-caller'), async (board: BoardDO) => {
      await board.init({ id: 'brd_tg2', tenantId: 'tnt_a', name: 'TG', stages: PIPE });
      await board.setGithubConfig({ triggerGrant: GRANT });
      const caller = ['prn_ffffffffffffffffffff'];
      const r = await board.createCardFromTrigger({ title: 'x', ownerUserId: 'usr_a', queuedGrant: caller });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.card.queuedGrant).toEqual(caller);
    });
  });

  it('leaves the grant null when the board has none — a standalone board is unchanged', async () => {
    await runInDurableObject(stubFor('tg-none'), async (board: BoardDO) => {
      await board.init({ id: 'brd_tg3', tenantId: 'tnt_a', name: 'TG', stages: PIPE });
      const r = await board.createCardFromTrigger({ title: 'x', ownerUserId: 'usr_a' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.card.queuedGrant).toBeNull();
    });
  });

  it('clears the standing grant when the operator no longer carries one', async () => {
    await runInDurableObject(stubFor('tg-clear'), async (board: BoardDO) => {
      await board.init({ id: 'brd_tg4', tenantId: 'tnt_a', name: 'TG', stages: PIPE });
      await board.setGithubConfig({ triggerGrant: GRANT });
      expect((await board.getState()).github.triggerGrantCount).toBe(1);
      await board.setGithubConfig({ triggerGrant: null });
      expect((await board.getState()).github.triggerGrantCount).toBeNull();
      const r = await board.createCardFromTrigger({ title: 'x', ownerUserId: 'usr_a' });
      if (r.ok) expect(r.value.card.queuedGrant).toBeNull();
    });
  });

  it('reports the grant as a count, never as the principal ids', async () => {
    await runInDurableObject(stubFor('tg-count'), async (board: BoardDO) => {
      await board.init({ id: 'brd_tg5', tenantId: 'tnt_a', name: 'TG', stages: PIPE });
      await board.setGithubConfig({ triggerGrant: ['prn_aaaaaaaaaaaaaaaaaaaa', 'prn_bbbbbbbbbbbbbbbbbbbb'] });
      const snap = await board.getState();
      expect(snap.github.triggerGrantCount).toBe(2);
      expect(JSON.stringify(snap.github)).not.toContain('prn_');
    });
  });
});
