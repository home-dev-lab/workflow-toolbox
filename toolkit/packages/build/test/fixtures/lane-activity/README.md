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

Then sanitized, because this repo is PUBLIC. Two path passes replace the capturing machine's
worktree path with `/tmp/fixture-worktree` and its home directory with `/home/fixture-user` —
personal directory layout is not schema shape, and a fixture has no reason to carry it.

⚠ One value is REDACTED rather than sanitized: the provider's `reasoningEncryptedContent`, an
opaque base64 payload nobody here — author or reviewer — can inspect. It carries no test value
(the reader identifies a reasoning part by its `type`, never by its content), and shipping an
unreadable blob into a public repo means publishing something that was never read. Its key and
nesting are preserved so the shape stays honest.

Everything else — every key, type, nesting level and value, including the `part.data.type` split
between `text`/`reasoning`/`step-finish` that the reader depends on — is untouched.

⚠ This note deliberately does NOT quote the real paths it replaced. An earlier draft did, which
published in its own sanitization notice exactly the home directory and project layout the
sanitization existed to remove.

`schema.sql` is the matching `CREATE TABLE` statements, copied verbatim from
`.schema session` / `.schema message` / `.schema part` against the same real store.

`real-log-tail.txt` is 8 real lines tailed from `~/.local/share/opencode/log/opencode.log` via
`grep -a <the-lane-worktree-name> opencode.log | tail -15`, sanitized the same way — it is the
source for `extractLatestLogActivity`'s real-fixture test.

Tests load the SQL fixtures into a fresh tmp-file `node:sqlite` `DatabaseSync` at run time (a
`:memory:` DB can't be opened `readOnly:true`, and read-only opening is the behavior under
test), and read the log fixture as plain text.
