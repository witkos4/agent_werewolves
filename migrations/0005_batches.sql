-- Headless batches (S-09). Additive: games archived before this change, and
-- single games after it, keep a NULL batch_id.
ALTER TABLE games ADD COLUMN batch_id TEXT;
CREATE INDEX games_batch_id ON games (batch_id);

-- A listable copy of each batch, upserted by its BatchRoom. `version` only
-- grows, so a delayed write never rolls a batch back. `summary_json` holds the
-- request and the slot list.
CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  game_count INTEGER NOT NULL,
  discussion_passes INTEGER NOT NULL,
  spend_limit_usd REAL NOT NULL,
  game_limit_usd REAL NOT NULL,
  charged_usd REAL NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  version INTEGER NOT NULL,
  summary_json TEXT NOT NULL
);
CREATE INDEX batches_created_at ON batches (created_at DESC);
