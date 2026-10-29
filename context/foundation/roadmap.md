---
project: Agent Werewolves
version: 1
status: draft
created: 2026-10-18
updated: 2026-10-29
prd_version: 1
main_goal: learn
top_blocker: time
milestone_id: watchable-measurable-ai-werewolf
milestone_seq: 1
milestone_status: open
---

# Roadmap: Agent Werewolves

> Derived from `context/foundation/prd.md` (v1) + auto-researched codebase baseline.
> Edit-in-place; archive when superseded.
> Slices below are listed in dependency order. The "At a glance" table is the index.

## Milestone

**M-1: Watchable, measurable AI Werewolf** — Status: open

- **Intent:** Deliver the PRD's v1. The operator can watch mixed-model AI games live behind an access key, inspect each finished game's record and reasoning, run spend-capped batches, and compare models on metrics from a verifiable archive.
- **Source materials:** `context/foundation/prd.md` (v1)
- **Done when:** every F-NN and S-NN below is `done`.
- **Scope anchors:** US-01, US-02; FR-001 to FR-009, FR-011 to FR-014, FR-016 (all must-haves). FR-017 (nice-to-have) is parked.

## Vision recap

The operator wants hands-on learning of agentic workflows across the whole build-ship-operate lifecycle, and wants to watch, measure, and inspect how different LLMs bluff and reason. Werewolf forces hidden roles, lying, and modeling other players' beliefs. Putting several models at one table shows reasoning differences that static benchmarks miss. Scale grows in *games*, not people: the audience stays one operator, while thousands of games make the metrics meaningful.

## North star

**S-02: Operator starts an all-AI game and watches it live until one side wins.** A "north star" here is the smallest end-to-end slice whose delivery proves the product works. It is placed as early as its prerequisites allow, because nothing else matters if this fails. It comes first under the `learn` goal because it exercises the two least familiar pieces: a game loop that keeps running for up to 45 minutes on the chosen platform, and live updates pushed to a spectator.

## At a glance

| ID | Change ID | Outcome (user can …) | Prerequisites | PRD refs | Status |
|---|---|---|---|---|---|
| F-01 | deploy-skeleton | (foundation) app runs on the chosen platform at a public URL, deploys on merge, and its logs are readable | — | NFR: Archive kept indefinitely (survives redeploys); infrastructure.md | done |
| F-02 | game-room-turn-loop-spike | (foundation) a dummy multi-turn game room is proven to survive eviction and redeploy, broadcast live, and never re-bill a retried turn | F-01 | NFR: Games finish in bounded time; NFR: Spend never overshoots; NFR: Live feels live | done |
| S-01 | access-key-gate | operator reaches the app only with the access key and can rotate it | F-01 | FR-001 | done |
| S-02 | first-live-ai-game | operator starts a fixed-setup all-AI game and watches it live until one side wins, with roles revealed at the end | F-02, S-01 | US-01, FR-005, FR-006, FR-007 | in-progress |
| S-03 | game-record-with-reasoning | operator reopens a finished game and reads the public transcript with each agent's private rationale beside it | S-02 | US-01, FR-009 | proposed |
| S-04 | spectator-role-visibility | spectator toggles between hidden and shown roles while watching | S-02 | US-01, FR-008 | proposed |
| S-05 | custom-table-composition | operator sets 5–9 seats and the role mix (by hand or randomized within the balance rule), with Witch, Hunter and Guard playable | S-02 | US-01, FR-002, FR-005 | proposed |
| S-06 | mixed-model-seats-and-personas | operator seats different models and personalities at one table, by hand or drawn from a pool | S-02 | US-01, FR-003, FR-004 | proposed |
| S-07 | spend-limit-and-estimate | operator sees an estimated cost, sets a spend limit, and over-budget games end and are archived as aborted | S-03 | US-01, FR-014 | proposed |
| S-08 | game-metrics | operator sees win rate, vote accuracy, deception success, cost and latency per model and role, each with its game count | S-03, S-06 | US-01, FR-011 | proposed |
| S-09 | headless-batch-runs | operator runs a spend-capped batch of 10–20 headless games with model rotation and reviews aggregated results | S-07, S-08 | US-02, FR-016, FR-003, FR-014 | proposed |
| S-10 | archive-browse-and-filter | operator browses past games filtered by model, role, outcome, date and batch | S-03, S-06 | US-02, FR-013 | proposed |
| S-11 | verifiable-archive | operator verifies an archived game's integrity, and crashed games land in the archive too | S-03 | US-01, FR-012 | proposed |

