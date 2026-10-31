# Admission configuration and snapshot isolation

`WT_SECOND_OPINION_ADMISSION` optionally names an absolute ES module path whose
default `admit({ repo, request, env })` receives the canonical absolute paths and
launch environment, returning `null` to admit or a non-empty string to refuse.
Import and admission are awaited before any model or sandbox starts with a
10,000 ms deadline (`WT_SECOND_OPINION_ADMISSION_TIMEOUT_MS` overrides it with a
positive integer up to 2147483647); synchronous policy code must not block the
event loop. Invalid configuration, module failures and timeouts refuse with
stderr and `REFUSED: ...` followed by `EXIT=3` in the output file; an output
naming the request itself is refused before admission without modifying it.

When the environment variable is **undefined**, the CLI falls back to
`pluginConfigs["workflow-toolbox@…"].options.second_opinion_admission` in the
profile's `settings.json` (`CLAUDE_CONFIG_DIR`, otherwise `$HOME/.claude`, with
the OS home directory as the final home fallback). A defined environment value
wins, including an empty value, which refuses rather than disabling admission.
An absent option leaves execution unconfigured. An absent settings file does so
only inside a natively resolved, existing profile directory; a missing or
undecidable profile (including dangling links at any depth) refuses. Unreadable or
invalid JSON, conflicting values across plugin entries, and non-string values
refuse with the settings file and a repair remedy. Resolution happens once per
invocation; timeout overrides remain environment-only. Profile directories use
native filesystem resolution, preserving symlink/`..` semantics. Settings must
have an object root and object configuration containers; malformed containers refuse.

With admission configured, the CLI copies the repository into a private per-run
temporary snapshot, excludes `.git` files and directories at **every level**, and
reads the caller's request once. Absolute canonical and caller-spelled repository
paths in the rendered prompt are rewritten on path-component boundaries before
admission; relative paths stay relative and resolve against the snapshot cwd.
Every remaining occurrence of a live repository spelling refuses, regardless of
surrounding formatting, unless native filesystem lookup proves it is part of a
longer existing sibling path outside the repository. Those sibling paths stay
unchanged, including spaces or parentheses. A sibling symlink back into the
repository refuses instead of producing a corrupted snapshot path.
The reviewer runs with that snapshot as its cwd and receives those scanned prompt
bytes. Before scanning, files become read-only (0444) and directories become
non-writable (0555) on POSIX; the outer run container stays owner-only (0500).
Windows applies file read-only attributes, but its
directories remain writable. Runtime scratch has a separate writable per-run
directory; output artifacts keep their configured locations outside the snapshot.
A same-user process can restore write permissions; this is not a read sandbox.
Git history and metadata are unavailable in this mode. Escaping symlinks
(including absolute links back into the original repo), all unresolved symlinks, sockets, FIFOs and
devices refuse. Snapshot copying is outside the policy deadline and can be slow
for large trees. Success, refusal, errors and handled termination clean up the
snapshot; SIGKILL can leave a temporary code copy. With neither configuration
source present, the CLI uses its existing live-directory behavior. Snapshot signal
handlers remain installed through cleanup for repeated SIGINT/SIGTERM and, on
POSIX, SIGHUP/SIGQUIT; SIGKILL remains uncatchable.
