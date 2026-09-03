-- Two additions to the registry: what a capability implies, and what it takes and returns.
--
-- ── Implication ──────────────────────────────────────────────────────────────────────────────
--
-- Routing is exact string equality, deliberately: when a card does not move, the diagnosis has to
-- stay a comparison anyone can run by hand. But equality alone cannot express that `code-review`
-- is a kind of `code`, so a workspace that renames a lane strands every agent staffed for the old
-- tag, and an agent that can plainly do the work is refused because it spelled its competence one
-- level down.
--
-- An edge, not a hierarchy. There is no root, no depth limit and no single tree — a capability may
-- imply several, and be implied by several. The claim path expands an agent's DECLARED set into an
-- EFFECTIVE set by walking these edges transitively.
--
-- Cycles are permitted in storage and terminated in the walk. Refusing them would mean a graph
-- traversal on every write to prevent a case that is harmless to survive, and a workspace that
-- declares `a implies b implies a` has said something odd but nothing dangerous: the closure is
-- {a, b} either way.
CREATE TABLE capability_implications (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),

  -- Both sides are capability KEYS rather than ids, matching how stages and agents store them.
  -- An edge may name a capability that does not exist yet: `ensureCapabilities` registers on every
  -- write path, so a foreign key here would refuse an edge for a capability the very next write
  -- would have created, and ordering would become the operator's problem.
  implies_from TEXT NOT NULL,
  implies_to   TEXT NOT NULL,

  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_by  TEXT,

  -- One edge per direction per workspace. A self-edge is meaningless rather than harmful — it is
  -- refused in the route, where an operator can be told why, instead of by a constraint error.
  PRIMARY KEY (tenant_id, implies_from, implies_to)
);

-- The claim path walks FROM a held capability TO what it implies, so that is the indexed direction.
CREATE INDEX capability_implications_from_idx ON capability_implications (tenant_id, implies_from);

-- ── Modalities ───────────────────────────────────────────────────────────────────────────────
--
-- `inputModes` / `outputModes` are A2A AgentSkill field names, continuing 0006's rule that this
-- table's columns ARE the A2A field names so an AgentCard is a projection rather than a
-- translation.
--
-- They are STORED AND PROJECTED, NOT ENFORCED. Nothing validates a handoff against them, because
-- a handoff happens in the board's Durable Object and this table lives in the catalog — the two
-- do not meet, and inventing a crossing here would be deciding that boundary in the wrong place.
-- Written down so a later reader does not mistake the presence of the column for a guarantee.
ALTER TABLE capabilities ADD COLUMN input_modes_json  TEXT NOT NULL DEFAULT '[]';
ALTER TABLE capabilities ADD COLUMN output_modes_json TEXT NOT NULL DEFAULT '[]';
