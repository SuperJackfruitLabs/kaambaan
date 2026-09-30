-- Migration 0012. Cross-board card edges. ADVISORY, always — read the design before extending this.
--
-- Cards live in per-board Durable Objects, so an edge whose ends are in different DOs cannot be
-- consulted on the claim path without a cross-DO read, and a stale cross-DO read either refuses a
-- card that just unblocked or admits one that just became blocked. Rather than an enforcement that
-- is wrong occasionally, these are informational and the UI says so.
--
-- `parent` is deliberately NOT an allowed kind: a parent edge carries a rule (a parent does not
-- advance while a child is open), and an advisory containment relationship is one that fails to
-- contain. Cross-board decomposition is a project (migration 0013).
CREATE TABLE card_links_external (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  from_board_id TEXT NOT NULL REFERENCES boards(id),
  from_card_id  TEXT NOT NULL,
  to_board_id   TEXT NOT NULL REFERENCES boards(id),
  to_card_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('blocks', 'relates')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (from_card_id, to_card_id, kind),
  -- A card blocking itself is never a fact worth storing, and across boards it cannot even be a
  -- typo the UI would catch: the two ends come from two different pickers.
  CHECK (from_card_id <> to_card_id)
);
CREATE INDEX idx_card_links_external_tenant ON card_links_external(tenant_id);
-- BOTH ends are indexed because `listExternalLinksFor` matches either one: a card's badge has to
-- show the edges it declares as well as the edges declared against it. One index would leave half
-- the reads doing a table scan.
CREATE INDEX idx_card_links_external_to ON card_links_external(to_card_id);
CREATE INDEX idx_card_links_external_from ON card_links_external(from_card_id);
