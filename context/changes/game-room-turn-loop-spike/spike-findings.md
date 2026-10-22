# Spike findings: game-room turn loop (F-02)

Drills run against production (`https://agent-werewolves.witkos4.workers.dev`) on 2026-10-22, 20:13–20:53 UTC, model `google/gemini-3.1-flash-lite`. Evidence comes from `wrangler tail` JSON logs (`game_room_constructed` and `turn_attempt` lines), the `/turns` journal, and OpenRouter response headers and generation records. Total spend across all drills was about $0.001.

## Summary

| Drill | Result |
|---|---|
| 4.1 PR run: `check` passes, `deploy` skipped | Pass (run 39842503400) |
| 4.2 `main` run succeeds end to end | Pass (run 39842677863) |
| 4.3 Production guards return 404 without the key | Pass |
| 4.4 Eviction | Pass |
| 4.5 Redeploy between turns | Pass |
| 4.6 Redeploy mid-call | Not reproducible: a deploy does not interrupt an in-flight alarm. Each turn was billed once |
| 4.7 Re-bill | Inconclusive from outside the Worker. The cache works, but a resend from a laptop misses entries the Worker wrote |
| 4.8 Viewer across redeploy | Pass |

## Setup problems found before the drills

- **`SPIKE_KEY` mismatch.** The production value differed from `.dev.vars`, so every keyed request got 404. Fixed by uploading the `.dev.vars` value. One key now works in both places.
- **`OPENROUTER_API_KEY` had a stray character** (probably a pasted newline). Every call failed before leaving the Worker with `network: TypeError: Invalid header value.`, and game `06f660b5` aborted with `attempts_exhausted` after 3 attempts. Fixed by re-uploading the key with `printf '%s' … | wrangler secret put`. The abort path worked as designed: the game ended in bounded time and nothing was billed.

## 4.4 Eviction

Game `ede9abe5-36d4-4140-96f1-bb2e951a430b`, `delayMs: 150000`, observed through `wrangler tail` only, with no `/turns` polling to keep the object awake. Version `f501d683` throughout.

```
20:41:50 game_room_constructed
20:41:50 turn_attempt turn 1 attempt 1 ok
20:44:21 game_room_constructed
20:44:21 turn_attempt turn 2 attempt 1 ok
20:46:52 game_room_constructed
20:46:52 turn_attempt turn 3 attempt 1 ok
```

A fresh `GameRoom` was constructed before turns 2 and 3. The game finished with each turn `done` on its first attempt, and turns 2 and 3 continue turn 1's story. **Pass.**

## 4.5 Redeploy between turns

Game `88881ba8-0a8b-490e-8e10-557f2be7199d`, `delayMs: 60000`. `wrangler deploy` ran from 20:30:15 to 20:30:42, between turns 1 and 2.

```
20:30:13 087b6e59 game_room_constructed
20:30:13 087b6e59 turn_attempt turn 1 ok
20:30:53 b40a6ab2 game_room_constructed
20:31:14 b40a6ab2 turn_attempt turn 2 ok
20:32:15 b40a6ab2 turn_attempt turn 3 ok
```

Turn 1 ran on the old version and turns 2 and 3 on the new one. Every turn was `done` on its first attempt, and the story chains across the deploy. **Pass.**

## 4.6 Redeploy mid-call

The plan was to deploy during a turn's `holdMs` pause, so the attempt dies before or during the OpenRouter call and is re-sent after the 45 s quiet period. That interruption never happened.

- **Game `103ee9eb-bfdc-4b35-a623-c4fd6476dbab`** (`holdMs: 30000`): turn 2's alarm started at about 20:33:18, and the deploy of `5341dcf9` finished at 20:33:31, inside the hold. Turn 2 completed on the **old** version `b40a6ab2` at 20:33:47 with attempt 1. Turn 3 also ran on `b40a6ab2` at 20:34:23, 52 s after the deploy. The drill was polling `/turns` every 1–5 s, and those requests kept being routed to the still-busy old instance.
- **Game `60b2b587-efab-4b46-97ed-329a669f04b3`** (`holdMs: 60000`, no polling after the deploy): turn 3's alarm started at 20:37:17 on `5341dcf9`, and the deploy of `f501d683` finished at 20:37:25. The alarm finished its 60 s hold and the call on the old version, with attempt 1 `ok`.

