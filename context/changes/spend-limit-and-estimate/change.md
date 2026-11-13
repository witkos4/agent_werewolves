---
change_id: spend-limit-and-estimate
title: See a game's estimated cost before starting, set a spend limit, and have an over-budget game end and be archived as aborted
status: planning
created: 2026-11-14
updated: 2026-11-14
archived_at: null
---

## Notes

Roadmap S-07 (FR-014; NFR "Spend never overshoots"; guardrail "LLM spend stays capped"). Unblocked by S-03. Must land before S-09 (batches).

Open for the operator, in plan.md:
- The roadmap's blocking unknown (whether an in-DO retry gets a free cache HIT) is dissolved by design, not by a drill: the ledger charges every unsettled attempt its full worst-case allowance, so the guarantee holds whether or not a retry is free. Confirm downgrading it to non-blocking.
- Pricing source for the estimate: archive history (cost per turn per model), not a price table. Confirm.
- Limit bounds: default $1.00 (today's fixed `SAFETY_USD`), min $0.05, max $5.00.
