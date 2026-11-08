# Mixed-Model Seats and Personalities — Plan Brief

## Outcome

Before starting a game, the operator sets each of the five seats to a model and a personality, either by hand or drawn at random. Model draws come from a pool the operator picks; personality draws come from a preset roster. Different models then play at one table. The live viewer, the record and the archive all show which model and personality held each seat. This delivers roadmap S-06: FR-003 (manual and pool modes) and FR-004.

## Proposed defaults

- A six-model catalog in code, one model per lab, each with its own request parameters. `claude-haiku-5.5` and `gpt-6-luna` reject `temperature`, and `require_parameters: true` would otherwise refuse to route them.
- The existing rate ceilings and the $0.25 safety allowance stay as they are, because every catalog model fits under them. The start-time pricing check runs for every distinct seated model.
- Eight drafted personalities, each one or two sentences about play style. Random draws give each seat a different personality.
- Roles are still shuffled after seats are configured, so the operator can't pick a model for a role. Model draws allow repeats (a two-model pool can fill five seats).
- Agents see their own personality only. They never see which model or personality any other seat has. Spectators see both: neither reveals a role.
- Default setup: every seat draws its model from the full catalog and its personality from the roster. A start request without seat settings, such as an older bearer script, gets that same default.

## Approach

Bump the engine state to version 2, with `model` and `persona` stored per player plus the requested `setup` for reproducibility. Version-1 states fall back to `game.model` and no personality, so the S-02/S-03 records still render. `buildRequest` takes the acting seat's model, catalog parameters and personality. Archive migration `0002` adds one nullable `game_players.persona` column. `game_players.model` already exists.

## Delivery order

1. Catalog, roster and engine v2 (pure), plus a dev smoke script that makes one real call per catalog model.
2. Start API with seat settings, per-model pricing check, record and archive columns.
3. Home setup form, plus seat labels in the live viewer and the record.
4. Production rollout and a mixed-model drill.

## Scope boundary

Batch rotation (S-09), metrics (S-08), archive filters (S-10), table sizes and new roles (S-05), and cost estimates or budgets (S-07) stay with their own slices. Models above the current rate ceilings need S-07's budget work first.

See [plan.md](plan.md) for implementation and verification details.
