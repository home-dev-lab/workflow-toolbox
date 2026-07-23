// external-delegation.test.ts — unit tests for the PURE external-delegation compliance scanner.
//
// The matcher is a CLOSED registry of grounded invocation shapes (see external-delegation.ts).
// The two halves of correctness it must hold:
//   1. RECALL on the real shapes — same-line `opencode … run`, the two-line resolver
//      `BIN=$(command -v opencode …)` + `"$BIN" run` (the false-negative-under-`.` case from
//      the manual 2026-07-10 check), `codex-companion.mjs`, and direct `codex exec`.
//   2. PRECISION against self-answering wrappers — an agent that only ran git/read commands
//      must scan to ZERO calls (the 16/17 self-answer case), and quoting a CLI path inside a
//      NON-Bash block or a tool_result must never count (the skill-text contamination case).

import { describe, it, expect } from 'vitest'
import {
  DELEGATION_EXPECTATIONS,
  expectationForAgentType,
  isDelegatedAgentType,
  isExternalCliCommand,
  parseTranscriptExternalCalls,
  buildExternalDelegationReport,
  emptyExternalDelegationReport,
} from '../src/external-delegation.js'

const OPENCODE = DELEGATION_EXPECTATIONS.find((e) => e.id === 'opencode')!
const CODEX = DELEGATION_EXPECTATIONS.find((e) => e.id === 'codex')!

/** One transcript line: an assistant message with the given content blocks. */
function line(blocks: unknown[]): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } })
}

function bashUse(command: string, id = 'toolu_1'): unknown {
  return { type: 'tool_use', id, name: 'Bash', input: { command } }
}

describe('expectationForAgentType — closed registry resolution', () => {
  it('resolves the bundled opencode bridge and any opencode-named type', () => {
    expect(expectationForAgentType('workflow-toolbox:opencode-verifier')?.id).toBe('opencode')
    expect(expectationForAgentType('opencode-verifier')?.id).toBe('opencode')
  })
  it('resolves codex types (plugin-namespaced and bare)', () => {
    expect(expectationForAgentType('codex:codex-rescue')?.id).toBe('codex')
  })
  it('returns null for a standard subagent type — unknown, never judged', () => {
    expect(expectationForAgentType('general-purpose')).toBeNull()
    expect(expectationForAgentType('magic-claude:code-reviewer')).toBeNull()
  })
})

describe('isDelegatedAgentType — the default spawn type is not a delegation', () => {
  it('rejects the runtime default (grounded: every agent of an ordinary run carries it)', () => {
    expect(isDelegatedAgentType('workflow-subagent')).toBe(false)
  })
  it('accepts real routing choices, registered or not', () => {
    expect(isDelegatedAgentType('workflow-toolbox:opencode-verifier')).toBe(true)
    expect(isDelegatedAgentType('some-future-bridge')).toBe(true)
  })
})

