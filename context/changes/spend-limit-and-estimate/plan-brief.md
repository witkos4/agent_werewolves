# Spend Limit and Estimate — Plan Brief

## Outcome

Before starting a game, the operator sees its estimated cost, based on archived games, and sets a spend limit (default $1.00). If the next model call could take the game past the limit, the game stops with "spend limit reached" and is archived as aborted. The record shows what the game spent against its limit. This delivers roadmap S-07 (FR-014) and is the spend gate S-09's batches will reuse.

## Proposed defaults

- **The limit is a hard ceiling, not "limit plus one turn".** Before every attempt the room checks `charged + worst-case cost of this attempt ≤ limit`. That is stricter than the NFR allows.
- **A settling ledger replaces the gross reservation.** Each attempt is charged its worst-case allowance (the formula already in `runtime.ts`). A turn that returns a known cost is re-charged at that cost. A failed, timed-out or unknown-cost attempt keeps its full allowance. Worst-case pessimism no longer piles up over a game, so a $1 limit really means about $1 of play.
- **The cache question stops blocking.** Retries are charged as if billed, so a free cache HIT only makes real spend lower than the ledger. No in-DO resend drill is needed.
- **The estimate comes from history:** mean cost per turn per model × mean turns per finished game with the same seat count and discussion passes, with "Random" seats averaged over the pool. It is shown with its game count. A model with no history falls back to the worst case and says so. No price table is maintained.
- **Limit bounds:** $0.05 to $5.00, entered on the start form. The form warns when the estimate exceeds the limit but does not block starting.

## Approach

`charged_usd` sits next to `reserved_usd` in the room's `live_game` row, and `spendLimitUsd` is stored in the `Game` state (rooms from before the change read as $1.00). The start API accepts `spendLimitUsd`, and it takes part in the idempotency check. Migration `0004` archives `spend_limit_usd` and `charged_usd`. The home loader reads the estimate inputs from D1 with one small query, and the form recomputes the estimate in the browser as seats change.

## Delivery order

1. Ledger and limit in the game room, plus the new abort reason. Tested with stubbed costs: a limit hit mid-game, unknown costs, retries, and idempotency.
2. Archive and record: migration `0004`, the record page shows "spent $x of $y".
3. Estimate: the archive query, a pure `estimateCost()`, and the start form (limit input, live estimate, over-limit warning).
4. Production: a game with a $0.05 limit aborts on budget and stays under it (checked against OpenRouter activity), and a normal game is compared with its estimate.

## Scope boundary

Batch-level limits (S-09), live spend in the viewer, maintaining a price table, and changing `SAFETY_USD`'s rate ceilings or the provider `max_price` routing stay out.

See [plan.md](plan.md) for implementation and verification details.
