# Resource reservation admission

Opted-in non-interactive POSIX commands launched by `wt-suite-lock run -- <command>` can share
the main queue when their class-specific resource reservations fit. There is no job-count limit.
The existing release, project precedence, priority, size bonus, project turn,
FIFO, and bounded light-pass ordering still ranks the queue.

## Explicit switch

Reservation admission is **off by default**. Enable it with
`WT_SUITE_LOCK_ADMISSION=reservation` or the marker file
`<lock root>/admission-reservation.enabled`. `WT_SUITE_LOCK_ADMISSION=exclusive`
overrides the marker. Other values produce one warning and are treated as unset,
so the marker still applies. With the switch off, acquisition and release use the
legacy exclusive path: no reservation state, compatibility fence, writer section
or watchdog is created. Phase-one measurement journalling continues.

## Workload identity

Supply `run --job-class <name> -- <command>` or `WT_SUITE_LOCK_JOB_CLASS=<name>`;
the flag wins. A name matches `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`. An invalid name
produces one warning and is ignored. Choose one class for **one repository plus
one command with a stable footprint**, for example `myrepo:unit-tests`. Different
workloads need different classes even when they use the same launcher or wrapper.

Request and release journal rows carry `jobClass`. Admission history is keyed
only by this explicit class. The argv-derived `cmd` category (`typecheck`, `lint`,
`quality`, `test`, or `other`) remains a display and measurement-catalogue label;
it never trains admission for an unrelated workload. A command replacement keeps
the explicit class; callers must preserve that class's workload contract.
The command's environment has `WT_SUITE_LOCK_JOB_CLASS` removed, so nested runs
cannot accidentally inherit their ancestor's class.

Without a class, or without qualifying class history, **heavy and light jobs
both run exclusively**, with basis `declared`. Direct one-file light runs still
take no ticket and are outside reservation accounting.

## Qualifying history and reservation

Use the class's latest ten release rows carrying a resources record, in terminal
append order rather than request or wall-clock order. Nonzero and unknown exits
are ignored for training, including memory stops, signals and launcher-death
reconciliation. They still occupy positions in that ten-row window.

A successful row is trainable when its CPU and memory peaks are finite and its
resources have no unknown reason. A successful incomplete or malformed resources
record is disqualifying. After ignoring unsuccessful exits, the latest **three**
rows must all be trainable to establish basis `measured`. A newer successful
incomplete observation revokes old measured status until three complete successes
follow it. Releases without a resources record do not enter the window.

The reservation is the maximum CPU peak and maximum memory peak across all
trainable rows in that window, each multiplied by **1.25**. Values remain at full
precision for admission and sums; only display rounds them. If the result exceeds
the nominal online CPU count or total memory minus the floor, its basis becomes
`measured-oversize` and it runs exclusively. It remains runnable alone rather
than blocking the queue with an impossible shared reservation.

A red run with positive overlap, together with a passing run whose recorded
overlap list is empty, marks that same class timing-sensitive, with exclusive
basis `timing-history`. Missing overlap data does not prove that a run was alone.
Every reservation release records overlapping lease IDs and their durations.

## Capacity and fit

CPU capacity is the online logical CPU count, with no over-booking factor.
A shared candidate must satisfy every condition:

- Holder core reservations plus its cores do not exceed online CPUs.
- One-minute load plus its cores does not exceed online CPUs.
- Holder memory reservations plus its memory do not exceed effective available
  memory minus the larger of 1 GiB and 10% of total memory.
- The grant's required machine readings and watchdog heartbeat are fresh.

Running memory is deliberately counted twice: it lowers available memory and is
also reserved. CPU overload pauses shared admission and stops nothing. An
exclusive candidate needs only an empty holder set, regardless of load or missing
readings. Missing or stale readings make a shared candidate exclusive for that
poll, rather than leaving it waiting indefinitely for a sensor.

The highest-ranked fitting ticket starts first. A ticket that cannot fit can be
passed by fitting lower-ranked tickets at most eight times, then admission
drains capacity for it. The bypass count survives an empty holder set.

## Memory stops and retries

One elected watchdog samples memory every second. **Only a fresh memory reading
strictly below the floor can stop a job.** CPU overload, an unknown reading,
unreadable reservation state, watchdog loss and stale supervision stop nothing.
The launcher keeps running, emits a supervision diagnostic once, and helps elect
a replacement. The watchdog marks one non-release holder first, then the lowest
frozen admission priority, then the youngest admission sequence. A missing
sequence falls back to the admission timestamp; missing both counts as oldest.
For a mixed legacy family, timestamp comparison applies across the family so
the ordering remains transitive; fully sequenced families use admission order.
The lease ID breaks remaining ties. If all holders have release priority, they
remain eligible for memory relief.

