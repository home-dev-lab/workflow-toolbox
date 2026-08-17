import { describe, expect, it } from 'vitest'
import { DELEGATION_EXPECTATIONS, isExternalCliCommand } from '../src/external-delegation.js'

const OPENCODE = DELEGATION_EXPECTATIONS.find((expectation) => expectation.id === 'opencode')!

describe('opencode envelope provenance lock', () => {
  it('recognises wt-opencode-envelope.mjs as a real external-CLI invocation', () => {
    const command =
      'node "${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel)/plugin}/bin/wt-opencode-envelope.mjs" "$TASKSFILE" --dir "/tmp/worktree" --model openai/gpt-5.4'

    expect(isExternalCliCommand(command, OPENCODE)).toBe(true)
  })

  it('does not recognise wt-opencode-json-extractor.mjs as an external-CLI invocation', () => {
    const command = 'node "${CLAUDE_PLUGIN_ROOT}/bin/wt-opencode-json-extractor.mjs" "$CAPTURED_STREAM"'

    expect(isExternalCliCommand(command, OPENCODE)).toBe(false)
  })

  // ⚠ The direction that matters. This matcher decides whether an agent PROVABLY called the
  // external model; a false NEGATIVE merely accuses an honest lane, but a false POSITIVE
  // certifies a self-answering one — it launders a fabricated verdict into a verified
  // provenance, which is the single outcome the whole audit exists to prevent.
  //
  // The first version of the envelope branch matched the filename plus a trailing quote-space,
  // which every one of these commands also has. Each was measured accepted before the fix.
  it('does not accept a command that merely NAMES the wrapper without running it', () => {
    const mentions = [
      'grep -c "wt-opencode-envelope.mjs" plugin/agents/opencode-envelope.md',
      'echo "you must run wt-opencode-envelope.mjs with a tasks file"',
      'ls -la /plugin/bin/wt-opencode-envelope.mjs && echo done',
      'cat plugin/bin/wt-opencode-envelope.mjs | head -40',
      // A `node` on an EARLIER line must not vouch for a mention on a later one.
      'node --version\ngrep -c "wt-opencode-envelope.mjs" notes.md',
    ]
    for (const command of mentions) {
      expect(isExternalCliCommand(command, OPENCODE), command).toBe(false)
    }
  })

  // ⚠ The plugin-root expansion contains SHELL SUBSTITUTIONS, and an early version of the
  // invocation check segmented on '(' — which `$(…)` inside the path silently defeated, so a
  // genuine call read as a mention. It went unnoticed because the probe written alongside it
  // happened to use a substitution containing the word `node`, and agreed with the code by
  // accident. Both real shapes are pinned here so no future narrowing can quietly drop one.
  // ⚠ The command that actually shipped, from run wf_105c89db-bdb — kept verbatim because every
  // hand-written approximation of it PASSED while this one failed. It is one Bash call that
  // exports two variables, writes a heredoc tasks file, and only then invokes the wrapper; and the
  // plugin-root expansion embeds an inline `node -e '…;…'` whose SEMICOLONS sit inside quotes.
  // An earlier version of the invocation check split segments on `;` as well as newlines, so those
  // quoted semicolons cut the invocation away from its own `node` and the real call read as a
  // mention. Two halves of the same evening's work, each correct alone, breaking each other.
  it('accepts the real shipped invocation — heredoc, exports, and quoted semicolons in the plugin-root expansion', () => {
    const shipped = [
      'WORKDIR="/tmp/w"',
      'TASKSFILE="${WORKDIR}/.oc-envelope-tasks-$$.json"',
      '',
      "cat > \"$TASKSFILE\" <<'TASKS_EOF'",
      '[{"id":"capital","prompt":"one word"}]',
      'TASKS_EOF',
      '',
      'node "${CLAUDE_PLUGIN_ROOT:-${WT_PLUGIN_ROOT:-$(node -e \'const fs=require("fs");const p=j.plugins||j;console.log(p[k][0].installPath)\' 2>/dev/null)}}/bin/wt-opencode-envelope.mjs" "$TASKSFILE" --dir "$WORKDIR"',
    ].join('\n')

    expect(isExternalCliCommand(shipped, OPENCODE)).toBe(true)
  })

  it('accepts the real invocation whatever shell substitution the plugin-root expansion carries', () => {
    const withGitRevParse =
      'node "${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel)/plugin}/bin/wt-opencode-envelope.mjs" "$TASKSFILE" --dir "/tmp/w"'
    const withNestedNodeEval =
      'node "${CLAUDE_PLUGIN_ROOT:-${WT_PLUGIN_ROOT:-$(node -e \'x\' 2>/dev/null)}}/bin/wt-opencode-envelope.mjs" "$T" --dir /w'

    expect(isExternalCliCommand(withGitRevParse, OPENCODE)).toBe(true)
    expect(isExternalCliCommand(withNestedNodeEval, OPENCODE)).toBe(true)
  })

  it('preserves existing accepted and rejected opencode invocation shapes', () => {
    expect(isExternalCliCommand('opencode run "verify this" --agent plan', OPENCODE)).toBe(true)
    expect(
      isExternalCliCommand(
        'BIN=$(command -v opencode || echo ~/.opencode/bin/opencode)\ntimeout 570 "$BIN" run "verify this"',
        OPENCODE,
      ),
    ).toBe(true)
    expect(isExternalCliCommand('grep "opencode run" docs/notes.md', OPENCODE)).toBe(false)
  })
})
