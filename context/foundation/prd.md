---
project: "Agent Werewolves"
version: 1
status: draft
created: 2026-10-18
context_type: greenfield
product_type: web-app
target_scale:
  users: small
  qps: null          # TODO: target_scale.qps — see Open Questions
  data_volume: null  # TODO: target_scale.data_volume — see Open Questions
timeline_budget:
  mvp_weeks: 8
  hard_deadline: null
  after_hours_only: true
---

## Vision & Problem Statement

The user wants hands-on learning of agentic workflows and the full agentic product-development lifecycle. They also want to watch, measure, and inspect how LLMs bluff and reason in real games, and to gather data from those games. So far their agent learning is tutorials and toy agents that don't exercise real multi-agent, multi-turn reasoning. What they know about LLM deception comes from secondhand benchmark data they cannot inspect themselves. No tool lets them put different models at one table and compare how they bluff and reason. The motivation is also partly plain curiosity.

Insight: Werewolf forces hidden roles, lying, and modeling of other players' beliefs, which most agent demos never exercise. A real hosted game with archives and reputation covers the whole build-ship-operate lifecycle, not just a prompt loop. Mixing models at one table shows reasoning differences that static benchmarks miss.

Scale note: at 100x, the growth is in *games*, not people. The audience stays tiny, but thousands of games make the metrics meaningful. Scale pressure is game volume and spend.

## User & Persona

**Primary persona:** the user, as a builder-learner. The project is their vehicle for learning agents, LLMs, and the agentic product-development lifecycle.

**Moments of use (three, all wanted):**
- **Play:** sit in one seat in a web UI and play a game against AI agents. _(Moved post-MVP; see Non-Goals.)_
- **Watch live:** watch an all-AI game unfold in a web UI as a spectacle of reasoning and bluffing.
- **Batch:** run 10–20 games in the background, headless (e.g. from a CLI). Only the results matter here.

**Post-MVP aspiration (user-stated):** stream games live to a public live-streaming platform.

### Secondary persona

The user, as an observer-researcher who inspects games and reasoning traces and compares how models bluff and reason.

## Success Criteria

### Primary
- The user opens the hosted web UI, enters the access key, and sets up a 5–9 seat game. Wolves are 1/3 of the seats, rounded down, plus 1–2 special roles (Seer, Witch, Hunter, Guard) and villagers in the remaining seats, with a model chosen per seat (mixed models). The user starts the game and watches it unfold live until one side wins.
- After the game, the user can see: the winner and every role revealed, the full public transcript (everything said, every vote), each agent's private reasoning next to what it said publicly, and metrics/scores.

v1 flow:
1. Open the hosted web UI and enter the access key.
2. Configure a game: 5–9 seats, roles, a model per seat.
3. Start the game.
4. Watch the night and day phases live: discussion, accusations, votes, eliminations.
5. Game ends: winner shown, roles revealed.
6. Inspect: public transcript, per-agent private reasoning, metrics/scores.

v1 agents have distinct personalities and memory within a game. Finished games go into verifiable archives.

### Secondary
- While watching live, the spectator can choose whether roles are hidden (guess along) or shown (see the bluffs).

_(Originally "play one seat yourself". Moved to post-MVP during the Phase 4 Socrates round.)_

### Guardrails
- **Games are never lost.** Every finished or crashed game ends up in the archive.
- **LLM spend stays capped.** A game or batch can never cost more than a limit the user sets.
- **No hidden-info leaks.** No agent ever sees information its role should not know.
- **Games always terminate.** A stuck model or failed call never leaves a game hanging forever.

## User Stories

### US-01: Operator watches a mixed-model game live and inspects it

- **Given** the operator has entered the access key and set up a game (player count, roles, models, and personalities either assigned by hand or randomized within bounds and balance rules)
- **When** they start the game, after seeing its estimated cost
- **Then** they watch the night and day phases unfold live until one side wins, and can then inspect the outcome

#### Acceptance Criteria
- While watching, the spectator can switch role visibility between hidden and shown.
- Each day's discussion stops at the operator-set limit and voting follows.
- The game ends with a winner shown and every role revealed.
- The game record shows the full public transcript (everything said, every vote, in order) with each agent's private rationale next to its public statements, in the same form for every model.
- Metrics are shown (win rate per model/role, vote accuracy, deception success, cost and latency), each with the number of games it is based on.
- The finished game appears in the archive and its integrity can be verified.
- No agent received information its role should not know.
- Total spend stayed within the operator's limit. If the limit is hit, the game is archived as aborted for budget reasons.

### US-02: Operator runs a batch of games and reviews aggregated results

- **Given** the operator has entered the access key and set up a batch of 10–20 games (models assigned, drawn from a pool, or rotated across seats and roles)
- **When** they see the estimated cost, set a spend limit, and start the batch
- **Then** the games run headless and the operator gets aggregated results across the batch

