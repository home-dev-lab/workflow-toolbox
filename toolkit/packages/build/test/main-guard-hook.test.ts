import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-main-guard-hook.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

let sandboxHome: string

beforeEach(() => {
  sandboxHome = mkdtempSync(join(tmpdir(), 'wt-main-guard-test-'))
})

afterEach(() => {
  rmSync(sandboxHome, { recursive: true, force: true })
})

function run(command: string, opts: { agentId?: string; cwd?: string; pluginData?: string | undefined; toolUseId?: string } = {}) {
  const payload: Record<string, unknown> = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd: opts.cwd ?? sandboxHome,
    tool_use_id: opts.toolUseId ?? 'tool-default',
  }
  if (opts.agentId) payload.agent_id = opts.agentId
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: sealedPluginCliEnv(sandboxHome, {
      CLAUDE_CONFIG_DIR: undefined,
      CLAUDE_PLUGIN_DATA: opts.pluginData,
      HOME: sandboxHome,
      XDG_STATE_HOME: join(sandboxHome, '.local', 'state'),
    }),
  })
  return {
    denied: res.stdout.includes('"deny"'),
    stdout: res.stdout,
    stderr: res.stderr,
    status: res.status,
  }
}

function runAsync(command: string, toolUseId: string) {
  const payload = {
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: sandboxHome, tool_use_id: toolUseId,
  }
  const child = spawn(process.execPath, [HOOK], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: sealedPluginCliEnv(sandboxHome, {
      CLAUDE_CONFIG_DIR: undefined,
      CLAUDE_PLUGIN_DATA: undefined,
      HOME: sandboxHome,
      XDG_STATE_HOME: join(sandboxHome, '.local', 'state'),
      NODE_ENV: 'test',
      WT_MAIN_GUARD_TEST_AFTER_READ_MS: '200',
    }),
  })
  let stdout = ''; let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  child.stdin.end(JSON.stringify(payload))
  return new Promise<{ denied: boolean; stdout: string; stderr: string; status: number | null }>((resolve) => {
    child.once('exit', (status) => resolve({ denied: stdout.includes('"deny"'), stdout, stderr, status }))
  })
}