A stop request has a 20-second deadline. No second victim is chosen while an
unabandoned request is outstanding. A proven-dead launcher is reconciled on the
next writer entry; an expired request is abandoned and retains its capacity until
release or dead-launcher reconciliation. After confirmed release of a memory
victim, the watchdog waits five seconds and requires a fresh reading taken after
confirmation before selecting another victim. Abandonment never signals a job.

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

Watchdog identity includes its PID namespace and process start time. Waiting
clients and holder launchers replace a proven-dead watchdog or one whose
heartbeat is more than 15 seconds old. A slow supervisor is never signalled;
after resuming it sees the new recorded identity and exits. A foreign PID alone
is not evidence of death. Unknown readings are visible in `status --json` and
the lock root's `watchdog.log`.

### Machine readings and sharing freshness

Linux uses `MemAvailable`. WSL is detected by the interop marker or a kernel
release containing `microsoft`. Its effective available memory is the minimum
of Linux `MemAvailable` and a fresh Windows free-physical-memory sample. Only
the elected watchdog owns the PowerShell reader: one non-interactive child
prints `Win32_OperatingSystem.FreePhysicalMemory` in KiB every two seconds for
150 iterations, then is respawned. Partial lines are buffered; malformed lines
do not refresh a sample. Ten seconds without a valid line makes Windows memory
unknown. The reader is function-injected in tests; no environment variable
replaces a machine reading.

Shared admission checks a heartbeat at most five seconds old, a WSL Windows
sample at most ten seconds old, and Linux memory read inside the writer section
immediately before publication. Cold start and missing or stale sensors fall
back to an exclusive grant for that poll: one job can run when no holder exists;
with a holder, admission waits. Sensor failure does not strand an empty queue.
For stopping, absent Windows data leaves Linux memory as the sole decision
source. A failed Linux/macOS reading produces a named unknown and stops nothing.

CPU capacity is exactly the online logical CPU count. The floor is the larger
of 1 GiB and 10% of total memory. The end-to-end-only
`WT_SUITE_LOCK_TEST_FLOOR_MIB` seam may raise it; a lower or invalid value is
ignored with a warning. Stops under the seam record `floorOverrideMiB` in the
request and terminal journal row. macOS retains free, inactive and speculative
pages from a bounded `vm_stat` call and its reported page size, without rounding.
An incomplete census is `machine-source-unavailable`, not a free-only estimate.

| Platform | Memory and process dependencies | Failure behavior |
| --- | --- | --- |
| Linux | `/proc/meminfo`, logical CPU count, load average, PID/start/namespace identity | Unavailable readings become named unknowns; shared admission falls back to exclusive and no job stops. |
| WSL | Linux dependencies plus one watchdog-owned PowerShell stream | Fresh samples use the lower memory value; unavailable Windows data blocks sharing but Linux still governs memory stops. |
| macOS | Bounded `/usr/bin/vm_stat`, logical CPU count and load average | Missing or incomplete output becomes a named unknown; exclusive fallback and no automatic stop. |
| Windows Node platform | Reservation memory/load monitoring unsupported | Uses the exclusive protocol; the machine reader returns `unsupported-platform-memory-and-load`. |

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

Reservations live outside `lock.d`; a missing fence does not erase capacity.
Both `reclaim.d` and `reservation-write.d` record PID, process start and namespace.
Any client can reclaim a proven-dead writer. A directory without a readable
owner becomes reclaimable after ten seconds. Reclaim renames it to a unique
tombstone; only the successful renamer removes it and attempts entry. A readable
live owner is never reclaimed based on age. Immutable, uniquely named intent
records serialize section entry and reclamation: a reclaimer cannot rename a
replacement writer after inspecting an older directory. Intents are atomically
published, retained through the section, and removed only by their owner or a
client proving that owner dead. An interrupted unpublished intent temporary
file does not participate in election. State publication is temporary-file
plus atomic rename, so interruption leaves the old or new complete state.

Every reservation writer entry first reconciles proven-dead holder launchers,
removes their stops and capacity, and journals `exit: null`, `cause:
launcher-dead`. Empty compatibility fences are removed. Release retries a busy
writer with bounded backoff for up to 60 seconds. At timeout the launcher keeps
its command exit code; its eventual death lets another writer reconcile it.

### Stop/requeue crash boundaries

The original launcher owns the retry, including its execution environment and
exit recipient. The watchdog only publishes a stop request; it never takes over
execution. Another waiter cannot inherit a crashed launcher's command.

