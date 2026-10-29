import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-find-newermt-format-guard-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')
const WRAPPED_NATURAL_LANGUAGE_COMMANDS = [
  'if find . -newermt yesterday; then :; fi',
  'sudo find . -newermt yesterday',
  'time find . -newermt yesterday',
  'env X=1 find . -newermt yesterday',
  '! find . -newermt yesterday',
  'xargs find . -newermt yesterday',
  '{ find . -newermt yesterday; }',
  'while find . -newermt yesterday; do :; done',
  '2>/dev/null find . -newermt "5 minutes ago"',
  'if true; then find . -newermt yesterday; fi',
]

function run(command: string, event = 'PreToolUse', tool = 'Bash') {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      hook_event_name: event,
      tool_name: tool,
      tool_input: { command },
    }),
    encoding: 'utf8',
  })
  return {
    // This guard ships WARN-ONLY — it never emits a "deny" decision.
    warned: res.stdout.includes('hookSpecificOutput'),
    denied: res.stdout.includes('"deny"'),
    stdout: res.stdout,
    stderr: res.stderr,
    status: res.status,
  }
}

describe('wt-find-newermt-format-guard-hook', () => {
  it('WARN: a natural-language -newermt argument is flagged', () => {
    const r = run('find . -newermt "5 minutes ago" 2>/dev/null | wc -l')
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.stdout).toContain('5 minutes ago')
    expect(r.status).toBe(0)
  })

  it('WARN: a relative shorthand form is flagged', () => {
    const r = run("find . -newermt '-20 seconds' -type f")
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })

  it('SILENT: an ISO-8601 date-only argument', () => {
    const r = run('find . -newermt "2026-08-06"')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENT: an ISO-8601 full timestamp built via command substitution', () => {
    const r = run(
      "find . -newermt \"$(date -d '5 minutes ago' +%Y-%m-%dT%H:%M:%S)\"",
    )
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('WARN (known false-positive family, documented and accepted): a heredoc body merely documenting the trap still fires, because this guard reasons about the raw string and cannot tell prose from a real invocation', () => {
    const r = run(
      [
        "cat <<'EOF'",
        'find . -newermt "5 minutes ago" silently finds nothing on bfs.',
        'EOF',
      ].join('\n'),
    )
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
  })

  it('stays out of the way for an ordinary find with no -newermt', () => {
    const r = run('find . -name "*.ts"')
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('is registered as a PreToolUse hook on Bash in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const entries = manifest.hooks?.PreToolUse ?? []
    const wired = entries
      .filter((e: { matcher?: string }) => e.matcher === 'Bash')
      .flatMap((e: { hooks?: { command?: string }[] }) => e.hooks ?? [])
      .some((h: { command?: string }) =>
        h.command?.includes('wt-find-newermt-format-guard-hook.mjs'),
      )
    expect(wired).toBe(true)
  })
})

describe('offset-bearing advice and timestamp warnings', () => {
  it('advertises an offset-bearing safe form in every example and explains the DST ambiguity', () => {
    const r = run('find . -newermt "5 minutes ago"')
    const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext
    expect(context).toContain('+%Y-%m-%dT%H:%M:%S%:z')
    expect(context).toContain('ambiguous local time at a DST fall-back')
    const source = readFileSync(HOOK, 'utf8')
    const formats = source.match(/\+%Y-%m-%dT%H:%M:%S(?:%:z)?/g)
    expect(formats).toEqual(Array(3).fill('+%Y-%m-%dT%H:%M:%S%:z'))
    const comments = source.slice(0, source.indexOf('\nimport '))
      .split(/\n\/\/\n/).filter((block) => block.includes('+%Y-%m-%dT%H:%M:%S'))
    expect(comments).toHaveLength(2)
    for (const block of comments) {
      expect(block).toContain('+%Y-%m-%dT%H:%M:%S%:z')
      expect(block).toContain('ambiguous local time at a DST fall-back')
    }
  })

  it.each([
    '2026-10-25T01:10:59',
    '"2026-10-25 01:10:59"',
  ])('WARN: an offsetless timestamp literal %s', (argument) => {
    const r = run(`find . -newermt ${argument}`)
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.stdout).toContain('+%Y-%m-%dT%H:%M:%S%:z')
    expect(r.status).toBe(0)
  })
})

describe('unambiguous timestamp and epoch literals', () => {
  it.each([
    '2026-10-25T01:10:59Z',
    '"2026-10-25 01:10:59Z"',
    '2026-10-25T01:10:59+01:00',
    '"2026-10-25 01:10:59+01:00"',
    '2026-10-25T01:10:59-04:00',
    "'2026-10-25 01:10:59-04:00'",
    '@1792887059',
    '@-1',
    '@1792887059.123',
    '@-1.25',
  ])('SILENT: an unambiguous instant %s', (argument) => {
    const r = run(`find . -newermt ${argument}`)
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
  })
})

describe('unknown shell-variable values', () => {
  it.each([
    { argument: '$T', warned: false },
    { argument: '"$T"', warned: false },
    { argument: '${T}', warned: false },
    { argument: '"${T}"', warned: false },
    { argument: '$T-suffix', warned: true },
    { argument: '"$T-suffix"', warned: true },
    { argument: '${T}-suffix', warned: true },
    { argument: '"${T}-suffix"', warned: true },
  ])(
    'a shell-variable argument $argument warns=$warned',
    ({ argument, warned }) => {
      const r = run(`find . -newermt ${argument}`)
      expect(r.warned).toBe(warned)
      if (!warned) expect(r.stdout).toBe('')
      expect(r.denied).toBe(false)
      expect(r.status).toBe(0)
    },
  )

  it('checks later -newermt arguments after a date and a shell variable', () => {
    const r = run('find . -newermt 2026-08-06 -newermt $T -newermt "2026-10-25 01:10:59"')
    expect(r.warned).toBe(true)
    expect(r.stdout).toContain('2026-10-25 01:10:59')
    expect(r.denied).toBe(false)
  })

  it('reports the first unsafe argument when multiple arguments are unsafe', () => {
    const r = run('find . -newermt yesterday -newermt tomorrow')
    const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext
    expect(context).toContain('find -newermt "yesterday"')
    expect(context).not.toContain('tomorrow')
    expect(r.denied).toBe(false)
  })
})

describe('shell argument boundaries', () => {
  it.each([';', '&&', '|', ')', '\n'].flatMap((separator) =>
    ['$T', '"$T"', '2026-10-25T01:10:59Z', '2026-10-25T01:10:59+01:00',
      '2026-10-25T01:10:59-04:00'].map((argument) => ({ separator, argument })),
  ))('SILENT: $argument followed immediately by $separator', ({ argument, separator }) => {
    const r = run(`find . -newermt ${argument}${separator} echo done`)
    expect(r.stdout).toBe('')
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })

  it.each(['"2026-10-25"T01:10:59', "'2026-10-25'T01:10:59"])(
    'WARN: concatenated quote segments form the offsetless timestamp %s', (argument) => {
      const r = run(`find . -newermt ${argument}`)
      expect(r.warned).toBe(true)
      expect(r.stdout).toContain('2026-10-25T01:10:59')
      expect(r.stdout).toContain('+%Y-%m-%dT%H:%M:%S%:z')
      expect(r.denied).toBe(false)
      expect(r.status).toBe(0)
    },
  )

  it.each(["'$T'", "'${T}'"])(
    'WARN: single-quoted %s is a visible non-date literal', (argument) => {
      const r = run(`find . -newermt ${argument}`)
      expect(r.warned).toBe(true)
      expect(r.denied).toBe(false)
      expect(r.status).toBe(0)
    },
  )
})

describe('fractional timestamp instants', () => {
  it.each([
    '2026-10-25T01:10:59.123Z',
    '2026-10-25T01:10:59.123+01:00',
    '2026-10-25T01:10:59.123-04:00',
    '"2026-10-25 01:10:59.123Z"',
  ])('SILENT: fractional seconds with an explicit offset %s', (argument) => {
    const r = run(`find . -newermt ${argument}`)
    expect(r.stdout).toBe('')
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })
})

describe('simple-command scope', () => {
  it.each([
    'bash review.sh "find . -newermt yesterday"',
    "bash review.sh 'find . -newermt yesterday; find . -newermt tomorrow'",
    'bash review.sh "subject: find . -newermt yesterday && bfs . -newermt tomorrow"',
    'bash review.sh "subject: find . -newermt yesterday\nfind . -newermt tomorrow"',
    'find . -name "-newermt yesterday"',
    'find . -name safe; echo -newermt yesterday',
    'bfs . -newermt 2026-10-25T01:10:59Z',
  ])('SILENT: %s', (command) => {
    const r = run(command)
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
  })

  it.each([
    'echo find . -newermt yesterday',
    'echo "find . -newermt safe"; find . -newermt yesterday',
    'echo done && /usr/bin/find . -newermt yesterday',
    '(find . -newermt yesterday)',
    'bfs . -newermt yesterday',
  ])('WARN: an actual find or bfs simple command in %s', (command) => {
    const r = run(command)
    expect(r.warned).toBe(true)
    expect(r.stdout).toContain('yesterday')
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })
})

describe('visible find words across shell contexts', () => {
  it.each([
    'if find . -newermt 2026-10-25T01:10:59; then :; fi',
    'if true; then find . -newermt 2026-10-25T01:10:59; fi',
    '2>/dev/null find . -newermt 2026-10-25T01:10:59',
  ])('WARN: an offsetless timestamp after shell syntax in %s', (command) => {
    const r = run(command)
    expect(r.warned).toBe(true)
    expect(r.stdout).toContain('2026-10-25T01:10:59')
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })

  it.each(WRAPPED_NATURAL_LANGUAGE_COMMANDS)('WARN: natural-language regression through %s', (command) => {
    const r = run(command)
    expect(r.warned).toBe(true)
    expect(r.stdout).toContain('+%Y-%m-%dT%H:%M:%S%:z')
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })

  it('WARN: a find on the right of a pipeline is checked', () => {
    const r = run('echo done | find . -newermt 2026-10-25T01:10:59')
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })

  it('SILENT: a pipe resets the preceding find scope', () => {
    const r = run('find . -name safe | echo -newermt yesterday')
    expect(r.stdout).toBe('')
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })
})

describe('comments, quoted predicates and continuations', () => {
  it.each([
    'find . -newermt 2026-10-25T01:10:59Z # -newermt yesterday',
    'find . -newermt 2026-10-25T01:10:59Z # " -newermt yesterday',
    'echo safe # find . -newermt yesterday',
    'find . -name "-newermt" -print',
    "find . -name '-newermt' -print",
    'find . -name -newer"mt" -print',
    'find . -newermt "2026-10-25T01:10:59\\\nZ"',
  ])('SILENT: shell data is not an unsafe predicate in %s', (command) => {
    const r = run(command)
    expect(r.stdout).toBe('')
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })

  it.each([
    'echo safe # ignored\nfind . -newermt yesterday',
    'find . -newermt 2026-10-25T01:10:59Z # ignored\nfind . -newermt yesterday',
    'find . -newermt yesterday#suffix',
    'find . -newermt "#yesterday"',
    'find . -newermt \\#yesterday',
  ])('WARN: comments end at newline and require an unquoted word start in %s', (command) => {
    const r = run(command)
    expect(r.warned).toBe(true)
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })
})

describe('hook delivery filters', () => {
  it.each([
    { event: 'PostToolUse', tool: 'Bash' },
    { event: 'PreToolUse', tool: 'Read' },
  ])('SILENT: event=$event tool=$tool', ({ event, tool }) => {
    const r = run('find . -newermt yesterday', event, tool)
    expect(r.stdout).toBe('')
    expect(r.denied).toBe(false)
    expect(r.status).toBe(0)
  })
})