## Streams

Navigation aid: groups items that share a prerequisites chain. Canonical ordering still lives in the dependency graph below; this table is the proposed reading order across parallel tracks.

| Stream | Theme | Chain | Note |
|---|---|---|---|
| A | Runtime and first live game | `F-01` → `F-02` → `S-01` → `S-02` → `S-04` | The `learn` spine: unfamiliar runtime and live push first; `S-01` runs alongside `F-02`. |
| B | Table setup | `S-05` → `S-06` | Joins Stream A at `S-02`. Both slices can run in parallel; `S-06` is the mixed-model hypothesis. |
| C | Record and archive | `S-03` → `S-10` → `S-11` | Joins Stream A at `S-02`. `S-10` also waits on `S-06` (model filter). |
| D | Spend, metrics and batches | `S-07` → `S-08` → `S-09` | Joins Stream C at `S-03` and Stream B at `S-06`. Ends in US-02. |

## Baseline

What's already in place in the codebase as of `2026-10-18` (auto-researched + user-confirmed).
Foundations below assume these are present and do NOT re-scaffold them.

- **Frontend:** present: SSR React app with a single welcome route (`app/root.tsx`, `app/routes.ts`), per tech-stack.md.
- **Backend / API:** partial: SSR server only; no loaders, actions, or game logic.
- **Data:** absent: no database driver, schema, or migrations (hosted Postgres planned per tech-stack.md).
- **Auth:** absent: no access-key gate.
- **Deploy / infra:** partial: a Node container file only. The platform is decided in `context/foundation/infrastructure.md` but not wired, and there is no CI workflow.
- **Observability:** absent: no logging or error tracking (platform logs planned per infrastructure.md).

## Foundations

### F-01: Deploy skeleton on the chosen platform

- **Outcome:** (foundation) the existing scaffold runs on the platform chosen in infrastructure.md at a public URL. Merging to main deploys it automatically, and runtime logs can be read from the terminal.
- **Change ID:** deploy-skeleton
- **PRD refs:** NFR: Archive kept indefinitely (survives app restarts and redeploys); tech-stack.md `ci_default_flow: auto-deploy-on-merge`; infrastructure.md Getting Started steps 1–4
- **Unlocks:** F-02, S-01; verification path "every later slice can be checked on a deployed URL".
- **Prerequisites:** —
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:** —
- **Risk:** First because the scaffold still targets a different runtime. Every later slice would be written against the wrong one until this lands. The risk is copying platform docs that target an older framework major version (flagged in infrastructure.md).
- **Status:** done

### F-02: Game-room turn-loop spike

- **Outcome:** (foundation) a throwaway three-turn game room proves four things before any real game logic exists. Each turn makes one real LLM call. Turns chain across platform evictions. A redeploy mid-game resumes from the last saved turn. Each turn is broadcast live to a connected viewer. A retried turn never pays for the same LLM call twice.
- **Change ID:** game-room-turn-loop-spike
- **PRD refs:** NFR: Games finish in bounded time; NFR: Spend never overshoots; NFR: Live feels live; Guardrails: games always terminate, games are never lost
- **Unlocks:** S-02. It also answers the blocking question "can a 45-minute game run as saved, retry-safe steps on this platform?" (infrastructure.md risk register, top two rows).
- **Prerequisites:** F-01
- **Parallel with:** S-01
- **Blockers:** —
- **Unknowns:**
  - Which LLM provider or gateway the spike calls (see Open Roadmap Question 3). Owner: user. Block: no.
- **Risk:** Sequenced before the north star because a game written as one long loop fails silently in production (infrastructure.md pre-mortem). The spike spends real LLM budget before the access key gate exists, so it must not be triggerable from the public URL.
- **Status:** done

## Slices

### S-01: Access key gate

