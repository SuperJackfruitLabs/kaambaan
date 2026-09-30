-- Labels get an origin, matching `capabilities` (migration 0006).
--
-- `CardDrawer.svelte` has had a free-text, comma-separated Labels input since before Phase 1, and
-- it wrote into `spec.labels` — a field the tile never read. The fix is to point that same input
-- at the catalogue: a typed name resolves to a catalogue id, and a name nobody has declared yet is
-- created on the spot. `origin: 'inferred'` is the same answer `capabilities` gives for a tag that
-- "appeared as a stage owner and was registered on first use" — refusing an undeclared name would
-- mean a person cannot label a card without first visiting a management screen, which is why the
-- free-text input existed in the first place. `created_by` records who typed it, the same pair
-- `capabilities` carries and for the same reason.
ALTER TABLE labels ADD COLUMN origin TEXT NOT NULL DEFAULT 'declared' CHECK (origin IN ('declared', 'inferred'));
ALTER TABLE labels ADD COLUMN created_by TEXT;

-- `resolveLabelNames` (src/db/labels.ts) matches a typed name against the catalogue
-- case-insensitively within a tenant, so "Urgent" and "urgent" resolve to the SAME label rather
-- than becoming two. `0010`'s `UNIQUE (tenant_id, name)` compares with SQLite's default BINARY
-- collation, so it would not stop that resolver's own INSERT from creating a second row that
-- differs only in case — the lookup and the constraint have to agree on what "already exists"
-- means. SQLite cannot ALTER an existing UNIQUE constraint, so a second, case-insensitive unique
-- index sits beside it.
--
-- The catalogue lookup matches case-insensitively, so uniqueness must too. Without this, `Urgent`
-- and `urgent` are two rows that render identically and split a filter in half.
CREATE UNIQUE INDEX labels_tenant_name_nocase ON labels (tenant_id, name COLLATE NOCASE);
