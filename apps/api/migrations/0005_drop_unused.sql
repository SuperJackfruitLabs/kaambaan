-- Columns and a table that were created and never used, removed on 2026-09-02.
--
-- Each of these has been in the schema since migration 0001 with no reader and no writer
-- anywhere in the codebase. Unused schema is not neutral: it reads as a capability the product
-- has, and every person who opens the catalog has to work out for themselves that it does not.

-- `webhooks` was the outbound-webhook table. Nothing has ever inserted into it or read from it.
-- The delivery mechanism that actually shipped is per-board push configs, held in the Durable
-- Object (`push_configs` / `push_deliveries`), and inbound GitHub uses a secret in board meta.
-- Neither has any use for a tenant-level table of URLs.
DROP TABLE IF EXISTS webhooks;

-- `agents.status` claimed to model online/busy/offline and was never written: every agent has
-- read 'offline' since the day it was created, including while it held a live lease. Liveness is
-- knowable from `runs` in the board DO, which is where a claim actually happens.
--
-- `agents.connection_json` defaulted to '["rest"]' and was never written or read. REST is the
-- only transport an agent has ever had.
--
-- SQLite supports DROP COLUMN, and D1 runs a modern SQLite. `icon_url` and `concurrency` are
-- deliberately NOT dropped alongside: both are now written by PATCH /v1/agents/:id and read (the
-- avatar on a card tile, the ceiling on a claim), so they became real rather than dead.
ALTER TABLE agents DROP COLUMN status;
ALTER TABLE agents DROP COLUMN connection_json;
