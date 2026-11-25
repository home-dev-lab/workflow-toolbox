# Launcher event delivery journal

Lane-exit notifications have two recipients: a delegate's launcher waiter and main's
orphan-event fallback. Both use the same delivery journal. This note describes its
normal protocol, failure model, and the boundaries of its regression tests.

## Delivery and recovery

Publishers create complete private staging files exclusively and reserve an event
key with a hard link. A complete reserved source is renamed into `pending/`.
Publishers do not take the reader's lease, so a blocked recipient does not prevent
publication. A retained staging link preserves the event identity through delivery.

Readers serialize through one populated `delivery.writer` directory per launcher.
Each incarnation has a random owner-token filename, PID and process-start identity.
A reaper needs positive death or comparable PID-reuse evidence; unknown ownership
is retained. It removes only the token it observed. A replacement's different token
keeps a stale reaper from removing that populated directory. These are cooperating
process ownership checks in private storage, not authentication against another
process with the owner's filesystem rights.

The writer opens `delivery.journal` with no-follow where available, validates that
descriptor as a regular, single-link file, and parses from that same descriptor.
Length/checksum-framed records advance through `claim`, `printed`, and `done`:

1. Append and fsync a claim, leaving the event payload pending.
2. Complete the recipient's synchronous output writer.
3. Append and fsync printed evidence. Only this evidence authorizes acknowledgement.
4. Append and fsync done evidence, then project the payload into `done/`.

Unreadable evidence never authorizes acknowledgement. A torn final frame is
truncated to the validated prefix; that invocation reports the repair and does no
delivery or acknowledgement. Interior corruption is retained and reported. A later
readable invocation retries. Printed appends have three attempts, or four for
Windows sharing failures. Exhaustion reports delivery unknown and retains the claim.
After printed is durable, failed done projection is retried without another output.

## Duplicate model

For one interruption after output completes but before printed evidence is durable,
one subsequent successful retry can produce one extra output. Repeated interruptions
in that same post-output commit window have **no finite total bound** on duplicates.
The same applies to repeated exhausted printed-record commits. This is a per-failed-
commit replay allowance, not an exactly-once or finite-lifetime-duplicate guarantee.
Once a complete printed frame is durable and readable, recovery does not reprint it.

## Compaction and storage

At 64 KiB the writer retains unprojected transactions in a checkpoint named
`delivery.<random-uuid>.next`. It creates that file with `O_CREAT | O_EXCL` and
`O_NOFOLLOW` where available, mode 0600. It never opens an existing checkpoint with
truncation. Even a pre-existing hard link at the selected name causes refusal;
the payload it aliases is untouched, and a later invocation chooses a fresh name.
The old fixed `delivery.next` pathname is not reused.

After writing and fsyncing the checkpoint, the writer closes the old journal,
atomically renames the checkpoint over it, syncs the containing directory where
supported, and reopens the journal. Handled failures clean up the checkpoint owned
by that invocation. A crash before replacement leaves the old journal authoritative;
a crash after replacement leaves the checkpoint as the authoritative journal.
Abandoned checkpoints from process death are never read as delivery evidence or
reused. Their aggregate storage is **not bounded** under repeated crashes; the
implementation does not automatically collect them. The active journal's normal
protocol bound is 65,536 bytes plus three maximum 1,099-byte frames. That bound
excludes abandoned files, pending payloads, and the retained seven-day done history.

## Verification boundaries

The journal regression tests are targeted examples and do not enumerate all schedules.
The concurrent-reader case holds one writer inside output and checks that another
reader cannot print or acknowledge. The dead-owner case pauses two reapers before
unlinking the observed owner token and releases both; their subsequent ordering is
chosen by the scheduler. It does not force every stale-reaper/replacement interleaving.
The token-specific removal protocol explains the intended replacement protection;
the examples alone are not an exhaustive proof of it.

The three compaction crash examples exercise an **empty checkpoint**, because the
preceding completed history has already been projected. They interrupt before
checkpoint fsync, before replacement, and after replacement while a new event stays
pending. They do not prove interruption at every byte of a nonempty retained claim.
Separate tests cover torn journal tails, interior corruption, size bounds, and
pre-existing hard-linked checkpoint aliases. Every checkpoint crash hook recognizes
both the historical fixed name and the unique checkpoint naming family.

SIGKILL is a process-death experiment, **not a power-loss simulation**. File fsync
and process-death recovery apply on Linux, macOS and Windows. Portable Node does not
provide directory fsync on Windows; macOS fsync is not `F_FULLFSYNC`. Hardware,
filesystem and controller durability beyond those operations is not established.
External mutation of private storage is outside the normal crash model; the explicit
exclusive-creation and descriptor checks cover the alias cases described above,
rather than establishing safety against every possible concurrent filesystem edit.
