-- A capability becomes a record, instead of a string on two objects.
--
-- Routing is `agent.capabilities.includes(stage.owner)` — exact equality between two free
-- strings. Nothing defined the set, so every producer invented one: board templates slugified a
-- stage name, the agent editor hardcoded three values, the suite picker defaulted to a token
-- SCOPE, and the create route normalised nothing. Five vocabularies for one field, compared by
-- equality, matching almost nothing.
--
-- The research brief (charter-adjacent, 2026-09-02) found that four of the five reference agent
-- registries — MCP, A2A, Entra, NANDA — deliberately DO NOT define a vocabulary. They standardise
-- the record: its fields, its identity, its provenance, and leave the set open. Only AGNTCY/OASF
-- ships a taxonomy, and even that is extensible with private schema extensions. So this table
-- gives a capability an identity and a definition; it does not enumerate what may exist.
--
-- The columns are A2A `AgentSkill` field names on purpose (`id, name, description, tags,
-- examples`). docs/01 already names AgentCard as an agent's capability document, and the
-- charter's layer-reference §5 says a capability registry "does not invent a replacement for
-- MCP/OpenAPI/CLI/A2A". Borrowing the field names now means a future AgentCard is a projection of
-- this table rather than a translation of it.
CREATE TABLE capabilities (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),

  -- The routing tag itself, and the thing `stageMatches` compares. Normalised by
  -- `capabilityTag` in the shared contract, so one capability has exactly one spelling.
  -- This stays the value stored on stages and agents: making them store `cap_…` instead would
  -- rewrite every board's Durable Object state and make a board snapshot unreadable to a person,
  -- to buy an indirection nothing needs.
  key             TEXT NOT NULL,

  -- A2A AgentSkill: what a person calls it, what it means, how it is found, what it looks like.
  name            TEXT NOT NULL,
  description     TEXT,
  tags_json       TEXT NOT NULL DEFAULT '[]',
  examples_json   TEXT NOT NULL DEFAULT '[]',

  -- How this capability arrived, which is the fact the mismatch hid.
  --   'declared' — someone defined it deliberately
  --   'inferred' — it appeared as a stage owner and was registered on first use
  -- An operator can then see which capabilities nobody ever meant to create.
  origin          TEXT NOT NULL DEFAULT 'declared' CHECK (origin IN ('declared', 'inferred')),
  created_by      TEXT,

  -- The same pair `tenants` and `agents` already carry, for the same reason and with the same
  -- all-or-nothing rule: OASF gives dotted, hierarchical ids (`nlp.summarization.abstractive`)
  -- over 18 categories, and this is how a local capability is ALSO known there. Local ids stay
  -- authoritative. NULL is the normal, complete state — a standalone board maps to nothing.
  --
  -- No grammar is imposed on external_id here: it is the peer taxonomy's contract to keep, not
  -- a CHECK this table enforces. Exactly the reasoning migration 0003 recorded for `prn_`.
  external_id     TEXT,
  external_source TEXT,

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT,

  -- One spelling per workspace. This is the constraint that makes a capability impossible to
  -- misspell into existence twice.
  UNIQUE (tenant_id, key),
  CONSTRAINT capabilities_external_pair CHECK ((external_id IS NULL) = (external_source IS NULL))
);
CREATE INDEX idx_capabilities_tenant ON capabilities(tenant_id);

-- Backfill from what is already in use, so the registry describes the product as it stands rather
-- than as an empty table nobody's boards match.
--
-- Both sources are read from the CATALOG, not from Durable Object storage, which a migration
-- cannot reach: `boards.stages_json` is the mirror the Worker keeps in step, and
-- `agents.capabilities_json` is the agent's own list. Everything found this way is `inferred` —
-- nobody declared these, they accumulated.
--
-- `json_each` needs valid JSON; `capabilities_json` and `stages_json` are both NOT NULL with JSON
-- defaults, so every row parses.
INSERT OR IGNORE INTO capabilities (id, tenant_id, key, name, origin, created_by)
SELECT
  'cap_' || lower(hex(randomblob(8))),
  b.tenant_id,
  json_extract(s.value, '$.owner'),
  json_extract(s.value, '$.owner'),
  'inferred',
  NULL
FROM boards b, json_each(b.stages_json) s
WHERE json_extract(s.value, '$.ownerKind') = 'capability'
  AND json_extract(s.value, '$.owner') IS NOT NULL
  AND json_extract(s.value, '$.owner') <> '';

INSERT OR IGNORE INTO capabilities (id, tenant_id, key, name, origin, created_by)
SELECT
  'cap_' || lower(hex(randomblob(8))),
  a.tenant_id,
  c.value,
  c.value,
  'inferred',
  NULL
FROM agents a, json_each(a.capabilities_json) c
WHERE c.value IS NOT NULL AND c.value <> '';
