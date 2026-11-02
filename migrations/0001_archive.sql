-- Archive of terminal games (S-03). Additive only: never drop or rename,
-- so `wrangler rollback` never needs a down-migration.

CREATE TABLE games (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('finished', 'aborted')),
  winner TEXT,
  abort_reason TEXT,
  model TEXT NOT NULL,
  discussion_passes INTEGER NOT NULL,
  seat_count INTEGER NOT NULL,
  days INTEGER NOT NULL,
  turns INTEGER NOT NULL,
  -- Sum of known per-turn costs; NULL when no turn reported a cost.
  total_cost_usd REAL,
  unknown_cost_turns INTEGER NOT NULL,
  reserved_usd REAL NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  archived_at INTEGER NOT NULL,
  engine_version INTEGER NOT NULL,
  -- Full engine state, a lossless copy the record is rebuilt from.
  state_json TEXT NOT NULL
);
CREATE INDEX games_ended_at ON games (ended_at DESC);

CREATE TABLE game_players (
  game_id TEXT NOT NULL REFERENCES games (id),
  seat TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  survived INTEGER NOT NULL,
  PRIMARY KEY (game_id, seat)
);
CREATE INDEX game_players_model_role ON game_players (model, role);

CREATE TABLE game_moves (
  game_id TEXT NOT NULL REFERENCES games (id),
  turn_no INTEGER NOT NULL,
  day INTEGER NOT NULL,
  phase TEXT NOT NULL,
  actor TEXT NOT NULL,
  text TEXT,
  target TEXT,
  result_role TEXT,
  rationale TEXT NOT NULL,
  cost_usd REAL,
  latency_ms INTEGER,
  attempts INTEGER NOT NULL,
  generation_id TEXT,
  PRIMARY KEY (game_id, turn_no)
);
