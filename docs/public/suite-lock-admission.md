# Resource reservation admission

Managed non-interactive POSIX commands launched by `wt-suite-lock run -- <command>` share the
main queue when their resource reservations fit. There is no job-count limit.
The existing release, project precedence, priority, size bonus, project turn,
FIFO, and bounded light-pass ordering still ranks the queue.

## Budget and history

- CPU booking budget: 1.5 times the online CPU parallelism reported by Node.
  These units include the reservation's 25% margin and 20% sampling headroom,
  so a fully CPU-bound historical run still fits its own host. The live load
  threshold remains the online CPU count; CPU pressure stops new admissions.
- Memory budget: currently available memory minus the larger of 1 GiB and 10%
  of total memory. Running reservations are also charged against this budget;
  this deliberately leaves conservative headroom for their current consumption.
- CPU load average above the online CPU count pauses admission. It stops no job.
- A measured reservation uses maximum CPU and RSS peaks from the latest ten
  complete observations, multiplied by 1.25. Completion follows terminal append
  order, rather than request order or wall-clock timestamps. Incomplete or
  malformed samples do not erase an established catalogue. Values remain full
  precision until rendered.
- With fewer than three complete observations, admission preserves the declaration: a heavy command is
  exclusive and reserves the entire budget; a light command reserves one core
  and 512 MiB.
- History uses the existing journal `cmd` identity (`typecheck`, `lint`,
  `quality`, `test`, or `other`). It does not fingerprint arbitrary command lines.

A red completed run with positive overlap, together with a passing run whose
recorded overlap list is empty, marks that identity timing-sensitive. It becomes
exclusive. Missing overlap data is not proof that a historical run was alone.
Every reservation release records overlapping lease IDs and their durations.

The highest-ranked fitting ticket starts first. A ticket that cannot fit can be
passed by fitting lower-ranked tickets at most eight times, then admission
drains capacity for it. The bypass count survives an empty holder set.

## Memory stops and retries

One elected watchdog samples memory every second. When available memory drops
below the floor, it marks one lowest-priority holder for stopping, choosing the
youngest within that priority. Release-priority work is protected while any
non-release holder remains; if all holders have release priority, the youngest
of them is still eligible. An outstanding stop prevents another selection.

The owning launcher stops only its own detached command group: TERM, then KILL
after five seconds, with five further seconds to confirm completion. Capacity
is retained until completion is confirmed. A `memory-pressure` release ends
that attempt; a fresh lease retries the same ticket with its original rank.
Before capacity is released, the launcher atomically republishes the original
ticket number with a fresh lease ID and an incremented `memoryRetries` counter.
It retains the queue timestamp, project, priority, size and original light/P0
counter snapshots. It does not serve a project turn. A polling peer therefore
sees the retry before it can use the freed capacity, subject to the existing
ranking and resource-fit bypass rules.

Automatic memory retries are bounded to **three requeues (four attempts total)**
per invocation, including stops while running alone. On the fourth memory stop,
the launcher confirms command-group completion, releases capacity without a
retry ticket, reports `memory retry limit reached (3 requeues)`, and exits 75.
There is no retry on an operator signal, an unconfirmed stop, or a failed release.
Stop errors retain capacity, including errors emitted before the stop promise
settles; they are never treated as confirmation.

Watchdog loss or unknown memory measurement closes admission and causes managed
clients to stop their own groups. These failures are not automatically retried.
Watchdog identity includes its PID namespace and process start time. A waiter
inside another PID namespace cannot replace a live or unverifiable supervisor
by probing that foreign PID locally; it uses the same positive-death evidence
as queue tickets, without a silence/age timeout.
Unknown readings are visible in `status --json` and the lock root's
`watchdog.log`. CPU overload never selects a victim.
Linux reads `MemAvailable`; macOS reads free, inactive and speculative pages
from a bounded `vm_stat` call, using its reported page size without MiB rounding.
An incomplete census becomes a named unknown rather than a free-only estimate.

## Compatibility and recovery

Non-managed library clients, interactive terminal commands, broker clients, parked commands and separate static
lane requests retain their exclusive/typed protocols. Legacy compatibility
fences in both the main and static domains prevent these clients from
overlapping managed reservations in either direction. Existing static work
drains before reservations begin. Descendants of a typed static lease retain
the legacy main-queue route, so the ancestor can still await its child.
Terminal contexts preserve the existing controlling-terminal and job-control
behavior rather than detaching the command into a new session.
Supervisor warm-up holds no compatibility fence: only an eligible admission
claims the fences, so a lower-ranked client cannot obstruct a legacy queue head.
Windows retains exclusive admission and explicitly reports that the reservation
memory watchdog and load measurement are unavailable.
Explicit zero-wait requests retain the exclusive fail-fast protocol: they try
once without waiting for watchdog warm-up and still respect reservation fences.

