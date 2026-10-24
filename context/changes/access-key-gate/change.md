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