#### Acceptance Criteria
- Aggregated metrics (win rate per model/role, vote accuracy, deception success, cost and latency) each show how many games they are based on.
- Every game in the batch is archived, including ones aborted for budget reasons or that failed, and can be found by filtering on batch.
- Any game in the batch can be reopened and inspected like a live-watched game.
- The batch never exceeds the operator's spend limit.

_Status: US-01 confirmed by the user. US-02 added at the user's request and drafted from FR-003, FR-011, FR-013, FR-014, FR-016._

## Functional Requirements

### Access
- FR-001: Operator can reach the app only by entering the access key, and can rotate the key at any time. The old key stops working immediately. Priority: must-have
  > Socrates: Counter-argument considered: "one shared key leaks easily (committed to a repo, shown in a screenshot), letting anyone drain the LLM budget." Resolution: revised in Step 7. Added key rotation. The spend limit (FR-014) remains a backstop.

### Game setup
- FR-002: Operator can set the player count (5–9) and role composition by hand, or have them randomized. Every setup, manual or random, follows the composition rule in Business Logic (wolves = 1/3 of seats rounded down, 1–2 special roles total, villagers fill the rest). Priority: must-have
  > Socrates: Counter-argument considered: "random setups can be unbalanced (e.g. 3 wolves in 5 seats), skewing win-rate metrics." Resolution: revised. The balance rule was pinned in Phase 5 as a fixed composition rule (see Business Logic).
- FR-003: Operator can assign a model to each seat by hand, have models drawn randomly from a pool the operator picks, or (for batches) rotate models systematically so each model plays each role equally often. Priority: must-have
  > Socrates: Counter-argument considered: "random model placement confounds comparison; few games means noisy per-model results." Resolution: revised. Added a rotation mode for batches.
- FR-004: Operator can assign each agent a personality from a preset roster, or have personalities drawn randomly from it. Priority: must-have
  > Socrates: Counter-arguments offered ("persona confounds model measurement", "writing the roster steals time"). Resolution: no counter-argument accepted. Stands as written.

### Gameplay
- FR-005: AI agents can play a full game: night actions, day discussion, accusations, votes, eliminations, until one side wins. Each day's discussion has an operator-set limit, after which voting is forced. Priority: must-have
  > Socrates: Counter-argument considered: "free discussion may never end, breaking the 'games always terminate' guardrail." Resolution: revised. Discussion is bounded per day.
- FR-006: Agents can remember what was said and done earlier in the same game. Priority: must-have
  > Socrates: Counter-argument considered: "remembering everything grows every call, so long games and batches blow up cost." Resolution: kept. The spend limit (FR-014) is the backstop and cost metrics (FR-011) show where spend goes.

### Watching & inspection
- FR-007: Spectator can watch a game live as it unfolds. Priority: must-have
  > Socrates: Counter-argument considered: "step-by-step replay of a finished game gives nearly the same spectacle, more simply." Resolution: kept live, and added replay as FR-017 (nice-to-have).
- FR-008: Spectator can choose, while watching, whether roles are hidden (guess along) or shown (see the bluffs). All roles are revealed and the winner shown at game end. Priority: must-have
  > Socrates: Counter-argument considered: "a reveal spoils live viewing; when to reveal is itself a choice." Resolution: revised. The spectator toggles role visibility.
- FR-009: Operator can read the full game record: the public transcript (everything said, every vote, in order) with each agent's private rationale next to its public statements. Every agent produces the same kind of private rationale, whatever its model. Priority: must-have
  > Socrates: Counter-arguments considered: "the transcript overlaps with private reasoning (former FR-010)" and "reasoning exposure is uneven across models." Resolution: merged former FR-010 into FR-009, with rationale normalized across models.
- FR-011: Operator can see metrics: win rate per model and role, vote accuracy, deception success, cost and latency per game. Every metric shows how many games it is based on. Priority: must-have
  > Socrates: Counter-arguments considered: "metrics need many games to mean anything" and "'deception success' is fuzzy." Resolution: revised. Sample size is shown, and each metric's exact definition must be pinned in Business Logic (Phase 5).

### Archive
- FR-012: Every game goes into an archive whose integrity can be verified. Priority: must-have
  > Socrates: Counter-argument considered: "with one operator, nobody else needs proof of integrity." Resolution: kept as an explicit learning goal.
- FR-013: Operator can browse and reopen past games, filtering by model, role, outcome, date, and batch. Priority: must-have
  > Socrates: Counter-argument considered: "after 100+ batch games a flat list is useless." Resolution: revised. Added filters.

### Spend
- FR-014: Operator can set a spend limit for a game or batch, and sees an estimated cost before it starts (and can cancel). If the limit is reached mid-game, the game ends and is archived as aborted for budget reasons, never silently lost. Priority: must-have
  > Socrates: Counter-arguments considered: "a hard stop leaves a half-finished game" and "the cost should be known up front." Resolution: revised. Added a pre-run estimate and defined abort-and-archive behavior.

### Batch
- FR-016: Operator can run a batch of 10–20 headless games and get aggregated results. Priority: must-have
  > Socrates: Counter-argument considered: "20 games × 7 seats is real money at scale." Resolution: kept. The spend limit and pre-run estimate (FR-014) are the gate.

