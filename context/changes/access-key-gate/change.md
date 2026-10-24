---
change_id: access-key-gate
title: Access key gate
status: implementing
created: 2026-10-22
updated: 2026-10-24
archived_at: null
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

- 2026-10-24 rotation drill (3.6): contrary to the plan, a viewer socket opened with the old key stayed `live` after `wrangler secret put ACCESS_KEY`. The game room restarted on the new version at its next alarm, but its hibernated WebSockets stayed connected and kept receiving events. Fix: `GameRoom` tags each socket with `keyFingerprint` (attachment) and closes mismatched sockets with code 4001 on construction and before every broadcast. Shipped as a follow-up PR, then the drill was re-run.
- 2026-10-24 re-drill after #11: the room did not restart at all. Turns 2-3 ran on the pre-rotation version with the old key, so the fingerprint check never fired and the viewer stayed `live` until the game finished. A running room keeps its version for an unpredictable time. Fix: viewer sockets older than `tuning.maxSocketAgeMs` (2 min) are closed (code 4002) before each broadcast and reconnect through the gate. The fingerprint check stays for the restart case. `wrangler secret list` kept showing `SPIKE_KEY` after the delete; `wrangler versions secret list` showed the live version has only `ACCESS_KEY` and `OPENROUTER_API_KEY`.
