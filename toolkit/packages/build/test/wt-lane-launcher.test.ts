import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const LAUNCHER = join(ROOT, 'plugin/bin/wt-lane.mjs')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(script: string) {
  const root = mkdtempSync(join(tmpdir(), 'wt-lane-launcher-')); roots.push(root)
  const dir = join(root, 'worktree'); const bin = join(root, 'bin'); const config = join(root, 'config')
  mkdirSync(join(dir, '.lane'), { recursive: true }); mkdirSync(bin); mkdirSync(config)
  writeFileSync(join(dir, 'brief.md'), '# brief\n')
  writeFileSync(join(bin, 'opencode'), `#!/bin/sh\n${script}\n`)
  spawnSync('chmod', ['+x', join(bin, 'opencode')])
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
  return { root, dir, config, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: config } }
}
function run(f: ReturnType<typeof fixture>, extra: string[] = []) {
  return spawnSync(process.execPath, [LAUNCHER, '--dir', f.dir, '--model', 'test/model', '--brief', join(f.dir, 'brief.md'), ...extra], { encoding: 'utf8', env: f.env })
}
function waitFor(log: string, ms = 3000) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (existsSync(log) && /EXIT=/.test(readFileSync(log, 'utf8'))) return; spawnSync('sleep', ['0.05']) }
}

describe('wt-lane detached launcher', () => {
  it('returns immediately, leaves the worker alive, closes stdin, and writes EXIT=0', () => {
    const f = fixture('IFS= read -r x; test -z "$x"; sleep 0.2; echo done')
    const res = run(f); const log = join(f.dir, '.lane', 'run.log')
    expect(res.status).toBe(0); expect(res.stdout).toMatch(/pid=\d+\nlog=/)
     const pid = Number(/pid=(\d+)/.exec(res.stdout)?.[1]); expect(() => process.kill(pid, 0)).not.toThrow()
     expect(readFileSync(join(f.dir, '.lane', 'pid'), 'utf8').trim()).toBe(String(pid))
    waitFor(log); expect(readFileSync(log, 'utf8')).toMatch(/EXIT=0\n$/)
  })
  it('enforces the timeout with EXIT=124', () => {
    const f = fixture('sleep 30')
    const res = run(f, ['--timeout', '1']); expect(res.status).toBe(0)
    const log = join(f.dir, '.lane', 'run.log'); waitFor(log, 3000)
    expect(readFileSync(log, 'utf8')).toMatch(/EXIT=124\n$/)
  })
  it('passes --variant through to opencode and refuses a malformed one', () => {
    const f = fixture('printf "%s\\n" "$@" > "$PWD/argv"; IFS= read -r x; echo done')
    const res = run(f, ['--variant', 'high']); expect(res.status).toBe(0)
    const log = join(f.dir, '.lane', 'run.log'); waitFor(log)
    expect(readFileSync(join(f.dir, 'argv'), 'utf8')).toMatch(/--variant\nhigh\n/)
    const bad = run(f, ['--variant', 'hi gh']); expect(bad.status).toBe(2); expect(bad.stderr).toContain('--variant')
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
})
