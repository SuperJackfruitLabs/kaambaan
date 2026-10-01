-- Migration 0013. Projects group work ACROSS boards; milestones are ordered checkpoints inside one project.
--
-- Here rather than in a board's Durable Object because that is the whole point: a project confined
-- to one board would be indistinguishable from a label, and labels already exist (migration 0010).
-- The cost is that a project's numbers are a fan-out read over many DOs and therefore a snapshot —
-- see project_rollups below, and note that the UI is required to show its "as of" time.
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  name         TEXT NOT NULL,
  description  TEXT,
  target_date  TEXT,
  state        TEXT NOT NULL DEFAULT 'active'
                 CHECK (state IN ('planned', 'active', 'paused', 'completed', 'canceled')),
  -- Declared by a human, never computed. A health that a rollup calculated would be a second,
  -- quieter progress bar; this is someone's judgement and is allowed to disagree with the numbers.
  health       TEXT CHECK (health IN ('on-track', 'at-risk', 'off-track')),
  lead_user_id TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT,
  UNIQUE (tenant_id, name)
);
CREATE INDEX idx_projects_tenant ON projects(tenant_id);

CREATE TABLE milestones (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  target_date TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_milestones_project ON milestones(project_id, sort_order);

-- The cached fan-out. `computed_at` is not bookkeeping: it is rendered in the UI, because a number
-- assembled from eleven Durable Objects at some past moment should not be presented as current.
CREATE TABLE project_rollups (
  project_id   TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  cards_total  INTEGER NOT NULL DEFAULT 0,
  cards_done   INTEGER NOT NULL DEFAULT 0,
  cards_overdue INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL NOT NULL DEFAULT 0,
  computed_at  TEXT NOT NULL
);