The POSIX compatibility record uses the live init identity. It is a fence, not
a command to signal. Actual reservation holders and watchdog state are listed
in `wt-suite-lock status --json`. Operator release refuses that fence.

Reservations live outside `lock.d`. A missing lock directory does not erase
capacity claims. Uncertain holder completion retains its claim. A writer crash
inside the short state-publication section leaves `reservation-write.d` and
closes admission; its owner record and reservation state must be inspected
before operator recovery. Never clear that directory based on age alone.

### Stop/requeue crash boundaries

The original launcher owns the retry, including its execution environment and
exit recipient. The watchdog only publishes a stop request; it never takes over
execution. Another waiter cannot inherit a crashed launcher's command.

| Crash point | Durable state and ownership | Recovery |
| --- | --- | --- |
| Before the stop request is published | Current holder still owns its capacity; no retry exists. | A live watchdog may select again. |
| After the stop request, before signalling | The marked holder still owns capacity. Its launcher owns stopping; no retry exists. | A live launcher observes the request. A dead launcher requires operator confirmation of its command group's termination. |
| During TERM/KILL or before positive completion confirmation | Capacity and the outstanding stop remain; no retry exists. | No second victim is selected. An unconfirmed stop never releases capacity or retries. |
| After completion confirmation, before the release writer section | The old holder is still charged; the launcher still owns the transition. | A crash retains capacity conservatively. Confirm group termination before operator reconciliation. |
| While writing the retry temporary file, before rename | The old holder remains charged; no published retry record exists. | A crashed writer leaves `reservation-write.d`, closing admission. Inspect its identity, state and temporary file; age alone never authorizes cleanup. |
| After retry-record rename, before the old release terminal | A fresh lease ID owns the original queue number, under the same launcher PID/start identity. The old holder remains charged. | The writer fence closes admission if the launcher crashes. Reconcile the confirmed-stopped old holder and the dead launcher's pending retry together; do not execute the retry under another owner. |
| After the old release terminal, before removing the holder from state | The pending retry still belongs to the launcher; old capacity remains charged. | Terminal de-duplication prevents a second release on resumption. A crash still requires writer-fence recovery with group-completion evidence. |
| After state publication, before compatibility-fence cleanup | Capacity has been released; the original-number retry is already visible and owned by the launcher. | The watchdog can remove empty compatibility fences. A dead launcher's retry is reaped by the normal PID/start/heartbeat rules, never reassigned. |
| During reacquisition, before or after refreshing the retry record | Atomic rename preserves the published ticket and fresh lease identity. | The same launcher continues with its original rank. If it dies, normal ticket reclamation applies; no lower-ranked peer wins through a missing-record interval. |
| After the next holder is published | The fresh attempt owns capacity under the new lease ID; its wait record is removed normally. | The same conservative holder-completion rules apply. The persisted retry counter carries the finite bound into the next attempt. |

These transitions deliberately favor retained capacity over guessing that a
crashed owner's detached command group has stopped. Reservation state is not a
durable command runner that replays work after its launcher dies.

## Queue reservations

`status --json` includes a `reservation` on every managed queue entry, with
unrounded `cores`, `memMiB`, `mode` and `basis`. These are recomputed from the
same complete-run history and current machine budget used by admission; a
waiting ticket's footprint can change as new history completes. Unknown host
readings appear as a named `reservation.unknown`, without invented zero values.
Text status labels shareable heavy waiters `reserved` and appends, for example,
`reservation 1.25 cores, 125.00 MiB (measured)` to a measured waiter, and marks
whole-budget reservations `exclusive`. Running reservations remain available
under `reservations.holders` in JSON. Only text rendering rounds values.

## Child environment

The lock-owned child receives:

- `WT_SUITE_LEASE_MODE`: `exclusive` or `reservation`.
- `WT_SUITE_LEASE_RESERVATION`: JSON containing `cores`, `memMiB`, `mode` and
  `basis` for a resource lease; `null` for a compatibility exclusive lease.

These values describe the granted lease, rather than the requested label.
