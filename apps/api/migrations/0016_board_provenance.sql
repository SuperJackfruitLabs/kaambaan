-- Migration 0016. Who made a board, and how many an agent may make in a day.
--
-- `boards` recorded NO creator at all — not the human, not an agent. That was survivable while only
-- a person could create one; it stops being survivable the moment an agent can, because the board
-- would appear in the workspace with nothing saying it was not the operator's. That is exactly the
-- gap `cards.queued_by_agent_id` exists to close, and the same answer applies.
--
-- NULL on both columns is honest for every board that exists today: nobody recorded it, and
-- backfilling the operator would be a lie the audit trail could not tell from a fact.
ALTER TABLE boards ADD COLUMN created_by TEXT;
ALTER TABLE boards ADD COLUMN created_by_agent_id TEXT;

-- Counted from `created_by_agent_id` below, so this column IS the ledger and there is no second
-- table to keep in step with it.
CREATE INDEX idx_boards_created_by_agent ON boards(created_by_agent_id, created_at);

-- How many boards an agent may compose in a day.
--
-- Boards are rare, so a DAY is the right window where cards take an hour. A scope says whether an
-- agent may create one; only this says how many, and a loop that makes five hundred boards is the
-- hazard a scope cannot bound. Three is deliberately small: composing a board is a considered act,
-- and an agent that needs a fourth in one day can be given one.
ALTER TABLE agents ADD COLUMN board_ceiling_per_day INTEGER NOT NULL DEFAULT 3;
