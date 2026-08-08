// lane-consent-gate.test.ts — behaviour lock for the PreToolUse gate that ENFORCES the
// executor-lane consent switch at the moment a lane call is about to run
// (plugin/bin/wt-lane-consent-gate-hook.mjs, decision in plugin/bin/lib/lane-consent-gate-core.mjs).
//
// This is the mechanism the card is about: the switch existed (a read/write CLI) and its
// disagreement with the auto-loaded rules was already detected (a SessionStart advisory), but
// nothing actually consulted it AT THE POINT a lane call executes — `opencode-verifier` shells
// out unconditionally, and the pilot-wave skill's "check consent first" is prose a model can
// silently skip. This suite proves the three paths named on the card: ON (consented, silent),
// OFF (refused, denied), and BROKEN (unreadable/malformed settings, denied — fail CLOSED).

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { evaluateConsentGate } from '../../../../plugin/bin/lib/lane-consent-gate-core.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { resolveConsent } from '../../../../plugin/bin/lib/lane-consent-check-core.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-lane-consent-gate-hook.mjs')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `wt-lane-consent-gate-${tag}-`))
  roots.push(root)
  const project = join(root, 'project')
  const config = join(root, 'config')
  const home = join(root, 'home')
  mkdirSync(project, { recursive: true })
  mkdirSync(config, { recursive: true })
  mkdirSync(home, { recursive: true })
  return {
    project,
    config,
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config },
  }
}

const LANE_COMMAND = 'opencode run --model openai/gpt-5.4 review < /dev/null'

function runHook(project: string, env: NodeJS.ProcessEnv, command: string) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: project }),
    encoding: 'utf8',
    env,
  })
}

describe('evaluateConsentGate (core decision)', () => {
  it('is silent on a command that has nothing to do with the lane — resolveConsentImpl never called', () => {
    const result = evaluateConsentGate(
      { tool_input: { command: 'ls -la' } },
      {
        resolveConsentImpl: () => {
          throw new Error('resolveConsentImpl should not be called for unrelated commands')
        },
      },
    )
    expect(result.silent).toBe(true)
  })

  it('is silent on a command that only MENTIONS the lane, never invokes it', () => {
    const resolveConsentImpl = () => {
      throw new Error('resolveConsentImpl should not be called for non-invocations')
    }
    expect(
      evaluateConsentGate({ tool_input: { command: "echo 'opencode run x'" } }, { resolveConsentImpl }).silent,
    ).toBe(true)
    expect(
      evaluateConsentGate({ tool_input: { command: 'grep -rn opencode docs/' } }, { resolveConsentImpl }).silent,
    ).toBe(true)
  })

  // ── ON path ──────────────────────────────────────────────────────────────────────────────
  it('ON: a real lane call is silent (allowed) when consent resolves true', () => {
    const result = evaluateConsentGate(
      { tool_input: { command: LANE_COMMAND } },
      { resolveConsentImpl: () => ({ outcome: 'true', account: { state: 'true', filePath: 'x' }, project: { state: 'missing', filePath: 'y' } }) },
    )
    expect(result.silent).toBe(true)
    expect(result.deny).toBeUndefined()
  })

  // ── OFF path ─────────────────────────────────────────────────────────────────────────────
  it('OFF: a real lane call is DENIED, naming why, when the account never opted in', () => {
    const result = evaluateConsentGate(
      { tool_input: { command: LANE_COMMAND } },
      {
        resolveConsentImpl: () => ({
          outcome: 'not_true',
          account: { state: 'missing', filePath: '/acct/settings.json' },
          project: { state: 'missing', filePath: '/proj/.claude/settings.local.json' },
        }),
      },
    )
    expect(result.silent).toBe(false)
    expect(result.deny).toBe(true)
    expect(result.message).toContain('Refused:')
    expect(result.message).toContain('account has not opted in')
    expect(result.message).toContain('/acct/settings.json')
  })

  it('OFF: a real lane call is DENIED, naming the project narrowing, when the account allows but the project narrows', () => {
    const result = evaluateConsentGate(
      { tool_input: { command: LANE_COMMAND } },
      {
        resolveConsentImpl: () => ({
          outcome: 'not_true',
          account: { state: 'true', filePath: '/acct/settings.json' },
          project: { state: 'not_true', filePath: '/proj/.claude/settings.local.json' },
        }),
      },
    )
    expect(result.silent).toBe(false)
    expect(result.deny).toBe(true)
    expect(result.message).toContain('narrows the account ceiling')
    expect(result.message).toContain('/proj/.claude/settings.local.json')
  })

  // ── BROKEN path — fail CLOSED ───────────────────────────────────────────────────────────
  it('BROKEN: a real lane call is DENIED — never allowed — when the consent chain cannot be resolved', () => {
    const result = evaluateConsentGate(
      { tool_input: { command: LANE_COMMAND } },
      {
        resolveConsentImpl: () => ({
          outcome: 'unknown',
          account: { state: 'unknown', filePath: '/acct/settings.json' },
          project: { state: 'missing', filePath: '/proj/.claude/settings.local.json' },
        }),
      },
    )
    expect(result.silent).toBe(false)
    expect(result.deny).toBe(true)
    expect(result.message).toContain('could not be resolved')
    expect(result.message).toContain('fails CLOSED')
    expect(result.message).toContain('/acct/settings.json')
  })

  it('resolves the real consent chain end-to-end (no injected mock) across ON/OFF/BROKEN', () => {
    const f = fixture('e2e-core')

    // OFF: nothing set anywhere
    let result = evaluateConsentGate({ tool_input: { command: LANE_COMMAND }, cwd: f.project }, { resolveConsentImpl: resolveConsent, env: f.env })
    expect(result.deny).toBe(true)
    expect(result.message).toContain('account has not opted in')

    // ON: account consents
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    result = evaluateConsentGate({ tool_input: { command: LANE_COMMAND }, cwd: f.project }, { resolveConsentImpl: resolveConsent, env: f.env })
    expect(result.silent).toBe(true)

    // BROKEN: account settings become invalid JSON
    writeFileSync(join(f.config, 'settings.json'), '{ not-json')
    result = evaluateConsentGate({ tool_input: { command: LANE_COMMAND }, cwd: f.project }, { resolveConsentImpl: resolveConsent, env: f.env })
    expect(result.deny).toBe(true)
    expect(result.message).toContain('fails CLOSED')
  })
})

