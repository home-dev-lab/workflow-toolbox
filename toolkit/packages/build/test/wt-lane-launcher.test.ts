import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { inspectProcess, sameIdentity } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const LAUNCHER = join(ROOT, 'plugin/bin/wt-lane.mjs')
const CONTROL = join(ROOT, 'plugin/bin/wt-lane-control.mjs')
const WATCHER = join(ROOT, 'plugin/bin/wt-lane-orphan-watch.mjs')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })

function fixture(script: string) {
  const root = mkdtempSync(join(tmpdir(), 'wt-lane-launcher-')); roots.push(root)
  const dir = join(root, 'worktree'); const bin = join(root, 'bin'); const config = join(root, 'config')
  mkdirSync(join(dir, '.lane'), { recursive: true }); mkdirSync(bin); mkdirSync(config)
  writeFileSync(join(dir, 'brief.md'), '# brief\n')
  writeFileSync(join(bin, 'opencode'), `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'fixture-1\n'; exit 0; fi
if [ "$1" = "--pure" ]; then if [ "$IGNORE_FENCE" = "1" ]; then printf '[{"name":"workflow-toolbox-fence-sentinel"}]\n'; elif [ "$INVISIBLE_ALLOW" = "1" ]; then printf '[]\n'; else printf '[{"name":"workflow-toolbox-allowed-sentinel"}]\n'; fi; exit 0; fi
if [ "$1" = "debug" ] && [ "$2" = "skill" ]; then if [ -n "$IDENTITY_RECORD" ]; then printf 'probe|%s|%s|%s\n' "$PWD" "$IDENTITY_MARKER" "\${OPENCODE_CONFIG-unset}" >> "$IDENTITY_RECORD"; fi; if [ -n "$SLOW_PREFLIGHT_AT_COUNT" ]; then count=0; [ -f "$PWD/.lane/preflight-count" ] && count=$(cat "$PWD/.lane/preflight-count"); count=$((count + 1)); printf '%s' "$count" > "$PWD/.lane/preflight-count"; [ "$count" = "$SLOW_PREFLIGHT_AT_COUNT" ] && sleep 6; fi; printf '%s\n' "\${EFFECTIVE_SKILLS:-[]}"; exit 0; fi
${script}\n`)
  spawnSync('chmod', ['+x', join(bin, 'opencode')])
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: config, XDG_STATE_HOME: join(root, 'state') }
  return { root, dir, config, env }
}
function run(f: ReturnType<typeof fixture>, extra: string[] = [], model = 'openai/gpt-5.6-luna') {
  return spawnSync(process.execPath, [LAUNCHER, '--dir', f.dir, '--model', model, '--brief', join(f.dir, 'brief.md'), '--allow-no-git', ...extra], { encoding: 'utf8', env: f.env })
}
function waitFor(log: string, ms = 3000) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (existsSync(log) && /EXIT=/.test(readFileSync(log, 'utf8'))) return; spawnSync('sleep', ['0.05']) }
}
function waitForFile(file: string, ms = 3000) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (existsSync(file)) return; spawnSync('sleep', ['0.05']) }
}
function waitForContent(file: string, pattern: RegExp, ms = 5000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (existsSync(file) && pattern.test(readFileSync(file, 'utf8'))) return
    spawnSync('sleep', ['0.05'])
  }
}
function journalEvents(file: string, event: string) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((item) => item.event === event)
}
function killIdentity(expected: { pid: number, argv: string[], cwd?: string | null } | null, signal: NodeJS.Signals) {
  if (!expected) throw new Error('expected test process identity is gone')
  expect(sameIdentity(expected, inspectProcess(expected.pid))).toBe(true)
  process.kill(expected.pid, signal)
}
function currentStateFile(dir: string, ms = 3000) {
  const pointer = join(dir, '.lane', 'supervision', 'current.json')
  waitForFile(pointer, ms)
  const runId = JSON.parse(readFileSync(pointer, 'utf8')).runId
  return join(dir, '.lane', 'supervision', `${runId}.json`)
}
function currentDecisionFile(dir: string) {
  const runId = JSON.parse(readFileSync(join(dir, '.lane', 'supervision', 'current.json'), 'utf8')).runId
  return join(dir, '.lane', 'supervision', `${runId}.decision.json`)
}

