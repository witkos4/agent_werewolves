---
change_id: mixed-model-seats-and-personas
title: Seat different models and personalities at one table, by hand or drawn from a pool
status: archived
created: 2026-11-08
updated: 2026-11-14
archived_at: 2026-11-14T10:00:00Z
---

## Notes

Roadmap S-06 (FR-003 manual and pool modes, FR-004). Batch rotation (the third FR-003 mode) belongs to S-09.

Decisions (2026-11-08, operator):
- Model catalog: six models from six labs, all under the existing rate ceilings ($0.50/M input, $2.00/M output), so the $0.25 per-game safety allowance is unchanged: `google/gemini-3.1-flash-lite`, `anthropic/claude-haiku-5.5`, `openai/gpt-6-luna`, `deepseek/deepseek-v4-flash`, `qwen/qwen3.8-flash`, `mistralai/mistral-small-2603`.
- Personality roster: Claude drafts eight short play-style personalities in code; the operator edits them before the drill.

Decisions (2026-11-09, operator):
- Personality review (step 1.6): removed The Quiet Observer (`observer`), added The Loyalist (`loyalist`) and The Logician (`logician`). The Storyteller now builds stories from what players said and how they voted, not "what happened each night", so it no longer invites made-up night events. Archived games that seated `observer` still show the bare id.
- The fixed table grows from 5 to 8 seats, pulled forward from S-05 because 8-player games are more interesting to analyze. `rolesFor` applies the PRD composition rule (2 Werewolves, 1 Seer, 5 Villagers at 8 seats). Wolves now pick the night kill in turn, each seeing teammates' picks so far (`teamKillVotes`, wolves only, kill phase only); the most-picked target dies, ties at random. S-05 still owns choosing the seat count and the Witch, Hunter and Guard.
- The per-game safety allowance rises from $0.25 to $1.00: simulated worst-case reservations for an 8-seat game are about $0.22 (one discussion round) and $0.43 (two rounds) before retries. Actual spend is unchanged in kind (the 5-seat drill games cost $0.002–0.003).
