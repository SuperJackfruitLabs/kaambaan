-- The same manoeuvre migration 0002 gave `tenants`: a local id plus an optional mapping to the
-- same real thing elsewhere. Here the "real thing" is a suite principal.
--
-- charter decisions/2026-08-30-an-agent-is-a-principal.md §5: an agent is a principal, and
-- `agents` gains the same `external_id` / `external_source` pair `tenants` already carries.
-- `kbn_` is NOT retired by this — it is kaambaan's native agent credential, permanently, and a
-- standalone kaambaan must keep booting with no hub in existence. This column pair is how a
-- local agent is ALSO known elsewhere; it is not how a local agent authenticates.
--
--   external_source  the system that knows this agent by another id — 'org-plane' once the
--                     Organization plane mints principals; nothing writes it yet
--   external_id      that system's id for the same agent, deliberately opaque, so no grammar is
--                    imposed on it here (the shared corpus pins `^prn_[0-9a-f]{20}$`, but that is
--                    the peer's contract to keep, not a CHECK this table enforces)
--
-- BOTH OR NEITHER, enforced here rather than in application code, for the identical reason
-- `tenants_external_pair` was: an id recorded without the system it came from cannot be joined
-- against anything, and a wrong join is harder to notice than a missing one.
--
-- NULL is the normal, complete state. An agent nobody has ever linked to a principal — which is
-- every agent in a standalone kaambaan, and every agent today — is a complete agent. This is
-- product independence, not migration scaffolding: the distinction the whole slice depends on.
--
-- SQLite has no ALTER TABLE ... ADD CONSTRAINT, so the CHECK rides in on the second ADD COLUMN,
-- exactly as 0002 did for `tenants`.
ALTER TABLE agents ADD COLUMN external_id TEXT;

ALTER TABLE agents ADD COLUMN external_source TEXT
  CONSTRAINT agents_external_pair CHECK ((external_id IS NULL) = (external_source IS NULL));
