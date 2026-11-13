-- Death day and cause per seat (S-08), for vote and deception metrics.
-- Additive and nullable: a seat that survived keeps NULLs.
ALTER TABLE game_players ADD COLUMN died_day INTEGER;
ALTER TABLE game_players ADD COLUMN died_by TEXT;

-- Backfill from the archived transcript. The phrases match `kill()` in
-- workers/game/engine.ts; seats run p1-p9, so "(p1)" matches only seat p1.
-- Fills only missing values, so it is safe to run again after a rollout.
UPDATE game_players SET
  died_day = (
    SELECT json_extract(e.value, '$.day') FROM games g, json_each(g.state_json, '$.transcript') e
    WHERE g.id = game_players.game_id AND json_extract(e.value, '$.kind') = 'death'
      AND instr(json_extract(e.value, '$.text'), '(' || game_players.seat || ')') > 0
  ),
  died_by = (
    SELECT CASE
      WHEN json_extract(e.value, '$.text') LIKE '%) died during the night.' THEN 'night'
      WHEN json_extract(e.value, '$.text') LIKE '%) was eliminated by the village.' THEN 'village'
    END
    FROM games g, json_each(g.state_json, '$.transcript') e
    WHERE g.id = game_players.game_id AND json_extract(e.value, '$.kind') = 'death'
      AND instr(json_extract(e.value, '$.text'), '(' || game_players.seat || ')') > 0
  )
WHERE survived = 0 AND died_day IS NULL;
