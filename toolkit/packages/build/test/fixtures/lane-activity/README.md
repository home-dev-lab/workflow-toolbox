# lane-activity fixtures — captured from a real opencode store

`real-session-rows.sql` holds actual `session`/`message`/`part` rows read out of a live
`~/.local/share/opencode/opencode.db` on 2026-08-07 (a real GPT-lane turn on this machine),
not hand-authored — a hand-written fixture would only ever agree with a hand-written reader's
own understanding of the schema, never refute it.

Captured with:

```bash
SID="ses_0224d2f4affeleoQm1djpA2sFF"
sqlite3 "file:$HOME/.local/share/opencode/opencode.db?mode=ro" <<SQL
.mode insert session
select * from session where id='$SID';
.mode insert message
select * from message where session_id='$SID' order by time_created limit 4;
.mode insert part
select * from part where session_id='$SID' order by time_created limit 6;
SQL
```

Then two path-sanitizing `sed` passes, nothing else: the machine's real worktree path
(`/home/doublefx/projects/wt-suite/worktrees/card-lane-token-split` → `/tmp/fixture-worktree`)
and the real home directory (`/home/doublefx` → `/home/fixture-user`, for the paths that survive
inside JSON payloads and log lines that reference OTHER worktrees/snapshots), because this repo
is public and both are personal directory layout, not schema shape. Every key, type, nesting
level, and value (including the `part.data.type` split between `text`/`reasoning`/`step-finish`
the reader depends on) is untouched.

`schema.sql` is the matching `CREATE TABLE` statements, copied verbatim from
`.schema session` / `.schema message` / `.schema part` against the same real store.

`real-log-tail.txt` is 8 real lines tailed from `~/.local/share/opencode/log/opencode.log` via
`grep -a card-lane-token-split opencode.log | tail -15`, sanitized the same way — it is the
source for `extractLatestLogActivity`'s real-fixture test.

Tests load the SQL fixtures into a fresh tmp-file `node:sqlite` `DatabaseSync` at run time (a
`:memory:` DB can't be opened `readOnly:true`, and read-only opening is the behavior under
test), and read the log fixture as plain text.
