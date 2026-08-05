// adopt-check-hook.test.ts — behavior gate for the SessionStart check
// (plugin/bin/wt-adopt-check-hook.mjs) that tells a session the truth about its
// rule-adoption state. Drives the REAL hook as a child process against isolated
// PROJECT + GLOBAL-config dirs (never the real ~/.claude), reusing install.mjs
// itself to seed each fixture — the same technique adopt-installer.test.ts uses
// (install, then a targeted string edit) rather than hand-rolling a second classifier.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-adopt-check-hook.mjs')
const INSTALL_RULES = join(REPO_ROOT, 'plugin/skills/adopt/scripts/install.mjs')
const RULE = 'wt-delegation-ladder.md'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function mkRoot(tag: string): string {
  const r = mkdtempSync(join(tmpdir(), `wt-adopt-check-${tag}-`))
  roots.push(r)
  return r
}

/** An isolated fixture: a `proj` dir (the hook's `cwd`) plus an isolated HOME/
 *  CLAUDE_CONFIG_DIR so the global-dir check never touches the real ~/.claude. */
function fixture(tag: string) {
  const root = mkRoot(tag)
  const proj = join(root, 'proj')
  mkdirSync(proj, { recursive: true })
  const home = join(root, 'home')
  const cfg = join(root, 'cfg')
  mkdirSync(home, { recursive: true })
  mkdirSync(cfg, { recursive: true })
  return { root, proj, cfg, env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: cfg } }
}

function installInto(dir: string): void {
  const res = spawnSync(process.execPath, [INSTALL_RULES, '--install', '--set', 'rules', '--dir', dir], {
    encoding: 'utf8',
  })
  if (res.status !== 0) throw new Error(`fixture install failed: ${res.stdout}${res.stderr}`)
}

function runHook(cwd: string, env: NodeJS.ProcessEnv): { stdout: string; context: string } {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd }),
    encoding: 'utf8',
    env,
  })
  const stdout = (res.stdout ?? '').trim()
  let context = ''
  try {
    const parsed = stdout ? (JSON.parse(stdout) as Record<string, unknown>) : null
    const hso = parsed?.['hookSpecificOutput'] as Record<string, unknown> | undefined
    context = (hso?.['additionalContext'] as string | undefined) ?? ''
  } catch {
    context = ''
  }
  return { stdout, context }
}

function runPostToolUsePushHook(
  cwd: string,
  env: NodeJS.ProcessEnv,
  tool_response?: unknown,
): { stdout: string; context: string } {
  const payload: Record<string, unknown> = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git push public main' },
    cwd,
  }
  if (tool_response !== undefined) payload.tool_response = tool_response
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  })
  const stdout = (res.stdout ?? '').trim()
  let context = ''
  try {
    const parsed = stdout ? (JSON.parse(stdout) as Record<string, unknown>) : null
    const hso = parsed?.['hookSpecificOutput'] as Record<string, unknown> | undefined
    context = (hso?.['additionalContext'] as string | undefined) ?? ''
  } catch {
    context = ''
  }
  return { stdout, context }
}

