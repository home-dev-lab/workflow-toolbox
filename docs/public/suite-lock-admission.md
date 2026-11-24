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
youngest within that priority. Release-priority work is protected unless it is
the sole holder. An outstanding stop prevents another selection.

The owning launcher stops only its own detached command group: TERM, then KILL
after five seconds, with five further seconds to confirm completion. Capacity
is retained until completion is confirmed. A `memory-pressure` release ends
that attempt; a fresh lease retries the same ticket with its original rank.
Stop errors retain capacity, including errors emitted before the stop promise
settles; they are never treated as confirmation.

Watchdog loss or unknown memory measurement closes admission and causes managed
clients to stop their own groups. These failures are not automatically retried.
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

## Child environment

The lock-owned child receives:

- `WT_SUITE_LEASE_MODE`: `exclusive` or `reservation`.
- `WT_SUITE_LEASE_RESERVATION`: JSON containing `cores`, `memMiB`, `mode` and
  `basis` for a resource lease; `null` for a compatibility exclusive lease.

These values describe the granted lease, rather than the requested label.
