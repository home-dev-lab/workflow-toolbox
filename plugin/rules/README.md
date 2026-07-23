# workflow-toolbox bundled rules

This directory is the single source of the **rule files** that the
`workflow-toolbox:adopt-rules` skill installs as editable copies into a user's
config (the `rules` set — the mirror of the `agents` set, which is sourced from
`../agents/`).

Each `*.md` file here is a **pure directive**: a project-agnostic, machine-free
guardrail that states what to do and the invariant that makes it right, with no
environment-specific narrative (no dates, no repo/agent names, no account model
tables). The rationale, calibration anchors, and field cases that justify a rule
live elsewhere (in the operator's own notes), never in the shipped file.

`README.md` is documentation, not a managed rule — the installer discovers every
`*.md` in this directory **except this file** and manages each one under a
versioned, fingerprinted banner so a later `--check` can tell an adopted copy is
behind the plugin (and `--install` refreshes only unedited copies).

To adopt these as editable rules, run the `workflow-toolbox:adopt-rules` skill:

```bash
node scripts/install-rules.mjs --set rules --check     # report status, write nothing
node scripts/install-rules.mjs --set rules --install   # write absent + refresh unedited copies
```

If a target `<config-dir>/rules/<name>.md` is a **symlink** (for example a config
dir whose rules are symlinked from another one), the installer never writes
through it: it reports the symlink and leaves it untouched unless you pass
`--replace-symlinks`, which replaces the link with a managed copy in place.

## Reconciling your existing project rules

Adopting the bundled rules into a project that already has rules can create
duplicate concerns that drift apart. `adopt-rules` installs the bundled rules,
but it does not reconcile them against your existing rules, so reconcile first.
This is a one-shot, per-project procedure, deliberately kept here as
documentation rather than a rule that would cost permanent context for a
one-time task.

### The method

1. **Back up first.** Copy the current rules directory to a timestamped backup.
   If the rules directory is under git, a dedicated commit is your rollback. If
   it is not under git, the timestamped backup plus a note in a durable report
   is your rollback.
2. **Inventory and classify at the clause level, not the file.** For every
   existing rule, classify each concern or clause, not the whole file, as:
   (a) a duplicate of a bundled or generic rule, to specialize or reduce to a
   one-line pointer to the generic rule; (b) genuinely project-specific, to keep
   as a directive; or (c) stale, to rewrite to the real current state or drop. A
   genuinely project-specific file routinely contains duplicate and stale
   clauses mixed in, so a per-file verdict misses them.
3. **Draft propose-only, in scratch.** Have an agent rewrite the rules into a
   scratch area plus a **disposition map** that records, per clause, its class
   (a/b/c) and its disposition (kept, specialized, reduced to a pointer,
   corrected, dropped, or relocated) — and, for a relocation, where the narrative
   is INTENDED to go. No real rule file and no real note is touched at this
   stage: the moves are recorded, not executed.
4. **Verify zero-loss, refute-first, with a fresh agent that opens every
   carrier.** A separate, fresh agent, told to prove a loss, diffs phrase by
   phrase from the original backup to the proposed rules. For each original
   phrase, it gives one verdict: present, whether verbatim or equivalent;
   relocated and verified by opening the claimed carrier — the project rule,
   generic or bundled rule, or note claimed to now carry it is read in full and
   preserves at least the original strength; or lost. It classifies each issue as LOSS, WEAKENING, WRONG-POINTER,
   or OK. Opening each carrier instead of trusting the pointer is what catches a
   WEAKENING that a plain diff would miss.
5. **Fix every non-OK verdict, then re-verify, before applying.** Repair each
   LOSS, WEAKENING, and WRONG-POINTER in scratch — reinstate a lost or weakened
   directive, correct a broken pointer — then re-run the fresh-agent
   verification, and apply only once it comes back clean. Reinsertion has one
   hard rule: the operator's own notes are not auto-loaded, so an operative
   directive that some auto-loaded rule would otherwise drop must stay in a rule;
   only narrative and rationale move out to the notes.
6. **Hold ambiguities for the user in a batch.** Present each ambiguity with its
   context, impact, and options, not one at a time.
7. **Apply, guard, and record.** Apply the proposed rules and EXECUTE the
   recorded relocations — write each relocated narrative into the operator's
   notes in the same pass as its removal from the rule, so nothing is orphaned.
   Grep-guard one owner per concern, then commit if git is in use or keep the
   timestamped-backup-plus-note rollback path if it is not, and write a durable
   report.

### Also

- A project clause that overrides a generic or user rule must name the
  overridden rules in its own text; otherwise the divergence is silent.
- Create or move a narrative's target note in the same pass as its removal, so
  no narrative is ever momentarily orphaned.
- Verify every pointer resolves to a rule that is actually loaded in your setup:
  check the real load state, not just name prefixes.
- Return findings as text, never as a report file. A spawned agent's report file
  may be refused by the harness, and inter-session messaging can be lost, so have
  the drafter and verifier write their artifacts to scratch and return their
  findings as text. If a spawned agent goes idle with no final message, check the
  scratch file mtimes and then its transcript before respawning.
- The pass is not a freeze; a reconciled rule stays editable afterward.

### Prompt templates

```text
You are the drafter for a rules reconciliation pass.

Inputs:
- Existing rules: <existing-rules-dir>
- Bundled or generic rules to reconcile against: <generic-rules-dir>
- Scratch area: <scratch>
- Rationale store: <the operator's notes>

Work propose-only. Do not edit any real rule file.

For every existing rule, classify each concern or clause, not the whole file:
(a) duplicate of a bundled or generic rule
(b) genuinely project-specific
(c) stale

Rewrite the rules into <scratch>/proposed/:
- Keep (b) as operative directives.
- Correct (c) to the real current state, or drop it when it is no longer true.
- Reduce (a) to a one-line pointer to the generic rule when no project-specific
  specialization is needed.
- For narrative or rationale that leaves a rule, record its INTENDED destination
  in the operator's notes — do not write to the real notes yet; that happens at
  apply, in the same pass as the removal.
- If a clause overrides a generic or user rule, name the overridden rule in the
  clause itself.

Record, in <scratch>/disposition.md, a per-clause map: each clause, its class
(a/b/c), and its disposition (kept / specialized / reduced-to-pointer /
corrected / dropped / relocated-with-intended-destination). Write all artifacts
to scratch and touch no real rule or note. Return findings as text, not as a
report file.
```

```text
You are the fresh verifier for a rules reconciliation pass.

Goal: prove a loss or weakening.

Inputs:
- Original backup: <backup-rules-dir>
- Proposed rules: <scratch>/proposed/
- Disposition map: <scratch>/disposition.md
- Generic/bundled rules being adopted: <generic-rules-dir>
- Rationale store: <the operator's notes>

Diff phrase by phrase from the original backup to the proposed rules. For each
original phrase, give exactly one verdict:
- present, verbatim or equivalent
- relocated, verified by opening the claimed carrier and reading it in full
- lost

Classify each issue as LOSS, WEAKENING, WRONG-POINTER, or OK.

Never trust a pointer unopened. For every relocation or pointer, open the
claimed carrier — a project rule, a generic or bundled rule, or the operator's
notes — read it in full, and verify it preserves at least the original strength.
Flag any operative directive removed from an auto-loaded rule and parked only in
a non-auto-loaded note as a WEAKENING.

Return findings as text.
```