describe('isExternalCliCommand — grounded invocation shapes', () => {
  it('matches a direct same-line opencode run', () => {
    expect(isExternalCliCommand('~/.opencode/bin/opencode run "verify this" --agent plan', OPENCODE)).toBe(true)
  })
  it('matches the two-line resolver shape (the false-negative-under-`.` case)', () => {
    const cmd =
      'BIN=$(command -v opencode || echo ~/.opencode/bin/opencode)\n' +
      'timeout 570 "$BIN" run "verify the claim" --agent plan --model zai-coding-plan/glm-5.2'
    expect(isExternalCliCommand(cmd, OPENCODE)).toBe(true)
  })
  it('matches the codex companion wrapper and direct codex exec', () => {
    expect(
      isExternalCliCommand('node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "review the diff"', CODEX),
    ).toBe(true)
    expect(isExternalCliCommand('codex exec --sandbox workspace-write "do a thing"', CODEX)).toBe(true)
  })
  it('does NOT match ordinary git/read commands (the self-answer shape)', () => {
    for (const cmd of ['git diff HEAD~1..HEAD', 'git show abc123:file.ts', 'cat toolkit/README.md']) {
      expect(isExternalCliCommand(cmd, OPENCODE)).toBe(false)
      expect(isExternalCliCommand(cmd, CODEX)).toBe(false)
    }
  })
  it('does NOT credit an `npm run` on a later line after a mere opencode mention', () => {
    expect(isExternalCliCommand('grep -r opencode docs/\nnpm run test', OPENCODE)).toBe(false)
  })
  it('does NOT credit SAME-LINE incidental mentions (pr-review HIGH on the first cut)', () => {
    // The exact contaminations the review demonstrated against the token-presence regexes:
    expect(isExternalCliCommand('test -f ./opencode-verifier.md && echo run', OPENCODE)).toBe(false)
    expect(isExternalCliCommand('echo "see opencode docs" && npm run test', OPENCODE)).toBe(false)
    expect(isExternalCliCommand('grep -rl opencode . | xargs -I{} echo processed {}; ./run.sh', OPENCODE)).toBe(false)
    expect(isExternalCliCommand('grep codex-companion.mjs README.md', CODEX)).toBe(false)
    expect(isExternalCliCommand('cat codex-companion.mjs | wc -l', CODEX)).toBe(false)
    expect(isExternalCliCommand('grep "codex exec" SKILL.md', CODEX)).toBe(false)
  })
  it('still matches path-prefixed and separator-preceded invocations', () => {
    expect(isExternalCliCommand('timeout 45 ~/.opencode/bin/opencode run "PROBE"', OPENCODE)).toBe(true)
    expect(isExternalCliCommand('cd /tmp && codex exec --sandbox read-only "check"', CODEX)).toBe(true)
    expect(
      isExternalCliCommand('BIN="/home/u/.opencode/bin/opencode"; timeout 570 "$BIN" run "verify" --agent plan', OPENCODE),
    ).toBe(true)
  })
  it('matches a fully-QUOTED binary path with the subcommand outside the quotes (run wf_f512a38e-14c verify:1:1)', () => {
    expect(
      isExternalCliCommand(
        'timeout 570 "/home/doublefx/.opencode/bin/opencode" run "Follow the instructions" --agent plan --model openai/gpt-5.5 -f /tmp/oc.md',
        OPENCODE,
      ),
    ).toBe(true)
    expect(isExternalCliCommand('"/usr/local/bin/codex" exec --sandbox read-only "check"', CODEX)).toBe(true)
    // …while a quoted STRING containing both words stays excluded (no closing quote between them):
    expect(isExternalCliCommand('grep "opencode run" docs/notes.md', OPENCODE)).toBe(false)
  })
  it('caps the scan on a pathologically long command without missing a leading invocation', () => {
    expect(isExternalCliCommand('opencode run "x" # ' + 'y'.repeat(50_000), OPENCODE)).toBe(true)
  })
})

// The linear two-step matcher (cards #1825363023930328542 + #1825347787861001678) replaced the
// single mega-regex whose BIN= arm backtracked ~30s on a 200KB opencode-but-no-run command, and
// the 20k scan cap that hid a real `run` past position 20k (the a50c1510/aafb024d false-refuse).
describe('matchesOpencodeRun (via isExternalCliCommand) — linear, ReDoS-safe, past-20k-run', () => {
  /** Worst-of-3 wall time for one match, in ms. */
  function matchMs(cmd: string): number {
    let best = Infinity
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now()
      isExternalCliCommand(cmd, OPENCODE)
      const dt = performance.now() - t0
      if (dt < best) best = dt
    }
    return best
  }

  it('credits a real opencode run whose `run` sits FAR past the old 20k cap (a50c1510: 33K heredoc)', () => {
    const cmd = 'BIN=/home/x/.opencode/bin/opencode\n' + 'x'.repeat(33_000) + '\ntimeout 570 "$BIN" run "verify" -f "$TASKFILE" < /dev/null'
    expect(isExternalCliCommand(cmd, OPENCODE)).toBe(true)
  })
  it('credits a run captured by the TAIL window (aafb024d: run at ~69.5K)', () => {
    const cmd = 'BIN=/home/x/.opencode/bin/opencode\n' + 'x'.repeat(69_500) + '\ntimeout 570 "$BIN" run "verify" -f "$T" < /dev/null'
    expect(isExternalCliCommand(cmd, OPENCODE)).toBe(true)
  })
  it('KILLS the ReDoS: a 200KB opencode-but-no-run command is false AND completes < 50ms (old regex: ~30s)', () => {
    const cmd = 'BIN=/home/x/.opencode/bin/opencode\n' + 'x'.repeat(200_000)
    expect(isExternalCliCommand(cmd, OPENCODE)).toBe(false)
    expect(matchMs(cmd)).toBeLessThan(50)
  })
  it('stays O(n) on 40K repeated `BIN=` tokens with no run (< 50ms — the arm-2 bound)', () => {
    const cmd = 'BIN=/x/opencode\n'.repeat(2_500) // ~40K of repeated BIN= assignments, no run
    expect(isExternalCliCommand(cmd, OPENCODE)).toBe(false)
    expect(matchMs(cmd)).toBeLessThan(50)
  })
  it('does NOT credit `opencode providers list` (a self-answer probe, not a run)', () => {
    expect(isExternalCliCommand('BIN=/home/x/.opencode/bin/opencode; "$BIN" providers list; grep -rn foo src/', OPENCODE)).toBe(false)
  })
  it('DOCUMENTED residual: a `run` in the MIDDLE of a >2*WIN command is missed (never observed)', () => {
    const cmd = 'a'.repeat(25_000) + ' /x/opencode run "y" ' + 'b'.repeat(25_000)
    expect(isExternalCliCommand(cmd, OPENCODE)).toBe(false)
  })
})

