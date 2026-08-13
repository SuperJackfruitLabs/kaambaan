import { describe, it, expect } from 'vitest';
import { TenantId, CardId, RunId, AgentId, MembershipId, ID_PREFIXES } from '../src';

describe('prefixed ids', () => {
  it('accepts well-formed ids', () => {
    expect(TenantId.safeParse('tnt_abc123').success).toBe(true);
    expect(CardId.safeParse('card_9f8e7d').success).toBe(true);
    expect(RunId.safeParse('run_Aa0Bb1').success).toBe(true);
    expect(AgentId.safeParse('agt_xyz789').success).toBe(true);
  });

  it('accepts the membership prefix the API actually mints', () => {
    // `mbr_`, not `mem_` — see apps/api/src/db/catalog.ts and the D1 rows already written.
    expect(MembershipId.safeParse('mbr_abc123').success).toBe(true);
    expect(MembershipId.safeParse('mem_abc123').success).toBe(false);
  });

  it('keeps the prefix table in step with the schemas', () => {
    // Every declared prefix must be accepted by its own schema, so the table can be used to mint.
    const schemas = { tenant: TenantId, membership: MembershipId, card: CardId, run: RunId, agent: AgentId };
    for (const [entity, schema] of Object.entries(schemas)) {
      const prefix = ID_PREFIXES[entity as keyof typeof ID_PREFIXES];
      expect(schema.safeParse(`${prefix}_abc123`).success).toBe(true);
    }
  });

  it('rejects the wrong prefix', () => {
    expect(CardId.safeParse('tnt_abc123').success).toBe(false);
    expect(RunId.safeParse('task_abc123').success).toBe(false);
  });

  it('rejects too-short tokens and bad characters', () => {
    expect(TenantId.safeParse('tnt_ab').success).toBe(false);
    expect(TenantId.safeParse('tnt_abc-12').success).toBe(false);
    expect(TenantId.safeParse('tnt_').success).toBe(false);
    expect(TenantId.safeParse('abc123').success).toBe(false);
  });
});