function journalLines(): Array<Record<string, unknown>> {
  const p = join(sandboxHome, '.local', 'state', 'wt-main-guard', 'journal.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

function initGitRepo(dir: string, branch = 'main') {
  mkdirSync(dir, { recursive: true })
  spawnSync('git', ['init', '-q', '-b', branch, dir])
  spawnSync('git', ['-C', dir, 'config', 'user.email', 't@t.co'])
  spawnSync('git', ['-C', dir, 'config', 'user.name', 't'])
  writeFileSync(join(dir, 'f.txt'), 'x')
  spawnSync('git', ['-C', dir, 'add', '-A'])
  spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'])
}

describe('wt-main-guard-hook — measured-BLOCKING classes', () => {
  it('RED: denies npm publish', () => {
    const r = run('cd pkg && npm publish')
    expect(r.denied).toBe(true)
    expect(r.stdout).toContain('npm/pnpm/yarn publish is a release action')
  })

  it('RED: denies pnpm publish', () => {
    const r = run('pnpm publish --no-git-checks')
    expect(r.denied).toBe(true)
  })

  it('RED: denies a force-push (--force)', () => {
    const r = run('git push origin my-branch --force')
    expect(r.denied).toBe(true)
    expect(r.stdout).toContain('force-push overwrites remote history')
  })

  it('RED: denies a force-push (--force-with-lease)', () => {
    const r = run('git push --force-with-lease origin my-branch')
    expect(r.denied).toBe(true)
  })

  it('RED: denies a remote branch deletion (--delete)', () => {
    const r = run('git push origin --delete stale-branch')
    expect(r.denied).toBe(true)
    expect(r.stdout).toContain('remote branch deletion is remote-destructive')
    expect(r.stdout).toContain('API deletions and gh calls are outside this guard')
  })

  it('RED: denies a remote branch deletion (: refspec form)', () => {
    const r = run('git push origin :stale-branch')
    expect(r.denied).toBe(true)
  })

  it('RED: denies rm -rf targeting the home directory', () => {
    const r = run('rm -rf ~')
    expect(r.denied).toBe(true)
    expect(r.stdout).toContain('home directory')
  })

  it('RED: denies rm -rf targeting $HOME', () => {
    const r = run('rm -rf $HOME')
    expect(r.denied).toBe(true)
  })

  it('RED: denies rm -rf targeting the filesystem root', () => {
    const r = run('rm -rf /')
    expect(r.denied).toBe(true)
    expect(r.stdout).toContain('filesystem root')
  })
})

describe('wt-main-guard-hook — measured-FALSE-POSITIVE classes now JOURNAL-ONLY', () => {
  it('GREEN: allows (but journals) rm -rf on a git repository root — worktree/clone purge is routine', () => {
    const target = join(sandboxHome, 'throwaway-clone')
    initGitRepo(target)
    const r = run(`rm -rf ${target}`)
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    const lines = journalLines()
    expect(lines.some((l) => l.class === 'rm-catastrophic' && l.decision === 'allowed-journaled')).toBe(true)
  })

  it('GREEN: allows (but journals) rm -rf "$VAR" where $VAR cannot be statically resolved', () => {
    const r = run('D=$(mktemp -d); rm -rf "$D"')
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    const lines = journalLines()
    expect(
      lines.some((l) => l.class === 'rm-catastrophic' && String(l.reason).includes('cannot be statically resolved')),
    ).toBe(true)
  })

  it('GREEN: allows (but journals) rm -rf on a glob target', () => {
    const r = run('rm -rf /tmp/prov-fixture-*')
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })
})

describe('wt-main-guard-hook — legitimate near-misses stay silent', () => {
  it('GREEN: an ordinary named-remote push is not a violation', () => {
    const r = run('git push origin my-branch')
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    expect(journalLines().length).toBe(0)
  })

  it('documents its bound in behavior: a branch deletion through gh api is outside the Bash-text classifier', () => {
    const r = run('gh api -X DELETE repos/acme/widget/git/refs/heads/stale-branch')
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    expect(journalLines()).toEqual([])
  })

  it('GREEN: an ordinary rm -rf on a plain (non-git, non-home, non-root) directory is journal-only, not denied', () => {
    const target = join(sandboxHome, 'scratch', 'build-dir')
    mkdirSync(target, { recursive: true })
    const r = run(`rm -rf ${target}`)
    expect(r.denied).toBe(false)
    const lines = journalLines()
    expect(lines.some((l) => l.class === 'rm-other')).toBe(true)
  })

  it('GREEN: "npm publish" mentioned inside a single-quoted commit message is not a violation', () => {
    const r = run("git commit -m 'about npm publish workflow, not running it'")
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('GREEN: "npm publish" mentioned inside a heredoc body is not a violation', () => {
    const r = run(["git commit -F - <<'MSG'", 'fixes the npm publish docs', 'MSG'].join('\n'))
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('GREEN: --force mentioned inside a double-quoted string is not a violation', () => {
    const r = run('echo "run git push --force only if you really mean it"')
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('GREEN: a quoted rm target under a real path stays visible to classification (not blinded by quote-stripping)', () => {
    const target = join(sandboxHome, 'with spaces')
    mkdirSync(target, { recursive: true })
    const r = run(`rm -rf "${target}"`)
    expect(r.denied).toBe(false) // ordinary dir, not catastrophic — but must be CLASSIFIED, not skipped
    const lines = journalLines()
    expect(lines.some((l) => l.class === 'rm-other')).toBe(true)
  })
})

describe('wt-main-guard-hook — journal-only merge direction', () => {
  it('journals (never denies) a merge INTO main while on main', () => {
    const repo = join(sandboxHome, 'repo')
    initGitRepo(repo, 'main')
    spawnSync('git', ['-C', repo, 'branch', 'feature'])
    const r = run('git merge feature', { cwd: repo })
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    const lines = journalLines()
    expect(lines.some((l) => l.class === 'merge-into-main')).toBe(true)
  })

  it('does not execute repository hooks while inspecting a merge INTO main', () => {
    const repo = join(sandboxHome, 'hooked-repo')
    const marker = join(sandboxHome, 'hook-ran')
    const hooks = join(repo, 'hooks')
    initGitRepo(repo, 'main')
    mkdirSync(hooks)
    writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\n: > "${marker}"\n`)
    chmodSync(join(hooks, 'post-checkout'), 0o755)
    spawnSync('git', ['-C', repo, 'config', 'core.hooksPath', hooks])
    spawnSync('git', ['-C', repo, 'branch', 'feature'])

    const r = run('git merge feature', { cwd: repo })

    expect(r.denied).toBe(false)
    expect(existsSync(marker)).toBe(false)
    expect(journalLines().some((line) => line.class === 'merge-into-main')).toBe(true)
  })

  it('stays a true no-op merging main INTO a feature branch (the reverse direction)', () => {
    const repo = join(sandboxHome, 'repo2')
    initGitRepo(repo, 'main')
    spawnSync('git', ['-C', repo, 'checkout', '-q', '-b', 'feature'])
    const r = run('git merge main', { cwd: repo })
    expect(r.denied).toBe(false)
    expect(journalLines().length).toBe(0)
  })
})

describe('wt-main-guard-hook — reset-hard is journal-only on dirty worktrees', () => {
  it('journals (never denies) git reset --hard when the worktree has uncommitted changes', () => {
    const repo = join(sandboxHome, 'dirty-reset-repo')
    initGitRepo(repo)
    writeFileSync(join(repo, 'f.txt'), 'dirty')

    const r = run('git reset --hard HEAD', { cwd: repo })

    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    expect(journalLines().some((l) => l.class === 'reset-hard' && l.decision === 'allowed-journaled')).toBe(true)
  })

  it('does not execute repository fsmonitor configuration while inspecting a dirty worktree', () => {
    const repo = join(sandboxHome, 'fsmonitor-reset-repo')
    const marker = join(sandboxHome, 'fsmonitor-ran')
    const monitor = join(repo, 'fsmonitor.sh')
    initGitRepo(repo)
    writeFileSync(monitor, `#!/bin/sh\n: > "${marker}"\n`)
    chmodSync(monitor, 0o755)
    spawnSync('git', ['-C', repo, 'config', 'core.fsmonitor', monitor])
    writeFileSync(join(repo, 'f.txt'), 'dirty')

    const r = run('git reset --hard HEAD', { cwd: repo })

    expect(r.status).toBe(0)
    expect(existsSync(marker)).toBe(false)
    expect(journalLines().some((line) => line.class === 'reset-hard')).toBe(true)
  })

  it('never executes command-bearing repository configuration or attributes on any Git read path', () => {
    const repo = join(sandboxHome, 'host-read-config-repo')
    const marker = join(sandboxHome, 'repository-command-ran')
    const command = join(sandboxHome, 'mark.sh')
    const hooks = join(repo, 'hooks')
    initGitRepo(repo)
    writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${marker}"\n`); chmodSync(command, 0o755)
    mkdirSync(hooks)
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\n"${command}" hooksPath\n`); chmodSync(join(hooks, 'pre-commit'), 0o755)
    writeFileSync(join(repo, '.gitattributes'), 'f.txt filter=probe diff=probe\n')
    const configs: Array<[string, string]> = [
      ['core.fsmonitor', `${command} fsmonitor`], ['core.hooksPath', hooks],
      ['filter.probe.clean', `${command} clean`], ['filter.probe.smudge', `${command} smudge`], ['filter.probe.process', `${command} process`],
      ['diff.probe.textconv', `${command} textconv`], ['diff.probe.command', `${command} diff-command`],
      ['core.pager', `${command} pager`], ['core.sshCommand', `${command} ssh`],
      ['credential.helper', `!${command} credential`], ['gpg.program', `${command} gpg`],
    ]
    for (const [key, value] of configs) spawnSync('git', ['-C', repo, 'config', key, value])
    writeFileSync(join(repo, 'f.txt'), 'y')
    const old = new Date(Date.now() - 60_000)
    utimesSync(join(repo, 'f.txt'), old, old)

    expect(run('git merge feature', { cwd: repo }).status).toBe(0)
    expect(run('git reset --hard HEAD', { cwd: repo }).status).toBe(0)
    expect(existsSync(marker)).toBe(false)
  })

  it('journals unknown state for git reset --hard without asking Git to inspect the worktree', () => {
    const repo = join(sandboxHome, 'clean-reset-repo')
    initGitRepo(repo)

    const r = run('git reset --hard HEAD', { cwd: repo })

    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    expect(journalLines().some((l) => l.class === 'reset-hard' && String(l.reason).includes('state left unknown'))).toBe(true)
  })

  it('journals git checkout -f when the named -C worktree has uncommitted changes', () => {
    const repo = join(sandboxHome, 'dirty-checkout-repo')
    initGitRepo(repo)
    writeFileSync(join(repo, 'f.txt'), 'dirty')

    const r = run(`git -C ${repo} checkout -f`, { cwd: sandboxHome })

    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    expect(journalLines().some((l) => l.class === 'reset-hard')).toBe(true)
  })

  it('stays silent when "git reset --hard" is only quoted in a commit message', () => {
    const r = run('git commit -m "document git reset --hard before rebasing"')

    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    expect(journalLines().some((l) => l.class === 'reset-hard')).toBe(false)
  })
})

describe('wt-main-guard-hook — scope', () => {
  it('no-ops for any subagent call (agent_id present) — the pilot guard already covers it', () => {
    const r = run('rm -rf /', { agentId: 'agent-pilot-1' })
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('no-ops for a non-Bash tool', () => {
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x', content: 'npm publish' },
    }
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: sealedPluginCliEnv(sandboxHome, { CLAUDE_CONFIG_DIR: undefined, CLAUDE_PLUGIN_DATA: undefined, HOME: sandboxHome }),
    })
    expect(res.stdout).toBe('')
  })

  it('stays out of the way for an ordinary command with no matching shape', () => {
    const r = run('git status')
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    expect(journalLines().length).toBe(0)
  })
})

describe('wt-main-guard-hook — escape hatch', () => {
  it.each([
    ['CLAUDE_PLUGIN_DATA set', () => join(sandboxHome, 'plugin-data', 'workflow-toolbox-test')],
    ['CLAUDE_PLUGIN_DATA unset', () => undefined],
  ])('prints the same allow-once path it consumes when %s', (_label, pluginData) => {
    const command = 'git push origin --delete stale-branch'
    const configuredPluginData = pluginData()
    const expectedPath = join(
      configuredPluginData ?? join(sandboxHome, '.local', 'state', 'wt-main-guard'),
      'allow-once.json',
    )
    const first = run(command, { pluginData: configuredPluginData })
    const refusal = JSON.parse(first.stdout).hookSpecificOutput.permissionDecisionReason as string
    const printedPath = refusal.match(/to (.+[\\/]allow-once\.json) and retry/)?.[1]

    expect(first.denied).toBe(true)
    expect(printedPath).toBe(expectedPath)
    mkdirSync(dirname(expectedPath), { recursive: true })
    writeFileSync(expectedPath, JSON.stringify({ command, reason: 'branch owner approved this exact deletion' }))

    expect(run(command, { pluginData: configuredPluginData })).toMatchObject({ denied: false, stdout: '', status: 0 })
  })

  it('atomically lets exactly one of two different concurrent tool calls claim one allowance', async () => {
    const stateDir = join(sandboxHome, '.local', 'state', 'wt-main-guard')
    mkdirSync(stateDir, { recursive: true })
    const command = 'git push origin --delete stale-branch'
    writeFileSync(join(stateDir, 'allow-once.json'), JSON.stringify({ command, reason: 'branch owner approved this exact deletion' }))

    const results = await Promise.all([runAsync(command, 'call-a'), runAsync(command, 'call-b')])

    expect(results.filter((result) => !result.denied), JSON.stringify(results)).toHaveLength(1)
    expect(results.filter((result) => result.denied), JSON.stringify(results)).toHaveLength(1)
  })

  it('lets duplicate concurrent registrations of the same tool call agree', async () => {
    const stateDir = join(sandboxHome, '.local', 'state', 'wt-main-guard')
    mkdirSync(stateDir, { recursive: true })
    const command = 'git push origin --delete stale-branch'
    writeFileSync(join(stateDir, 'allow-once.json'), JSON.stringify({ command, reason: 'branch owner approved this exact deletion' }))

    const results = await Promise.all([runAsync(command, 'same-call'), runAsync(command, 'same-call')])

    expect(results, JSON.stringify(results)).toEqual([
      expect.objectContaining({ denied: false, status: 0 }),
      expect.objectContaining({ denied: false, status: 0 }),
    ])
  })

  it('a byte-exact allow-once override records its consuming tool call and lets the exact command through', () => {
    const stateDir = join(sandboxHome, '.local', 'state', 'wt-main-guard')
    mkdirSync(stateDir, { recursive: true })
    const command = 'rm -rf /'
    writeFileSync(
      join(stateDir, 'allow-once.json'),
      JSON.stringify({ command, reason: 'deliberate wipe of a disposable VM, verified by hand' }),
    )
    const r = run(command)
    expect(r.denied).toBe(false)
    expect(r.stdout).toBe('')
    expect(JSON.parse(readFileSync(join(stateDir, 'allow-once.json'), 'utf8'))).toMatchObject({
      command,
      consumedBy: 'tool-default',
    })
    const lines = journalLines()
    expect(lines.some((l) => l.decision === 'override-allow')).toBe(true)
  })

  it('a claim directory left by a crashed hook does not refuse an authorized command for ever', () => {
    const stateDir = join(sandboxHome, '.local', 'state', 'wt-main-guard')
    mkdirSync(join(stateDir, 'allow-once.json.claim'), { recursive: true })
    const old = new Date(Date.now() - 60_000)
    utimesSync(join(stateDir, 'allow-once.json.claim'), old, old)
    const command = 'rm -rf /'
    writeFileSync(join(stateDir, 'allow-once.json'), JSON.stringify({ command, reason: 'deliberate wipe of a disposable VM, verified by hand' }))
    expect(run(command).denied).toBe(false)
  })

  it('two registrations allow the same tool call, then a different call is refused and spends the entry', () => {
    const stateDir = join(sandboxHome, '.local', 'state', 'wt-main-guard')
    mkdirSync(stateDir, { recursive: true })
    const file = join(stateDir, 'allow-once.json')
    const command = 'git push origin --delete stale-branch'
    writeFileSync(file, JSON.stringify({ command, reason: 'branch owner approved this exact deletion' }))

    const first = run(command, { toolUseId: 'tool-delete-1' })
    const secondRegistration = run(command, { toolUseId: 'tool-delete-1' })
    const laterCall = run(command, { toolUseId: 'tool-delete-2' })

    expect(first).toMatchObject({ denied: false, stdout: '', status: 0 })
    expect(secondRegistration).toMatchObject({ denied: false, stdout: '', status: 0 })
    expect(laterCall.denied).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(journalLines().map((line) => line.decision)).toEqual(['override-allow', 'override-allow', 'denied'])
  })

  it('a spent entry for this command refuses a different tool call and is removed', () => {
    const stateDir = join(sandboxHome, '.local', 'state', 'wt-main-guard')
    mkdirSync(stateDir, { recursive: true })
    const file = join(stateDir, 'allow-once.json')
    const command = 'rm -rf /'
    writeFileSync(file, JSON.stringify({
      command,
      reason: 'already used',
      consumedBy: 'tool-old',
      consumedAt: '2026-09-17T18:00:00.000Z',
    }))

    expect(run(command, { toolUseId: 'tool-new' }).denied).toBe(true)
    expect(existsSync(file)).toBe(false)
  })

  it('does not consume the override for a DIFFERENT command (byte-exact match only)', () => {
    const stateDir = join(sandboxHome, '.local', 'state', 'wt-main-guard')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
      join(stateDir, 'allow-once.json'),
      JSON.stringify({ command: 'rm -rf /', reason: 'unrelated' }),
    )
    const r = run('rm -rf ~')
    expect(r.denied).toBe(true)
    expect(existsSync(join(stateDir, 'allow-once.json'))).toBe(true) // untouched
  })

  it('does not consume or authorize an exact-command override without a non-empty reason', () => {
    const stateDir = join(sandboxHome, '.local', 'state', 'wt-main-guard')
    mkdirSync(stateDir, { recursive: true })
    const file = join(stateDir, 'allow-once.json')
    writeFileSync(file, JSON.stringify({ command: 'rm -rf /', reason: '  ' }))
    const r = run('rm -rf /')
    expect(r.denied).toBe(true)
    expect(existsSync(file)).toBe(true)
  })
})

describe('wt-main-guard-hook — registration', () => {
  it('is registered as a PreToolUse hook on Bash in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const entries = manifest.hooks?.PreToolUse ?? []
    const wired = entries
      .filter((e: { matcher?: string }) => e.matcher === 'Bash')
      .flatMap((e: { hooks?: { command?: string }[] }) => e.hooks ?? [])
      .some((h: { command?: string }) => h.command?.includes('wt-main-guard-hook.mjs'))
    expect(wired).toBe(true)
  })
})
