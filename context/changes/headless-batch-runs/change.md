---
change_id: headless-batch-runs
title: Run a spend-capped batch of headless games, with setups repeated or models rotated across roles, and review results aggregated across the batch
status: implementing
created: 2026-11-14
updated: 2026-11-14
archived_at: null
---

## Notes

Roadmap S-09 (US-02; FR-016, FR-003 rotation mode, FR-014 batch limit). Prerequisites S-07 (in progress: phases 1–3 merged, production checks pending, the operator reviews them separately) and S-08 (done).

Planned before S-07 was closed. The batch escrow relies on S-07's per-game ledger holding in production, so S-07's Phase 4 drills should pass before this change's Phase 4 runs real batches.

Decisions made in planning (2026-11-14), all the recommended option:
- Up to 3 games run at once.
- The batch limit is enforced by reserving a slice of it for each game when it starts (escrow), not by a shared ledger checked every turn.
- Batches start from a web page; the same JSON API works with the Bearer key, and there is no dedicated CLI script.
- Rotation means exact role balance per model (±1).
- Two modes: repeat a setup template, or rotate over a pool.
- Cancel aborts running games; start failures are retried; games aborted mid-way are kept and not replaced.
- 2–20 games, batch limit $0.10–$20 (default $5), per-game limit $0.05–$5 (default $1).
- The results page shows progress, every slot and the batch-filtered metrics. Batch games are hidden from home's recent list.
- Production check: two small drills.
