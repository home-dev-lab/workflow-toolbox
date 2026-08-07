import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-rule-convention-guard-hook.mjs')
const MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')
const FIX_SENTENCE = 'A rule states what to DO plus the invariant that makes it right. Move the date, the name and the story to a note, and keep the directive.'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `wt-rule-convention-${tag}-`))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { root, home, env: { ...process.env, HOME: home } }
}

type HookRun = {
  status: number | null
  stdout: string
  stderr: string
  decision: string | undefined
  reason: string
}

function runHook(payload: unknown, env: NodeJS.ProcessEnv = process.env): HookRun {
  const res = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env,
  })
  const stdout = (res.stdout ?? '').trim()
  const stderr = (res.stderr ?? '').trim()
  let decision: string | undefined
  let reason = ''
  try {
    const parsed = stdout ? (JSON.parse(stdout) as Record<string, unknown>) : null
    const output = parsed?.['hookSpecificOutput'] as Record<string, unknown> | undefined
    decision = output?.['permissionDecision'] as string | undefined
    reason = (output?.['permissionDecisionReason'] as string | undefined) ?? ''
  } catch {
    decision = undefined
    reason = ''
  }
  return { status: res.status, stdout, stderr, decision, reason }
}

function writePayload(filePath: string, content: string, cwd: string) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    cwd,
    tool_input: { file_path: filePath, content },
  }
}

describe('wt-rule-convention-guard-hook', () => {
  it('registers the PreToolUse/Edit|Write|MultiEdit hook in plugin.json', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>
    }
    const group = (manifest.hooks?.PreToolUse ?? []).find((entry) =>
      (entry.hooks ?? []).some((hook) => (hook.command ?? '').includes('wt-rule-convention-guard-hook.mjs')),
    )
    expect(group).toBeTruthy()
    expect(group?.matcher).toBe('Edit|Write|MultiEdit')
  })

  it('uses the proven date detector discriminators', () => {
    const f = fixture('dates')
    const file = join(f.root, '.claude', 'rules', 'wt', 'rule.md')
    const cases = [
      ['measured 3/3 to 1/3', false, 'ratio stays quiet'],
      ['16/16 on a wrapper', false, 'measurement stays quiet'],
      ['554/556 transcripts', false, 'count stays quiet'],
      ['1254/1279 stragglers', false, 'large count stays quiet'],
      ['45/45 members', false, 'member count stays quiet'],
      ['plugin 0.85.0', false, 'version stays quiet'],
      ['+%Y-%m-%dT%H:%M:%S', false, 'strftime token stays quiet'],
      ['card #1827047859321570464', false, 'numeric card id stays quiet'],
      ['arXiv:2509.23055', false, 'arxiv id stays quiet'],
      ['(Frederic, 27/07)', true, 'day/month fires'],
      ['Measured 2026-08-06', true, 'iso fires'],
      ['le 04/08 matin', true, 'day/month in prose fires'],
      ['28/07/2026', true, 'day/month/year fires'],
    ] as const

    for (const [text, shouldDeny, label] of cases) {
      const run = runHook(writePayload(file, text, f.root), f.env)
      expect(run.status, `${label}: exit`).toBe(0)
      expect(Boolean(run.stdout), `${label}: stdout presence`).toBe(shouldDeny)
      expect(run.decision === 'deny', `${label}: decision`).toBe(shouldDeny)
    }
  })

  it('fires on date violations and stays quiet on a near-miss measurement', () => {
    const f = fixture('date-detector')
    const file = join(f.root, '.claude', 'rules', 'policy.md')

    const fire = runHook(writePayload(file, 'Measured 2026-08-06', f.root), f.env)
    expect(fire.decision).toBe('deny')
    expect(fire.reason).toContain('DATE (ISO): "2026-08-06"')
    expect(fire.reason).toContain('Measured 2026-08-06')
    expect(fire.reason.endsWith(FIX_SENTENCE)).toBe(true)

    const quiet = runHook(writePayload(file, '16/16 on a wrapper', f.root), f.env)
    expect(quiet.stdout).toBe('')
  })

  it('fires on people-name violations and stays quiet on a near-miss spelling', () => {
    const f = fixture('people-detector')
    const file = join(f.root, 'plugin', 'rules', 'shipped.md')

    const fire = runHook(writePayload(file, 'Frederic prefers this wording.', f.root), f.env)
    expect(fire.decision).toBe('deny')
    expect(fire.reason).toContain('PEOPLE: "Frederic"')

    const quiet = runHook(writePayload(file, 'Frederick prefers this wording.', f.root), f.env)
    expect(quiet.stdout).toBe('')
  })

  it('fires on narrative violations and stays quiet on a near-miss phrase', () => {
    const f = fixture('narrative-detector')
    const file = join(f.root, '.claude', 'rules', 'wt', 'story.md')

    const fire = runHook(writePayload(file, 'This was a standing instruction from ops.', f.root), f.env)
    expect(fire.decision).toBe('deny')
    expect(fire.reason).toContain('NARRATIVE: "standing instruction from"')

    const quiet = runHook(writePayload(file, 'This was a standing order from ops.', f.root), f.env)
    expect(quiet.stdout).toBe('')
  })

  it('inspects only the added strings of a MultiEdit payload', () => {
    const f = fixture('multiedit')
    const file = join(f.root, '.claude', 'agents', 'pilot.md')
    const run = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'MultiEdit',
      cwd: f.root,
      tool_input: {
        file_path: file,
        edits: [
          { old_string: 'legacy (Frederic, 27/07)', new_string: 'Directive only.' },
          { old_string: 'keep', new_string: 'Measured 2026-08-06' },
        ],
      },
    }, f.env)

    expect(run.decision).toBe('deny')
    expect(run.reason).toContain('DATE (ISO): "2026-08-06"')
    expect(run.reason).not.toContain('27/07')
    expect(run.reason).not.toContain('Frederic')
  })

  it('exempts a line carrying the escape hatch marker', () => {
    const f = fixture('escape')
    const file = join(f.root, '.claude', 'rules', 'quoted.md')
    const run = runHook(writePayload(file, 'Quote (Frederic, 27/07) <!-- rule-lint: allow -->', f.root), f.env)
    expect(run.stdout).toBe('')
  })

  it('ignores a blatant violation on a non-rule path as the negative control', () => {
    const f = fixture('negative-control')
    const file = join(f.root, 'tmp', 'notes.md')
    const run = runHook(writePayload(file, 'Frederic said this on 28/07/2026.', f.root), f.env)
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
  })

  it('fails open on empty stdin, invalid JSON, and a payload missing tool_input', () => {
    const empty = runHook('')
    expect(empty.status).toBe(0)
    expect(empty.stdout).toBe('')

    const invalid = runHook('{not json')
    expect(invalid.status).toBe(0)
    expect(invalid.stdout).toBe('')

    const missing = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: process.cwd() })
    expect(missing.status).toBe(0)
    expect(missing.stdout).toBe('')
  })
})