| Crash point | Durable state and ownership | Recovery |
| --- | --- | --- |
| Waiter before grant | Only its queued ticket exists. | Normal queue liveness reaps a proven-dead ticket on a subsequent poll. No command is replayed. |
| Launcher after grant, before spawn | Capacity and fences exist, but no command has started. | Next watchdog/client writer entry removes the proven-dead launcher and journals an unknown release. |
| Launcher after spawn | Detached descendants may still exist. | Next writer entry reconciles a proven-dead launcher. Descendants are not adopted or replayed. |
| Watchdog dies | Holders and commands keep running. | Holder launchers or waiters re-elect on their next poll, normally within one second. |
| Watchdog is paused or slow | Its heartbeat ages; commands keep running. | Sharing falls back to exclusive after five seconds; election may supersede it after 15 seconds, without signalling it. |
| While writing an unpublished intent temporary file | No intent participates in section entry yet. | The temporary file is ignored; the next client proceeds normally. |
| After intent rename, before directory creation, or after directory removal | One immutable intent still names the launcher. | Next entry proves the owner dead and removes that unique record; it cannot remove a replacement intent. |
| After writer-directory creation, before owner publication | Directory exists without a readable owner. | Any client reclaims after ten seconds, on its next entry attempt. |
| After writer owner publication, before state temporary write | Old complete state remains. | A contender reclaims immediately after positive owner-death proof and reconciles launchers before its operation. |
| During state temporary write, before rename | Old complete state and an unused temporary file remain. | Same writer reclamation; the temporary file is never treated as state. |
| After atomic state rename, before writer cleanup | New complete state remains behind the writer directory. | Same writer reclamation; reconciliation uses the newly published state. |
| During compatibility-fence creation, before its holder record | An empty main/static `lock.d` may remain. | The existing managed queue reaper uses the legacy empty-lock grace (60 seconds); a completed fence is reused or removed by reservation writers. |
| After stop publication, before signalling | Stop and capacity remain. | A live launcher observes it; a dead launcher is reconciled. A request past its 20-second deadline is abandoned. |
| During TERM/KILL, before completion confirmation | Stop and capacity remain; no retry exists. | No concurrent stop inside the deadline; an unconfirmed group is not released by its live launcher. |
| After completion confirmation, before release | Old holder remains charged. | Live release retries up to 60 seconds; death permits next-entry reconciliation. |
| During retry temporary write, before rename | Old holder remains; unpublished retry is ignored. | Dead-writer reclamation plus launcher reconciliation; no replay. |
| After retry rename, before release terminal or holder removal | Retry ticket has a fresh lease ID and original launcher identity. | Normal queue liveness reaps a dead launcher's retry; writer reconciliation removes old capacity. Terminal de-duplication avoids duplicate releases. |
| After release state publication, before fence removal | No holder may remain, but fences can remain. | Next writer entry/watchdog removes empty fences, normally within one second while supervised. |
| Release writer timeout | Capacity remains; launcher exits with command code. | Next entry after launcher death reconciles the holder. No release failure changes the command result. |
| During retry acquisition or after next grant | Original rank and finite retry counter persist. | Same waiter/launcher recovery; another process never inherits execution. |

These bounds assume another waiter or holder launcher continues polling; without
a client, reconciliation occurs on the next arrival. Reservation state is not a
durable runner that replays commands after launcher death.

Known limits: a descendant that leaves the command group with `setsid` survives
a stop and can overlap its retry. Direct one-file light runs take no ticket and
are outside accounting. Running memory is counted both against availability and
as reserved memory, conservatively. Victim priority is frozen at admission.

## Queue reservations

`wt-suite-lock status` reports whether the switch is on and its source
(`environment`, `marker` or `default`). It lists each waiting and running job's
class (or `none`), mode, reservation and basis, plus the sum of running reservations.
`status --json` includes this view under `admission` (`enabled`, `source`, `running`,
`waiting`, `totals`), and `jobClass` on queue entries. Unknown legacy reservation
amounts are shown as unknown rather than invented zero budgets.

`status --json` includes a `reservation` on every managed queue entry, with
unrounded `cores`, `memMiB`, `mode` and `basis`. These are recomputed from the
same class-specific qualifying history and current machine budget used by admission; a
waiting ticket's footprint can change as new history completes. Unknown host
readings appear as a named `reservation.unknown`, without invented zero values.
Text status labels shareable heavy waiters `reserved` and appends, for example,
`reservation 1.25 cores, 125.00 MiB (measured)` to a measured waiter, and marks
whole-budget reservations `exclusive`. Running reservations remain available
under `reservations.holders` in JSON. Only text rendering rounds values.

## Child environment

Only a managed client's command receives:

- `WT_SUITE_LEASE_MODE`: `exclusive` or `reservation`.
- `WT_SUITE_LEASE_RESERVATION`: JSON containing `cores`, `memMiB`, `mode` and
  `basis` for its granted managed lease.
- In reservation mode only, `WT_SUITE_LEASE_RESERVATION_CORES` and
  `WT_SUITE_LEASE_RESERVATION_MEM_MIB`: positive integer ceilings of the raw
  reservation values, with a minimum of one. Exclusive mode omits both.

These values describe the granted lease, rather than the requested label.
Unmanaged commands receive none of these variables; inherited values are removed
before the command is spawned.
