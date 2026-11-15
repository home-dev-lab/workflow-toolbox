# Durable and retained roots

Previously registered canonical roots remain available for 30 days after their last persisted live
observation, including after a server restart with no project session running. The
`artifact_server_retain_days` option (environment fallback `WT_ARTIFACT_SERVER_RETAIN_DAYS`)
accepts finite values from 0 to 3650, including fractions. Zero restores live-only serving and removes
older retained records for roots live while disabled; other records are left untouched. Retained
roots keep the union of deny patterns from the last scan where they were live. Before replacing an
existing policy, the server durably writes a recovery marker and acknowledges its nonce in the new
record. If that prerequisite fails, it skips replacement and removes the older record, syncing its
directory on POSIX. Failed record updates also invalidate the older record. If removal or its sync
fails, the server blocks retained serving in memory and tries to write another recovery marker.
If the state directory refuses both the recovery-marker write and record removal, then becomes
writable before a restart after the registrant has gone, the older record can still be served;
the live process continues blocking it in memory. These failures are logged.
An unreadable forget-marker directory or any unreadable or invalid marker file makes marker state
unknown: retained roots are unavailable until a fully successful read, while live roots stay served
and their policies are still persisted. Previously known markers are preserved during read failures;
the server logs once and retries at each scan, including after an unknown state at startup.

Retention requires a running server. Retained roots do not keep the process alive, count as sessions,
or change stop/restart refusals. An always-running service must be arranged separately if links must
work while every session is stopped. `status` labels retained mounts with their last-live timestamp;
`url` resolves their files just like live roots.

Retirement is pathname-based: a directory recreated at the same canonical pathname is served again.
Retained mount names are seeded from their records on restart; names may be reused after a record
expires or becomes invalid, or when issued with retention disabled. Hosts upgrading with colliding
root basenames may see a suffixed mount name change once. Same-user modification of the private
state directory is outside the trust boundary. Retention uses wall-clock time: backward clock
corrections extend the window, and forward corrections shorten it. The window starts at the last
persisted observation, which may precede departure by up to `min(1 hour, retention / 24)` plus one
poll interval; requests check expiry even between scans.

To retire a retained root, use its mount name from `status`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/wt-artifact-server.mjs" forget <mount-name>
```

The command writes a request even when the server is stopped. The next scan (or startup) stops
serving a non-live root; forgetting a live root is ignored with a server diagnostic, leaving it
served and retained. A later live registration makes a forgotten root eligible again. Unknown names
and write failures exit 1; successful requests exit 0. Forget markers persist until the state is
removed, and a crash before marker persistence may require repeating the command.
Names beginning with a dash are accepted. Use `forget -- --help` to retire a mount literally named
`--help`; the optional `--` separator makes a following help-looking name data.

Owner-only `retained/` records and `forgotten/` markers store canonical pathnames and retirement
nonces. Root records use atomic rename with file and directory fsync; Windows skips directory
fsync and POSIX mode-bit checks, relying on the user profile's ACLs. UID checks apply where the OS
exposes a numeric uid. A caught record-write error removes its own staging file; a crash can leave
an ignored dotfile. Running two `serve` processes against one state directory is unsupported.
