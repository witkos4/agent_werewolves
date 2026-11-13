-- Per-game spend limit and settled spend ledger (S-07). Additive and
-- nullable: games archived before this change had no per-game limit.
ALTER TABLE games ADD COLUMN spend_limit_usd REAL;
ALTER TABLE games ADD COLUMN charged_usd REAL;
