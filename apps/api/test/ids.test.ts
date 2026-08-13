import { describe, it, expect } from 'vitest';
import type { ZodType } from 'zod';
import {
  TenantId,
  UserId,
  MembershipId,
  BoardId,
  AgentId,
  TokenId,
  CardId,
  RunId,
  ReferenceId,
  GateId,
  ContextId,
  ID_PREFIXES,
} from '@kaambaan/contract';
import { newId } from '../src/ids';

// The contract is the shared source of truth for id shapes, across this repo and its consumers.
// It only holds if every id the API mints validates against the schema that claims to describe it —
// the drift this guards is `newId('mbr')` vs a `MembershipId` schema that demanded `mem_…`.

/** Prefix → the contract schema for it, one row per `newId(...)` call site in src/. */
const MINTED: Record<string, ZodType> = {
  tnt: TenantId,
  usr: UserId,
  mbr: MembershipId,
  brd: BoardId,
  agt: AgentId,
  tok: TokenId,
  card: CardId,
  ctx: ContextId,
  ref: ReferenceId,
  run: RunId,
  gate: GateId,
  // ('push' is minted for push-config rows and has no contract id yet — nothing validates it.)
};

describe('minted ids satisfy the contract', () => {
  for (const [prefix, schema] of Object.entries(MINTED)) {
    it(`newId('${prefix}') parses`, () => {
      const id = newId(prefix);
      const parsed = schema.safeParse(id);
      expect(parsed.success, `${id} was rejected by the contract schema for "${prefix}"`).toBe(true);
    });
  }

  it("the contract's prefix table matches the prefixes the API mints", () => {
    expect(ID_PREFIXES.membership).toBe('mbr');
    for (const prefix of Object.values(ID_PREFIXES)) {
      const schema = MINTED[prefix];
      if (!schema) continue; // declared in the contract but not minted by this app
      expect(schema.safeParse(newId(prefix)).success).toBe(true);
    }
  });
});
