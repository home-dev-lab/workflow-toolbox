// adopt-check-hook.test.ts — behavior gate for the SessionStart check
// (plugin/bin/wt-adopt-check-hook.mjs) that tells a session the truth about its
// rule-adoption state. Drives the REAL hook as a child process against isolated
// PROJECT + GLOBAL-config dirs (never the real ~/.claude), reusing install.mjs
// itself to seed each fixture — the same technique adopt-installer.test.ts uses
// (install, then a targeted string edit) rather than hand-rolling a second classifier.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
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

function installInto(dir: string, script = INSTALL_RULES): void {
  const res = spawnSync(process.execPath, [script, '--install', '--set', 'rules', '--dir', dir], {
    encoding: 'utf8',
  })
  if (res.status !== 0) throw new Error(`fixture install failed: ${res.stdout}${res.stderr}`)
}

function runHook(cwd: string, env: NodeJS.ProcessEnv, hook = HOOK): { stdout: string; context: string } {
  const res = spawnSync(process.execPath, [hook], {
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

function makeHookCopy(version = '1.0.0'): { hook: string; installer: string; rulesDir: string } {
  const root = mkRoot('shipped')
  const plugin = join(root, 'plugin')
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }))
  for (const dir of ['rules', 'agents', 'agent-templates']) {
    cpSync(join(REPO_ROOT, 'plugin', dir), join(plugin, dir), { recursive: true })
  }
  cpSync(join(REPO_ROOT, 'plugin/CHANGELOG.md'), join(plugin, 'CHANGELOG.md'))
  const scriptDir = join(plugin, 'skills', 'adopt', 'scripts')
  mkdirSync(scriptDir, { recursive: true })
  const installer = join(scriptDir, 'install.mjs')
  cpSync(INSTALL_RULES, installer)
  const binDir = join(plugin, 'bin')
  mkdirSync(binDir, { recursive: true })
  cpSync(join(REPO_ROOT, 'plugin/bin/lib'), join(binDir, 'lib'), { recursive: true })
  const hook = join(binDir, 'wt-adopt-check-hook.mjs')
  cpSync(HOOK, hook)
  return { hook, installer, rulesDir: join(plugin, 'rules') }
}