- **Outcome:** user can reach the app only after entering the access key, and the operator can rotate the key so the old one stops working immediately.
- **Change ID:** access-key-gate
- **PRD refs:** FR-001
- **Prerequisites:** F-01
- **Parallel with:** F-02
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Placed before the north star because the first real game spends LLM budget from a public URL. A leaked key is mitigated by rotation now and by the spend limit later (S-07).
- **Status:** done

### S-02: First live AI game (north star)

- **Outcome:** user can start a fixed-setup all-AI game (Werewolves, Villagers and a Seer) and watch the night and day phases live until one side wins. Roles are revealed at the end.
- **Change ID:** first-live-ai-game
- **PRD refs:** US-01, FR-005, FR-006, FR-007; NFR: Live feels live; NFR: Games finish in bounded time
- **Prerequisites:** F-02, S-01
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - Exact turn protocol: what each agent receives per phase so that no agent sees information its role should not know. Owner: user. Block: no (resolve in `/10x-plan`).
  - Interim safety cap on spend until S-07 lands. Owner: user. Block: no.
- **Risk:** The riskiest slice in the milestone: hidden-info leaks, games that never end, and live lag all surface here first. The fixed setup and the single special role keep it thin enough to plan in one go.
- **Status:** in-progress — implemented locally; production acceptance pending (`context/changes/first-live-ai-game/verification.md`).

### S-03: Game record with private reasoning

- **Outcome:** user can reopen a finished game and read the full public transcript (every statement and vote, in order). Each agent's private rationale sits beside its public statements, in the same form for every model.
- **Change ID:** game-record-with-reasoning
- **PRD refs:** US-01, FR-009; NFR: Archive kept indefinitely
- **Prerequisites:** S-02
- **Parallel with:** S-04, S-05, S-06
- **Blockers:** —
- **Unknowns:**
  - Whether the hosted Postgres free tier pauses inactive projects, which would threaten "games are never lost" (infrastructure.md risk register). Owner: user. Block: no.
- **Risk:** The first slice that persists games outside the game room, so the archive's durability assumptions are tested here. Rationale differs per model, so this slice must settle on one shared format.
- **Status:** proposed

### S-04: Spectator role visibility toggle

- **Outcome:** user can switch, while watching, between hidden roles (guess along) and shown roles (see the bluffs).
- **Change ID:** spectator-role-visibility
- **PRD refs:** US-01, FR-008
- **Prerequisites:** S-02
- **Parallel with:** S-03, S-05, S-06
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Small and isolated, but it must not leak hidden roles to the browser when they are set to hidden.
- **Status:** proposed

### S-05: Custom table composition and remaining roles

- **Outcome:** user can set 5–9 seats and the role mix, by hand or randomized, always within the composition rule. Witch, Hunter and Guard are fully playable.
- **Change ID:** custom-table-composition
- **PRD refs:** US-01, FR-002, FR-005; Business Logic: composition rule and role table
- **Prerequisites:** S-02
- **Parallel with:** S-03, S-04, S-06
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Three new night abilities with edge cases (Witch's single-use potions, the Hunter not shooting when poisoned, the Guard's no-repeat rule) can each break game termination. They are split from S-02 so the north star stays thin.
- **Status:** proposed

### S-06: Mixed-model seats and personalities

- **Outcome:** user can assign a model and a personality to each seat, by hand or drawn at random from an operator-picked pool or roster. Different models then play at one table.
- **Change ID:** mixed-model-seats-and-personas
- **PRD refs:** US-01, FR-003, FR-004
- **Prerequisites:** S-02
- **Parallel with:** S-03, S-04, S-05
- **Blockers:** —
- **Unknowns:**
  - Who writes the preset personality roster, and how many personalities v1 needs. Owner: user. Block: no.
- **Risk:** Under the `learn` goal this is the core comparison the product exists for. Provider-specific quirks (rate limits, how each model exposes reasoning) surface here, not earlier.
- **Status:** proposed

### S-07: Spend limit and cost estimate