**Finding:** Cloudflare lets an in-flight Durable Object alarm run to completion on the old code after a deploy (at least 60 s plus the call). Requests that arrive while it is still busy also reach the old instance. A deploy is therefore not a way to produce a lost-reply retry, and in practice deploys are much less dangerous to a running turn than the pre-mortem assumed. The quiet-period and re-send path is covered only by the workerd tests (1.6, 1.7). Each turn was billed exactly once (journal: `attempts=1` on every turn).

## 4.7 Re-bill

The `request_body` values come from game `2a0563a1-c400-498d-a632-fe510cfbe1ce`.

| Request | Sent from | `X-OpenRouter-Cache-Status` | Cost |
|---|---|---|---|
| Turn 2 body, 1st resend | laptop (curl) | MISS | $0.000052 |
| Turn 2 body, 2nd resend | laptop (curl) | HIT (source `gen-1792700925-…`, the 1st resend) | $0 |
| Turn 3 body, with the Worker's exact headers incl. `X-Title` | laptop (curl) | MISS | $0.0000595 |

The same API key was used throughout. It was re-uploaded to production before game `2a0563a1` started.

**Finding:** OpenRouter's cache works (laptop to laptop is a HIT), but a laptop resend does not see the entry the Worker wrote. The cache key is documented as API key + model + endpoint + streaming + body, with attribution headers excluded, and entries are "stored in edge infrastructure". The likely explanation is that cache entries are local to an edge location. This fits Phase 2's local pass (2.6), where both requests came from the same machine. It is not a problem for the product as long as a Durable Object's retry leaves from the same location as the first attempt, which is the usual case because a DO stays put. That has **not** been proven in production. Proving it needs a drill-only route that re-sends a finished turn's stored body from inside `GameRoom`. Until then, treat "a retried turn is never re-billed" as unverified in production.

## 4.8 Viewer across redeploy

Game `d6bfee87-ea3d-4f53-bd67-7025986342e4`, `delayMs: 60000`. The operator opened `/spike/<gameId>` after turn 1, and `wrangler deploy` (`1e7bb36a`) ran from 20:50:23 to 20:50:38, between turns 1 (20:49:46) and 2 (20:50:47).

The page ended showing turns 1, 2 and 3 exactly once each. The badge was green (`live`). Turn 3 ran on `1e7bb36a`. The reported delays were 16.2 s for turn 1 (backlog: the page was opened about 16 s after the commit), then **−2.4 s** for turns 2 and 3. **Pass.**

**Finding:** "received N s after commit" subtracts the server's `createdAt` from the browser's clock, so clock skew dominates it. Here the operator's clock ran at least 2.4 s behind. The live deliveries were effectively instant, but this number cannot show it.

## Implications for S-02

- **The turn-per-alarm design holds in production.** Evictions and deploys between turns are invisible to the game. S-02 can build a 45-minute game as a chain of alarms.
- **Old and new code overlap.** After a deploy, an in-flight alarm, and any request that reaches the busy instance, runs the old code. Changes to the game schema or event format must stay readable by both the previous and the next version (the `schema_version` migrations already assume this).
- **Re-billing is unproven in production.** Before S-07 relies on "spend never overshoots", add a drill-only in-DO resend (or log `X-OpenRouter-Cache-Status` on every retry) to prove that Worker retries are cache HITs.
- **Trim secrets in code.** Read `OPENROUTER_API_KEY` with `.trim()`, and fail fast at start with a clear error instead of three retries of `Invalid header value`.
- **Viewer latency needs one clock.** Have the server stamp send time, or measure from socket receive alone, if S-02 wants to show live-ness. Skew made today's number meaningless.
- **There is no heartbeat.** The badge showed `live` throughout, which was correct today. A half-open socket would also show `live` forever. Consider a ping or idle timeout in S-02's viewer.
- **For S-07 cost estimates:** a 3-turn story turn costs about $0.00005–0.00008 on `gemini-3.1-flash-lite`, with 0.6–1.0 s latency.
