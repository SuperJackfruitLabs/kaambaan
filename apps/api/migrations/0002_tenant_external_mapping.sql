-- The tenant is kaambaan's LOCAL isolation boundary — not an authority on who anyone is.
-- Principal, Team, Role and authority belong to the Organization plane, which does not exist
-- yet. So this does not add an org model; it adds the one thing kaambaan legitimately owns
-- about the outside world: a note that the same real organisation is also known somewhere else.
--
--   external_source  the system the id came from — 'agentpod' today, 'org-plane' later
--   external_id      that system's id, deliberately opaque (AgentPod's are bare UUIDs, the
--                    Organization plane's shape is unknown), so no grammar is imposed on it
--
-- BOTH OR NEITHER, enforced here rather than in application code. An id recorded without the
-- system it came from is worse than no id at all: nothing downstream can tell whose id space
-- it belongs to, and a wrong join is harder to notice than a missing one. AgentPod carries the
-- same pair with the same all-or-nothing CHECK on acp_runs (its migration 0035,
-- `acp_runs_external_pair`); this is the symmetric half, so when the Organization plane mints
-- canonical ids both products map to them as a data move, not a schema change.
--
-- NULL is the normal, complete state. A standalone kaambaan — a plain kanban board for
-- someone's agents, with no organisation layer anywhere — never sets either column, and the
-- CHECK is satisfied by both being absent.
--
-- Deliberately NOT unique. kaambaan is one-tenant-per-user, so two people in the same real
-- organisation legitimately map two local boundaries onto one external id. A shared mapping
-- must never become a shared keyspace: isolation stays local, on tenant_id.
--
-- SQLite has no ALTER TABLE ... ADD CONSTRAINT, so the CHECK rides in on the second ADD COLUMN
-- (a column constraint may reference any column of its table). The result is one named table
-- constraint, `tenants_external_pair`, with no table rebuild — which matters because five
-- tables carry a foreign key to tenants(id).
ALTER TABLE tenants ADD COLUMN external_id TEXT;

ALTER TABLE tenants ADD COLUMN external_source TEXT
  CONSTRAINT tenants_external_pair CHECK ((external_id IS NULL) = (external_source IS NULL));