### Replay
- FR-017: Operator can replay an archived game step by step. Priority: nice-to-have
  > Socrates: This FR came out of FR-007's challenge as its resolution. No separate challenge.

### Removed / moved
- FR-010: merged into FR-009.
- FR-015 (player takes one seat and plays against AI agents): moved to post-MVP. Socrates counter-argument accepted: "a player's view must hide everything their role can't know, which is effectively a second UI."

## Non-Functional Requirements

- **Live feels live:** a spectator sees each statement, vote, or death within 2 s of it happening in the game.
- **Games finish in bounded time:** a 9-player game completes, or is aborted and archived, within 45 min, even if a model stalls.
- **Spend never overshoots:** actual spend never exceeds the operator's limit by more than one agent turn's cost.
- **Archive kept indefinitely:** archived games stay until the operator deletes them, and survive app restarts and redeploys.
- **Reproducible setup:** any archived game shows exactly which models, personalities, roles, and limits it ran with, so it can be rerun under the same setup.
- **Desktop browsers only:** the web UI works on the latest two major versions of mainstream desktop browsers. Mobile is not required.

_The user asked the facilitator to propose the first four; the user accepted all six, including the 2 s and 45 min targets._

## Business Logic

The app runs a Werewolf game by its rules, giving each agent only what its role may know, and scores how well each model deceives and deduces.

**Composition rule (balance):** a game has 5–9 players. Werewolves are 1/3 of the seats, rounded down (5→1, 6–8→2, 9→3). Each game has 1–2 special roles in total, drawn from Seer, Witch, Hunter, and Guard. Villagers fill the remaining seats.

| Role | Team | Ability |
|---|---|---|
| 👤 Villager | Village | No special ability. Finds wolves through discussion and voting. |
| 🐺 Werewolf | Wolf | Kills one player each night. Coordinates with teammates. |
| 👁️ Seer | Village | Checks one player's identity each night. |
| 🧪 Witch | Village | One antidote (save) and one poison (kill), each single-use. |
| 🔫 Hunter | Village | Shoots one player upon death (not when poisoned). |
| 🛡️ Guard | Village | Protects one player each night. Cannot protect the same player on consecutive nights. |

**Inputs:** the game setup (player count, role composition, models per seat, personalities, assigned by hand or randomized within bounds and balance rules), the per-day discussion limit, and the spend limit. During play, the inputs are the agents' speech, votes, and night actions.

**Output:** a completed (or budget-aborted) game with a winner, plus scores. Scoring is defined as follows:
- **Win rate per model and role:** every seat on the winning side gets a win for the role it played, alive or dead.
- **Vote accuracy:** two figures, shown separately: (a) per-vote accuracy, the share of day votes cast by non-wolves that target an actual werewolf; (b) per-elimination accuracy, the share of day eliminations where the eliminated player was a werewolf.
- **Deception success:** all three measures (user: "all if possible"): (a) wolf survival, the number of day rounds each wolf survives; (b) votes misdirected, the share of village votes landing on innocents while wolves are alive; (c) suspicion dodged, how rarely a wolf was voted for compared with innocents.
- **Cost and latency:** per game and per model.
- Every metric shows the number of games it is based on.

**How the user encounters it:** live while watching (FR-007, FR-008), in the game record and metrics after a game (FR-009, FR-011), and aggregated across batches (FR-016).

## Access Control

Single operator (the user); no accounts. The hosted app is reachable only by presenting one access key, which the operator can rotate at any time (the old key stops working immediately). Without the key, nothing is usable, so strangers cannot start games or spend the LLM budget.

Operator, player, and spectator are **modes** the user switches between, not permission boundaries:
- **Operator:** start games, run background batches, inspect archives.
- **Player:** take one seat in a game. _(Post-MVP; see Non-Goals.)_
- **Spectator:** watch an all-AI game live.

One key unlocks all modes.

## Non-Goals

- **No human player seat in v1.** Moved post-MVP: a player's view must hide everything their role can't know, which is effectively a second UI.
- **No persistent identity or reputation across games in v1.** Deferred post-MVP by user decision in Phase 3.
- **No public live streaming in v1.** Post-MVP aspiration.
- **No multiple users or accounts.** Single operator behind one access key; roles are modes, not permissions.
- **No mobile support.** Desktop browsers only.
- **No self-hosted or local LLMs.** v1 uses hosted models only.
- **No roles beyond the six.** The role set is locked to Villager, Werewolf, Seer, Witch, Hunter, and Guard.
- **No training on game data.** Games are measured, not used to fine-tune or train models.

## Open Questions

1. **What is the expected request load (`target_scale.qps`)?** Not discussed during shaping. The scale note says growth comes from game volume (up to thousands of games), not from more users. — Owner: user. Block: no.
2. **What is the expected data volume (`target_scale.data_volume`)?** Not discussed during shaping. Archives are kept indefinitely and may grow to thousands of games with full transcripts and per-agent reasoning. — Owner: user. Block: no.
