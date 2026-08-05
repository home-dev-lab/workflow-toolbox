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
const ORIGINAL_ENFORCE_MODE = process.env.WT_LANE_ENFORCE_MODE
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  // A test asserting the real default must delete the env var to observe it — restore
  // whatever was there before (present or absent) so later tests, or a CI/operator-set
  // value, are never silently discarded by this file.
  if (ORIGINAL_ENFORCE_MODE === undefined) delete process.env.WT_LANE_ENFORCE_MODE
  else process.env.WT_LANE_ENFORCE_MODE = ORIGINAL_ENFORCE_MODE
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

  it('is silent when the literal phrase "opencode run"/"codex exec" appears only inside quotes or a comment — never a real invocation', () => {
    // A command line MIXES code and data: text a shell would never execute (a quoted
    // argument, a shell comment) must not read as if it would. Before this, these each
    // matched the raw LANE_INVOCATIONS regex and would have DENIED once this guard could
    // deny — a real false-deny risk for any Bash caller, main session included.
    const countLaneProcesses = () => {
      throw new Error('countLaneProcesses should not be called for mention-only commands')
    }
    const cases = [
      "echo 'opencode run x'",
      `printf '%s\\n' 'opencode run'`,
      'echo "please do not opencode run this manually"',
      '# opencode run is documented below',
      'cat notes.txt # reminder: opencode run needs the model flag',
    ]
    for (const command of cases) {
      expect(evaluateLaneCall({ tool_input: { command } }, { countLaneProcesses }).silent, command).toBe(true)
    }
  })

  it('still detects a real invocation chained after another command, or preceded by an unquoted modifier', () => {
    // The false-positive fix must not become a false-negative regression: a real lane call
    // is never itself wrapped in quotes or written after a comment marker, so stripping
    // quoted/commented text must leave true positives untouched. Forced deliberately over
    // bound so the ONLY way this returns non-silent is that the command was recognized as
    // an invocation at all — a command missed by detection short-circuits to silent:true
    // before countLaneProcesses is even consulted, regardless of what it would have said.
    const countLaneProcesses = () => ({ state: 'ok' as const, count: 100 })
    const boundFromEnv = () => ({ bound: 1, source: 'default' })
    const cases = [
      'cd /tmp && opencode run --model x < /dev/null',
      'nohup opencode run --model x < /dev/null &',
      'echo starting; opencode run --model x < /dev/null',
    ]
    for (const command of cases) {
      expect(evaluateLaneCall({ tool_input: { command } }, { countLaneProcesses, boundFromEnv }).silent, command).toBe(false)
    }
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

  it('DENIES by default — naming the count, the bound and the real failure mode — when the call would cross the bound', () => {
    // Default enforcement is now `deny`, not advisory: an informed caller was measured
    // (on this exact card) proceeding past a plain warning anyway, because nothing forced
    // otherwise. `enforceModeFromEnv` is not injected here, so this exercises the real
    // default — confirm it reads 'deny' with no WT_LANE_ENFORCE_MODE override present.
    delete process.env.WT_LANE_ENFORCE_MODE
    const result = evaluateLaneCall(
      { tool_input: { command: 'opencode run -m x y < /dev/null' } },
      {
        countLaneProcesses: () => ({ state: 'ok', count: 1 }),
        boundFromEnv: () => ({ bound: 1, source: 'WT_LANE_MAX_CONCURRENT' }),
      },
    )
    expect(result.silent).toBe(false)
    expect(result.deny).toBe(true)
    expect(result.message).toContain('at or past its bound')
    expect(result.message).toContain('bound 1')
    // The reader must be told what actually goes wrong: not a clean refusal from the CLI,
    // but a slowdown that the CALLER's own timeout turns into a dead call — kept even
    // though this call is now refused before it ever reaches that CLI, because the same
    // guard falls back to warn mode where the slowdown-not-refusal distinction matters.
    expect(result.message).toContain('converts that slowdown into a dead call')
    // And that a 0-byte output file proves nothing while the process is alive.
    expect(result.message).toContain('does NOT distinguish "queued" from "about to expire"')
    expect(result.message).toContain('REFUSED, not merely flagged')
    expect(result.message).toContain('WT_LANE_ENFORCE_MODE=warn')
  })

  it('falls back to advisory (never denies) when WT_LANE_ENFORCE_MODE=warn', () => {
    // The rollback lever: instant, no code change, for if the deny default proves too
    // aggressive under real usage.
    const result = evaluateLaneCall(
      { tool_input: { command: 'opencode run -m x y < /dev/null' } },
      {
        countLaneProcesses: () => ({ state: 'ok', count: 1 }),
        boundFromEnv: () => ({ bound: 1, source: 'WT_LANE_MAX_CONCURRENT' }),
        env: { WT_LANE_ENFORCE_MODE: 'warn' },
      },
    )
    expect(result.silent).toBe(false)
    expect(result.deny).toBe(false)
    expect(result.message).toContain('at or past its bound')
    expect(result.message).toContain('This is advisory (WT_LANE_ENFORCE_MODE=warn)')
    expect(result.message).toContain('call is NOT blocked')
  })

  it('reports NOT MEASURED — never a zero, and NEVER denies — when counting is unavailable', () => {
    // The failure this closes: "pgrep is missing" and "nothing is running" are opposite
    // facts, and reporting the first as the second tells a caller the lane is free at
    // exactly the moment nobody can tell. A measurement failure must never be grounds to
    // block — that direction of error is at least as costly as the one this guard exists
    // to catch.
    const result = evaluateLaneCall(
      { tool_input: { command: 'opencode run -m x y < /dev/null' } },
      {
        countLaneProcesses: () => ({ state: 'unknown', reason: 'pgrep is unavailable (ENOENT)' }),
        boundFromEnv: () => ({ bound: 8, source: 'default' }),
      },
    )
    expect(result.silent).toBe(false)
    expect(result.deny).toBe(false)
    expect(result.message).toContain('NOT MEASURED')
    expect(result.message).toContain('not a report that the lane is free')
    expect(result.message).not.toContain('at or past its bound')
  })

  it('is silent — never even reaches the deny decision — while strictly below the bound', () => {
    // The false-deny check for uncontended usage: a call that would not cross the bound
    // must never be touched by the enforcement mode at all.
    const result = evaluateLaneCall(
      { tool_input: { command: 'opencode run -m x y < /dev/null' } },
      {
        countLaneProcesses: () => ({ state: 'ok', count: 0 }),
        boundFromEnv: () => ({ bound: 8, source: 'default' }),
      },
    )
    expect(result.silent).toBe(true)
    expect(result.deny).toBeUndefined()
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

  // Now that this guard can DENY, a broken entry path must fail OPEN, never closed — an
  // uncaught exception here silently blocking every lane call on the machine would be a
  // worse outcome than the contention this guard exists to prevent. Uses the fail-open
  // self-test seam (WT_FAIL_OPEN_TRACE_SELF_TEST) shared by every deny-capable guard in
  // this directory, so this is a real exercise of the same code path they all use, not a
  // bespoke fixture.
  it('fails OPEN (allows, never denies) when the entry path throws — real self-test seam, no mock', () => {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'opencode run -m x < /dev/null' } }),
      encoding: 'utf8',
      env: { ...process.env, WT_FAIL_OPEN_TRACE_SELF_TEST: 'wt-lane-saturation-hook.mjs' },
    })
    expect(res.status).toBe(0)
    expect(res.stdout ?? '').toBe('') // no deny JSON, no advisory text — silent allow
    expect(res.stderr ?? '').toContain('wt-lane-saturation-hook.mjs: FAILED OPEN')
  })

  // ── Manufactured two-arc contention proof ─────────────────────────────────────────────
  //
  // The discriminating requirement this guard is held to: seeing, on a case built
  // deliberately, BOTH (a) a second launcher genuinely bounds itself or waits because the
  // lane is saturated, and (b) the lane stays usable by both arcs with no lost work. A
  // mechanism that has never met real contention is not proven — a green suite of mocked
  // branches does not settle that on its own, because a mock agrees with whatever the test
  // author already believed.
  //
  // This drives the REAL CLI script (HOOK) — spawned exactly as the harness's PreToolUse
  // dispatcher would invoke it, stdin JSON in, stdout JSON out — through the REAL
  // pgrep-backed counting path, against a REAL process named exactly `opencode` — the same
  // positive-control technique as the delta test above — playing "arc A" (already
  // occupying the lane) against "arc B" (the launcher under test). ⚠ SCOPE, stated
  // honestly: this proves the HOOK's own decision (does it emit permissionDecision:'deny'
  // under real contention, and allow again once it drains) — it does not drive Claude
  // Code's actual dispatcher or a real `opencode run` process for arc B, so it cannot by
  // itself prove the harness obeys a `deny` decision (that is the harness's own contract,
  // not this hook's). "No call ever executes past the bound" is verified at the level this
  // hook controls: arc B's own `opencode run` process is never spawned by a refused call.
  // Skips (never fails) if pgrep is unavailable, for the same documented reason as above.
  it('two-arc contention: the hook denies arc B while arc A saturates the lane, and allows again once arc A drains — arc B is never itself spawned by a refused call', ({ skip }) => {
    const baseline = countLaneProcessesReal(['opencode'])
    if (baseline.state === 'unknown') {
      skip()
      return
    }

    const root = mkdtempSync(join(tmpdir(), 'wt-lane-contend-'))
    roots.push(root)
    const fake = join(root, 'opencode')
    copyFileSync('/bin/sleep', fake)
    chmodSync(fake, 0o755)

    // Bound is sized RELATIVE to whatever is already live on this machine (baseline), not
    // to an absolute count — the same robustness discipline as the delta test above. With
    // the bound set to exactly baseline+1: arc B's call is allowed while only the ambient
    // baseline is live, denied once arc A adds one more live process, and allowed again
    // once arc A's process exits.
    const env: NodeJS.ProcessEnv = { ...process.env, WT_LANE_MAX_CONCURRENT: String(baseline.count + 1) }
    delete env.WT_LANE_ENFORCE_MODE // real default: deny

    const callArcB = () =>
      spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'opencode run --model openai/gpt-5.4 review < /dev/null' } }),
        encoding: 'utf8',
        env,
      })

    // --- direction (b), first half: UNCONTENDED — arc B must pass through untouched. This
    // is the false-deny check the closing criterion's own "no lost work" half depends on:
    // a guard that denies normal, uncontended usage is worse than the problem it fixes.
    const before = callArcB()
    expect(before.status).toBe(0)
    expect(`${before.stdout ?? ''}`.trim()).toBe('') // silent = allowed, no deny JSON

    // --- arc A saturates the lane: one real process, named exactly `opencode`, alive.
    const arcA = spawnSync(process.execPath, [
      '-e',
      `const {spawn}=require('node:child_process');const c=spawn(${JSON.stringify(fake)},['5'],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid)`,
    ], { encoding: 'utf8' })
    const arcAPid = Number.parseInt(String(arcA.stdout ?? '').trim(), 10)

    try {
      // Poll until pgrep actually sees arc A's process under its exact name, rather than a
      // blind sleep — the same drain-polling discipline as the recovery half below.
      const registerDeadline = Date.now() + 5000
      while (Date.now() < registerDeadline) {
        const current = countLaneProcessesReal(['opencode'])
        if (current.state === 'ok' && current.count > baseline.count) break
        spawnSync('sleep', ['0.1'])
      }

      // --- direction (a): arc B is now DENIED — it must genuinely be refused, not merely
      // told. This is the harness-level refusal (permissionDecision:'deny'); arc B's
      // ACTUAL `opencode run` process is never spawned by this refused call — which is
      // exactly what "no lost work" (direction b) requires: a denied call cannot time out,
      // because it never started.
      const contended = callArcB()
      expect(contended.status).toBe(0)
      const parsed = JSON.parse(contended.stdout || '{}')
      expect(parsed?.hookSpecificOutput?.permissionDecision).toBe('deny')
      expect(String(parsed?.hookSpecificOutput?.permissionDecisionReason ?? '')).toContain('REFUSED, not merely flagged')
      expect(String(parsed?.hookSpecificOutput?.permissionDecisionReason ?? '')).toContain('at or past its bound')
    } finally {
      if (Number.isFinite(arcAPid)) {
        try {
          process.kill(arcAPid)
        } catch {
          /* already gone */
        }
      }
    }

    // --- direction (b), second half: arc A has DRAINED — the lane stays USABLE for arc B,
    // which now proceeds exactly as it would have without ever having lost a batch: no
    // retry loop, no accumulated state, no manual intervention. This is "waits, then
    // proceeds" made concrete rather than asserted. Poll for the real count to actually
    // return to baseline rather than a fixed sleep — killing a process is asynchronous, and
    // a blind delay either flakes under scheduling pressure or pads every run with slack
    // that was never needed.
    const drainDeadline = Date.now() + 5000
    while (Date.now() < drainDeadline) {
      const current = countLaneProcessesReal(['opencode'])
      if (current.state === 'ok' && current.count <= baseline.count) break
      spawnSync('sleep', ['0.1'])
    }
    const after = callArcB()
    expect(after.status).toBe(0)
    expect(`${after.stdout ?? ''}`.trim()).toBe('')
  })
})
