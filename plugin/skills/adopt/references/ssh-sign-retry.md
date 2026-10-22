# Opt-in SSH signing retry

For an SSH agent relayed across hosts, a correct key can intermittently produce an agent
failure. Explicitly adopt the retry program to give signing three attempts, one second apart:

```sh
node scripts/install.mjs --set ssh-sign-retry --check --global
node scripts/install.mjs --set ssh-sign-retry --install --global
```

Paths above are relative to the adopt skill directory. `--global` installs
`wt-ssh-sign-retry.mjs` under the active Claude config directory's `scripts/` and writes
Git's **global** `gpg.ssh.program`. Without `--global`, run inside a Git repository: the
program lands in `.claude/scripts/` and the Git setting is **local to that repository**.
`--dir` overrides the program directory; Git scope stays local. The configured command
quotes the absolute Node executable and program paths, including paths with spaces.

Only this explicitly named set installs the program or configures Git. `--set all`, the
ordinary `scripts` set, and `--refresh-only` do not activate it. `--check` is read-only.
The copy is versioned, fingerprinted and editable, using adopt's normal refresh rules.
An edited, hand-authored or symlinked program is not newly configured as the signer.
Even `--force` never replaces an existing `gpg.ssh.program`: any effective or write-scope
value, including an empty string, is reported and left alone. Re-adoption therefore
preserves an existing custom signer. This step does not select a key, enable signing,
or change `gpg.format`; the user's SSH signing configuration supplies those choices.

## Runtime contract

- Only `-Y sign` is eligible for retry. Other argument vectors run once with inherited
  stdin, stdout and stderr and the child's exit status. POSIX uses `execve` when available;
  Windows and older Node versions use an inherited-stream child process.
- Retry matches are case-sensitive substrings: `No private key found`,
  `communication with agent failed`, `agent refused`, and `agent not present`.
  A failing attempt prints its stderr, followed by a `retrying because ...` diagnostic
  before each one-second wait. A success, unmatched error, signal, or third attempt stops.
  A permanently unloaded key can match too; the maximum added delay is two seconds.
- Signing stdin is buffered and replayed unchanged. Signing stdout is buffered per
  attempt; only a successful attempt's bytes are published. Failed attempts cannot
  contaminate a signature. Signing input/output therefore consume memory proportional
  to their size; this program is intended for Git's small signing payloads.
- The real `ssh-keygen` is resolved on PATH, skipping the program's own filesystem
  identity (including symlinks and hard links). Missing or unlaunchable binaries report
  an error. No key or agent address is embedded in the program.

## Platform status

Linux fake-binary execution and temporary Git configuration are tested. The implementation
uses Node built-ins, native `ssh-keygen` on POSIX and `ssh-keygen.exe` on Windows, and a
quoted Node command through Git's command shell (including Git for Windows' `sh`). It
needs no shell-script launcher. Windows and macOS execution are **unverified**; native
executable lookup, Git command quoting and forwarded-agent behavior on those hosts need
host evidence. POSIX executable bits are checked; Windows relies on native executable
launch. Spawn-fallback signal handling is best effort, and force-killing the wrapper can
orphan a child. Node and OpenSSH must already be installed and available.

The exact stock-agent wording `agent refused operation` has not been independently
verified (the observed `agent refused` substring would match it). The candidate
`agent contains no identities` remains unverified and is deliberately unmatched.
