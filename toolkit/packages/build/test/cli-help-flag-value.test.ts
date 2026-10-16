// cli-help-flag-value.test.ts — locks the INVARIANT "`--help` / `-h` is help only in FLAG position,
// where flag position is decided by walking the CLI's declared grammar".
//
// The defect this guards: the shared helper used `argv.includes('--help')`, so a value spelled
// `--help` for a value-taking flag (`wt-stale-date-guard --today --help`,
// `wt-check-commit-signatures --range --help`) printed usage and exited 0. Several of these CLIs
// are guards whose exit 0 is read as "pass" by a hook. A first fix judged position from how the
// PREVIOUS TOKEN was spelled; a cross-family review showed that both refuses legitimate help and
// lets commands run, so the helper now walks argv like the parser, from a grammar every caller
// declares in full.
//
// Locks, each over a POPULATION rather than an enumeration:
//   1. the walk itself (`inspectHelpRequest`), as a table with explicit grammars;
//   2. every reviewer counterexample, through the real CLI, with its expected outcome;
//   3. the guards: a value spelled `--help` / `-h` reaches the parser (no usage AND non-zero exit);
//   4. grammar consistency, read from the sources in both directions;
//   5. every declared VALUE flag of every helper CLI, behaviourally;
//   6. the sweep: an undeclared option next to a help token is refused by every helper CLI;
//   7. compatibility locks: boolean flags still accept help (these also pass on the old helper).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { inspectHelpRequest, isHelpRequested } from '../../../../plugin/bin/lib/cli-help.mjs'
import { allOperatorCliFiles, BIN_DIR, JUSTIFIED_EXCLUSIONS } from './helpers/operator-cli-population.js'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'

