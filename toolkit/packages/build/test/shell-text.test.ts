// Lock for plugin/bin/lib/shell-text.mjs — the one implementation of "remove the parts of a shell
// command that are DATA, not code", and for the lane gate that was refusing correct work without it.
//
// THE CLASS THIS GUARDS, measured three times on three different guards: a command line carries
// code and data in one string, and nothing textual separates them. A heredoc body, a quoted
// message and a JSON payload all carry the very shapes a guard refuses. Mentioning a footgun is
// not committing one — and a regex over a command string cannot tell the difference.
//
// ⚠ BOTH DIRECTIONS MATTER, and only one of them is obvious. A stripper that removed too much
// would silence the guards entirely and every test asserting "correct work is not refused" would
// still pass. So every false-positive row below is paired with a true-positive row: the real
// invocation must STILL be caught.

import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { stripHeredocs, stripQuotedSpans, stripNonCode } from '../../../../plugin/bin/lib/shell-text.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { stripNonExecutedText, LANE_INVOCATIONS } from '../../../../plugin/bin/lib/wt-lane-saturation-core.mjs'

const CLI = 'open' + 'code'
const INVOCATION = `${CLI} run --model openai/gpt-5.4 "a question"`

/** What the lane-consent gate asks: is this command a real external-lane invocation? */
function readsAsLaneInvocation(command: string): boolean {
  const stripped = stripNonExecutedText(command)
  return (LANE_INVOCATIONS as RegExp[]).some((re) => re.test(stripped))
}

describe('stripHeredocs', () => {
  it('removes a quoted-delimiter heredoc body, which is where the invocation was hiding', () => {
    const cmd = `cat > f.ts <<'EOF'\nconst c = '${INVOCATION}'\nEOF`
    expect(stripHeredocs(cmd)).not.toContain(INVOCATION)
  })

  it('handles the bare, dash and double-quoted delimiter forms', () => {
    for (const open of ['<<EOF', '<<-EOF', '<<"EOF"', "<<'EOF'"]) {
      const cmd = `cat > f <<${open.slice(2)}\n${INVOCATION}\nEOF`
      expect(stripHeredocs(cmd), open).not.toContain(INVOCATION)
    }
  })

  it('leaves a command with no heredoc completely untouched', () => {
    expect(stripHeredocs(INVOCATION)).toBe(INVOCATION)
  })
})

describe('stripQuotedSpans', () => {
  it('empties single- and double-quoted spans', () => {
    expect(stripQuotedSpans(`echo 'a mentioned command'`)).toBe("echo ''")
    expect(stripQuotedSpans(`echo "a mentioned command"`)).toBe('echo ""')
  })

  // ⚠ The invocation used elsewhere in this file carries its own double quotes, so wrapping it
  // gives NESTED quotes and no single exact output. Assert the PROPERTY that matters — the
  // command word is gone — rather than a string the fixture's own punctuation decides.
  it('removes the command word even when the quoted text carries quotes of its own', () => {
    expect(stripQuotedSpans(`echo '${INVOCATION}'`)).not.toContain(CLI)
  })
})

describe('stripNonCode applies heredocs BEFORE quotes', () => {
  // The order is load-bearing: a heredoc body can contain a quote that would otherwise pair with
  // a quote outside it and swallow real code between them.
  it('does not let a lone quote inside a heredoc body swallow what follows', () => {
    const cmd = `cat > f <<'EOF'\nit's fine\nEOF\ngit push --force`
    expect(stripNonCode(cmd)).toContain('git push --force')
  })
})

describe('the lane gate no longer refuses a fixture that merely MENTIONS an invocation', () => {
  // ⚠ THE discriminating case, and it took a red proof to find it. The invocation must sit BARE
  // in the heredoc body — the shape a prose comment or a markdown backtick span produces. An
  // invocation written inside QUOTES in the body is already handled by the quote-stripper, with
  // or without the heredoc fix, so a fixture using the quoted form passes either way and locks
  // nothing. Measured 2026-08-28: quoted-in-heredoc false both ways; bare-in-heredoc true without
  // the fix, false with it. That is the row that fails when the fix is removed.
  it('does not read a BARE invocation inside a heredoc body as an invocation', () => {
    const writingAFixture = `cat > test.ts <<'EOF'\n// see ${INVOCATION} for the shape\nEOF`
    expect(readsAsLaneInvocation(writingAFixture)).toBe(false)
  })

  it('does not read a quoted mention as an invocation either', () => {
    expect(readsAsLaneInvocation(`echo "about to run ${INVOCATION}"`)).toBe(false)
  })

  // ⚠ The paired row. Without it, a stripper that removed everything would pass the two above.
  it('STILL reads a real invocation as one', () => {
    expect(readsAsLaneInvocation(INVOCATION)).toBe(true)
  })

  it('STILL reads a real invocation that follows a heredoc in the same command', () => {
    const cmd = `cat > f <<'EOF'\njust data\nEOF\n${INVOCATION}`
    expect(readsAsLaneInvocation(cmd)).toBe(true)
  })
})
