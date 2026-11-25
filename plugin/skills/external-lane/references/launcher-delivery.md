# Launcher delivery operations

Read this when operating or diagnosing delegate launcher routing. The launch and
bounded background-wait commands remain in [the skill](../SKILL.md).

Events are individual files under `wt-launcher-events/<id>/pending/` beside the
lane host-state root, created mode 0600 in private directories (on Windows, access follows the owner's
state-directory ACL). Live delegate events stay out of main's watcher output.
For an unconsumed event, if liveness says `complete:true`, main receives
`orphaned-launcher=<id>` immediately; consumed events are never echoed to main.
An absent liveness file gets a 120-second grace from its first observed absence.
The main watcher revisits pending lane exits even if their lane record disappears.
Even with live liveness, an event unconsumed for 57 minutes (one 55-minute waiter plus
the 120-second grace) falls back to main. Keep re-arming the waiter on expiry.
An orphan delivered to main is acknowledged separately from the historical notice
archive, so archive eviction cannot hide a pending event or replay a handled one.
An unreadable liveness file triggers a named routing diagnostic and main fallback.
A failed publication reports `launcher-publish-failed` and is retried from the lane record;
readers and sweeps also finish complete reserved sources after that record ages out.

Publishers write complete private temporary files with exclusive creation, then publish
with a hard link that never overwrites an existing name. No publisher waits on a reader.
Readers serialize on one populated writer directory per launcher, with PID and start
identity ownership. Only positive process-death or comparable PID-reuse evidence permits
reclaim; unknown ownership is retained. Publishers never take that reader lease. Events
remain pending while one append-only `delivery.journal` records claim, printed and done.
Length/checksum-framed records are synchronously appended and fsync'd. Both recipients
complete synchronous stdout before recording printed; only a complete printed record
authorizes acknowledgement. Unreadable evidence retains the claim for retry. A torn tail
is truncated to its validated prefix and reported as `launcher-journal-torn-tail-retained`;
that invocation does no delivery or acknowledgement, and the next invocation retries.

See the [delivery design note](launcher-event-delivery.md) for the full protocol and
proof limits, including replay and durability boundaries.
