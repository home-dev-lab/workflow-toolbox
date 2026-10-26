# Operator-configured suite-lock offload

The Linux lane suite-lock broker supports an **operator-configured offload command**.
It is opt-in and disabled by default. Local acquisition keeps its original ticket
while the command runs. The first successful local acquisition or valid offload
completion wins; a fallback keeps waiting locally.

## Host configuration

Set these in the environment of the **host process launching the lane**, before
the broker starts:

- `WT_SUITE_LOCK_OFFLOAD_COMMAND`: absolute path of an executable, spawned directly
  with no arguments and no shell. Unset or empty disables offload.
- `WT_SUITE_LOCK_OFFLOAD_MIN_AHEAD`: positive integer, default `2`. An attempt
  starts once this many live waiting tickets precede the request, excluding the
  request itself and the current holder. There is at most one attempt per request.

Invalid configuration prints `suite-lock offload disabled: <reason>` at broker
startup and leaves local acquisition available. The launcher supplies the trusted
worktree root through broker `--root`; the request cannot supply a root or command.
The broker resolves the requested working directory inside that root. At dispatch
it walks the directory components using pinned, no-follow directory descriptors
and starts the command with that directory as its **inherited working directory**.
A queued directory replaced by a symlink falls back; replacement after dispatch
cannot redirect the inherited directory. Explicit light requests and commands
the broker classifies as light are never offloaded.

Only command-running clients opt in. The broker status reply advertises
`capabilities.offload: 1` when configured (`0` otherwise); the client then sends
`offload: {version: 1, requestId: "...", cwd: "...", laneToken: "..."}` alongside its ordinary
request. Old clients keep executing locally. New clients use the local route when
an old broker lacks the capability or refuses the extra field. Generic consumers
of `acquireSuiteLock` do not opt in: they still require a local lease.

The launcher generates a fresh 256-bit `WT_SUITE_LOCK_LANE_TOKEN` for each
sandbox and supplies it to that lane and its broker. It is an internal bearer
capability, not an operator setting. Offload requests with a missing or different
capability are refused before queueing; it is never forwarded in the command's
JSON input or advertised in status. A manually started broker without a launch
capability disables offload with a named diagnostic. This binds offload consent
to the serving lane; it does not protect against a host process able to inspect
that lane's environment or the launcher's memory. Legacy requests remain local.
Negotiation metadata has a separate bounded wire allowance, preserving the
existing 4096-byte command-request budget.

Before announcing readiness (and before the launcher exposes the lane), the
broker captures the trusted plugin guardian's source into host-only process
memory. Each guardian runs that captured source directly as a Node module;
dispatch never reopens a guardian pathname in the checkout. The guardian imports
only Node built-ins. Editing its original file, replacing it with a symlink, or
renaming another file over it after startup cannot execute lane-written host
code or fabricate an accepted completion. This adds no filesystem mounts or
host-readable paths to the lane. The plugin install must be trusted when the
broker starts; host-selected executable and runtime configuration remain trusted
operator inputs.

## Command protocol, version 1

Stdin contains one JSON object followed by EOF:

```json
{"version":1,"requestId":"request-id","root":"/worktree","cwd":"toolkit","argv":["pnpm","test"],"light":false,"logPath":"/temporary/output.log","deadlineS":2700}
```

`root` is the host launch root, `cwd` is relative to it (`.` for its root), and
`argv` is the original command vector. `logPath` is a broker-created host file;
append the run's output there as it becomes available. `deadlineS` is the integer
run budget in seconds, derived from the host broker's maximum hold bound.

**Filesystem consumption:** use the inherited working directory, or open `.` and
retain that directory descriptor. `root` and `cwd` are provenance labels; do not
reopen their concatenated pathname or change directory to it, because the lane
can replace it after dispatch. A snapshotter must also enforce containment at
each subsequent filesystem access (including symlink traversal); a preflight
`realpath` check alone is insufficient. The broker cannot constrain a trusted
operator executable that disregards this consumption contract.

The **last stdout line** must be exactly one of:

```json
{"outcome":"completed","exit":0,"archive":"archive-id","snapshot":"snapshot-id"}
{"outcome":"fallback","reason":"execution unavailable"}
```

An exit must be an integer from 0 through 255; archive and snapshot identifiers
must be nonempty, bounded, single-line identifiers (letters, digits and
`._:/@+-`). Earlier stdout lines are not test output. A missing or malformed last
line, invalid outcome, spawn failure, oversized stdout line, or expired deadline
produces a named fallback. A nonzero command-process exit without a valid terminal
line is also fallback. The command-process exit status is **not** the test exit:
a valid `completed` line supplies the test exit even when that process exits
nonzero. An operator command must return `fallback` when it cannot verify the run.

The broker streams log bytes to the client in base64 JSON frames, separately from
progress and terminal completion frames. Every frame carries version and request
id. Log text, including protocol-looking lines, is never interpreted as control
messages. The client prints the relayed bytes, prints
`wt-suite-lock: offloaded; archive <id>`, and exits with the reported test exit.
An incomplete connection or invalid frame cannot produce a successful exit.

## Race, fallback and limits

- Completed offload first: cancel the local ticket and relay the completion.
  Log drainage retains the original offload deadline; a non-reading client
  receives no successful completion and cannot retain the temporary log
  indefinitely. Terminal connections are also force-closed after a bounded grace.
- Fallback: retain the same local ticket and its queue position.
- Local lease first: kill the command's process group, ignore later offload
  results, and execute locally under the lease.
- Client disconnect or broker shutdown: cancel acquisition and kill the command's
  process group. An independent group guardian watches a private broker-lifetime
  pipe, so sandbox disposal or broker `SIGKILL` also kills that group and removes
  its temporary log directory. The offload command must arrange cleanup of work
  it launched outside that process group.
- Command exit: the guardian removes the temporary log directory **before**
  killing its group, including surviving descendants and itself. Its independent
  deadline does the same even when the broker is suspended. Broker-initiated
  group termination also removes the directory first. The broker's already-open
  reader can drain the unlinked log through the original delivery deadline, so
  removing the pathname does not discard output or leave an abandoned directory
  if the broker dies before consuming the result. Delivery closes the reader on
  success, cancellation, or deadline expiry.

Results come from **wherever the operator's command ran them**. The broker binds
the reply to this invocation and validates its shape; the operator command is
responsible for snapshot/archive provenance, dependency parity and verification
of the actual run. The repository supplies no remote transport or executor.

This seam is Linux-only, using the lane sandbox and Linux descriptor paths.
Unix-domain sockets, direct
executable spawn and negative-PID process-group signals work on Linux and macOS,
but offload is explicitly disabled on macOS. Windows does not provide this POSIX
socket/group contract; configured offload reports its Linux requirement and
remains disabled before these dependencies are used. A missing executable or
socket produces a named error rather than a plausible successful outcome.
