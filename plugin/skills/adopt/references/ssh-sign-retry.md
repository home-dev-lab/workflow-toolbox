# Opt-in SSH signing retry

For an SSH agent relayed across hosts, a correct key can intermittently produce an agent
failure. Explicitly adopt the retry program to retry signing once: two attempts total,
with a one-second wait between them:

```sh
node scripts/install.mjs --set ssh-sign-retry --check --global
node scripts/install.mjs --set ssh-sign-retry --install --global
```

Paths above are relative to the adopt skill directory. The default program location is
`~/.workflow-toolbox/ssh-sign-retry/wt-ssh-sign-retry.mjs` on every platform (the home
directory is resolved by Node). This per-user copy survives worktree removal and Claude
config-profile changes. `--global` writes Git's **global** `gpg.ssh.program`; without it,
run inside a Git repository to write the **repository-local**, shared-worktree setting.
`--dir` explicitly overrides the program directory; Git scope stays local. When overriding,
choose a persistent directory: Git will still reference it after the adopting worktree is
removed. The configured command quotes the absolute Node executable and program paths,
including paths with spaces. Removing that Node installation also requires reconfiguration.

Only this explicitly named set installs the program or configures Git. `--set all`, the
ordinary `scripts` set, and `--refresh-only` do not activate it. `--check` is read-only.
The copy is versioned, fingerprinted and editable, using adopt's normal refresh rules.
An edited, hand-authored or symlinked program is not newly configured as the signer.
Even `--force` never replaces an existing `gpg.ssh.program`: any effective or write-scope
value, including an empty string, is reported and left alone. Re-adoption therefore
preserves an existing custom signer. Adoption locks **only the configuration file it
writes**, using that file's Git-compatible `.lock`. It repeats the absence checks under
that lock, publishes an edited snapshot, then asks Git for the effective
`gpg.ssh.program`, `user.signingkey` and `gpg.ssh.defaultKeyCommand`. The program must
equal the intended command and the key-selection values must be unchanged, including
the distinction between absent, empty and newline-containing values. Git output is
validated before UTF-8 decoding: invalid UTF-8 refuses adoption explicitly, so distinct
raw byte values cannot silently compare equal. Valid UTF-8 is preserved, including a
leading byte-order mark. These reads use
the committing working directory and environment; the `git config`-only `GIT_CONFIG`
override is excluded because commits ignore it. Adoption does not execute a default-key
command or validate key material. It holds the write lock through this check and restores
the original file (or original absence) if the check fails. Before publication, a
same-filesystem hard link retains the original inode without rewriting it; rollback
therefore preserves its exact bytes, full mode including special bits, owner and native
ACLs. If that identity cannot be retained, adoption refuses before publishing. If
rollback itself fails, the error explicitly reports incomplete restoration and names
the retained original backup for recovery; it does not claim a clean restore. The
refusal names the effective values it saw, and never reports `WROTE`. A prepared program
copy is reported as `PREPARED`; only verified configuration publication reports `WROTE`.

Included config files are not locked. A concurrent writer to an included config file
during adoption is detected by the postcondition check only if its change lands before
that check and changes the effective values being checked. After the check, it is the
user's own configuration change. This is a checked configuration update, not a transaction
over Git's entire include graph. Writers that ignore the write target's lock are also
outside the serialization guarantee.

Git supplies HOME interpolation for selecting the global write target and the repository
config path for local adoption. Its HOME may differ from Node's program-storage home.
Whitespace/newlines and native symlink/`..` traversal in target paths are preserved.
No include discovery, conditional marker probes or system-config locks are needed.
A changed write target or already-held lock is reported and left alone; rerun the same
adoption command. These deliberate refusals can exit successfully without installation:
automation must inspect the `gpg.ssh.program WROTE`, `PRESENT` or refusal disposition.
This step does not select a key, enable signing, or change `gpg.format`; the user's
SSH signing configuration supplies those choices.

### Removal, older installs, and interrupted adoption

There is no automatic uninstall. Before deleting an adopted program or its Node executable,
inspect `git config --show-origin --get-all gpg.ssh.program`. If the value is this program,
remove that exact value from its origin file, for example
`git config --file <origin-file> --fixed-value --unset-all gpg.ssh.program <exact-command>`.
Keep the home-owned program while any repository or global config still references it.