const SPELLINGS = ['--help', '-h'] as const
const roots: string[] = []
afterAll(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function tempRoot(tag: string): string {
  const r = mkdtempSync(join(tmpdir(), `wt-cli-help-fv-${tag}-`))
  roots.push(r)
  return r
}

interface CliRun {
  status: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** The sealed state root of this run (XDG_STATE_HOME is `<root>/state`). */
  root: string
}

/** Spawn a plugin/bin CLI sealed from the real machine, in a throwaway cwd, with a hard timeout so
 *  a CLI that (wrongly) starts work cannot hang the suite. stdin is closed. */
function runCli(file: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): CliRun {
  const root = tempRoot('env')
  const r = spawnSync(process.execPath, [join(BIN_DIR, file), ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? tempRoot('cwd'),
    env: sealedPluginCliEnv(root, { WT_GUARD_JOURNAL_DIR: tempRoot('journal'), ...opts.env }),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
    killSignal: 'SIGKILL',
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: r.error !== undefined, root }
}

const referenceHelp = new Map<string, string>()
/** The CLI's own usage text, read from `<cli> --help` — the control every "does not print usage"
 *  assertion compares against. It must be non-empty, or "stdout lacks the usage" would hold for a
 *  CLI that prints nothing at all. */
function usageOf(file: string): string {
  let text = referenceHelp.get(file)
  if (text === undefined) {
    const r = runCli(file, ['--help'])
    expect(r.timedOut, `${file} --help timed out`).toBe(false)
    text = r.stdout.trim()
    expect(text.length, `${file} --help printed nothing, so it gives no reference to compare against`).toBeGreaterThan(0)
    referenceHelp.set(file, text)
  }
  return text
}

// ---------------------------------------------------------------------------------------------
// The grammar of every helper CLI is read from its OWN source (the literal passed to
// handleHelpFlag), never kept as a second table here.
interface Grammar {
  valueFlags: string[]
  booleanFlags: string[]
}
function readList(source: string, key: 'valueFlags' | 'booleanFlags'): string[] | null {
  const m = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(source)
  return m ? [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] ?? '') : null
}
const HELPER_IMPORT = /from '\.\/lib\/cli-help\.mjs'/
const helperUsers: string[] = allOperatorCliFiles().filter((f) => HELPER_IMPORT.test(readFileSync(join(BIN_DIR, f), 'utf8')))
function grammarOf(file: string): Grammar {
  const source = readFileSync(join(BIN_DIR, file), 'utf8')
  const valueFlags = readList(source, 'valueFlags')
  const booleanFlags = readList(source, 'booleanFlags')
  if (valueFlags === null || booleanFlags === null) throw new Error(`${file} imports cli-help but declares no { valueFlags, booleanFlags } literal`)
  return { valueFlags, booleanFlags }
}

// Subcommand CLIs: the first subcommand each accepts, used to build `[subcommand, ...]` shapes, and
// the prefix a flag needs to be exercised at all. Their grammar is the UNION over subcommands.
const SUBCOMMAND: Record<string, string> = {
  'wt-artifact-server.mjs': 'serve',
  'wt-grounding-sources.mjs': 'list',
  'wt-pilot-fidelity.mjs': 'verify',
  'wt-crossos-dispatch.mjs': 'release-check',
}

describe('inspectHelpRequest — the grammar walk, as a table', () => {
  const grammar = { valueFlags: ['--path', '--today'], booleanFlags: ['--json'] }

  const help: Array<[string, string[]]> = [
    ['--help first', ['--help']],
    ['-h first', ['-h', '--zz']],
    ['--help after a positional', ['list', '--help']],
    ['-h after a positional', ['list', '-h']],
    ['--help after a lone dash (a positional)', ['-', '--help']],
    ['--help after a declared boolean', ['--json', '--help']],
    ['-h after a declared boolean', ['--json', '-h']],
    ['--help after a value flag and its value', ['--path', 'x', '--help']],
    ['--help after a value that LOOKS like an option', ['--path', '--weird', '--help']],
    ['-h after a value that looks like a short option', ['--path', '-x', '-h']],
    ['--help after a value that is a consumed --', ['--path', '--', '--help']],
    ['--help after a value that is a negative number', ['--today', '-5', '--help']],
  ]
  it.each(help)('%s -> help', (_label, argv) => {
    expect(inspectHelpRequest(argv, grammar)).toEqual({ kind: 'help' })
    expect(isHelpRequested(argv, grammar)).toBe(true)
  })

  const valueHelp: Array<[string, string[]]> = [
    ['a value flag followed by --help', ['--path', '--help']],
    ['a value flag followed by -h', ['--path', '-h']],
    ['the second value flag followed by --help', ['--path', 'x', '--today', '--help']],
    ['the second value flag followed by -h', ['--path', 'x', '--today', '-h']],
  ]
  it.each(valueHelp)('%s -> the help token is a VALUE, not help', (_label, argv) => {
    expect(inspectHelpRequest(argv, grammar)).toEqual({ kind: 'none' })
    expect(isHelpRequested(argv, grammar)).toBe(false)
  })

  const refused: Array<[string, string[], string]> = [
    ['an undeclared long option', ['--zz', '--help'], '--zz'],
    ['an undeclared short option', ['-x', '-h'], '-x'],
    ['--name=v with an undeclared name', ['--zz=v', '--help'], '--zz=v'],
    ['--name=v with a DECLARED name (equals syntax is not understood: what it consumes is unknowable)', ['--path=x', '--help'], '--path=x'],
    ['--name=v with a declared name, then -h', ['--path=x', '-h'], '--path=x'],
    ['a boolean written --json=1 (only a VALUE flag takes =)', ['--json=1', '--help'], '--json=1'],
    ['a negative number in option position', ['-5', '--help'], '-5'],
    ['the -- terminator when the CLI does not declare endOfOptions', ['--', '--help'], '--'],
    ['an undeclared option after a positional and a declared value', ['list', '--path', 'x', '--zz', '--help'], '--zz'],
    ['an undeclared option that precedes a help which is later consumed as a value', ['--zz', '--path', '--help'], '--zz'],
  ]
  it.each(refused)('%s next to a help token -> refusal naming the token', (_label, argv, token) => {
    expect(inspectHelpRequest(argv, grammar)).toEqual({ kind: 'unknown-option', token })
    expect(isHelpRequested(argv, grammar)).toBe(false)
  })

  it('an undeclared option WITHOUT any help token is none: the CLI parser decides, as before', () => {
    expect(inspectHelpRequest(['--zz', '--json', 'x', '-5'], grammar)).toEqual({ kind: 'none' })
    expect(inspectHelpRequest([], grammar)).toEqual({ kind: 'none' })
  })

  it('help wins over an undeclared option that comes AFTER it', () => {
    expect(inspectHelpRequest(['--help', '--zz'], grammar)).toEqual({ kind: 'help' })
  })

  describe('endOfOptions: true — a literal -- ends options', () => {
    const withEnd = { ...grammar, endOfOptions: true }
    it('-- then --help is data, so none', () => {
      expect(inspectHelpRequest(['run', '--', '--help'], withEnd)).toEqual({ kind: 'none' })
      expect(inspectHelpRequest(['--', '-h'], withEnd)).toEqual({ kind: 'none' })
    })
    it('a value flag still consumes -- as its value, and the next --help is help', () => {
      expect(inspectHelpRequest(['--path', '--', '--help'], withEnd)).toEqual({ kind: 'help' })
    })
    it('help BEFORE the -- still counts', () => {
      expect(inspectHelpRequest(['--help', '--', 'x'], withEnd)).toEqual({ kind: 'help' })
    })
    it('a value flag that consumes -- leaves the next --help in option position (run-gate: `--check -- --help`)', () => {
      expect(inspectHelpRequest(['--path', '--', '--help'], withEnd)).toEqual({ kind: 'help' })
      expect(inspectHelpRequest(['--path', 'n', '--', 'tool', '--help'], withEnd)).toEqual({ kind: 'none' })
    })
  })

  describe('the grammar argument is required and validated', () => {
    const bad: Array<[string, unknown]> = [
      ['missing', undefined],
      ['null', null],
      ['an array', []],
      ['no valueFlags', { booleanFlags: [] }],
      ['no booleanFlags', { valueFlags: [] }],
      ['valueFlags not an array', { valueFlags: '--path', booleanFlags: [] }],
      ['a flag that is not an option name', { valueFlags: ['path'], booleanFlags: [] }],
      ['a flag declared as both value and boolean', { valueFlags: ['--x'], booleanFlags: ['--x'] }],
      ['--help declared as an option', { valueFlags: [], booleanFlags: ['--help'] }],
      ['endOfOptions not a boolean', { valueFlags: [], booleanFlags: [], endOfOptions: 'yes' }],
    ]
    it.each(bad)('%s throws a TypeError, even when argv holds no help token', (_label, value) => {
      // `never` is assignable to any parameter type: the runtime guard is what is under test
      expect(() => inspectHelpRequest(['x'], value as never)).toThrow(TypeError)
    })
  })
})

// ---------------------------------------------------------------------------------------------
// Reviewer counterexamples, through the real CLI.
describe('every cross-family review counterexample, with its expected outcome', () => {
  const stateFiles = (root: string): string[] => {
    const out: string[] = []
    const walk = (dir: string) => {
      if (!existsSync(dir)) return
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else out.push(p)
      }
    }
    walk(join(root, 'state'))
    return out
  }

  const expectHelp = (file: string, r: CliRun) => {
    expect(r.timedOut).toBe(false)
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    expect(r.stdout.trim()).toBe(usageOf(file))
  }
  const expectRefusal = (file: string, r: CliRun, token: string) => {
    expect(r.timedOut).toBe(false)
    expect(r.status, `stdout: ${r.stdout}`).toBe(2)
    expect(r.stderr).toContain(`unknown option ${token}`)
    expect(r.stdout).not.toContain(usageOf(file))
  }

  const helpRows: Array<[string, string, string[]]> = [
    ['an option-looking VALUE then help', 'wt-stale-date-guard.mjs', ['--path', '--weird', '--help']],
    ['a consumed -- then help', 'wt-stale-date-guard.mjs', ['--path', '--', '--help']],
    ['an option-looking value (--version) then help', 'wt-command-repeat-check.mjs', ['--command', '--version', '--help']],
    ['a short-option-looking value then help', 'wt-changelog-entry.mjs', ['--summary', '-x', '--help']],
    ['a short-option-looking value then -h', 'wt-changelog-entry.mjs', ['--summary', '-x', '-h']],
    ['an inherited object name is a positional once the parser reads own properties only', 'wt-crossos-dispatch.mjs', ['release-check', 'constructor', '--help']],
    ['the other inherited name, with -h', 'wt-crossos-dispatch.mjs', ['release-check', 'toString', '-h']],
  ]
  it.each(helpRows)('HELP (exit 0, usage): %s — %s %j', (_label, file, args) => {
    expectHelp(file, runCli(file, args))
  })

  it('REFUSAL, nothing started: `wt-artifact-server serve --unknown --help` (it used to start the server)', () => {
    const r = runCli('wt-artifact-server.mjs', ['serve', '--unknown', '--help'])
    expectRefusal('wt-artifact-server.mjs', r, '--unknown')
    expect(stateFiles(r.root), 'a listener would have written its discovery/state files').toEqual([])
  })

  it('REFUSAL, file never read: `wt-intake-triage --cards <file> --unknown --help` (it used to parse the file)', () => {
    const cwd = tempRoot('cards')
    const cards = join(cwd, 'cards.json')
    writeFileSync(cards, '{ not json')
    const r = runCli('wt-intake-triage.mjs', ['--cards', cards, '--unknown', '--help'], { cwd })
    expectRefusal('wt-intake-triage.mjs', r, '--unknown')
    expect(r.stderr, 'the command ran: it reached the JSON parse').not.toMatch(/JSON|position/i)
  })

  it('REFUSAL (a dash-prefixed positional is read as an option, the POSIX reading; `./-report.md` is the spelling for a path), report never checked: `wt-report-findings-check -report.md --help`', () => {
    const cwd = tempRoot('report')
    writeFileSync(join(cwd, '-report.md'), '# Report\n')
    const r = runCli('wt-report-findings-check.mjs', ['-report.md', '--help'], { cwd })
    expectRefusal('wt-report-findings-check.mjs', r, '-report.md')
    expect(r.stdout, 'the command ran: it printed a findings verdict').not.toContain('findings:')
  })

  it('REFUSAL, exit 2 instead of usage/0: `wt-check-observer-pairing --bogus=x --help`', () => {
    const r = runCli('wt-check-observer-pairing.mjs', ['--bogus=x', '--help'])
    expectRefusal('wt-check-observer-pairing.mjs', r, '--bogus=x')
    expect(r.stdout, 'the parser ran and produced a verdict').not.toContain('"status"')
  })

  // Its parser skips the token after ANY `--` token, `--name=x` included, so equals syntax is not
  // a thing the helper may assume even for a DECLARED name: refused, exit 2, no usage.
  it.each(SPELLINGS)('REFUSAL (equals syntax is not supported by any parser): `wt-check-observer-pairing --name=x %s`', (spelling) => {
    const r = runCli('wt-check-observer-pairing.mjs', ['--name=x', spelling])
    expectRefusal('wt-check-observer-pairing.mjs', r, '--name=x')
    expect(r.stdout, 'the parser ran and produced a verdict').not.toContain('"status"')
  })

  describe('wt-run-gate: the helper sees the whole argv, so a `--` that a value flag consumes is not a terminator', () => {
    it.each(SPELLINGS)('HELP (exit 0, usage): `wt-run-gate --check -- %s` (`--` is the value of --check)', (spelling) => {
      expectHelp('wt-run-gate.mjs', runCli('wt-run-gate.mjs', ['--check', '--', spelling]))
    })

    it.each(SPELLINGS)('NOT HELP: `wt-run-gate --name n -- <cmd> … %s` runs the command and passes its own exit code through', (spelling) => {
      const outDir = tempRoot('gate-out')
      // `process.argv[1]` is what follows node's own `--`; the command exits 3 when it was handed the help token
      const probe = `process.exit(process.argv[1] === ${JSON.stringify(spelling)} ? 3 : 4)`
      const r = runCli('wt-run-gate.mjs', ['--name', 'n', '--out-dir', outDir, '--', process.execPath, '-e', probe, '--', spelling])
      expect(r.timedOut).toBe(false)
      expect(r.stdout, 'run-gate printed its own usage instead of running the command').not.toContain(usageOf('wt-run-gate.mjs'))
      expect(r.stdout).toContain('GATE n: exit=3')
      expect(readFileSync(join(outDir, 'n.exit'), 'utf8').trim()).toBe('3')
    })
  })

  it('PARSER: crossos-dispatch reads option names by OWN property (`constructor` is not an option)', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const r = runCli('wt-crossos-dispatch.mjs', ['release-check', name, 'value'])
      expect(r.status, r.stdout).toBe(2)
      expect(r.stdout, `${name} must be refused as an unknown option`).toContain(`unknown or missing option: ${name}`)
    }
  })

  it('PARSER: artifact-server `serve` takes no arguments, and `url` takes one path (and --remote) only', () => {
    for (const args of [['serve', 'extra'], ['serve', '--zz'], ['url', 'a', 'b'], ['url', '--zz', 'a'], ['url', 'a', '--zz']]) {
      const r = runCli('wt-artifact-server.mjs', args)
      expect(r.timedOut, `${args.join(' ')} did not return`).toBe(false)
      expect(r.status, `${args.join(' ')}: ${r.stderr}`).toBe(2)
      expect(r.stderr).toContain('usage:')
      expect(stateFiles(r.root)).toEqual([])
    }
  })

  // The round-2 `startsWith('--')` refusal removed path spellings the old code accepted. The old
  // `urlCommand` (git show 1075adda:plugin/bin/wt-artifact-server.mjs) took the first argument that
  // is not `--remote` and passed `path.resolve(it)` to artifactUrlResult, whatever it looked like. So
  // `url --report.md` is the same call as `url ./--report.md`: same stdout, stderr and exit code, and
  // never the usage text.
  it('PARSER: `url --report.md` (no help token) reaches artifactUrlResult exactly like `url ./--report.md`, as before the change', () => {
    const cwd = tempRoot('url')
    const bare = runCli('wt-artifact-server.mjs', ['url', '--report.md'], { cwd })
    const dotted = runCli('wt-artifact-server.mjs', ['url', './--report.md'], { cwd })
    expect(bare.timedOut).toBe(false)
    expect(bare.stderr, 'the usage refusal was reintroduced').not.toContain('usage:')
    expect(bare.status, 'exit 2 is the usage refusal; the old code never answered 2 here').not.toBe(2)
    expect({ status: bare.status, stdout: bare.stdout, stderr: bare.stderr }).toEqual({
      status: dotted.status,
      stdout: dotted.stdout,
      stderr: dotted.stderr,
    })
  })
})

