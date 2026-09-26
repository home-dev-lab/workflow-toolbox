# Reporting — monitor at act

Three roles keep this from recurring when combined — confusing them is exactly how one ends up
building two alarms while believing an engine was built:

| Role | What it does | What it does NOT do |
|---|---|---|
| re-paces itself, hands control back on its own, unprompted | resumes stopped work without anyone asking | only exists while the process running it exists — can't outlive that |
| watches delegated work, raises an alarm if it stalls | catches a delegate that has frozen | nothing, IF its alarm can't reach an idle session — see below |
| makes an unexplained stop loud instead of silent | turns a silent stop into a visible one | can't force further work to happen |

Third row has inherent limit: a check blocking every stop unconditionally would deadlock work it
protects, so it can object once, then must let turn proceed regardless — exactly why it can't
substitute for first row.

**Second row's limit is NOT inherent — depends on a property of your harness, worth measuring,
not assuming.** Question: watcher emits while session is IDLE (turn ended, nothing pending) —
does session get a turn? If yes, watcher IS engine in practice — hands control back, session
resumes delegate, no self-paced loop needed. If no, alarm reaches nobody until human speaks —
only first row can restart anything.

Cheap measurement, readable both outcomes: arm a watcher emitting once after a short delay AND
writing a timestamped marker to disk, then deliberately end turn. A turn arriving on its own
proves delivery; none arriving still leaves marker, proving watcher fired and isolating failure
to delivery rather than emission. Without marker the two are indistinguishable.

Where harness delivers, sufficient shape for long autonomous work is a **delegate that advances
on its own** plus a **watcher on its liveness** — not a loop. Also cheaper: a loop hands
coordinator a turn on fixed cadence whether or not anything happened, and each turn re-reads its
whole accumulated context; watcher only costs a turn when something actually changed. Assumes
delegate can be RESUMED, not recreated — verify that too: on many harnesses a "stopped" delegate
merely ran out of active work and resumes, context intact, on next message addressed to it.
