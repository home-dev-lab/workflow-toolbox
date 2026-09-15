// lane-saturation-hook.test.ts — behaviour lock for the PreToolUse advisory that makes
// external-lane contention visible (plugin/bin/wt-lane-saturation-hook.mjs).
//
// The defect it addresses is not carelessness: a lane is a shared resource nobody
// reserves, and every arc sees only its own calls. Two concurrent arcs both observe "it's
// slow, nothing comes back" and neither can reach the cause, because the cause is in the
// other one. So the silence cases below are not padding — a guard that fires on ordinary
// commands becomes noise within a day and takes its real case with it.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { LANE_PROCESS_NAMES, countLaneProcessesReal, evaluateLaneCall } from '../../../../plugin/bin/lib/wt-lane-saturation-core.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-lane-saturation-hook.mjs')

const roots: string[] = []
const ORIGINAL_ENFORCE_MODE = process.env.WT_LANE_ENFORCE_MODE

function childExit(child: ChildProcess) {
  return new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

async function waitForOwnedLane(pid: number, executable: string, patienceMs = 10_000) {
  const deadline = Date.now() + patienceMs
  while (Date.now() < deadline) {
    const count = countLaneProcessesReal(['opencode'], [pid])
    let argvMatches = true
    if (process.platform === 'linux') {
      try { argvMatches = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] === executable } catch { argvMatches = false }
    }
    if (count.state === 'ok' && count.pids?.includes(pid) && argvMatches) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`owned lane pid ${pid} did not become visible with argv ${executable}`)
}

async function stopOwnedChild(child: ChildProcess, executable: string) {
  if (!child.pid) return
  await waitForOwnedLane(child.pid, executable)
  const exited = childExit(child)
  child.kill('SIGTERM')
  await exited
}

