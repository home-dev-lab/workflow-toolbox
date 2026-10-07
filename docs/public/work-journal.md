# Daily work journal

The journal is a mechanical index of completed acts: local time, subject, one sentence and
a link to the detail. Hooks and one shared writer maintain it; an agent never writes lines
from memory. It is recent-activity context, not a task backlog. Board-based projects retire
their old Markdown task file after a verified, lossless archive; projects without a board
keep that file and receive a session-start onboarding reminder.

## Storage and access

The live journal and its never-rotated archive live in separate per-user state directories
outside every repository. They survive plugin uninstall. Both the active Claude configuration
directory and the project root contribute to their keys: two profiles never share a chain,
lock or archive, and changing into a sub-repository does not change the session's project.
Keys use native on-disk path spelling without case folding, preserving distinct directories
on case-sensitive volumes while resolving existing aliases to the same directory.

On Linux the lane sandbox keeps lanes out of those directories. On macOS and Windows lanes
are not sandboxed: omitting storage names from their instructions is a naming fence, not
access control. A same-user process can alter the files; the hash chain detects alterations
against the surviving head and mirror, not an adversary replacing every copy together.

State uses an absolute `XDG_STATE_HOME` when present, otherwise the home directory's local
state area on all platforms (functional, though unconventional on macOS and Windows).
`WT_WORK_JOURNAL_DIR` and `WT_WORK_JOURNAL_ARCHIVE_DIR` override the two storage roots;
profile/project keying and refusal inside a repository still apply. Do not put their values
in lane briefs. CLI commands require `CLAUDECODE=1`, which proves a Claude Code process,
not main-session authentication.

## What is recorded

Shipped defaults cover Git commits, merges, cherry-picks, reverts and pulls from the HEAD
reflog; push confirmation from remote-tracking ref movement; newly created tags; pull-request
URLs; and Planka moves whose returned card is in the cached Done list. Other default
recorders admit main calls; Done also admits subagents and unknown actors because delegated
pilots close cards. Fleet workers lack a reliable main-session provenance signal.

Publish and `gh release` calls remain `unknown` until a real Bash response fixture establishes
a success marker. Pushes of tags, untracked refs and unchanged tracking refs are also unknown,
never a claimed success. More than 200 reflog acts in a call fails visibly rather than silently
aggregating them. Scripts calling a board over HTTP have no tool-hook surface.

Projects declare `<project>/.claude/work-journal.json` with `recorders`, `disable` and `outward` arrays.
Recorders merge by `id`; invalid configuration falls back to defaults with a loud warning.
Generic recorders use `kind: "tool"`, a `tag`, a regex `tool` in the registered `Bash` or
`mcp__.*` families, an optional regex `command` on executable command heads, `sentence`,
`link`, optional `subject` and `actors`. Templates such as `{{tool_input.channel}}` and
`{{tool_response.url}}` read scalars only. Unobservable tool families are rejected loudly.
Disabling a default recorder does not disable its outward-act Stop warning.

## Commands

Run `node <plugin-root>/bin/wt-work-journal.mjs --help` for the full syntax.

- `show --days 30 --grep X` follows recent acts about a subject; `--date` and `--subject`
  narrow the query. `digest` details the two most recent worked days, even after a long idle
  period, with at most twelve subjects per day. Other worked days in the last fourteen
  calendar days (today inclusive) are condensed into one line each: act count, the three
  busiest subjects and an omitted-subject count. Dates point to `show --date YYYY-MM-DD`;
  the full journal remains available on demand. A short card subject is folded into the
  full card id that starts with the same ten digits, when exactly one such id appears;
  two different full ids are never merged. Stored lines are unchanged.
  The digest is deterministic and capped at 7,000 UTF-16 characters. Fields are sanitized
  and limited by code point; kinds are limited to three plus a count. Budget trimming
  removes oldest condensed days first, then the least recent subjects of the older detail
  day, then the newer day, and always includes a trim marker. SessionStart puts integrity
  and other notices first, caps configuration warnings to five lines of 300 characters,
  and gives the digest the remaining space within a 9,500-character total. CLI `digest`
  verifies first and prints a loud warning on failure; a broken selected live chain refuses
  the digest. Its anchored, contiguous read covers the window and the last two worked
  day files through the newest file, including rollback timestamps in later-dated files.
  SessionStart still separately reads the full chain for verification and recovery; the
  digest's smaller read does not reduce total SessionStart I/O.
- `verify` checks the chain across daily files, durable head, two-way day inventory and
  mirror equality: exit 0 intact, 1 broken, 2 unreadable. Hooks never block the session on
  an internal error; they print a loud notice. Stop is warn-only probation until the owner
  labels the first twenty live warnings from transcripts and per-act outcome records.
- `setup-board` resolves the pointer's Done list through the board client and caches it.
  Set the pointer's `mcpUrl` or the configured Planka MCP endpoint; this CLI may network,
  hooks never do. Run it again if the pointer changes.
- `unsynced "sentence" --detail-file <file>` (or full detail on stdin) archives and verifies
  the full narrative before adding an index line. `unsynced --list` reads open details;
  `resolve <hash>` records successful reconciliation with the board.
- `retire-progress --archive-only` preserves the untouched historical file before onboarding,
  without requiring a board. Create cards from that original, write the board pointer, run
  `setup-board`, then run `retire-progress`. Full retirement requires a verified byte-for-byte
  archive, chained history and retirement lines, and a SHA check of the atomically renamed
  original before exclusively creating an empty replacement. A racing writer's data is kept.
- `restore YYYY-MM-DD` restores a missing/damaged live day only from a verified archive and
  records the restoration. `unlock` re-checks that the recorded owner is dead on this host;
  a live, remote or unknown owner is never removed. There is no automatic lock reclaim.
- `export-closed --to <directory>` copies verified closed days idempotently into an external
  snapshot rotation. The continuous, never-rotated mirror remains independent of that rotation.

Interrupted appends retain stable act IDs in pending files. Recovery quarantines a torn
newest tail, rebuilds a lagging head, repairs only a verified live-to-mirror prefix and replays
pending IDs without duplication. An ahead head blocks appends until explicit restoration.
Late acts append on the append day; a clock rollback never grows an already closed day.
Observing a later day persists an empty day boundary in both inventories when needed;
that boundary prevents a closed exported day from reopening after a clock rollback.
Files fsync on all three platforms; directory fsync is unavailable on Windows.
