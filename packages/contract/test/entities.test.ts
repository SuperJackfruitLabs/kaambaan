import { describe, it, expect } from 'vitest';
import { Agent, Board, Card, Reference, Tenant } from '../src';

describe('entity schemas', () => {
  it('parses a board with a pipeline and applies stage defaults', () => {
    const board = Board.parse({
      id: 'brd_abc123',
      tenantId: 'tnt_abc123',
      name: 'Content',
      stages: [
        { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
        { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
      ],
      createdAt: '2026-06-20T10:00:00.000Z',
    });
    expect(board.stages[0]!.gate).toBe('none'); // default
    expect(board.stages[1]!.gate).toBe('approval');
  });

  it('requires at least one stage', () => {
    const r = Board.safeParse({
      id: 'brd_abc123',
      tenantId: 'tnt_abc123',
      name: 'Empty',
      stages: [],
      createdAt: '2026-06-20T10:00:00.000Z',
    });
    expect(r.success).toBe(false);
  });

  it('applies card defaults (spec, labels, priority)', () => {
    const card = Card.parse({
      id: 'card_abc123',
      boardId: 'brd_abc123',
      tenantId: 'tnt_abc123',
      contextId: 'ctx_abc123',
      title: 'Summarize incident reports',
      ownerUserId: 'usr_abc123',
      currentStageKey: 'research',
      createdAt: '2026-06-20T10:00:00.000Z',
    });
    expect(card.spec).toEqual({});
    expect(card.labels).toEqual([]);
    expect(card.priority).toBe(0);
  });

  it('a reference requires a provider and source type', () => {
    const ok = Reference.safeParse({
      id: 'ref_abc123',
      cardId: 'card_abc123',
      tenantId: 'tnt_abc123',
      url: 'https://github.com/org/repo/pull/42',
      provider: 'github',
      sourceType: 'pull_request',
      addedBy: 'agent',
      createdAt: '2026-06-20T10:00:00.000Z',
    });
    expect(ok.success).toBe(true);
    expect(Reference.safeParse({ id: 'ref_abc123' }).success).toBe(false);
  });
});

/**
 * The tenant is kaambaan's LOCAL isolation boundary. `externalId` + `externalSource` optionally
 * record that the same real organisation is also known elsewhere; the pair is all-or-nothing,
 * mirroring the database CHECK (apps/api/migrations/0002_tenant_external_mapping.sql).
 */
describe('tenant external mapping', () => {
  const base = {
    id: 'tnt_abc123',
    slug: 'acme',
    name: 'Acme',
    createdAt: '2026-06-20T10:00:00.000Z',
  };

  it('a standalone tenant carries no external mapping', () => {
    const t = Tenant.parse(base);
    expect(t.externalId).toBeUndefined();
    expect(t.externalSource).toBeUndefined();
  });

  it('accepts an explicit absence on both halves', () => {
    expect(Tenant.safeParse({ ...base, externalId: null, externalSource: null }).success).toBe(true);
  });

  it('accepts both halves together', () => {
    const t = Tenant.parse({
      ...base,
      externalId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      externalSource: 'agentpod',
    });
    expect(t.externalSource).toBe('agentpod');
  });

  it('rejects an external id with no source naming whose id it is', () => {
    expect(Tenant.safeParse({ ...base, externalId: 'org_1' }).success).toBe(false);
    expect(Tenant.safeParse({ ...base, externalId: 'org_1', externalSource: null }).success).toBe(false);
  });

  it('rejects a source with no external id', () => {
    expect(Tenant.safeParse({ ...base, externalSource: 'agentpod' }).success).toBe(false);
    expect(Tenant.safeParse({ ...base, externalSource: 'agentpod', externalId: null }).success).toBe(false);
  });

  it('rejects an empty string as a stand-in for either half', () => {
    expect(Tenant.safeParse({ ...base, externalId: '', externalSource: 'agentpod' }).success).toBe(false);
    expect(Tenant.safeParse({ ...base, externalId: 'org_1', externalSource: '' }).success).toBe(false);
  });
});

/**
 * An agent maps to a suite principal the same way a tenant maps to a real organisation:
 * `externalId` + `externalSource`, all-or-nothing (apps/api/migrations/0003_agent_external_mapping.sql).
 * `kbn_`, the agent's bearer token, is untouched by any of this — it is a separate, permanent
 * credential (charter decisions/2026-08-30-an-agent-is-a-principal.md §5).
 */
describe('agent external mapping', () => {
  const base = {
    id: 'agt_abc123',
    tenantId: 'tnt_abc123',
    name: 'Forge',
    createdAt: '2026-06-20T10:00:00.000Z',
  };

  it('a freshly registered agent carries no external mapping', () => {
    const a = Agent.parse(base);
    expect(a.externalId).toBeUndefined();
    expect(a.externalSource).toBeUndefined();
  });

  it('accepts an explicit absence on both halves', () => {
    expect(Agent.safeParse({ ...base, externalId: null, externalSource: null }).success).toBe(true);
  });

  it('accepts both halves together', () => {
    const a = Agent.parse({ ...base, externalId: 'prn_0123456789abcdef0123', externalSource: 'org-plane' });
    expect(a.externalSource).toBe('org-plane');
  });

  it('rejects half a mapping, either half missing the other', () => {
    expect(Agent.safeParse({ ...base, externalId: 'prn_1' }).success).toBe(false);
    expect(Agent.safeParse({ ...base, externalSource: 'org-plane' }).success).toBe(false);
    expect(Agent.safeParse({ ...base, externalId: 'prn_1', externalSource: null }).success).toBe(false);
    expect(Agent.safeParse({ ...base, externalSource: 'org-plane', externalId: null }).success).toBe(false);
  });

  it('rejects an empty string as a stand-in for either half', () => {
    expect(Agent.safeParse({ ...base, externalId: '', externalSource: 'org-plane' }).success).toBe(false);
    expect(Agent.safeParse({ ...base, externalId: 'prn_1', externalSource: '' }).success).toBe(false);
  });
});
