import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { stripHeredocs, stripQuotedSpans, stripNonCode } from '../../../../plugin/bin/lib/command-invocation.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { stripNonExecutedText, LANE_INVOCATIONS } from '../../../../plugin/bin/lib/wt-lane-saturation-core.mjs'

const CLI = 'open' + 'code'
const INVOCATION = `${CLI} run --model openai/gpt-5.4 "a question"`

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

  it('removes the command word even when the quoted text carries quotes of its own', () => {
    expect(stripQuotedSpans(`echo '${INVOCATION}'`)).not.toContain(CLI)
  })
})

describe('stripNonCode applies heredocs BEFORE quotes', () => {
  it('does not let a lone quote inside a heredoc body swallow what follows', () => {
    const cmd = `cat > f <<'EOF'\nit's fine\nEOF\ngit push --force`
    expect(stripNonCode(cmd)).toContain('git push --force')
  })
})

describe('the lane gate no longer refuses a fixture that merely MENTIONS an invocation', () => {
  it('does not read a BARE invocation inside a heredoc body as an invocation', () => {
    const writingAFixture = `cat > test.ts <<'EOF'\n// see ${INVOCATION} for the shape\nEOF`
    expect(readsAsLaneInvocation(writingAFixture)).toBe(false)
  })

  it('does not read a quoted mention as an invocation either', () => {
    expect(readsAsLaneInvocation(`echo "about to run ${INVOCATION}"`)).toBe(false)
  })

  it('STILL reads a real invocation as one', () => {
    expect(readsAsLaneInvocation(INVOCATION)).toBe(true)
  })

  it('STILL reads a real invocation that follows a heredoc in the same command', () => {
    const cmd = `cat > f <<'EOF'\njust data\nEOF\n${INVOCATION}`
    expect(readsAsLaneInvocation(cmd)).toBe(true)
  })
})
