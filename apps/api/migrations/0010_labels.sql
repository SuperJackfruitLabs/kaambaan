-- Labels: the one Card field that docs/01 has declared since the beginning and no table stored.
--
-- `packages/contract/src/entities.ts` has carried `labels: z.array(z.string()).default([])` for as
-- long as the Card schema has existed, and there were zero occurrences of `labels` in the Board DO.
-- docs/01 flags it, so this closes a documented gap rather than fixing a surprise.
--
-- The catalogue is tenant-scoped and lives here, not in a board's Durable Object, because a label
-- that means one thing on the Press board and another on Releases is not a label. Cards store
-- applied label IDS (not names) so renaming a label cannot orphan a card.
CREATE TABLE labels (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  name       TEXT NOT NULL,
  -- A CSS colour token or hex. Not constrained: the UI owns its palette, and a CHECK here would
  -- be a migration every time the palette gains a shade.
  colour     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- One spelling per workspace, for the same reason `capabilities` has it (migration 0006): it is
  -- what makes a label impossible to misspell into existence twice.
  UNIQUE (tenant_id, name)
);
CREATE INDEX idx_labels_tenant ON labels(tenant_id);
