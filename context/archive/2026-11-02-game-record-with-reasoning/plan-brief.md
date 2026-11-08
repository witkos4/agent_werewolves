# Game Record With Private Reasoning — Plan Brief

> Full plan: `context/changes/game-record-with-reasoning/plan.md`

## What & Why

Roadmap S-03 (FR-009). The operator reopens a finished or aborted game and reads every statement and every vote in order, with each agent's private rationale beside it and the private night actions inline. It is also the first archive outside the game room. S-07, S-08, S-10 and S-11 all build on it.

## Starting Point

Each game lives only in its Durable Object: a JSON state blob, plus per-turn cost and latency. Every move already carries a normalized `rationale` from one JSON contract for all models, but nothing outside the room ever reads it, and there is no list of past games.

## Desired End State

When a game ends, its room writes it to Cloudflare D1 and keeps retrying until the write lands. `/games/:id` becomes the record: roles revealed, one ordered timeline, rationale beside each speech and each individual vote, and night checks and kills marked private. It reads D1, or falls back to the room with an "Archiving…" badge. Home lists the last 20 archived games. The three S-02 drill games join the archive the first time they're opened.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Next slice | S-03 | Unblocks four later slices |
| Archive store | Cloudflare D1 (not Supabase/Hyperdrive) | No free-tier pause risk, no external account, no pooler layers |
| Which games | Finished + aborted | Same code path; "games are never lost"; S-07 budget aborts need it |
| Night actions | Inline, marked private | Complete decision trail, kept in time order |
| Reopening | Same URL + home "latest 20" list | Usable without saved URLs; S-10 adds filters later |
| Data model | `games` + `game_players` + `game_moves` rows, plus full state JSON | S-08/S-10 query plain SQL with no backfill; JSON is a lossless copy |
| Read source | D1, else room + "Archiving…" badge | No dead end right after a game ends, and archive lag stays visible |
| Existing games | Archive on next open | Reuses the outbox; no extra endpoint |
| Migrations | CI applies on merge, additive only | Schema and code never drift; the merge is the approval |

## Scope

**In scope:** D1 binding and schema; CI and local migrations; a pure record projection; the room outbox with retry; the record view at `/games/:id`; the home recent list; docs (tech-stack, infrastructure, README); the production drill.

**Out of scope:** filters and search (S-10), integrity proofs (S-11), live role toggle (S-04), native reasoning tokens, replay (FR-017), deletion, spike rooms, engine or prompt changes.

## Architecture / Approach

```
terminal transition ──(same txn)──> live_archive = pending, alarm = now
alarm ──> buildRecord(state, live_turns) ──> D1 batch (INSERT … ON CONFLICT DO NOTHING) ──> mark archived
                                              └─ failure: backoff 30 s ×4 … 1 h, retry forever
/games/:id ──> running? live viewer : D1 record ?? room.getRecord() + "Archiving…"
```

One projection, `buildRecord`, serves both read sources, so they render identically. The Durable Object class and its migrations don't change, so rollback stays possible.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. D1 foundation | Binding, `0001` schema, test/dev/CI migrations, docs | CI token lacks D1 permission |
| 2. Projection + outbox | `buildRecord`, D1 writer, retrying archive from the room | Merging the turn-less transcript with private moves in the right order |
| 3. Record page + list | Record view, live-to-record switch, home list | Leaking rationale into the live view |
| 4. Production drill | Deploy, one new game, three drill games archived, evidence | Legacy drill state shape differs from tests |

**Prerequisites:** the operator runs `npx wrangler d1 create agent-werewolves-archive` once and confirms the CI token has D1 edit rights.
**Estimated effort:** ~2–3 sessions across 4 phases.

## Open Risks & Assumptions

- The CI `CLOUDFLARE_API_TOKEN` may need D1 edit permission added (a human step).
- Drill games were made by the same engine version (state `version: 1`), so the projection is expected to handle them; Phase 2 tests a drill-shaped state to make sure.
- Rationale is self-reported (25 words at most). That is FR-009's normalized form, not the models' internal reasoning.

## Success Criteria (Summary)

- Any terminal game's URL shows the complete record with rationale beside every statement and vote, and night actions marked private.
- Every game that ends lands in D1 exactly once, even across D1 failures or evictions, and the three drill games are archived.
- Live viewing never exposes rationale, roles or night actions while the game runs.