function writeManagedRule(file: string, body: string, version: string, fp?: string): void {
  const stamped = fp ?? createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)
  writeFileSync(
    file,
    `<!-- installed from workflow-toolbox v${version} · content sha256:${stamped} by the adopt skill -->\n\n${body}`,
  )
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

  // Card 1835727457 (rules/wt/ subfolder migration): the hook must search BOTH the
  // pre-migration flat location AND the new default, or a migrated project reads as
  // "nothing adopted" (checking only the old flat dir) or an un-migrated one reads the
  // same way (checking only the new one) — either is the exact false negative this pair
  // of tests locks against.
  it('is SILENT when adopted at the NEW default location (.claude/rules/wt/, already migrated)', () => {
    const f = fixture('migrated')
    installInto(join(f.proj, '.claude', 'rules', 'wt'))
    const r = runHook(f.proj, f.env)
    expect(r.stdout).toBe('')
  })

  it.each([
    ['project rules/', (f: ReturnType<typeof fixture>) => join(f.proj, '.claude', 'rules')],
    ['project rules/wt/', (f: ReturnType<typeof fixture>) => join(f.proj, '.claude', 'rules', 'wt')],
    ['global rules/', (f: ReturnType<typeof fixture>) => join(f.cfg, 'rules')],
    ['global rules/wt/', (f: ReturnType<typeof fixture>) => join(f.cfg, 'rules', 'wt')],
  ])('content-identical copy at %s is current despite stale banner metadata and trailing-newline variance', (_label, locate) => {
    const f = fixture('four-locations')
    const shipped = makeHookCopy()
    const target = locate(f)
    installInto(target, shipped.installer)
    const body = readFileSync(join(shipped.rulesDir, RULE), 'utf8').replace(/[ \t\r\n]+$/u, '') + '\n\n'
    writeManagedRule(join(target, RULE), body, '0.0.1', '000000000000')

    expect(runHook(f.proj, f.env, shipped.hook).stdout).toBe('')
  })

  it('manual checker and hook both classify a newer divergent global rules/wt copy as ahead/forked and name its location', () => {
    const f = fixture('ahead-fork')
    const shipped = makeHookCopy()
    const target = join(f.cfg, 'rules', 'wt')
    installInto(target, shipped.installer)
    const body = readFileSync(join(shipped.rulesDir, RULE), 'utf8') + '\nA FORKED FUTURE LINE\n'
    writeManagedRule(join(target, RULE), body, '999.0.0')

    const checked = spawnSync(
      process.execPath,
      [shipped.installer, '--check', '--set', 'rules', '--dir', target],
      { encoding: 'utf8', env: f.env },
    ).stdout
    expect(checked).toContain(`${RULE}: AHEAD/FORKED`)
    const hooked = runHook(f.proj, f.env, shipped.hook)
    expect(hooked.context).toContain('ahead of v1.0.0')
    expect(hooked.context).toContain(`${RULE} (${target})`)
    expect(hooked.context).not.toContain('behind v1.0.0')
  })

  it('manual checker and hook both classify real project rules/wt content drift as behind and name its location', () => {
    const f = fixture('behind-drift')
    const shipped = makeHookCopy()
    const target = join(f.proj, '.claude', 'rules', 'wt')
    installInto(target, shipped.installer)
    const body = readFileSync(join(shipped.rulesDir, RULE), 'utf8') + '\nAN OLD SHIPPED LINE\n'
    writeManagedRule(join(target, RULE), body, '0.0.1')

    const checked = spawnSync(
      process.execPath,
      [shipped.installer, '--check', '--set', 'rules', '--dir', target],
      { encoding: 'utf8', env: f.env },
    ).stdout
    expect(checked).toContain(`${RULE}: STALE`)
    const hooked = runHook(f.proj, f.env, shipped.hook)
    expect(hooked.context).toContain('behind v1.0.0')
    expect(hooked.context).toContain(`${RULE} (${target})`)
    expect(hooked.context).not.toContain('ahead of v1.0.0')
  })

  it('same-version shipped content drift is STALE, refreshes cleanly, and surfaces through the hook', () => {
    const f = fixture('same-version-content-drift')
    const shipped = makeHookCopy()
    const target = join(f.proj, '.claude', 'rules')
    installInto(target, shipped.installer)
    const changed = readFileSync(join(shipped.rulesDir, RULE), 'utf8') + '\nA SAME-VERSION SHIPPED FIX\n'
    writeFileSync(join(shipped.rulesDir, RULE), changed)

    const checked = spawnSync(
      process.execPath,
      [shipped.installer, '--check', '--set', 'rules', '--dir', target],
      { encoding: 'utf8', env: f.env },
    ).stdout
    expect(checked).toContain(`${RULE}: STALE (content`)
    expect(checked).toContain('content changed without a version change; no version range to show.')

    const hooked = runHook(f.proj, f.env, shipped.hook)
    expect(hooked.context).toContain('behind v1.0.0')
    expect(hooked.context).toContain(`${RULE} (${target})`)

    const refreshed = spawnSync(
      process.execPath,
      [shipped.installer, '--install', '--set', 'rules', '--dir', target],
      { encoding: 'utf8', env: f.env },
    ).stdout
    expect(refreshed).toContain('REFRESHED')
    expect(readFileSync(join(target, RULE), 'utf8')).toContain('A SAME-VERSION SHIPPED FIX')
  })

  it('derives ahead from a newer copy body, not the installer warning word', () => {
    const f = fixture('content-ahead')
    const shipped = makeHookCopy()
    const target = join(f.proj, '.claude', 'rules')
    installInto(target, shipped.installer)
    const body = readFileSync(join(shipped.rulesDir, RULE), 'utf8') + '\nA DECISION PRESENT ONLY IN THE NEWER COPY\n'
    writeManagedRule(join(target, RULE), body, '1.0.0')

    const hooked = runHook(f.proj, f.env, shipped.hook)
    expect(hooked.context).toContain('ahead of v1.0.0')
    expect(hooked.context).toContain('--set rules --install')
  })

  it('derives behind from a sentence missing from the copy body', () => {
    const f = fixture('content-behind')
    const shipped = makeHookCopy()
    const target = join(f.proj, '.claude', 'rules')
    installInto(target, shipped.installer)
    const lines = readFileSync(join(shipped.rulesDir, RULE), 'utf8').split('\n')
    const removed = lines.findIndex((line, index) => index > 0 && line.trim() !== '')
    const body = [...lines.slice(0, removed), ...lines.slice(removed + 1)].join('\n')
    writeManagedRule(join(target, RULE), body, '1.0.0')

    const hooked = runHook(f.proj, f.env, shipped.hook)
    expect(hooked.context).toContain('behind v1.0.0')
  })

  it('a genuinely un-migrated flat install is never double-counted or masked at the new location', () => {
    const f = fixture('unmigrated')
    const dir = join(f.proj, '.claude', 'rules')
    installInto(dir) // still at the flat root, nothing under rules/wt/ yet
    // A real STALE finding at the flat root must still surface — the wt/ side's own
    // MIGRATION-PENDING classification (install.mjs's legacy fallback) must never read as
    // 'ok' and silently outvote it.
    const p = join(dir, RULE)
    const body = readFileSync(join(REPO_ROOT, 'plugin/rules', RULE), 'utf8') + '\nA PARAGRAPH SINCE REWRITTEN UPSTREAM\n'
    const fp = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)
    writeFileSync(p, `<!-- installed from workflow-toolbox v0.0.1 · content sha256:${fp} by the adopt skill -->\n\n${body}`)
    const r = runHook(f.proj, f.env)
    expect(r.stdout, 'must not be silent').not.toBe('')
    expect(r.context).toContain('behind v')
    expect(r.context).toContain(RULE)
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
    expect(r.context).toContain('behind v')
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
    expect(r.context).toContain('behind v')
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
    expect(r.context).not.toContain('behind v')
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
