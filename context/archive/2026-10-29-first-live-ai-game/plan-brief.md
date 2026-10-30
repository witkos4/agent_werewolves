# First Live AI Game — Plan Brief

## Outcome

The signed-in operator starts a fixed table and watches night actions, discussion, votes and deaths live until a team wins. All roles are revealed at completion. This delivers roadmap S-02 and the first thin path through FR-005, FR-006 and FR-007.

## Proposed defaults

- Five seats: one Werewolf, one Seer, three Villagers; roles shuffled once and persisted.
- Existing OpenRouter gateway and configured `google/gemini-3.1-flash-lite` model for every seat.
- Night first; Seer investigates before the wolf kill resolves. Dead players take no further turns.
- One discussion pass per day by default, adjustable to one or two before starting. Every living seat then casts one public vote; no self-votes or abstentions.
- Tied day votes eliminate one tied player using a persisted random choice. Village wins when no wolves remain; wolves win at parity with the surviving village.
- Roles stay hidden in live spectator data; ordinary deaths do not reveal roles. Completion reveals every role. Role visibility controls belong to S-04.
- Maximum 45 minutes and four day eliminations. With one wolf and mandatory elimination this table reaches a winner; infrastructure/provider failures instead produce an explicit abort.

## Approach

Build a pure game state machine and an explicit per-seat information projection. Reuse the Durable Object alarm, SQL journal, LLM seam and WebSocket replay patterns. Keep the deployed `GameRoom` class and old spike rooms compatible. Persist requests before calls and commit results, state transitions and public events atomically.

## Delivery order

1. Pure rules, information boundaries and structured output validation.
2. Versioned SQL state, alarm-driven game turns and failure limits.
3. Gated start endpoint and live viewer, including reconnect and terminal states.
4. Automated checks, runbook and a separately recorded production game drill.

## Spend protection

Bound attempts, context, output and duration. Reserve a conservative per-attempt dollar allowance before sending, including retries and unknown outcomes; stop when the fixed safety allowance is exhausted. Validate the configured model's rate ceiling before enabling paid starts. This is an interim safety mechanism; S-07 still owns operator estimates, configurable budgets and the production cache retry proof.

## Scope boundary

Custom tables, mixed models, personalities, role toggles, archive integration, reasoning inspection and metrics stay with their later roadmap slices. Store turn provenance now without exposing private data in the viewer.

See [plan.md](plan.md) for implementation and verification details.
