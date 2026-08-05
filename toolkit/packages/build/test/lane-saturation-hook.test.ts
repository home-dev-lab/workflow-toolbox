// lane-saturation-hook.test.ts — behaviour lock for the PreToolUse advisory that makes
// external-lane contention visible (plugin/bin/wt-lane-saturation-hook.mjs).
//
// The defect it addresses is not carelessness: a lane is a shared resource nobody
// reserves, and every arc sees only its own calls. Two concurrent arcs both observe "it's
// slow, nothing comes back" and neither can reach the cause, because the cause is in the
// other one. So the silence cases below are not padding — a guard that fires on ordinary
// commands becomes noise within a day and takes its real case with it.

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { countLaneProcessesReal, evaluateLaneCall } from '../../../../plugin/bin/lib/wt-lane-saturation-core.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-lane-saturation-hook.mjs')

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('wt-lane-saturation-hook.mjs', () => {
  it('is silent on a command that has nothing to do with the lane', () => {
    const result = evaluateLaneCall(
      { tool_input: { command: 'ls -la' } },
      {
        countLaneProcesses: () => {
          throw new Error('countLaneProcesses should not be called for unrelated commands')
        },
      },
    )
    expect(result.silent).toBe(true)
  })

  it('is silent on a command that MENTIONS the lane without invoking it', () => {
    // The distinction that keeps this usable: a grep, a doc edit, or a commit message
    // about the lane must not trip a contention warning.
    const countLaneProcesses = () => {
      throw new Error('countLaneProcesses should not be called for non-invocations')
    }
    expect(evaluateLaneCall({ tool_input: { command: 'grep -rn opencode docs/' } }, { countLaneProcesses }).silent).toBe(true)
    expect(
      evaluateLaneCall({ tool_input: { command: 'git commit -m "document the opencode lane"' } }, { countLaneProcesses }).silent,
    ).toBe(true)
  })

  it('is silent on a real lane call while the lane is below its bound', () => {
    const result = evaluateLaneCall(
      { tool_input: { command: 'opencode run --model openai/gpt-5.4 review < /dev/null' } },
      {
        countLaneProcesses: () => ({ state: 'ok', count: 0 }),
        boundFromEnv: () => ({ bound: 8, source: 'WT_LANE_MAX_CONCURRENT' }),
      },
    )
    expect(result.silent).toBe(true)
  })

  it('speaks — naming the count, the bound and the real failure mode — when the call would cross the bound', () => {
    const result = evaluateLaneCall(
      { tool_input: { command: 'opencode run -m x y < /dev/null' } },
      {
        countLaneProcesses: () => ({ state: 'ok', count: 1 }),
        boundFromEnv: () => ({ bound: 1, source: 'WT_LANE_MAX_CONCURRENT' }),
      },
    )
    expect(result.silent).toBe(false)
    expect(result.message).toContain('at or past its bound')
    expect(result.message).toContain('bound 1')
    // The reader must be told what actually goes wrong: not a clean refusal, but a
    // slowdown that the CALLER's own timeout turns into a dead call.
    expect(result.message).toContain('converts that slowdown into a dead call')
    // And that a 0-byte output file proves nothing while the process is alive.
    expect(result.message).toContain('does NOT distinguish "queued" from "about to expire"')
    // Advisory, never a gate.
    expect(result.message).toContain('NOT blocked')
  })

  it('reports NOT MEASURED — never a zero — when counting is unavailable', () => {
    // The failure this closes: "pgrep is missing" and "nothing is running" are opposite
    // facts, and reporting the first as the second tells a caller the lane is free at
    // exactly the moment nobody can tell.
    const result = evaluateLaneCall(
      { tool_input: { command: 'opencode run -m x y < /dev/null' } },
      {
        countLaneProcesses: () => ({ state: 'unknown', reason: 'pgrep is unavailable (ENOENT)' }),
        boundFromEnv: () => ({ bound: 8, source: 'default' }),
      },
    )
    expect(result.silent).toBe(false)
    expect(result.message).toContain('NOT MEASURED')
    expect(result.message).toContain('not a report that the lane is free')
    expect(result.message).not.toContain('at or past its bound')
  })

  // This is the one test in this suite that exercises the real, ambient-dependent `pgrep`
  // mechanism; it is deliberately built to tolerate other real `opencode`/`codex` processes
  // already running on this machine via a before/after delta, and if `pgrep` itself is
  // unavailable it skips rather than fails. This is NOT a silent flake tolerance — it is a
  // documented, deliberate scope limitation.
  it('counts by exact process name in the real pgrep path, using a delta robust to ambient usage', ({ skip }) => {
    const baseline = countLaneProcessesReal(['opencode'])
    if (baseline.state === 'unknown') {
      skip()
      return
    }

    const root = mkdtempSync(join(tmpdir(), 'wt-lane-real-'))
    roots.push(root)
    const fake = join(root, 'opencode')
    const marker = join(root, 'marker.sh')
    copyFileSync('/bin/sleep', fake)
    chmodSync(fake, 0o755)
    writeFileSync(marker, '#!/bin/sh\n# opencode run --model x\nsleep 5\n')
    chmodSync(marker, 0o755)

    const laneChild = spawnSync(process.execPath, [
      '-e',
      `const {spawn}=require('node:child_process');const c=spawn(${JSON.stringify(fake)},['5'],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid)`,
    ], { encoding: 'utf8' })
    const lanePid = Number.parseInt(String(laneChild.stdout ?? '').trim(), 10)

    let shellPid = Number.NaN

    try {
      const withLane = countLaneProcessesReal(['opencode'])
      expect(withLane.state).toBe('ok')
      if (withLane.state === 'ok') expect(withLane.count - baseline.count).toBe(1)

      const shellChild = spawnSync(process.execPath, [
        '-e',
        `const {spawn}=require('node:child_process');const c=spawn('/bin/sh',[${JSON.stringify(marker)}],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid)`,
      ], { encoding: 'utf8' })
      shellPid = Number.parseInt(String(shellChild.stdout ?? '').trim(), 10)

      const withShellMention = countLaneProcessesReal(['opencode'])
      expect(withShellMention.state).toBe('ok')
      if (withShellMention.state === 'ok') expect(withShellMention.count - baseline.count).toBe(1)
    } finally {
      for (const pid of [lanePid, shellPid]) {
        if (!Number.isFinite(pid)) continue
        try {
          process.kill(pid)
        } catch {
          /* already gone */
        }
      }
    }
  })

  it('the CLI wrapper stays silent on a non-lane command and exits 0', () => {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }),
      encoding: 'utf8',
      env: process.env,
    })
    expect(`${res.stdout ?? ''}${res.stderr ?? ''}`).toBe('')
    expect(res.status).toBe(0)
  })
})
