-- Migration 0014. The rollup fan-out (Task 19) must be able to say it did not get a confident
-- total, not just compute one: `partial` + `boards_unanswered` persist alongside the cached
-- numbers in `project_rollups` (migration 0013), so a reader inside the 60s cache window sees the
-- same "this is incomplete" admission the fan-out itself produced, rather than a flag that only
-- ever existed in memory for the one request that happened to recompute it.
ALTER TABLE project_rollups ADD COLUMN partial INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_rollups ADD COLUMN boards_unanswered INTEGER NOT NULL DEFAULT 0;