- **Outcome:** user can see a game's estimated cost before starting, cancel, or set a spend limit. A game that hits the limit ends and is archived as aborted for budget reasons.
- **Change ID:** spend-limit-and-estimate
- **PRD refs:** US-01, FR-014; NFR: Spend never overshoots; Guardrail: LLM spend stays capped
- **Prerequisites:** S-03
- **Parallel with:** S-04, S-05, S-06, S-08, S-10, S-11
- **Blockers:** —
- **Unknowns:**
  - Where per-model pricing for the estimate comes from (provider price list vs. a maintained table). Owner: user. Block: no.
  - Whether a turn retried from inside `GameRoom` gets a free OpenRouter cache HIT in production. F-02 could not prove it: a laptop resend misses entries the Worker wrote, likely because the cache is per edge location (`context/archive/2026-10-19-game-room-turn-loop-spike/spike-findings.md`, 4.7). Prove it with an in-DO resend drill before relying on "spend never overshoots". Owner: user. Block: yes.
- **Risk:** Must land before batches (S-09) multiply spend. Overshoot is allowed by at most one agent turn, so the check has to run before every LLM call, not after.
- **Status:** proposed

### S-08: Game metrics

- **Outcome:** user can see win rate per model and role, vote accuracy (per vote and per elimination), deception success (wolf survival, misdirected votes, suspicion dodged), and cost and latency. Every figure shows how many games it is based on.
- **Change ID:** game-metrics
- **PRD refs:** US-01, FR-011; Business Logic: scoring definitions
- **Prerequisites:** S-03, S-06
- **Parallel with:** S-07, S-10, S-11
- **Blockers:** —
- **Unknowns:** —
- **Risk:** The definitions are pinned in the PRD, so the risk is fidelity, not design. Metrics computed from records that lack a needed field force a backfill, so check S-03's record covers every input first.
- **Status:** proposed

### S-09: Headless batch runs

- **Outcome:** user can launch a batch of 10–20 headless games, with models assigned, drawn from a pool, or rotated so each model plays each role equally often. The batch stays within its spend limit, and the operator reviews results aggregated across it.
- **Change ID:** headless-batch-runs
- **PRD refs:** US-02, FR-016, FR-003, FR-014
- **Prerequisites:** S-07, S-08
- **Parallel with:** S-10, S-11
- **Blockers:** —
- **Unknowns:**
  - Whether batch games run concurrently or one after another, within platform free-tier limits (infrastructure.md: workflow step and duration caps). Owner: user. Block: no.
- **Risk:** Multiplies every earlier weakness (spend, termination, archive durability) by 10–20, so it comes last on its chain, after spend limits and metrics exist.
- **Status:** proposed

### S-10: Archive browse and filter

- **Outcome:** user can browse past games and filter by model, role, outcome, date and batch, then reopen any of them.
- **Change ID:** archive-browse-and-filter
- **PRD refs:** US-02, FR-013
- **Prerequisites:** S-03, S-06
- **Parallel with:** S-07, S-08, S-09, S-11
- **Blockers:** —
- **Unknowns:** —
- **Risk:** The batch filter only becomes meaningful once S-09 lands; if S-10 ships first, verify batch filtering again after S-09.
- **Status:** proposed

### S-11: Verifiable archive

- **Outcome:** user can verify that an archived game's record has not been altered, and games that crashed or were aborted land in the archive just like finished ones.
- **Change ID:** verifiable-archive
- **PRD refs:** US-01, FR-012; Guardrail: games are never lost
- **Prerequisites:** S-03
- **Parallel with:** S-04, S-05, S-06, S-07, S-08, S-09, S-10
- **Blockers:** —
- **Unknowns:**
  - What "verifiable" must prove, and to whom: tamper evidence checked by the operator inside the app, or proof checkable outside it. Owner: user. Block: no.
- **Risk:** Kept as an explicit learning goal (PRD FR-012). It is independent of the gameplay slices, so it can slot in whenever time allows without blocking anything.
- **Status:** proposed

## Backlog Handoff