describe('parseTranscriptExternalCalls — Bash tool_use only, tolerant', () => {
  it('counts matching Bash invocations and keeps a capped first-command preview', () => {
    const long = 'timeout 570 "$BIN" run "' + 'x'.repeat(300) + '"'
    const jsonl = [
      line([bashUse('BIN=$(command -v opencode)\n' + long, 'toolu_1')]),
      line([bashUse('opencode run "second probe" --agent plan', 'toolu_2')]),
      line([bashUse('git diff', 'toolu_3')]),
    ].join('\n')
    const scan = parseTranscriptExternalCalls(jsonl, OPENCODE)
    expect(scan.cliCalls).toBe(2)
    expect(scan.firstCommand).not.toBeNull()
    expect(scan.firstCommand!.length).toBeLessThanOrEqual(120)
    expect(scan.firstCommand).toContain('opencode')
  })
  it('scans a self-answering wrapper to ZERO calls (the 16/17 case)', () => {
    const jsonl = [
      line([bashUse('git status', 'toolu_1')]),
      line([bashUse('git diff main..HEAD', 'toolu_2')]),
      line([{ type: 'text', text: 'VERDICT: the claim is refuted.' }]),
    ].join('\n')
    expect(parseTranscriptExternalCalls(jsonl, CODEX).cliCalls).toBe(0)
  })
  it('never counts a CLI path quoted OUTSIDE a Bash tool_use (skill-text contamination)', () => {
    const jsonl = [
      // Injected agent-definition text quoting the wrapper path, inside a plain text block:
      line([{ type: 'text', text: 'Run node scripts/codex-companion.mjs task per your instructions.' }]),
      // A tool_result echoing a command (e.g. the agent grepping its own definition):
      line([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_9',
          content: [{ type: 'text', text: 'codex-companion.mjs task — found in SKILL.md' }],
        },
      ]),
      // A NON-Bash tool whose input mentions the path:
      line([{ type: 'tool_use', id: 'toolu_10', name: 'Read', input: { file_path: '/x/codex-companion.mjs' } }]),
    ].join('\n')
    expect(parseTranscriptExternalCalls(jsonl, CODEX).cliCalls).toBe(0)
  })
  it('never throws on malformed input', () => {
    expect(parseTranscriptExternalCalls('not json\n{"half":', OPENCODE)).toEqual({ cliCalls: 0, firstCommand: null })
    expect(parseTranscriptExternalCalls('', OPENCODE).cliCalls).toBe(0)
  })
})

describe('buildExternalDelegationReport — rollup, flags, unknown split', () => {
  const scanOk = { cliCalls: 2, firstCommand: 'opencode run "probe"' }
  const scanNone = { cliCalls: 0, firstCommand: null }

  it('flags a run where an audited agent shows no CLI call', () => {
    const r = buildExternalDelegationReport([
      { agentId: 'a1', agentType: 'workflow-toolbox:opencode-verifier', scan: scanOk },
      { agentId: 'a2', agentType: 'workflow-toolbox:opencode-verifier', scan: scanNone },
    ])
    expect(r.delegatedAgents).toBe(2)
    expect(r.flagged).toBe(true)
    expect(r.withoutCli.map((a) => a.agentId)).toEqual(['a2'])
    expect(r.agents.find((a) => a.agentId === 'a1')?.cliSeen).toBe(true)
  })
  it('stays clean when every audited agent invoked its CLI', () => {
    const r = buildExternalDelegationReport([
      { agentId: 'a1', agentType: 'codex:codex-rescue', scan: scanOk },
    ])
    expect(r.flagged).toBe(false)
    expect(r.withoutCli).toEqual([])
  })
  it('routes unregistered agentTypes to `unknown` without flagging', () => {
    const r = buildExternalDelegationReport([
      { agentId: 'a1', agentType: 'some-future-bridge', scan: scanNone },
    ])
    expect(r.delegatedAgents).toBe(0)
    expect(r.unknown).toEqual([{ agentId: 'a1', agentType: 'some-future-bridge' }])
    expect(r.flagged).toBe(false)
  })
  it('drops agents whose transcript was unreadable (absent scan proves nothing)', () => {
    const r = buildExternalDelegationReport([
      { agentId: 'a1', agentType: 'codex:codex-rescue', scan: null },
    ])
    expect(r.delegatedAgents).toBe(0)
    expect(r.flagged).toBe(false)
  })
  it('emptyExternalDelegationReport matches a rollup of nothing', () => {
    expect(buildExternalDelegationReport([])).toEqual(emptyExternalDelegationReport())
  })
})
