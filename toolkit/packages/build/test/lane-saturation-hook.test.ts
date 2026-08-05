// lane-saturation-hook.test.ts — behaviour lock for the PreToolUse advisory that makes
// external-lane contention visible (plugin/bin/wt-lane-saturation-hook.mjs).
//
// The defect it addresses is not carelessness: a lane is a shared resource nobody
// reserves, and every arc sees only its own calls. Two concurrent arcs both observe "it's
// slow, nothing comes back" and neither can reach the cause, because the cause is in the
// other one. So the silence cases below are not padding — a guard that fires on ordinary
// commands becomes noise within a day and takes its real case with it.

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-lane-saturation-hook.mjs')

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function run(command: string, env: Record<string, string> = {}): { out: string; code: number | null } {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { out: `${res.stdout ?? ''}${res.stderr ?? ''}`, code: res.status }
}

describe('wt-lane-saturation-hook.mjs', () => {
  it('is silent on a command that has nothing to do with the lane', () => {
    expect(run('ls -la').out).toBe('')
  })

  it('is silent on a command that MENTIONS the lane without invoking it', () => {
    // The distinction that keeps this usable: a grep, a doc edit, or a commit message
    // about the lane must not trip a contention warning.
    expect(run('grep -rn opencode docs/').out).toBe('')
    expect(run('git commit -m "document the opencode lane"').out).toBe('')
  })

  it('is silent on a real lane call while the lane is below its bound', () => {
    // Nothing named `opencode`/`codex` is running in the test environment, so a generous
    // bound must produce no output at all.
    const { out, code } = run('opencode run --model openai/gpt-5.4 review < /dev/null', {
      WT_LANE_MAX_CONCURRENT: '8',
    })
    expect(out).toBe('')
    expect(code).toBe(0)
  })

  it('speaks — naming the count, the bound and the real failure mode — when the call would cross the bound', () => {
    // A real process whose EXACT NAME is `opencode`, so the hook counts something true
    // rather than a fixture of its own beliefs.
    const root = mkdtempSync(join(tmpdir(), 'wt-lane-'))
    roots.push(root)
    const fake = join(root, 'opencode')
    copyFileSync('/bin/sleep', fake)
    chmodSync(fake, 0o755)
    const child = spawnSync(process.execPath, [
      '-e',
      `const {spawn}=require('node:child_process');const c=spawn(${JSON.stringify(fake)},['3'],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid)`,
    ], { encoding: 'utf8' })
    const pid = Number.parseInt(String(child.stdout ?? '').trim(), 10)
    try {
      const { out, code } = run('opencode run -m x y < /dev/null', { WT_LANE_MAX_CONCURRENT: '1' })
      expect(out).toContain('at or past its bound')
      expect(out).toContain('bound 1')
      // The reader must be told what actually goes wrong: not a clean refusal, but a
      // slowdown that the CALLER's own timeout turns into a dead call.
      expect(out).toContain('converts that slowdown into a dead call')
      // And that a 0-byte output file proves nothing while the process is alive.
      expect(out).toContain('does NOT distinguish "queued" from "about to expire"')
      // Advisory, never a gate.
      expect(out).toContain('NOT blocked')
      expect(code).toBe(0)
    } finally {
      try {
        process.kill(pid)
      } catch {
        /* already gone — the sleep is short by design */
      }
    }
  })

  it('reports NOT MEASURED — never a zero — when the counting tool is unavailable', () => {
    // The failure this closes: "pgrep is missing" and "nothing is running" are opposite
    // facts, and reporting the first as the second tells a caller the lane is free at
    // exactly the moment nobody can tell.
    const root = mkdtempSync(join(tmpdir(), 'wt-lane-nopgrep-'))
    roots.push(root)
    const { out, code } = run('opencode run -m x y < /dev/null', { PATH: root })
    expect(out).toContain('NOT MEASURED')
    expect(out).toContain('not a report that the lane is free')
    expect(out).not.toContain('at or past its bound')
    expect(code).toBe(0)
  })

  it('counts by exact process name, so a shell merely carrying the string is not counted', () => {
    // This is the trap the hook exists to avoid, and it is worth asserting directly:
    // measured on a machine with ZERO lane calls running, `pgrep -c -f 'opencode run'`
    // returned 2 (its own shells) while `pgrep -c -x opencode` returned 0. A guard built
    // on the command-line form would warn about contention that does not exist.
    const root = mkdtempSync(join(tmpdir(), 'wt-lane-selfmatch-'))
    roots.push(root)
    const marker = join(root, 'holder.sh')
    writeFileSync(marker, '#!/bin/sh\n# opencode run --model x\nsleep 3\n')
    chmodSync(marker, 0o755)
    const child = spawnSync(process.execPath, [
      '-e',
      `const {spawn}=require('node:child_process');const c=spawn('/bin/sh',[${JSON.stringify(marker)}],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid)`,
    ], { encoding: 'utf8' })
    const pid = Number.parseInt(String(child.stdout ?? '').trim(), 10)
    try {
      // A process whose command line carries the lane string but whose NAME is `sh`.
      // With a bound of 1 the hook must still stay silent: nothing named opencode runs.
      expect(existsSync(marker)).toBe(true)
      const { out } = run('opencode run -m x y < /dev/null', { WT_LANE_MAX_CONCURRENT: '1' })
      expect(out).toBe('')
    } finally {
      try {
        process.kill(pid)
      } catch {
        /* already gone */
      }
    }
  })
})
