// Hermetic real-git selftests: the guard's evidence is the index and tree, not a mocked diff.
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-gate-evidence-guard-hook.mjs')
const RUN_GATE = join(REPO_ROOT, 'plugin/bin/wt-run-gate.mjs')
const HERMETIC = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const made: string[] = []
const states = new Map<string, string>()

afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
  states.clear()
})

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...HERMETIC } })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

function write(root: string, file: string, body: string) {
  const target = join(root, file)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, body)
}

function repo(withDeclaration = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-gate-evidence-')))
  made.push(root)
  const state = realpathSync(mkdtempSync(join(tmpdir(), `wt-gate-evidence-state-${basename(root)}-`)))
  made.push(state)
  states.set(root, state)
  git(root, 'init', '-q')
  if (withDeclaration) write(root, '.wt-gates.json', JSON.stringify({ gates: [{ name: 'test', command: 'pnpm test', cwd: 'toolkit' }], paths: ['plugin/', 'toolkit/'] }))
  write(root, 'plugin/thing.mjs', '// base\n')
  write(root, 'outside.txt', 'base\n')
  git(root, 'add', '.')
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'base')
  return root
}

function env(root: string) {
  return { ...process.env, ...HERMETIC, WT_GUARD_JOURNAL_DIR: states.get(root), WT_GUARD_JOURNAL_NOW: '2026-09-06T01:00:00.000Z' }
}

function run(root: string, command = 'git commit -m x') {
  const result = spawnSync(process.execPath, [HOOK], {
    cwd: root,
    encoding: 'utf8',
    env: env(root),
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, tool_input: { command } }),
  })
  return { stdout: result.stdout, status: result.status }
}

function record(root: string, exit = 0) {
  const result = spawnSync(process.execPath, [RUN_GATE, '--record', 'test', '--', process.execPath, '-e', `process.exit(${exit})`], {
    cwd: root,
    encoding: 'utf8',
    env: env(root),
  })
  expect(result.status).toBe(exit)
}

function recordFile(root: string) {
  const repoId = createHash('sha256').update(realpathSync.native(root)).digest('hex')
  return join(states.get(root)!, 'wt-gate-records', repoId, 'test.json')
}

describe('wt-gate-evidence-guard-hook', () => {
  it('is silent without a declaration or when staged files are outside declared paths', () => {
    const undeclared = repo(false)
    write(undeclared, 'plugin/thing.mjs', '// changed\n')
    git(undeclared, 'add', 'plugin/thing.mjs')
    expect(run(undeclared).stdout).toBe('')

    const outside = repo()
    write(outside, 'outside.txt', 'changed\n')
    git(outside, 'add', 'outside.txt')
    expect(run(outside).stdout).toBe('')
  })

  it('is silent for a fresh green record and records the wrapper exit and signature', () => {
    const root = repo()
    write(root, 'plugin/thing.mjs', '// changed\n')
    git(root, 'add', 'plugin/thing.mjs')
    record(root)
    expect(run(root).stdout).toBe('')
    expect(JSON.parse(readFileSync(recordFile(root), 'utf8'))).toMatchObject({ name: 'test', exit: 0, command: expect.stringContaining(process.execPath), tree: expect.any(String) })
  })

  it('warns with the exact remedy for missing, red, and stale evidence', () => {
    const root = repo()
    write(root, 'plugin/thing.mjs', '// changed\n')
    git(root, 'add', 'plugin/thing.mjs')
    const missing = run(root)
    expect(missing.stdout).toContain('test: MISSING')
    expect(JSON.parse(missing.stdout).hookSpecificOutput.additionalContext).toContain('node "${CLAUDE_PLUGIN_ROOT}/bin/wt-run-gate.mjs" --record test -- pnpm test')

    record(root, 7)
    expect(run(root).stdout).toContain('test: RED (exit 7)')

    record(root)
    write(root, 'plugin/thing.mjs', '// edited after gate\n')
    git(root, 'add', 'plugin/thing.mjs')
    expect(run(root).stdout).toContain('test: STALE')
  })

  it('allows and journals the explicit trailer, including a heredoc message', () => {
    const root = repo()
    write(root, 'plugin/thing.mjs', '// changed\n')
    git(root, 'add', 'plugin/thing.mjs')
    expect(run(root, "git commit -m 'work\n\ngates: skipped — offline fixture'").stdout).toBe('')
    expect(run(root, "git commit -F - <<'MSG'\ngates: skipped — heredoc reason\nMSG").stdout).toBe('')
    const journal = readFileSync(join(states.get(root)!, readdirSync(states.get(root)!).find((file) => file.endsWith('.ndjson'))!), 'utf8')
    expect(journal).toContain('gate-evidence-skipped')
    expect(journal).toContain('heredoc reason')
  })

  it('refuses on the twentieth firing and ignores prose heredocs mentioning git commit', () => {
    const root = repo()
    write(root, 'plugin/thing.mjs', '// changed\n')
    git(root, 'add', 'plugin/thing.mjs')
    for (let i = 0; i < 19; i++) expect(run(root).stdout).toContain('additionalContext')
    expect(run(root).stdout).toContain('"deny"')
    expect(run(root, "cat <<'EOF'\ngit commit -m x\nEOF").stdout).toBe('')
  })

  it('records a failing gate command exit code', () => {
    const root = repo()
    record(root, 9)
    expect(JSON.parse(readFileSync(recordFile(root), 'utf8'))).toMatchObject({ exit: 9, name: 'test', tree: expect.any(String) })
  })
})
