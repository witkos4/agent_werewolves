# First Live AI Game Implementation Plan

## Starting point (before implementation)

`workers/game-room.ts` already journals requests before sending, commits replies and events together, schedules one attempt per alarm, and replays events to hibernating WebSockets. Its actual turn logic is a three-sentence story from `workers/spike/story.ts`. `workers/spike/routes.ts` exposes spike start, journal and socket endpoints. The home route is a placeholder.

The Worker gate protects HTTP and WebSocket handshakes. Preserve the socket key fingerprint and two-minute age cap: archived S-01 drills show that deploys can leave old instances and sockets alive. Preserve the `GameRoom` class and additive migrations: existing spike objects are deployed and old/new code may overlap.

F-02 proved eviction, redeploy continuity and event replay. It did **not** prove free production retries. Before this change, an absent OpenRouter `usage.cost` became zero; the implementation now preserves it as unknown. See [README.md](../../../README.md#live-werewolf-game) for the current safety contract.

## Phase 1: Rules and agent protocol

- [x] Add pure `workers/game/` types, setup, transitions, information projections, request builder and response validator, independent of Cloudflare imports.
- [x] Persist a shuffled five-seat assignment (one wolf, one Seer, three villagers), chosen model, discussion-pass limit, limits and game start time. Seat IDs and display names remain stable. Tests inject the role assignment and tie choices.
- [x] Implement night investigation, night kill, dawn announcement, bounded discussion, all living players' votes, elimination and winner evaluation. Investigate before resolving the kill, but publish neither investigation nor intended victim. Deaths announce seat and cause, not role. Check victory after each resolved death.
- [x] Make day votes simultaneous in information terms: collect privately, then reveal the complete vote set together. Otherwise later voters gain information earlier voters did not have. Discussion statements appear immediately and subsequent speakers receive them.
- [x] For tied votes choose uniformly from tied targets once, and persist that choice with the resolution. No self-targets for kills, investigations or votes; all targets must be living and permitted for the acting role. Dead players neither speak nor act.
- [x] Define village victory as zero living wolves; wolf victory as living wolves >= living non-wolves. Four day eliminations is a defensive ceiling for this fixed table; exceeding it aborts as an invariant failure.
- [x] Use separate structured response contracts for speech and target actions. Validate JSON shape, actor/phase, allowed targets and text lengths server-side. Require a short self-reported decision rationale for later record support; treat it as private data, not provider chain of thought. Invalid output aborts explicitly in this slice, avoiding extra repair calls and silent invented moves.
- [x] Build requests from an allowlist: rules, own role, stable public roster, public events, own prior outputs and own investigation results. Wolf teammates may be included for future-compatible projection, though this table has one wolf. Never serialize full state and redact afterward. Treat other players' statements as untrusted quoted game data.
- [x] Bound input size before calling; abort explicitly if full permitted game memory cannot fit. Do not silently truncate history or hidden facts. Give each turn a stable identity in its stored body so two otherwise identical actions cannot share cached replies accidentally.

Verify rule paths for both winners, Seer death, ties, invalid/dead targets, discussion limits and no post-death turns. Use sentinel private facts in projection tests to show that wolf knowledge, investigations, rationale and unrevealed roles never cross into another seat's request or public events. Model claims may be lies; they do not become authoritative engine facts.

## Phase 2: Durable execution and interim limits

- [x] Add versioned game state and turn metadata without changing the legacy spike table contract. Old rooms continue through the existing spike path; new starts explicitly select the Werewolf rules version. Keep migrations additive and test a legacy room through the upgrade.
- [x] Store authoritative state, exact request, actor, phase, sequence, output, rationale, usage metadata and attempt ledger. Persist request and reservation before sending. Commit accepted output, next state, next turn pointer and public events in one transaction; schedule the successor alarm as part of the durable transition.
- [x] Execute at most one model call per alarm. Persist resolved non-model transitions and generated tie choices before yielding. Guard against reentrant/stale alarm results with the expected turn/status; terminal state cannot be overwritten by a late result.
- [x] Keep the existing timeout (30 seconds), quiet period (45 seconds) and maximum three attempts as initial limits. Bound each fetch by the remaining game deadline too. On resume, exhausted attempts, deadline, input overflow or invariant failure ends the game as aborted with a public reason and no fabricated winner.
- [x] Persist `deadlineAt` (45 minutes after start), and always schedule a wake no later than the deadline. Check it before each call and when accepting a response. Repair missing successor alarms on recovery paths; terminal states never schedule another paid turn.
- [x] Trim the provider credential and reject missing credentials before starting. Keep secrets and private prompts out of application logs.
- [x] Propose a fixed $0.25 safety allowance per game, independent of future S-07 operator budgets. Pin the allowed model and validated input/output rate ceilings, cap output at 256 tokens, and conservatively reserve every outgoing attempt using a safe input bound plus maximum output. Include provider reasoning tokens if applicable; disable models for which the bound cannot be established. Reserve ambiguous attempts permanently rather than assuming a free retry. Fail closed when pricing/configuration is missing. Record actual cost separately; absent usage remains unknown. Rate ceilings must be verified before paid starts are enabled.
- [x] Document that bounded per-game calls do not impose an account-wide ceiling across repeated starts. Keep start submissions idempotent with a persisted client request UUID, so double clicks and HTTP retries return the same room rather than creating multiple games. Reject reuse with different settings.

Use workerd tests with the existing LLM seam for successful games, malformed replies, stalls, retry exhaustion, deadline recovery, unknown usage, reservation exhaustion, duplicate starts and duplicate alarms. Reconstruct the room between turns and assert exactly one accepted move/event sequence. Do not claim upstream exactly-once billing: lost replies can still cost money, and every attempt consumes reserved allowance.

## Phase 3: Start and live viewing

- [x] Add gated `POST /api/games/start`, `GET /api/games/:id` and `/api/games/:id/ws` routing before React Router. Validate UUIDs and setup fields; keep the existing spike harness available. Return only a public projection from snapshot APIs. Do not reuse the spike journal response for real games.
- [x] Add a home start form showing fixed composition, configured model and safety limits; expose the one-or-two discussion-pass setting. Disable while submitting and preserve the start UUID across retries. Navigate to `/games/:gameId` after creation; display actionable start errors.
- [x] Add a server-loaded public snapshot and a sequence-cursor WebSocket stream. Replay only events after the snapshot cursor, deduplicate on sequence, detect gaps, and reconnect with bounded backoff. On expired/rotated credentials show a sign-in action instead of endless reconnection. Distinguish connecting, live, reconnecting, finished and aborted.
- [x] Render the living/dead seats, phase/day, statements, vote results, deaths and terminal outcome. Only the finished projection reveals roles. Aborted games explain the reason without implying a winning team.
- [x] Preserve socket fingerprint and age expiry. Add ping/pong liveness detection so a half-open socket cannot show live forever. Keep snapshot and event payloads private-data-free, including reconnect backlog and errors.

Verify authentication on every new surface, empty/nonexistent room handling, snapshot/replay handoff, disconnect/reconnect without missing or duplicate events, terminal rendering, and absence of hidden data in serialized loader and socket payloads. Read the repository React Router skill before implementing route modules.

## Phase 4: Checks and production evidence

- [x] Run `npm test`, `npm run typecheck` and `npm run build`; fix relevant failures. Update README with setup, safety bounds, failure semantics and live-game drill instructions.
- [x] Check migrations against a pre-change spike room and a new real game. Keep exports/bindings compatible and generated Cloudflare types current.
- [ ] Record one deployed paid game from start to winner and complete role reveal after pricing and credential prerequisites are met. Record a safe simulated failure/abort drill and a reconnect/eviction drill. Use existing credentials through the supported secret flow; never print them.
- [ ] Measure live delivery with a single-clock test harness around commit/broadcast and receipt; do not subtract the browser clock from server timestamps (the spike found clock skew). Demonstrate delivery within two seconds for connected viewers, separately from model latency and historical replay.
- [x] Record findings and remaining limitations in this change folder. Mark S-02 done only after its implementation and deployed acceptance evidence are complete.

## Deferred work and open decisions

S-03 owns durable external archive and reasoning inspection. S-04 owns role visibility controls; S-05 owns table composition and additional roles; S-06 owns mixed models/personas; S-07 owns estimates, operator budgets and the in-DO retry-cache drill. Keep SQL turn provenance useful for those slices without adding their UI now.

The user authorized planning and implementation on 2026-10-29; the proposed defaults are implemented. No 10x workflow or delegated review was invoked. Local verification is recorded in `verification.md`; deployed paid-game and latency acceptance remain open.