describe('wt-adopt-check-hook — SessionStart rule-adoption truth check', () => {
  // POSITIVE CONTROL FIRST (per the brief): prove the hook actually speaks in the
  // absent case before trusting the silent case — otherwise a broken invocation and a
  // correct silence read identically.
  it('SPEAKS when no rules are installed anywhere (positive control)', () => {
    const f = fixture('absent')
    const r = runHook(f.proj, f.env) // no .claude/rules under proj; empty cfg dir
    expect(r.stdout, 'must not be silent').not.toBe('')
    expect(r.context).toContain('NOT installed')
    expect(r.context).toContain('workflow-toolbox:adopt')
    // names at least the anchor rule file, so the reader knows WHICH are missing
    expect(r.context).toContain(RULE)
  })

  it('is SILENT when every rule is installed and current in the project dir', () => {
    const f = fixture('current')
    installInto(join(f.proj, '.claude', 'rules'))
    const r = runHook(f.proj, f.env)
    expect(r.stdout).toBe('')
  })

  it('is SILENT when adopted only at the GLOBAL config dir (not the project dir)', () => {
    const f = fixture('global-only')
    installInto(join(f.cfg, 'rules')) // adopted globally, nothing in the project
    const r = runHook(f.proj, f.env)
    expect(r.stdout).toBe('')
  })

  it('SPEAKS and names WHICH files are STALE (installed, behind the shipped version)', () => {
    const f = fixture('stale')
    const dir = join(f.proj, '.claude', 'rules')
    installInto(dir)
    const p = join(dir, RULE)
    // Build a genuinely stale copy: an older banner version AND a body that differs from
    // what ships, with the fingerprint restamped over that body so it still reads as
    // unedited. Lowering the version alone no longer produces staleness — the installer
    // compares CONTENT, so a version-only fixture describes an up-to-date copy and this
    // test would then assert the hook speaks about a file it has nothing to say about.
    const body = readFileSync(join(REPO_ROOT, 'plugin/rules', RULE), 'utf8') + '\nA PARAGRAPH SINCE REWRITTEN UPSTREAM\n'
    const fp = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)
    writeFileSync(p, `<!-- installed from workflow-toolbox v0.0.1 · content sha256:${fp} by the adopt skill -->\n\n${body}`)
    const r = runHook(f.proj, f.env)
    expect(r.stdout, 'must not be silent').not.toBe('')
    expect(r.context).toContain('Behind the shipped version')
    expect(r.context).toContain(RULE)
    expect(r.context).toContain('adopt')
  })

  it('PostToolUse push wording stays neutral while still naming stale files', () => {
    const f = fixture('posttooluse-stale')
    const dir = join(f.proj, '.claude', 'rules')
    installInto(dir)
    const p = join(dir, RULE)
    const body = readFileSync(join(REPO_ROOT, 'plugin/rules', RULE), 'utf8') + '\nA PARAGRAPH SINCE REWRITTEN UPSTREAM\n'
    const fp = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)
    writeFileSync(p, `<!-- installed from workflow-toolbox v0.0.1 · content sha256:${fp} by the adopt skill -->\n\n${body}`)
    const r = runPostToolUsePushHook(f.proj, f.env)
    expect(r.stdout, 'must not be silent').not.toBe('')
    expect(r.context).not.toContain('just landed')
    expect(r.context).not.toContain('A push just landed and the adopted rule copies are now behind it')
    expect(r.context).toContain('A `git push` command just ran; this Bash PostToolUse hook cannot tell whether it landed.')
    expect(r.context).toContain('Behind the shipped version')
    expect(r.context).toContain(RULE)
  })

  // Locks the actual design decision: the fix does NOT branch on tool_response (its shape for
  // the Bash tool is not reliably documented), so the preface must stay byte-identical whether
  // tool_response looks like a failure, a success, or is absent altogether. A future change that
  // starts reading tool_response to differentiate the message must consciously update this test,
  // not slip past it.
  it('PostToolUse wording is IDENTICAL regardless of what tool_response claims (or omits)', () => {
    const f = fixture('posttooluse-response-invariant')
    const dir = join(f.proj, '.claude', 'rules')
    installInto(dir)
    const p = join(dir, RULE)
    const body = readFileSync(join(REPO_ROOT, 'plugin/rules', RULE), 'utf8') + '\nA PARAGRAPH SINCE REWRITTEN UPSTREAM\n'
    const fp = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)
    writeFileSync(p, `<!-- installed from workflow-toolbox v0.0.1 · content sha256:${fp} by the adopt skill -->\n\n${body}`)

    const absent = runPostToolUsePushHook(f.proj, f.env)
    const failureLike = runPostToolUsePushHook(f.proj, f.env, {
      success: false,
      exitCode: 1,
      stderr: 'refused: out-of-scope ref',
    })
    const successLike = runPostToolUsePushHook(f.proj, f.env, { success: true, exitCode: 0, stdout: 'ok' })

    expect(failureLike.context).toBe(absent.context)
    expect(successLike.context).toBe(absent.context)
    for (const ctx of [absent.context, failureLike.context, successLike.context]) {
      expect(ctx).not.toContain('just landed')
    }
  })

  it('SPEAKS for a locally-EDITED file, and does NOT frame it as a problem', () => {
    const f = fixture('edited')
    const dir = join(f.proj, '.claude', 'rules')
    installInto(dir)
    writeFileSync(join(dir, RULE), readFileSync(join(dir, RULE), 'utf8') + '\nMY LOCAL EDIT\n')
    const r = runHook(f.proj, f.env)
    expect(r.context).toContain('Locally modified')
    expect(r.context).toContain(RULE)
    expect(r.context.toLowerCase()).toContain('supported')
    expect(r.context).not.toContain('Behind the shipped version')
    expect(r.context).not.toContain('NOT installed')
  })

  it('a file EDITED in the project but CLEAN/current globally counts as adopted (silent contributor)', () => {
    const f = fixture('mixed-ok')
    const projDir = join(f.proj, '.claude', 'rules')
    installInto(projDir)
    installInto(join(f.cfg, 'rules'))
    // Edit only the project copy; the global copy stays clean and current.
    writeFileSync(join(projDir, RULE), readFileSync(join(projDir, RULE), 'utf8') + '\nMY LOCAL EDIT\n')
    const r = runHook(f.proj, f.env)
    expect(r.stdout).toBe('') // the global clean copy is enough — this file is NOT flagged
  })

  it('never writes anything — the fixture dirs are unchanged after the check', () => {
    const f = fixture('readonly')
    const dir = join(f.proj, '.claude', 'rules')
    installInto(dir)
    const before = readFileSync(join(dir, RULE), 'utf8')
    runHook(f.proj, f.env)
    const after = readFileSync(join(dir, RULE), 'utf8')
    expect(after).toBe(before)
  })

  it('PostToolUse stays SILENT when everything is installed and current', () => {
    const f = fixture('posttooluse-current')
    installInto(join(f.proj, '.claude', 'rules'))
    const r = runPostToolUsePushHook(f.proj, f.env)
    expect(r.stdout).toBe('')
  })

  it('fail-safe SILENT on a payload without cwd', () => {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
      encoding: 'utf8',
    })
    expect((res.stdout ?? '').trim()).toBe('')
    expect(res.status).toBe(0)
  })

  it('fail-safe SILENT on empty stdin', () => {
    const res = spawnSync(process.execPath, [HOOK], { input: '', encoding: 'utf8' })
    expect((res.stdout ?? '').trim()).toBe('')
    expect(res.status).toBe(0)
  })
})