// ---------------------------------------------------------------------------------------------
// Guards: the value of a value-taking flag is spelled `--help` / `-h`. It must reach the parser:
// no usage AND a non-zero exit (a 0 here would read as "the guard passed"). Every row measured:
// none of these has a correct answer of 0 in the sealed temp environment.
const GUARD_VALUES: Array<{ file: string; args: string[] }> = [
  { file: 'wt-check-commit-signatures.mjs', args: ['--range'] },
  { file: 'wt-stale-date-guard.mjs', args: ['--today'] },
  { file: 'wt-memory-index-check.mjs', args: ['--store'] },
  { file: 'wt-spawn-registry-scan.mjs', args: ['--session'] },
  { file: 'wt-check-observer-pairing.mjs', args: ['--name'] },
  { file: 'wt-run-gate.mjs', args: ['--check'] },
  { file: 'wt-pilot-fidelity.mjs', args: ['verify', '--root'] },
  { file: 'wt-crossos-dispatch.mjs', args: ['release-check', '--ref'] },
]

describe('a guard given a flag VALUE spelled --help / -h does not take the help path and does not exit 0', () => {
  it.each(GUARD_VALUES.flatMap((g) => SPELLINGS.map((s) => [g.file, g.args.join(' '), s, g] as const)))(
    '%s %s %s',
    (file, _args, spelling, g) => {
      const usage = usageOf(file)
      const r = runCli(file, [...g.args, spelling])
      expect(r.timedOut, `${file} did not return within the timeout`).toBe(false)
      expect(r.stdout, `stdout carried the usage text (status ${r.status}, stderr: ${r.stderr})`).not.toContain(usage)
      expect(r.status, `exit 0 is read as "pass" by the consumers of ${file}; stdout: ${r.stdout} stderr: ${r.stderr}`).not.toBe(0)
    },
  )

  it('wt-check-commit-signatures --range --help exits non-zero in a real git repository (the card lock: exit 0 is "pass")', () => {
    const repo = tempRoot('repo')
    // An empty file, not os.devNull: Git for Windows exits 128 on GIT_CONFIG_GLOBAL set to the \\.\nul device.
    const emptyConfig = join(tempRoot('cfg'), 'empty.gitconfig')
    writeFileSync(emptyConfig, '')
    const git = (...a: string[]) =>
      spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...a], {
        encoding: 'utf8',
        env: { ...process.env, HOME: repo, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' },
      })
    expect(git('init', '-q').status).toBe(0)
    expect(git('commit', '-q', '--allow-empty', '-m', 'one').status).toBe(0)
    for (const spelling of [...SPELLINGS, '--all', '--']) {
      const r = runCli('wt-check-commit-signatures.mjs', ['--repo', repo, '--range', spelling], { cwd: repo })
      expect(r.timedOut).toBe(false)
      expect(r.status, `stdout: ${r.stdout} stderr: ${r.stderr}`).toBe(2)
      expect(r.stderr).toContain('--range must not start with "-"')
      expect(r.stdout).not.toContain(usageOf('wt-check-commit-signatures.mjs'))
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Grammar consistency, read from the sources, both directions.
const EXTRA_PARSER_SOURCES: Record<string, string[]> = {
  'wt-crossos-dispatch.mjs': ['lib/crossos-dispatch.mjs'],
}
// `--name` string literals a CLI source compares against that are NOT options of that CLI (arguments
// of a git/gh/claude child process), with the reason. An entry that no longer appears in the source
// is itself a failure, so this list cannot go stale.
const NOT_OPTIONS_OF_THE_CLI: Record<string, { literals: string[]; reason: string }> = {
  'wt-changelog-entry.mjs': { literals: ['--abbrev-ref', '--name-only'], reason: 'arguments of the `git rev-parse` / `git diff` it runs' },
  'wt-check-commit-signatures.mjs': {
    literals: ['--root', '--git-dir', '--get', '--bool', '--not', '--end-of-options'],
    reason: 'arguments of the `git rev-list` / `git config` / `git rev-parse` calls it makes',
  },
  'wt-crossos-dispatch.mjs': {
    literals: [
      '--verify', '--job', '--log', '--parents', '--name-only', '--no-renames', '--get', '--git-path', '--is-ancestor',
      '--delete', '--branch', '--json', '--heads', '--topo-order', '--absolute-git-dir', '--git-common-dir', '--end-of-options',
    ],
    reason: 'arguments of the git and gh commands lib/crossos-dispatch.mjs builds; none is read from its own argv',
  },
  'wt-plugin-eval-gate.mjs': {
    literals: ['--runs', '--ablation', '--no-publish', '--model', '--json', '--report'],
    reason: 'arguments of the nested `claude plugin eval` it spawns; the gate itself takes no arguments',
  },
  'wt-run-gate.mjs': {
    literals: ['--is-inside-work-tree', '--short', '--quiet', '--porcelain'],
    reason: 'arguments of the `git rev-parse` / `git status` calls it makes to sign the tree',
  },
}
function optionLiterals(relativeSource: string): Set<string> {
  const text = readFileSync(join(BIN_DIR, relativeSource), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(?:valueFlags|booleanFlags):\s*\[[^\]]*\]/g, '')
  return new Set([...text.matchAll(/(['"])(--[a-z][a-z0-9-]*)\1/g)].map((m) => m[2] ?? ''))
}

describe('every helper CLI declares exactly the options its parser reads', () => {
  it('discovers helper CLIs, and each declares both lists', () => {
    expect(helperUsers.length).toBeGreaterThan(30)
    for (const f of helperUsers) expect(() => grammarOf(f), f).not.toThrow()
  })

  it.each(helperUsers)('%s: declared flags and parser literals agree, both directions', (file) => {
    const { valueFlags, booleanFlags } = grammarOf(file)
    const declared = new Set([...valueFlags, ...booleanFlags])
    const literals = new Set(optionLiterals(file))
    for (const extra of EXTRA_PARSER_SOURCES[file] ?? []) for (const l of optionLiterals(extra)) literals.add(l)
    const allowed = new Set(NOT_OPTIONS_OF_THE_CLI[file]?.literals ?? [])
    const parserOnly = [...literals].filter((l) => !declared.has(l) && !allowed.has(l))
    const declaredOnly = [...declared].filter((d) => !literals.has(d))
    const staleAllowance = [...allowed].filter((a) => !literals.has(a))
    expect(parserOnly, `${file}: the source compares against these option names but does not declare them`).toEqual([])
    expect(declaredOnly, `${file}: declared but absent from the source`).toEqual([])
    expect(staleAllowance, `${file}: allow-listed literals that no longer appear`).toEqual([])
  })

  it('the not-an-option allow-list names only helper CLIs and carries reasons', () => {
    for (const [file, entry] of Object.entries(NOT_OPTIONS_OF_THE_CLI)) {
      expect(helperUsers.includes(file), `${file} is not a helper CLI`).toBe(true)
      expect(entry.reason.length).toBeGreaterThan(20)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Every declared VALUE flag, behaviourally: `[prefix, V, --help]` — the help token is V's value, so
// no usage. Run sealed, in a temp cwd, under a timeout.
// A flag is excluded ONLY by name, with the reason (it would start a long-lived loop, reach the
// network, or touch a real account). The nine CLIs whose exit code is a verdict can have none.
const LOOP_REASON =
  'With the value `-h` the parser accepts it (it only rejects values that start with `--`) and the CLI STARTS ITS LONG-LIVED WATCH LOOP; ' +
  'the `--help` spelling is refused at once and stays covered.'
const VALUE_FLAG_EXCLUSIONS: Record<string, { flags: string[]; spellings: string[]; reason: string }> = {
  'wt-arc-watch.mjs': { flags: ['--project', '--reports'], spellings: ['-h'], reason: LOOP_REASON },
  'wt-autonomy-watch.mjs': { flags: ['--project'], spellings: ['-h'], reason: LOOP_REASON },
  'wt-cache-keepalive.mjs': { flags: ['--project'], spellings: ['-h'], reason: LOOP_REASON },
  'wt-observer.mjs': { flags: ['--project', '--index'], spellings: ['-h'], reason: LOOP_REASON },
  'wt-service-watch.mjs': { flags: ['--flag', '--url', '--fixture'], spellings: ['-h'], reason: LOOP_REASON },
  'wt-wake-floor.mjs': { flags: ['--project'], spellings: ['-h'], reason: LOOP_REASON },
  'wt-autonomy-arm.mjs': {
    flags: ['--project'],
    spellings: ['-h'],
    reason:
      'With the value `-h` it ARMS a mandate for a project literally named `-h`: it writes mandate state, at a location the ambient ' +
      'WT_AUTONOMY_WATCH_MANDATE_DIR can redirect to a real directory. The `--help` spelling is refused and stays covered.',
  },
}
const VERDICT_CLIS = [
  'wt-check-commit-signatures.mjs', 'wt-check-observer-pairing.mjs', 'wt-memory-index-check.mjs', 'wt-pilot-fidelity.mjs',
  'wt-report-findings-check.mjs', 'wt-spawn-registry-scan.mjs', 'wt-stale-date-guard.mjs', 'wt-run-gate.mjs', 'wt-crossos-dispatch.mjs',
]

describe('a declared value flag followed by --help / -h: the reference usage is never on stdout (no claim about the exit code; the guard table asserts that)', () => {
  it('the exclusion map names real helper CLIs and flags, with reasons, and spares the verdict CLIs', () => {
    for (const [file, entry] of Object.entries(VALUE_FLAG_EXCLUSIONS)) {
      expect(helperUsers.includes(file), `${file} is not a helper CLI`).toBe(true)
      expect(VERDICT_CLIS.includes(file), `${file} is a verdict CLI: every value flag must be covered`).toBe(false)
      expect(entry.reason.length).toBeGreaterThan(20)
      for (const flag of entry.flags) expect(grammarOf(file).valueFlags, `${file} ${flag}`).toContain(flag)
    }
  })

  const excluded = (file: string, flag: string, spelling: string) =>
    VALUE_FLAG_EXCLUSIONS[file]?.flags.includes(flag) === true && VALUE_FLAG_EXCLUSIONS[file]?.spellings.includes(spelling) === true
  const cases = helperUsers.flatMap((file) =>
    grammarOf(file).valueFlags.flatMap((flag) =>
      SPELLINGS.filter((spelling) => !excluded(file, flag, spelling)).map((spelling) => [file, flag, spelling] as const),
    ),
  )
  it.each(cases)('%s %s %s', (file, flag, spelling) => {
    const usage = usageOf(file)
    const sub = SUBCOMMAND[file]
    const r = runCli(file, [...(sub === undefined ? [] : [sub]), flag, spelling])
    expect(r.timedOut, `${file} ${flag} ${spelling} did not return within the timeout`).toBe(false)
    expect(r.stdout, `stdout carried the usage text (status ${r.status}, stderr: ${r.stderr})`).not.toContain(usage)
  })
})

// ---------------------------------------------------------------------------------------------
// Sweep: an option the CLI cannot know about next to a help token is REFUSED by every helper CLI
// (exit 2, the token named, no usage, the command never ran). CLIs that keep their own help
// handling are swept for "no usage" only; one that cannot hold even that goes in the map.
const OWN_HELP_EXCLUSIONS: Record<string, string> = {
  'wt-lane-postdiff-check.mjs':
    'Its own parser consumes the value of every option it knows (`--worktree`, `--out`, `--before`, `--after`, ' +
    '`--brief-paths`) BEFORE it looks at help, and pushes an unknown token to a positional list. ' +
    '`--zz-undeclared --help` is therefore a positional followed by a flag, which that grammar answers with usage.',
}
const PROBE = '--zz-undeclared-cli-help-probe'

describe('the sweep over every operator CLI', () => {
  const files = allOperatorCliFiles()
  const eligible = files.filter((f) => !JUSTIFIED_EXCLUSIONS[f])
  const ownHelp = eligible.filter((f) => !helperUsers.includes(f) && !OWN_HELP_EXCLUSIONS[f])

  it('the exclusion map names only files that still exist and carries real reasons', () => {
    for (const [name, reason] of Object.entries(OWN_HELP_EXCLUSIONS)) {
      expect(files.includes(name), `${name} no longer exists under plugin/bin/`).toBe(true)
      expect(helperUsers.includes(name), `${name} now uses the helper: sweep it with the others`).toBe(false)
      expect(reason.length).toBeGreaterThan(20)
    }
    expect(helperUsers.length + ownHelp.length).toBeGreaterThan(0)
  })

  it.each(helperUsers.flatMap((f) => SPELLINGS.map((s) => [f, s] as const)))(
    '%s: [undeclared option, %s] is refused (exit 2, token named, no usage)',
    (file, spelling) => {
      const r = runCli(file, [PROBE, spelling])
      expect(r.timedOut, `${file} did not return within the timeout`).toBe(false)
      expect(r.status, `stdout: ${r.stdout}`).toBe(2)
      expect(r.stderr).toContain(`unknown option ${PROBE}`)
      expect(r.stdout).not.toContain(usageOf(file))
    },
  )

  const subcommandCases = Object.entries(SUBCOMMAND).flatMap(([file, sub]) => SPELLINGS.map((s) => [file, sub, s] as const))
  it.each(subcommandCases)('%s: [%s, undeclared option, %s] is refused too (the subcommand shape)', (file, sub, spelling) => {
    expect(helperUsers.includes(file), `${file} must use the helper`).toBe(true)
    const r = runCli(file, [sub, PROBE, spelling])
    expect(r.timedOut, `${file} did not return within the timeout`).toBe(false)
    expect(r.status, `stdout: ${r.stdout}`).toBe(2)
    expect(r.stderr).toContain(`unknown option ${PROBE}`)
    expect(r.stdout).not.toContain(usageOf(file))
  })

  it.each(ownHelp.flatMap((f) => SPELLINGS.map((s) => [f, s] as const)))(
    '%s (own help handling): [undeclared option, %s] does not print the usage',
    (file, spelling) => {
      const r = runCli(file, [PROBE, spelling])
      expect(r.timedOut, `${file} did not return within the timeout`).toBe(false)
      expect(r.stdout).not.toContain(usageOf(file))
    },
  )
})

// ---------------------------------------------------------------------------------------------
// wt-grounding-sources: after the walk, `init --typo --help` is refused by the helper; the CLI also
// refuses an unknown token on its own, so the registry is never written by an ignored typo.
describe('wt-grounding-sources refuses an unknown token instead of ignoring it', () => {
  function registryEnv() {
    const dir = tempRoot('registry')
    const registry = join(dir, 'registry', 'grounding-sources.json')
    return { registry, env: { CLAUDE_PLUGIN_OPTION_GROUNDING_SOURCES: registry } }
  }

  it('control: `init` with no typo DOES write the registry (so "nothing written" below can be false)', () => {
    const { registry, env } = registryEnv()
    const r = runCli('wt-grounding-sources.mjs', ['init'], { env })
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    expect(existsSync(registry)).toBe(true)
  })

  it.each(SPELLINGS)('init --zz-typo %s exits non-zero, names the token, and writes nothing', (spelling) => {
    const { registry, env } = registryEnv()
    const r = runCli('wt-grounding-sources.mjs', ['init', '--zz-typo', spelling], { env })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--zz-typo')
    expect(existsSync(registry)).toBe(false)
    expect(r.stdout).not.toContain(usageOf('wt-grounding-sources.mjs'))
  })

  it('WITHOUT a help token the CLI itself refuses a typo (the helper stays out of the way)', () => {
    const { registry, env } = registryEnv()
    const r = runCli('wt-grounding-sources.mjs', ['init', '--zz-typo'], { env })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('unknown argument: --zz-typo')
    expect(existsSync(registry)).toBe(false)
  })

  it('a stray positional after the command is refused too', () => {
    const { registry, env } = registryEnv()
    const r = runCli('wt-grounding-sources.mjs', ['init', 'extra'], { env })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('extra')
    expect(existsSync(registry)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Compatibility locks: help still works right after a declared boolean flag. These ALSO pass on the
// old `includes` helper — they do not prove the value handling, they prove the new walk did not
// take help away from a position every CLI accepts it in.
// A boolean flag that only exists under one subcommand is exercised under it.
const BOOLEAN_PREFIX: Record<string, Record<string, string[]>> = {
  'wt-artifact-server.mjs': { '--remote': ['url'], '--force': ['stop'] },
  'wt-grounding-sources.mjs': { '--dry-run': ['init'], '--json': ['list'] },
  'wt-pilot-fidelity.mjs': { '--require-same-tree': ['verify'], '--require-clean-tree': ['verify'], '--require-head': ['verify'] },
  'wt-crossos-dispatch.mjs': { '--dry-run': ['run'] },
}

describe('compatibility lock: a declared boolean flag does not swallow --help / -h', () => {
  const cases = helperUsers.flatMap((file) =>
    grammarOf(file).booleanFlags.flatMap((flag) => SPELLINGS.map((spelling) => [file, flag, spelling] as const)),
  )
  it.each(cases)('%s: %s %s prints usage and exits 0', (file, flag, spelling) => {
    const prefix = BOOLEAN_PREFIX[file]?.[flag] ?? []
    const r = runCli(file, [...prefix, flag, spelling])
    expect(r.timedOut).toBe(false)
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    expect(r.stdout.trim()).toBe(usageOf(file))
  })
})