function verifyOwnedArgv(child: ChildProcess, executable: string) {
  if (!child.pid) throw new Error('owned child has no pid')
  if (process.platform === 'linux') {
    expect(readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0')[0]).toBe(executable)
  } else {
    expect(child.spawnfile).toBe(executable)
  }
}
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

  it('is silent when a heredoc-written fixture contains a lane invocation mention', () => {
    const countLaneProcesses = () => {
      throw new Error('countLaneProcesses should not be called for heredoc data')
    }
    const command = `cat > fixture.ts <<'EOF'\nopencode run --model x\nEOF`
    expect(evaluateLaneCall({ tool_input: { command } }, { countLaneProcesses }).silent).toBe(true)
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

  // This is the one test in this suite that exercises the real `pgrep`
  // mechanism; it is deliberately restricted to PIDs this test spawned and whose argv it
  // verifies, so unrelated `opencode`/`codex` processes cannot affect it. If `pgrep` itself is
  // unavailable it skips rather than fails. This is NOT a silent flake tolerance — it is a
  // documented, deliberate scope limitation.
  it('counts by exact process name in the real pgrep path, restricted to child pids and argv the test owns', async ({ skip }) => {
    const available = countLaneProcessesReal(['opencode'], [])
    if (available.state === 'unknown') {
      skip()
      return
    }

    const root = mkdtempSync(join(tmpdir(), 'wt-lane-real-'))
    roots.push(root)
    const fake = join(root, 'opencode')
    const marker = join(root, 'marker.sh')
    copyFileSync('/bin/sleep', fake)
    chmodSync(fake, 0o755)
    writeFileSync(marker, '#!/bin/sh\n# opencode run --model x\nsleep 30\n')
    chmodSync(marker, 0o755)

    const laneChild = spawn(fake, ['30'], { stdio: 'ignore' })
    if (!laneChild.pid) throw new Error('lane child has no pid')
    await waitForOwnedLane(laneChild.pid, fake)
    let shellChild: ChildProcess | null = null

    try {
      const withLane = countLaneProcessesReal(['opencode'], [laneChild.pid])
      expect(withLane.state).toBe('ok')
      if (withLane.state === 'ok') expect(withLane).toMatchObject({ count: 1, pids: [laneChild.pid] })

      shellChild = spawn('/bin/sh', [marker], { stdio: 'ignore' })
      if (!shellChild.pid) throw new Error('shell child has no pid')

      const withShellMention = countLaneProcessesReal(['opencode'], [laneChild.pid, shellChild.pid])
      expect(withShellMention.state).toBe('ok')
      if (withShellMention.state === 'ok') expect(withShellMention).toMatchObject({ count: 1, pids: [laneChild.pid] })
    } finally {
      if (shellChild?.pid) {
        verifyOwnedArgv(shellChild, '/bin/sh')
        const exited = childExit(shellChild)
        shellChild.kill('SIGTERM')
        await exited
      }
      await stopOwnedChild(laneChild, fake)
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

  it('an empty or malformed owned-pid control cannot hide a real lane process from the limiter', async ({ skip }) => {
    const available = countLaneProcessesReal(['opencode'], [])
    if (available.state === 'unknown') {
      skip()
      return
    }
    const root = mkdtempSync(join(tmpdir(), 'wt-lane-empty-owned-'))
    roots.push(root)
    const fake = join(root, 'opencode')
    copyFileSync('/bin/sleep', fake)
    chmodSync(fake, 0o755)
    const lane = spawn(fake, ['30'], { stdio: 'ignore' })
    if (!lane.pid) throw new Error('lane child has no pid')
    await waitForOwnedLane(lane.pid, fake)

    try {
      for (const pids of ['', 'not-a-pid', `${lane.pid},broken`]) {
        const res = spawnSync(process.execPath, [HOOK], {
          input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'opencode run -m x < /dev/null' } }),
          encoding: 'utf8',
          env: { ...process.env, WT_LANE_MAX_CONCURRENT: '1', WT_LANE_SATURATION_TEST_MODE: '1', WT_LANE_SATURATION_TEST_PIDS: pids },
        })
        expect(JSON.parse(res.stdout || '{}')?.hookSpecificOutput?.permissionDecision, pids).toBe('deny')
        expect(res.stderr).toContain('LANE SATURATION TEST MODE')
        expect(res.stderr).toContain(`WT_LANE_SATURATION_TEST_PIDS=${pids}`)
      }
    } finally {
      await stopOwnedChild(lane, fake)
    }
  })

  it('treats malformed pgrep output as unknown instead of a false zero', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-lane-malformed-pgrep-'))
    roots.push(root)
    const pgrep = join(root, 'pgrep')
    writeFileSync(pgrep, '#!/bin/sh\nprintf "not-a-pid\\n"\n')
    chmodSync(pgrep, 0o755)

    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'opencode run -m x < /dev/null' } }),
      encoding: 'utf8',
      env: { ...process.env, PATH: root },
    })

    expect(res.stdout).toContain('lane usage NOT MEASURED')
    expect(res.stdout).toContain('malformed pid')
    expect(res.stdout).not.toContain('permissionDecision')
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
  it('two-arc contention: the hook denies arc B while arc A saturates the lane, and allows again once arc A drains — arc B is never itself spawned by a refused call', async ({ skip }) => {
    // Prove pgrep exists before manufacturing contention. The hook below receives only the
    // owned PID, so ambient opencode/codex processes cannot alter either decision.
    const available = countLaneProcessesReal(LANE_PROCESS_NAMES, [])
    if (available.state === 'unknown') {
      skip()
      return
    }

    const root = mkdtempSync(join(tmpdir(), 'wt-lane-contend-'))
    roots.push(root)
    const fake = join(root, 'opencode')
    copyFileSync('/bin/sleep', fake)
    chmodSync(fake, 0o755)

    const marker = join(root, 'start-lane')
    const arcA = spawn('/bin/sh', ['-c', 'while [ ! -e "$1" ]; do sleep 0.02; done; exec "$2" 30', 'arc-a', marker, fake], { stdio: 'ignore' })
    if (!arcA.pid) throw new Error('arc A has no pid')
    await new Promise<void>((resolve, reject) => {
      arcA.once('spawn', resolve)
      arcA.once('error', reject)
    })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WT_LANE_MAX_CONCURRENT: '1',
      WT_LANE_SATURATION_TEST_MODE: '1',
      WT_LANE_SATURATION_TEST_PIDS: String(arcA.pid),
    }
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
    expect(before.stderr).toContain('WT_LANE_SATURATION_TEST_PIDS')

    // --- arc A saturates the lane: one real process, named exactly `opencode`, alive.
    writeFileSync(marker, 'start')

    try {
      await waitForOwnedLane(arcA.pid, fake)

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
      await stopOwnedChild(arcA, fake)
    }

    // --- direction (b), second half: arc A has DRAINED — the lane stays USABLE for arc B,
    // which now proceeds exactly as it would have without ever having lost a batch: no
    // retry loop, no accumulated state, no manual intervention. The child's `exit` event above
    // is the drain signal; no wall-clock sleep guesses when SIGTERM has taken effect.
    const after = callArcB()
    expect(after.status).toBe(0)
    expect(`${after.stdout ?? ''}`.trim()).toBe('')
    expect(after.stderr).toContain(`WT_LANE_SATURATION_TEST_PIDS=${arcA.pid}`)
  })
})
