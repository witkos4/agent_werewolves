-- Per-seat personality (S-06). Additive and nullable: version-1 games have none.
ALTER TABLE game_players ADD COLUMN persona TEXT;