describe('wt-lane-consent-gate-hook.mjs (PreToolUse Bash wrapper)', () => {
  it('is silent and exits 0 on a non-lane command', () => {
    const f = fixture('hook-nonlane')
    const res = runHook(f.project, f.env, 'ls -la')
    expect(res.status).toBe(0)
    expect(`${res.stdout ?? ''}${res.stderr ?? ''}`).toBe('')
  })

  it('ON: is silent (allows) on a real lane call when the account has consented', () => {
    const f = fixture('hook-on')
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    const res = runHook(f.project, f.env, LANE_COMMAND)
    expect(res.status).toBe(0)
    expect((res.stdout ?? '').trim()).toBe('')
  })

  it('OFF: DENIES a real lane call when consent was never given, and names which level refused', () => {
    const f = fixture('hook-off')
    const res = runHook(f.project, f.env, LANE_COMMAND)
    expect(res.status).toBe(0)
    const parsed = JSON.parse(res.stdout || '{}')
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(String(parsed?.hookSpecificOutput?.permissionDecisionReason ?? '')).toContain('Refused:')
    expect(String(parsed?.hookSpecificOutput?.permissionDecisionReason ?? '')).toContain('account has not opted in')
  })

  it('OFF: a project narrowing an allowing account is DENIED and named as the reason', () => {
    const f = fixture('hook-narrow')
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    mkdirSync(join(f.project, '.claude'), { recursive: true })
    writeFileSync(join(f.project, '.claude', 'settings.local.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'false' } }))
    const res = runHook(f.project, f.env, LANE_COMMAND)
    const parsed = JSON.parse(res.stdout || '{}')
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(String(parsed?.hookSpecificOutput?.permissionDecisionReason ?? '')).toContain('narrows the account ceiling')
  })

  it('BROKEN: malformed account settings DENIES the call and says it fails CLOSED, never allows', () => {
    const f = fixture('hook-broken')
    writeFileSync(join(f.config, 'settings.json'), '{ not-json')
    const res = runHook(f.project, f.env, LANE_COMMAND)
    expect(res.status).toBe(0)
    const parsed = JSON.parse(res.stdout || '{}')
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(String(parsed?.hookSpecificOutput?.permissionDecisionReason ?? '')).toContain('could not be resolved')
    expect(String(parsed?.hookSpecificOutput?.permissionDecisionReason ?? '')).toContain('fails CLOSED')
  })

  it('BROKEN: malformed PROJECT settings also DENIES (fail closed), even with a consenting account', () => {
    const f = fixture('hook-broken-project')
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    mkdirSync(join(f.project, '.claude'), { recursive: true })
    writeFileSync(join(f.project, '.claude', 'settings.local.json'), '{ not-json')
    const res = runHook(f.project, f.env, LANE_COMMAND)
    const parsed = JSON.parse(res.stdout || '{}')
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(String(parsed?.hookSpecificOutput?.permissionDecisionReason ?? '')).toContain('fails CLOSED')
  })

  // The inverse of every OTHER guard's self-test: an internal error here must DENY, not allow.
  it('fails CLOSED (denies, never silently allows) when the entry path itself throws', () => {
    const f = fixture('hook-selftest')
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: LANE_COMMAND }, cwd: f.project }),
      encoding: 'utf8',
      env: { ...f.env, WT_LANE_CONSENT_GATE_SELF_TEST: 'wt-lane-consent-gate-hook.mjs' },
    })
    expect(res.status).toBe(0)
    const parsed = JSON.parse(res.stdout || '{}')
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(String(parsed?.hookSpecificOutput?.permissionDecisionReason ?? '')).toContain('internal error')
    expect(res.stderr ?? '').toContain('FAILED CLOSED')
  })

  it('does not deny commands wrapping the lane phrase only inside quotes/comments (no false-deny under OFF)', () => {
    const f = fixture('hook-mention-only')
    const res = runHook(f.project, f.env, "echo 'opencode run x'")
    expect(res.status).toBe(0)
    expect((res.stdout ?? '').trim()).toBe('')
  })
})