describe('wt-lane detached launcher', () => {
  it('launches a model in the default lane model allow-list', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    expect(run(f).status).toBe(0)
    waitFor(join(f.dir, '.lane', 'run.log'))
    expect(readFileSync(join(f.dir, 'spawned'), 'utf8')).toBe('spawned')
  })
  it.each(['google/gemini-3.6-flash', 'openai/gpt-5.6-sol-fast'])('refuses unlisted model %s before spawn', (model) => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    const res = run(f, [], model)
    expect(res.status).toBe(1)
    expect(res.stderr).toBe('wt-lane: Refused: model ' + model + ' is not in the lane model allow-list (openai/gpt-5.6-luna, openai/gpt-5.6-terra, openai/gpt-5.6-sol, openai/gpt-6-astra); set WT_LANE_MODELS to the full list to allow (it replaces the default).\n')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })
  it('honours a comma- or whitespace-separated WT_LANE_MODELS override with exact matching', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.WT_LANE_MODELS = 'test/one, google/gemini-3.6-flash\ntest/two'
    expect(run(f, [], 'openai/gpt-5.6-luna').status).toBe(1)
    expect(run(f, [], 'google/gemini-3.6-flash').status).toBe(0)
    waitFor(join(f.dir, '.lane', 'run.log'))
    expect(readFileSync(join(f.dir, 'spawned'), 'utf8')).toBe('spawned')
  })
  it('returns immediately, leaves the worker alive, closes stdin, and writes EXIT=0', () => {
    const f = fixture('IFS= read -r x; test -z "$x"; sleep 0.2; echo done')
    const res = run(f); const log = join(f.dir, '.lane', 'run.log')
    expect(res.status).toBe(0); expect(res.stdout).toMatch(/pid=\d+\nrun=\d+-\d+\nlog=/)
     const pid = Number(/pid=(\d+)/.exec(res.stdout)?.[1]); expect(() => process.kill(pid, 0)).not.toThrow()
     expect(readFileSync(join(f.dir, '.lane', 'pid'), 'utf8').trim()).toBe(String(pid))
    waitFor(log); expect(readFileSync(log, 'utf8')).toMatch(/EXIT=0\n$/)
  })
  it('reports timeout for owner decision without killing live work', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '1']); expect(res.status).toBe(0)
    const pidFile = join(f.dir, 'opencode.pid'); waitForFile(pidFile)
    const status = currentStateFile(f.dir)
    const until = Date.now() + 3000
    while (Date.now() < until && !readFileSync(status, 'utf8').includes('decision-needed')) spawnSync('sleep', ['0.05'])
    expect(JSON.parse(readFileSync(status, 'utf8'))).toMatchObject({ state: 'decision-needed', defaultDecision: 'extend' })
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 0)).not.toThrow()
    expect(existsSync(join(f.dir, '.lane', 'run.log')) ? readFileSync(join(f.dir, '.lane', 'run.log'), 'utf8') : '').not.toMatch(/EXIT=/)
    const worker = Number(/pid=(\d+)/.exec(res.stdout)?.[1])
    process.kill(worker, 'SIGTERM')
    const cleanupUntil = Date.now() + 4000
    while (Date.now() < cleanupUntil) { try { process.kill(worker, 0); spawnSync('sleep', ['0.05']) } catch { break } }
  })
  it('keeps one immutable supervision record per run behind an atomic current pointer', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '1']); expect(res.status).toBe(0)
    waitForFile(join(f.dir, '.lane', 'supervision', 'current.json'))
    const pointer = JSON.parse(readFileSync(join(f.dir, '.lane', 'supervision', 'current.json'), 'utf8'))
    const recordFile = join(f.dir, '.lane', 'supervision', `${pointer.runId}.json`)
    waitForContent(recordFile, /decision-needed/)
    expect(JSON.parse(readFileSync(recordFile, 'utf8'))).toMatchObject({ runId: pointer.runId, state: 'decision-needed' })
    expect(readdirSync(join(f.dir, '.lane', 'supervision')).filter((name) => /^\d+-\d+\.json$/.test(name))).toContain(`${pointer.runId}.json`)
    process.kill(Number(/pid=(\d+)/.exec(res.stdout)?.[1]), 'SIGTERM')
  })
  it('records the stated extend default when the decision grace expires and still keeps work alive', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '1', '--decision-grace', '0']); expect(res.status).toBe(0)
    const pidFile = join(f.dir, 'opencode.pid'); waitForFile(pidFile)
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    waitForContent(journal, /"source":"grace-default"/)
    expect(readFileSync(journal, 'utf8')).toContain('"decision":"extend"')
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 0)).not.toThrow()
    process.kill(Number(/pid=(\d+)/.exec(res.stdout)?.[1]), 'SIGTERM')
  })
  it('re-arms grace defaults and abandons at the configured extension ceiling', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '0.2', '--decision-grace', '0', '--max-extensions', '1']); expect(res.status).toBe(0)
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    waitForContent(journal, /"decision":"abandon"/, 4000)
    const text = readFileSync(journal, 'utf8')
    expect((text.match(/"source":"grace-default"/g) ?? [])).toHaveLength(2)
    expect(text).toContain('"decision":"extend"')
    expect(text).toContain('"decision":"abandon"')
  })
  it('keeps worktree files when the owner abandons and starts a fresh lane with the normal launcher', () => {
    const f = fixture('if [ ! -f "$PWD/progress" ]; then printf kept > "$PWD/progress"; echo $$ > "$PWD/first.pid"; sleep 30; else sleep 0.5; printf resumed > "$PWD/resumed"; fi')
    f.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
    const res = run(f, ['--timeout', '1', '--decision-grace', '10']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir)
    waitForContent(status, /decision-needed/)
    writeFileSync(currentDecisionFile(f.dir), JSON.stringify({ runId: 'stale', timeoutAt: 'stale', decision: 'abandon' }))
    const control = spawnSync(process.execPath, [CONTROL, '--dir', f.dir, '--decision', 'abandon', '--reason', 'e2e stalled fixture'], { encoding: 'utf8', env: f.env })
    expect(control.status, control.stderr).toBe(0)
    waitForContent(status, /abandoned/)
    const fresh = run(f, ['--timeout', '10'])
    expect(fresh.status, fresh.stderr).toBe(0)
    waitForFile(join(f.dir, 'resumed'), 5000)
    expect(readFileSync(join(f.dir, 'progress'), 'utf8')).toBe('kept')
    expect(readFileSync(join(f.dir, 'resumed'), 'utf8')).toBe('resumed')
    waitForContent(join(f.dir, '.lane', 'run.log'), /EXIT=0/)
    expect(readFileSync(join(f.dir, '.lane', 'run.log'), 'utf8')).toMatch(/EXIT=0\n$/)
    expect((readFileSync(join(f.dir, '.lane', 'run.log'), 'utf8').match(/^EXIT=/gm) ?? [])).toHaveLength(1)
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    waitForContent(journal, /"decision":"abandon"/)
    expect(readFileSync(journal, 'utf8')).toContain('"decision":"abandon"')
    expect(JSON.parse(readFileSync(status, 'utf8'))).toMatchObject({ state: 'abandoned', decision: 'abandon' })
  })
  it('does not treat an old EXIT marker as an orphan while the current launcher is alive', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    writeFileSync(join(f.dir, '.lane', 'run.log'), 'old run\nEXIT=0\n')
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const pidFile = join(f.dir, 'opencode.pid'); waitForFile(pidFile)
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: f.env })
    expect(watcher.status, watcher.stderr).toBe(0)
    expect(watcher.stdout).not.toContain('would-clean')
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(() => process.kill(pid, 0)).not.toThrow()
    expect(readFileSync(join(f.dir, '.lane', 'run.log'), 'utf8')).toMatch(/^LANE_RUN_ID=/)
    expect(readFileSync(join(f.dir, '.lane', 'run.log'), 'utf8')).not.toContain('old run')
    expect(readFileSync(journal, 'utf8')).not.toContain('"event":"would-clean"')
    process.kill(Number(/pid=(\d+)/.exec(res.stdout)?.[1]), 'SIGTERM')
  })
  it('observe mode journals would-clean but kills nothing', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); const pidFile = join(f.dir, 'opencode.pid')
    waitForFile(status); waitForFile(pidFile)
    const worker = Number(/pid=(\d+)/.exec(res.stdout)?.[1]); process.kill(worker, 'SIGKILL')
    const state = JSON.parse(readFileSync(status, 'utf8')); writeFileSync(status, JSON.stringify({ ...state, state: 'abandoned' }))
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: f.env })
    expect(watcher.status, watcher.stderr).toBe(0)
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(() => process.kill(pid, 0)).not.toThrow()
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    expect(readFileSync(journal, 'utf8')).toContain('"event":"would-clean"')
    process.kill(pid, 'SIGKILL')
  })
  it.each([
    ['pilot', 'stalled'],
    ['pilot', 'would-clean'],
    ['foreign session', 'stalled'],
    ['foreign session', 'would-clean'],
  ])('journals one %s-owned %s episode across repeated sweeps', (ownerKind, event) => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    f.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
    const ownerArgs = ownerKind === 'pilot' ? ['--owner', 'pilot', '--owner-token', 'pilot-token'] : []
    const res = run(f, ['--timeout', '60', ...ownerArgs]); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); const pidFile = join(f.dir, 'opencode.pid')
    waitForFile(status); waitForFile(pidFile)
    const state = JSON.parse(readFileSync(status, 'utf8'))
    if (event === 'would-clean') {
      killIdentity({ pid: state.workerPid, argv: state.workerArgv }, 'SIGKILL')
      writeFileSync(status, JSON.stringify({ ...state, state: 'abandoned' }))
    } else {
      const old = new Date(Date.now() - 120_000)
      const ageTree = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const file = join(dir, name)
          if (file === join(f.dir, '.lane', 'supervision')) continue
          if (statSync(file).isDirectory()) ageTree(file)
          utimesSync(file, old, old)
        }
      }
      ageTree(f.dir); utimesSync(f.dir, old, old)
    }
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    const watcher = spawn(process.execPath, [WATCHER, '--project', f.dir, '--poll', '0.05'], {
      stdio: 'ignore',
      env: { ...f.env, CLAUDE_CODE_SESSION_ID: 'watching-session', WT_LANE_STALL_MINUTES: '1' },
    })
    const watcherIdentity = inspectProcess(watcher.pid!)
    spawnSync('sleep', ['0.3'])
    killIdentity(watcherIdentity, 'SIGTERM')
    expect(journalEvents(journal, event)).toHaveLength(1)
    if (event === 'would-clean') killIdentity({ pid: state.childPid, argv: state.childArgv, cwd: state.worktree }, 'SIGKILL')
    else killIdentity({ pid: state.workerPid, argv: state.workerArgv }, 'SIGTERM')
  })
  it('enforce mode escalates and journals cleaned only after the orphan is gone', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); const pidFile = join(f.dir, 'opencode.pid')
    waitForFile(status); waitForFile(pidFile)
    process.kill(Number(/pid=(\d+)/.exec(res.stdout)?.[1]), 'SIGKILL')
    const state = JSON.parse(readFileSync(status, 'utf8')); writeFileSync(status, JSON.stringify({ ...state, state: 'abandoned' }))
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: { ...f.env, WT_LANE_ORPHAN_CLEANUP: 'enforce' }, timeout: 5000 })
    expect(watcher.status, watcher.stderr).toBe(0)
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    expect(readFileSync(journal, 'utf8')).toContain('"event":"cleaned"')
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 0)).toThrow()
  })
  it('keeps polling after a journal write failure', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); const pidFile = join(f.dir, 'opencode.pid')
    waitForFile(status); waitForFile(pidFile)
    process.kill(Number(/pid=(\d+)/.exec(res.stdout)?.[1]), 'SIGKILL')
    const state = JSON.parse(readFileSync(status, 'utf8')); writeFileSync(status, JSON.stringify({ ...state, state: 'abandoned' }))
    const blocked = join(f.root, 'blocked-state'); writeFileSync(blocked, 'not a directory')
    const watcher = spawn(process.execPath, [WATCHER, '--project', f.dir, '--poll', '0.05'], { stdio: 'ignore', env: { ...f.env, XDG_STATE_HOME: blocked } })
    spawnSync('sleep', ['0.3'])
    expect(() => process.kill(watcher.pid!, 0)).not.toThrow()
    process.kill(watcher.pid!, 'SIGTERM')
    process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL')
  })
  it('reports a failed enforce kill journal on stdout', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); const pidFile = join(f.dir, 'opencode.pid')
    waitForFile(status); waitForFile(pidFile)
    process.kill(Number(/pid=(\d+)/.exec(res.stdout)?.[1]), 'SIGKILL')
    const state = JSON.parse(readFileSync(status, 'utf8')); writeFileSync(status, JSON.stringify({ ...state, state: 'abandoned' }))
    const blocked = join(f.root, 'blocked-state'); writeFileSync(blocked, 'not a directory')
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: { ...f.env, XDG_STATE_HOME: blocked, WT_LANE_ORPHAN_CLEANUP: 'enforce' }, timeout: 5000 })
    expect(watcher.stdout).toContain('kill journal failed')
  })
  it('prints owner notices even when the journal is unavailable and reports that failure once', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    f.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); const pidFile = join(f.dir, 'opencode.pid')
    waitForFile(status); waitForFile(pidFile)
    process.kill(Number(/pid=(\d+)/.exec(res.stdout)?.[1]), 'SIGKILL')
    const state = JSON.parse(readFileSync(status, 'utf8')); writeFileSync(status, JSON.stringify({ ...state, state: 'abandoned' }))
    const blocked = join(f.root, 'blocked-state'); writeFileSync(blocked, 'not a directory')
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: { ...f.env, XDG_STATE_HOME: blocked } })
    expect(watcher.stdout).toContain('LANE would-clean:')
    expect((watcher.stderr.match(/journal write failed/g) ?? [])).toHaveLength(1)
    process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL')
  })
  it('prints a stalled owner notice even when the journal is unavailable', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    f.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); waitForFile(status); waitForFile(join(f.dir, 'opencode.pid'))
    const old = new Date(Date.now() - 120_000)
    const ageTree = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name)
        if (file === join(f.dir, '.lane', 'supervision')) continue
        if (statSync(file).isDirectory()) ageTree(file)
        utimesSync(file, old, old)
      }
    }
    ageTree(f.dir); utimesSync(f.dir, old, old)
    const blocked = join(f.root, 'blocked-state'); writeFileSync(blocked, 'not a directory')
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: { ...f.env, XDG_STATE_HOME: blocked, WT_LANE_STALL_MINUTES: '1' } })
    expect(watcher.stdout).toContain('LANE stalled:')
    expect((watcher.stderr.match(/journal write failed/g) ?? [])).toHaveLength(1)
    process.kill(Number(/pid=(\d+)/.exec(res.stdout)?.[1]), 'SIGTERM')
  })
  it('prints an unattributed warning even when the journal is unavailable', () => {
    const f = fixture('true')
    const child = spawn('bash', ['-c', 'exec -a opencode sleep 30'], { cwd: f.dir, stdio: 'ignore' })
    try {
      spawnSync('sleep', ['0.1'])
      const blocked = join(f.root, 'blocked-state'); writeFileSync(blocked, 'not a directory')
      const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: { ...f.env, XDG_STATE_HOME: blocked } })
      expect(watcher.stdout).toContain(`WARNING: unattributed opencode pid=${child.pid}`)
      expect((watcher.stderr.match(/journal write failed/g) ?? [])).toHaveLength(1)
    } finally {
      try { process.kill(child.pid!, 'SIGKILL') } catch {}
    }
  })
  it('refuses control from a session other than the recorded owner', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30'); f.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
    const res = run(f, ['--timeout', '1', '--decision-grace', '10']); expect(res.status).toBe(0)
    waitForContent(currentStateFile(f.dir), /decision-needed/)
    const quietWatcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: { ...f.env, CLAUDE_CODE_SESSION_ID: 'other-session' } })
    expect(quietWatcher.stdout).not.toContain('LANE decision-needed')
    const control = spawnSync(process.execPath, [CONTROL, '--dir', f.dir, '--decision', 'extend'], { encoding: 'utf8', env: { ...f.env, CLAUDE_CODE_SESSION_ID: 'other-session' } })
    expect(control.status).toBe(1); expect(control.stderr).toContain('recorded owner')
    process.kill(Number(/pid=(\d+)/.exec(res.stdout)?.[1]), 'SIGTERM')
  })
  it('prints a control command that runs as written outside the plugin repository', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30'); f.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
    const res = run(f, ['--timeout', '1', '--decision-grace', '10']); expect(res.status).toBe(0)
    waitForContent(currentStateFile(f.dir), /decision-needed/)
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: f.env })
    const command = /extend with (node .*? --decision extend)(?:,| before)/.exec(watcher.stdout)?.[1]
    expect(command).toBeTruthy()
    const control = spawnSync(command!, { cwd: f.root, shell: true, encoding: 'utf8', env: f.env })
    expect(control.status, control.stderr).toBe(0)
    const state = JSON.parse(readFileSync(currentStateFile(f.dir), 'utf8'))
    killIdentity({ pid: state.workerPid, argv: state.workerArgv }, 'SIGTERM')
  })
  it('refuses relaunch as an unknown decision', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    const control = spawnSync(process.execPath, [CONTROL, '--dir', f.dir, '--decision', 'relaunch'], { encoding: 'utf8', env: f.env })
    expect(control.status).toBe(2)
    expect(control.stderr).toContain('required --dir and --decision extend|abandon')
  })
  it('extends and then abandons a pilot lane through control with a real worker', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '1', '--decision-grace', '10', '--owner', 'pilot', '--owner-token', 'pilot-token']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); waitForContent(status, /decision-needed/)
    const extend = spawnSync(process.execPath, [CONTROL, '--dir', f.dir, '--decision', 'extend', '--extend', '0.2', '--owner-token', 'pilot-token'], { encoding: 'utf8', env: f.env })
    expect(extend.status, extend.stderr).toBe(0)
    waitForContent(status, /"extensionCount": 1/)
    expect(JSON.parse(readFileSync(status, 'utf8'))).toMatchObject({ state: 'running', extensionCount: 1 })
    waitForContent(status, /decision-needed/)
    const abandon = spawnSync(process.execPath, [CONTROL, '--dir', f.dir, '--decision', 'abandon', '--owner-token', 'pilot-token'], { encoding: 'utf8', env: f.env })
    expect(abandon.status, abandon.stderr).toBe(0)
    waitForContent(status, /abandoned/)
    expect(JSON.parse(readFileSync(status, 'utf8'))).toMatchObject({ state: 'abandoned', decision: 'abandon' })
    const pid = Number(readFileSync(join(f.dir, 'opencode.pid'), 'utf8').trim())
    const until = Date.now() + 4000; let alive = true
    while (Date.now() < until) { try { process.kill(pid, 0); spawnSync('sleep', ['0.05']) } catch { alive = false; break } }
    expect(alive).toBe(false)
  })
  it('a SIGTERM to the worker takes the opencode process with it and writes EXIT=143 (a killed launcher used to leave the lane running)', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const worker = Number(/pid=(\d+)/.exec(res.stdout)?.[1])
    const pidFile = join(f.dir, 'opencode.pid'); waitForFile(pidFile)
    const opencodePid = Number(readFileSync(pidFile, 'utf8').trim())
    process.kill(worker, 'SIGTERM')
    const log = join(f.dir, '.lane', 'run.log'); waitFor(log, 4000)
    expect(readFileSync(log, 'utf8')).toMatch(/EXIT=143\n$/)
    const until = Date.now() + 4000; let alive = true
    while (Date.now() < until) { try { process.kill(opencodePid, 0) } catch { alive = false; break } spawnSync('sleep', ['0.05']) }
    expect(alive).toBe(false)
  })
  it('an external SIGTERM after the lane wrote its own EXIT line does not append a second one (a lifecycle group kill used to turn EXIT=0 into EXIT=143)', () => {
    const f = fixture('printf "lane done\\nEXIT=0\\n" >> "$PWD/.lane/run.log"; echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const worker = Number(/pid=(\d+)/.exec(res.stdout)?.[1])
    const pidFile = join(f.dir, 'opencode.pid'); waitForFile(pidFile)
    process.kill(worker, 'SIGTERM')
    const log = join(f.dir, '.lane', 'run.log')
    const until = Date.now() + 4000
    while (Date.now() < until) { try { process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 0); spawnSync('sleep', ['0.05']) } catch { break } }
    expect(readFileSync(log, 'utf8')).toMatch(/EXIT=0\n$/)
    expect((readFileSync(log, 'utf8').match(/^EXIT=/gm) ?? []).length).toBe(1)
  })
  it('passes --variant through to opencode and refuses a malformed one', () => {
    const f = fixture('printf "%s\\n" "$@" > "$PWD/argv"; IFS= read -r x; echo done')
    const res = run(f, ['--variant', 'high']); expect(res.status).toBe(0)
    const log = join(f.dir, '.lane', 'run.log'); waitFor(log)
    expect(readFileSync(join(f.dir, 'argv'), 'utf8')).toMatch(/--variant\nhigh\n/)
    const bad = run(f, ['--variant', 'hi gh']); expect(bad.status).toBe(2); expect(bad.stderr).toContain('--variant')
  })
  it('fences Claude Code skills while preserving the opencode argv contract and launch options', () => {
    const f = fixture('printf "%s\\n" "$OPENCODE_DISABLE_CLAUDE_CODE_SKILLS" > "$PWD/claude-skills-fence"; printf "%s\\n" "$@" > "$PWD/argv"')
    f.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = 'false'
    const res = run(f, ['--variant', 'high', '--timeout', '1']); expect(res.status).toBe(0)
    waitFor(join(f.dir, '.lane', 'run.log'))
    expect(readFileSync(join(f.dir, 'claude-skills-fence'), 'utf8')).toBe('true\n')
    expect(readFileSync(join(f.dir, 'argv'), 'utf8')).toBe([
      'run',
      `Read and execute the complete brief at ${join(f.dir, 'brief.md')}.`,
      '--auto',
      '--dir',
      f.dir,
      '--model',
      'openai/gpt-5.6-luna',
      '--variant',
      'high',
      '',
    ].join('\n'))
  })
  it('refuses before launch when OpenCode ignores the fence', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.IGNORE_FENCE = '1'
    const res = run(f)
    expect(res.status).toBe(1)
    expect(res.stderr).toBe('OPENCODE_SKILL_FENCE_UNAVAILABLE: the synthetic Claude skill is still listed under the forced fence; update OpenCode or workflow-toolbox before launching.\n')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })
  it('refuses before spawn when effective discovery reports a project-native refused skill', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.EFFECTIVE_SKILLS = '[{"name":"save-memory","location":"/lane/.opencode/skills/save-memory/SKILL.md"}]'
    const res = run(f)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('save-memory at /lane/.opencode/skills/save-memory/SKILL.md')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })

  it.each(['Save-Memory', 'save_memory', 'SAVE-MEMORY'])('refuses the discovered %s variant before spawn', (name) => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.EFFECTIVE_SKILLS = JSON.stringify([{ name, location: `/lane/.opencode/skills/${name}/SKILL.md` }])
    const res = run(f)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain(`${name} at /lane/.opencode/skills/${name}/SKILL.md`)
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })

  it('drops an inherited OPENCODE_CONFIG before both effective discovery and spawn', () => {
    const f = fixture('printf "run|%s|%s|%s\\n" "$PWD" "$IDENTITY_MARKER" "${OPENCODE_CONFIG-unset}" >> "$IDENTITY_RECORD"; printf spawned > "$PWD/spawned"')
    f.env.IDENTITY_RECORD = join(f.root, 'identity-record')
    f.env.IDENTITY_MARKER = 'same'
    f.env.OPENCODE_CONFIG = join(f.root, 'unsafe.json')
    expect(run(f).status).toBe(0)
    waitFor(join(f.dir, '.lane', 'run.log'))
    expect(readFileSync(join(f.dir, 'spawned'), 'utf8')).toBe('spawned')
    expect(readFileSync(f.env.IDENTITY_RECORD, 'utf8').trim().split('\n').slice(-2)).toEqual([
      `probe|${f.dir}|same|unset`,
      `run|${f.dir}|same|unset`,
    ])
  })
  it('keeps an empty allow-list launchable when the allow half is unavailable', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.INVISIBLE_ALLOW = '1'
    const res = run(f)
    expect(res.status).toBe(0)
    waitFor(join(f.dir, '.lane', 'run.log'))
    expect(readFileSync(join(f.dir, 'spawned'), 'utf8')).toBe('spawned')
  })
  it('refuses requested single-writer, missing, and unavailable allow-list skills before launch', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.WT_LANE_SKILLS = 'save-memory'
    expect(run(f).stderr).toContain('save-memory is a single-writer memory/board-writing skill')
    f.env.WT_LANE_SKILLS = 'missing'
    expect(run(f).stderr).toContain('missing: missing-source (skill source is missing: missing)')
    mkdirSync(join(f.config, 'skills', 'allowed'), { recursive: true })
    writeFileSync(join(f.config, 'skills', 'allowed', 'SKILL.md'), '---\nname: allowed\ndescription: allowed\n---\n')
    f.env.WT_LANE_SKILLS = 'allowed'; f.env.INVISIBLE_ALLOW = '1'
    const unavailable = run(f)
    expect(unavailable.status).toBe(1)
    expect(unavailable.stderr).toContain('allow-list half failed for opencode-config-skills-paths')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })
  it.each(['save_memory', 'SAVE-MEMORY'])('refuses requested single-writer variant %s', (name) => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.WT_LANE_SKILLS = name
    expect(run(f).stderr).toContain('single-writer memory/board-writing skill')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })
  it('passes the materialised mechanism only for requested allowed skills', () => {
    const f = fixture('printf "%s" "$OPENCODE_CONFIG" > "$PWD/opencode-config"')
    mkdirSync(join(f.config, 'skills', 'allowed'), { recursive: true })
    writeFileSync(join(f.config, 'skills', 'allowed', 'SKILL.md'), '---\nname: allowed\ndescription: allowed\n---\n')
    f.env.WT_LANE_SKILLS = 'allowed'
    expect(run(f).status).toBe(0)
    waitFor(join(f.dir, '.lane', 'run.log'))
    expect(readFileSync(join(f.dir, 'opencode-config'), 'utf8')).toBe(join(f.dir, '.lane', 'opencode-skills.json'))
  })
  it('refuses absent consent before spawning', () => {
    const f = fixture('echo spawned > "$PWD/spawned"')
    writeFileSync(join(f.config, 'settings.json'), '{}')
    const res = run(f); expect(res.status).not.toBe(0); expect(res.stderr).toContain('Refused:')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })
  it('rejects missing required arguments', () => {
    const f = fixture('true')
    const res = spawnSync(process.execPath, [LAUNCHER, '--model', 'test/model', '--brief', join(f.dir, 'brief.md')], { encoding: 'utf8', env: f.env })
    expect(res.status).toBe(2); expect(res.stderr).toContain('missing required')
  })
  it('writes a redacted environment snapshot and launching session when the worker starts', () => {
    const f = fixture('sleep 0.2')
    delete f.env.CLAUDE_CODE_SESSION_ID
    writeFileSync(join(f.root, 'bin', 'ssh-add'), '#!/bin/sh\nprintf \'ssh-rsa AAAA fingerprint\n\'\nexit 0\n')
    spawnSync('chmod', ['+x', join(f.root, 'bin', 'ssh-add')])
    const res = run(f); expect(res.status).toBe(0)
    const envLog = join(f.dir, '.lane', 'env.log'); waitForFile(envLog)
    const lines = readFileSync(envLog, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toBe('CLAUDE_CODE_SESSION_ID=')
    expect(lines[1]).toMatch(/^SSH_AUTH_SOCK=(present|absent)$/)
    expect(lines[2]).toBe('ssh-add -l: exit=0 keys=1')
    expect(lines[3]).toMatch(/^HOME=(present|absent) USER=(present|absent)$/)
    expect(lines[4]).toMatch(/^node=v\d+\.\d+\.\d+$/)
    expect(lines[5]).toMatch(/^at=\d{4}-\d\d-\d\dT.*Z$/)
    expect(readFileSync(envLog, 'utf8')).not.toMatch(/ssh-rsa|fingerprint|AAAA|\/home\//)
  })

  it('records the launching Claude session id and an empty value when absent', () => {
    const withSession = fixture('sleep 0.2')
    withSession.env.CLAUDE_CODE_SESSION_ID = 'session-under-test'
    expect(run(withSession).status).toBe(0)
    const withSessionLog = join(withSession.dir, '.lane', 'env.log'); waitForFile(withSessionLog)
    expect(readFileSync(withSessionLog, 'utf8')).toContain('CLAUDE_CODE_SESSION_ID=session-under-test\n')

    const withoutSession = fixture('sleep 0.2')
    delete withoutSession.env.CLAUDE_CODE_SESSION_ID
    expect(run(withoutSession).status).toBe(0)
    const withoutSessionLog = join(withoutSession.dir, '.lane', 'env.log'); waitForFile(withoutSessionLog)
    expect(readFileSync(withoutSessionLog, 'utf8')).toContain('CLAUDE_CODE_SESSION_ID=\n')
  })
  it('records an ssh-add exit without exposing probe output', () => {
    const f = fixture('sleep 0.2')
    writeFileSync(join(f.root, 'bin', 'ssh-add'), '#!/bin/sh\nexit 2\n')
    spawnSync('chmod', ['+x', join(f.root, 'bin', 'ssh-add')])
    expect(run(f).status).toBe(0)
    const envLog = join(f.dir, '.lane', 'env.log'); waitForFile(envLog)
    expect(readFileSync(envLog, 'utf8')).toContain('ssh-add -l: exit=2 keys=0')
    expect(readFileSync(envLog, 'utf8')).not.toMatch(/ssh-ed25519|SHA256:|secret|AAAA/)
  })
  it('reports keys=0 when ssh-add fails while still printing a sentence', () => {
    const f = fixture('sleep 0.2')
    writeFileSync(join(f.root, 'bin', 'ssh-add'), '#!/bin/sh\nprintf \'The agent has no identities.\\n\'\nexit 1\n')
    spawnSync('chmod', ['+x', join(f.root, 'bin', 'ssh-add')])
    expect(run(f).status).toBe(0)
    const envLog = join(f.dir, '.lane', 'env.log'); waitForFile(envLog)
    expect(readFileSync(envLog, 'utf8')).toContain('ssh-add -l: exit=1 keys=0')
    expect(readFileSync(envLog, 'utf8')).not.toContain('identities')
  })
})
