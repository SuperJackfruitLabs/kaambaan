import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { buildAgentCard } from '../src/db/agent-card';

/**
 * An agent's A2A AgentCard, projected from the registry.
 *
 * This is what naming migration 0006's columns after `AgentSkill` was for. The test that matters
 * most is the last one: a capability the agent holds that the registry has never seen must still
 * appear on the card. A card that omits a tag the agent actually routes on is a card that
 * disagrees with the claim predicate, which is the class of silent mismatch this area exists to
 * end — and it would be very easy to "clean up" by filtering.
 */
const T = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'X-User-Id': 'usr_card', 'Content-Type': 'application/json' });

async function makeAgent(tenant: string, name: string, capabilities: string[]): Promise<string> {
  const res = await SELF.fetch('https://api.test/v1/agents', {
    method: 'POST',
    headers: T(tenant),
    body: JSON.stringify({ name, capabilities }),
  });
  return (await res.json<{ agent: { id: string } }>()).agent.id;
}

async function card(tenant: string, agentId: string) {
  const res = await SELF.fetch(`https://api.test/v1/agents/${agentId}/card`, { headers: T(tenant) });
  return { status: res.status, body: await res.json<{ card: any }>() };
}

describe('GET /v1/agents/:id/card', () => {
  it('projects a defined capability into an AgentSkill, field for field', async () => {
    const t = 'tnt_card_def';
    await SELF.fetch('https://api.test/v1/capabilities', {
      method: 'POST',
      headers: T(t),
      body: JSON.stringify({
        key: 'security',
        name: 'Security review',
        description: 'Assess a change for security impact',
        tags: ['review'],
        examples: ['Check this PR for injection risk'],
      }),
    });
    const agentId = await makeAgent(t, 'Auditor', ['security']);

    const { body } = await card(t, agentId);
    expect(body.card.name).toBe('Auditor');
    expect(body.card.version).toBeTruthy();
    expect(body.card.skills).toHaveLength(1);
    // A2A AgentSkill field names, verbatim — nothing renamed on the way out.
    expect(body.card.skills[0]).toMatchObject({
      id: 'security',
      name: 'Security review',
      description: 'Assess a change for security impact',
      tags: ['review'],
      examples: ['Check this PR for injection risk'],
      inputModes: [],
      outputModes: [],
    });
    expect(body.card.unregistered).toEqual([]);
  });

  it('includes what an implication adds, so the card matches what the agent can claim', async () => {
    const t = 'tnt_card_imp';
    const agentId = await makeAgent(t, 'Reviewer', ['code-review']);
    await SELF.fetch('https://api.test/v1/capabilities/implications', {
      method: 'POST',
      headers: T(t),
      body: JSON.stringify({ from: 'code-review', to: 'code' }),
    });

    const { body } = await card(t, agentId);
    const ids = body.card.skills.map((s: { id: string }) => s.id).sort();
    // Publishing only the declared set would give a card that disagrees with the claim predicate.
    expect(ids).toEqual(['code', 'code-review']);
  });

  it('404s for an agent in another workspace, rather than leaking that it exists', async () => {
    const agentId = await makeAgent('tnt_card_a', 'Theirs', ['code']);
    expect((await card('tnt_card_b', agentId)).status).toBe(404);
  });
});

describe('buildAgentCard — the degraded skill', () => {
  it('lists a capability the registry has no row for, rather than dropping it', () => {
    // Every API write path registers, and deleting a referenced capability is refused, so this
    // state is not reachable through the routes today — which is exactly why it is pinned here.
    // A card that omits a tag the agent routes on would disagree with the claim predicate, and
    // "filter out the ones we cannot describe" is a very easy tidy-up to make later.
    const built = buildAgentCard({ name: 'Legacy', capabilities: ['known', 'ghost'] }, [
      {
        id: 'cap_1',
        tenantId: 't',
        key: 'known',
        name: 'Known',
        description: 'described',
        tags: [],
        examples: [],
        origin: 'declared',
        createdBy: null,
        externalId: null,
        externalSource: null,
        inputModes: [],
        outputModes: [],
      },
    ]);

    expect(built.skills.map((s) => s.id)).toEqual(['known', 'ghost']);
    expect(built.skills[1]).toMatchObject({ id: 'ghost', name: 'ghost', description: null });
    expect(built.unregistered).toEqual(['ghost']);
  });
});
