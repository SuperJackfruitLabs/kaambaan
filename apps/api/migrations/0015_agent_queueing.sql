-- Migration 0015. What an agent is allowed to do when it queues work of its OWN.
--
-- Three columns and a ledger. A coordinator agent can now create cards, which is the only agent
-- act that spends other agents' time, so each column answers one question the scope alone cannot:
-- who ends up answerable for the card, which boards may receive one, and how many per hour.
--
-- Deliberately NOT here: the dispatch grant. `queued_grant` is what the control pair checks at
-- claim time, and its authority is AgentPod's — the operator sets it with `fleet grants set`. A
-- copy of it in this plane would be a second source of truth that drifts silently after a
-- revocation, which is the worst direction for a permission to drift. It arrives in the token's
-- claims instead, exactly as a human's `mayDispatch` already does.

-- The human an agent-queued card belongs to. `createCard` used to fall back to the literal string
-- `usr_dev` when no user was resolved, which on an agent path would own real work to a principal
-- that does not exist. NULL here means this agent may not queue at all, and the route says so by
-- name rather than inventing an owner.
ALTER TABLE agents ADD COLUMN owner_user_id TEXT;

-- Which boards this agent may queue onto, as a JSON array of board ids. NULL means NONE.
--
-- The design doc proposed defaulting to the agent's "rostered boards". There is no such thing in
-- this plane: an agent's capabilities are workspace-wide and no table records which boards it
-- works on — the roster that reasoning came from lives in AgentPod. So the default is the
-- fail-closed half of what that section actually required: "Unset and unrostered means no board,
-- never every board."
ALTER TABLE agents ADD COLUMN may_queue_to_json TEXT;

-- Cards per hour. A scope says whether an agent may queue; it says nothing about volume, and an
-- agent that can spend OTHER agents' time unasked is the hazard the scope was split out for.
ALTER TABLE agents ADD COLUMN queue_ceiling_per_hour INTEGER NOT NULL DEFAULT 20;

-- Every card an agent queued, in one place.
--
-- Here rather than counted from the cards themselves because cards live in per-board Durable
-- Objects: a per-agent hourly count would be a fan-out read over every board the agent can reach,
-- and the number it produced would be a snapshot of ten separate answers. This is also the only
-- place an operator can ask "what has this agent asked for today" without opening ten boards.
CREATE TABLE agent_card_queues (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  board_id   TEXT NOT NULL,
  card_id    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The ceiling's read is `WHERE agent_id = ? AND created_at >= ?`, so the index is that pair in
-- that order.
CREATE INDEX idx_agent_card_queues_agent_time ON agent_card_queues(agent_id, created_at);
CREATE INDEX idx_agent_card_queues_tenant ON agent_card_queues(tenant_id);