An older installation may point into `.claude/scripts/` in a worktree. Adoption deliberately
preserves even that existing value. Before deleting that worktree, inspect the origins,
remove only its matching command as above, then rerun this explicit adoption step to use
the persistent default. Existing managed copies in project/config directories are not
implicitly selected for the SSH retry set. `--diff` without `--dir` inspects the home copy.
An existing signer value is an arbitrary shell command; adoption cannot safely infer
ownership from path substrings, so migration remains an explicit exact-value operation.

Process death can leave the target's Git-compatible `.lock` and a `<config>.adopt-*`
staging directory behind, just as interrupted Git writes
can. Adoption never guesses that another writer is dead or deletes an existing lock.
Identify the failed process and verify it has stopped before manually removing its stale
config lock and abandoned staging directory, then rerun the same adoption command.
Power-loss durability is unverified.

## Runtime contract

- Only `-Y sign` is eligible for retry. Other argument vectors run once with inherited
  stdin, stdout and stderr and the child's exit status. POSIX uses `execve` when available;
  Windows and older Node versions use an inherited-stream child process.
  Attached options such as `-Ysign` are recognized. Classification is conservative:
  only the signing options `-Y`, `-f`, `-n`, `-O`, `-q`, `-v` and `-U` are interpreted;
  mixed operations, unknown flags and ambiguous option ordering run once unchanged.
  Only stdin signing (no file operand, or a single `-`) is retried. Named-file signing
  runs once unchanged, avoiding repeated `.sig` writes and overwrite prompts.
  Option values and `--` are respected, so a verification operation cannot be retried
  merely because an earlier argument spelled `-Y sign`.
- Retry matches are case-sensitive substrings: `No private key found`,
  `communication with agent failed`, `agent refused`, and `agent not present`.
  Each attempt streams its stderr immediately, followed on a matched failure by a
  `retrying because ...` diagnostic
  before the one-second wait. A success, unmatched error, signal, or second attempt stops.
  A permanently unloaded key can match too; the maximum retry-sleep delay is one second.
  `agent refused` can also represent a deliberate denial: an agent confirmation prompt can
  therefore repeat once. The wrapper cannot distinguish intent from that text.
  This is not a child-execution timeout: a child waiting for input or a stalled agent can
  still wait, just as native OpenSSH does.
- The first signing attempt starts immediately. Stdin is forwarded as it arrives and
  retained for replay; it is not read to EOF before launching the child. A named-file
  invocation passes through without waiting for stdin EOF. Retried signing stdout is buffered per
  attempt; only a successful attempt's bytes are published. Failed attempts cannot
  contaminate a signature. Signing input/output therefore consume memory proportional
  to their size; this program is intended for Git's small signing payloads.
- The real `ssh-keygen` is resolved on PATH, skipping the program's own filesystem
  identity (including symlinks and hard links) and distinct adopted copies carrying its
  standalone-program marker. On POSIX an unset PATH uses `/usr/bin:/bin`; an explicitly
  empty PATH searches the current directory. POSIX PATH entries retain native
  symlink/`..` traversal rather than being normalized lexically. Missing or unlaunchable binaries report
  an error. No key or agent address is embedded in the program.
- Key file contents are not pinned. Replacing the file named by `-f` during the retry
  delay can select a different key on the second attempt, even though the pathname and
  arguments are unchanged. Keep key files stable during signing. Adoption likewise checks
  the key-selection configuration, not a cryptographic snapshot of external key files or
  the output of a dynamic default-key command.

## Platform status

Linux fake-binary execution and temporary Git configuration are tested. The implementation
uses Node built-ins, native `ssh-keygen` on POSIX and native `.exe`/`.com` programs on
Windows, and a quoted Node command through Git's command shell (including Git for Windows' `sh`). It
needs no shell-script launcher. Windows and macOS execution are **unverified**; native
executable lookup, Git command quoting and forwarded-agent behavior on those hosts need
host evidence. Windows resolver simulations cover PATH directory order and PATHEXT extension
order. An earlier `.cmd`, `.bat` or other non-native shim is reported as unsupported rather
than silently bypassed; put native OpenSSH before that directory on PATH. No command shell
is introduced for executable lookup. With PATH unset on Windows, lookup uses the system
directory under `SystemRoot` (default `C:\Windows`); that fallback is unverified on a host.
POSIX executable bits are checked; Windows relies on native executable
launch. Spawn-fallback signal handling is best effort, and force-killing the wrapper can
orphan a child. Node and OpenSSH must already be installed and available.

The exact stock-agent wording `agent refused operation` has not been independently
verified (the observed `agent refused` substring would match it). The candidate
`agent contains no identities` remains unverified and is deliberately unmatched.