| Roadmap ID | Change ID | Suggested issue title | Ready for `/10x-plan` | Notes |
|---|---|---|---|---|
| F-01 | deploy-skeleton | Run the scaffold on the chosen platform with auto-deploy on merge | yes | Run `/10x-plan deploy-skeleton` |
| F-02 | game-room-turn-loop-spike | Spike: retry-safe, deploy-surviving game-room turn loop | no | Needs F-01 |
| S-01 | access-key-gate | Gate the app behind a rotatable access key | no | Needs F-01 |
| S-02 | first-live-ai-game | Watch a fixed-setup all-AI game live to the end | yes | Implemented locally; deployed acceptance pending in `context/changes/first-live-ai-game/` |
| S-03 | game-record-with-reasoning | Game record: transcript with per-agent private rationale | no | Needs S-02 |
| S-04 | spectator-role-visibility | Spectator toggle for hidden/shown roles | no | Needs S-02 |
| S-05 | custom-table-composition | Configurable seats and roles incl. Witch, Hunter, Guard | no | Needs S-02 |
| S-06 | mixed-model-seats-and-personas | Per-seat models and personalities (manual or pooled) | no | Needs S-02 |
| S-07 | spend-limit-and-estimate | Pre-game cost estimate, spend limit, budget abort | no | Needs S-03 |
| S-08 | game-metrics | Per-model/role metrics with sample sizes | no | Needs S-03, S-06 |
| S-09 | headless-batch-runs | Spend-capped headless batches with model rotation | no | Needs S-07, S-08 |
| S-10 | archive-browse-and-filter | Browse and filter the game archive | no | Needs S-03, S-06 |
| S-11 | verifiable-archive | Integrity-verifiable archive incl. crashed games | no | Needs S-03 |

## Open Roadmap Questions

1. **What is the expected request load (`target_scale.qps`)?** Not discussed during shaping. The scale note says growth comes from game volume (up to thousands of games), not from more users. Owner: user. Block: no (roadmap-wide).
2. **What is the expected data volume (`target_scale.data_volume`)?** Not discussed during shaping. Archives are kept indefinitely and may grow to thousands of games with full transcripts and per-agent reasoning. Owner: user. Block: no (roadmap-wide).
3. **Which LLM access path: one gateway that fronts many models, or direct provider APIs per model?** This decides how mixed-model seats, cost estimates and per-model latency are obtained. It was explicitly out of scope in infrastructure.md. Owner: user. Block: no; decide during `/10x-plan` for F-02, since it shapes S-02, S-06 and S-07.

## Parked

- **Step-by-step replay of an archived game (FR-017).** Why parked: nice-to-have, and the `time` blocker keeps the milestone to must-haves.
- **Human player seat.** Why parked: PRD Non-Goals (a player's view must hide everything their role can't know; effectively a second UI).
- **Persistent identity or reputation across games.** Why parked: PRD Non-Goals (deferred post-MVP).
- **Public live streaming.** Why parked: PRD Non-Goals (post-MVP aspiration).
- **Multiple users or accounts.** Why parked: PRD Non-Goals (single operator behind one key).
- **Mobile support.** Why parked: PRD Non-Goals (desktop browsers only).
- **Self-hosted or local LLMs.** Why parked: PRD Non-Goals (hosted models only).
- **Roles beyond the six.** Why parked: PRD Non-Goals (role set locked).
- **Training on game data.** Why parked: PRD Non-Goals (games are measured, not used for training).

## Milestone History

## Done
- **F-01: (foundation) the existing scaffold runs on the platform chosen in infrastructure.md at a public URL. Merging to main deploys it automatically, and runtime logs can be read from the terminal.** — Archived 2026-10-19 → `context/archive/2026-10-18-deploy-skeleton/`. Lesson: —.
- **F-02: (foundation) a throwaway three-turn game room proves turns chain across evictions and redeploys, broadcast live, and are billed once.** — Archived 2026-10-22 → `context/archive/2026-10-19-game-room-turn-loop-spike/`. Lesson: deploys let an in-flight DO alarm finish on old code, so a redeploy cannot force a retry; the no-re-bill proof moved to S-07.
- **S-01: user can reach the app only after entering the access key, and the operator can rotate the key so the old one stops working immediately.** — Archived 2026-10-29 → `context/archive/2026-10-22-access-key-gate/`. Lesson: hibernated WebSockets outlive a key rotation (a running room can stay on the old version), so long-lived sockets need their own key fingerprint and age cap.
