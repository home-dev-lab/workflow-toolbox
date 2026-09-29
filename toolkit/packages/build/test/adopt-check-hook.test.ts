// adopt-check-hook.test.ts — behavior gate for the SessionStart check
// (plugin/bin/wt-adopt-check-hook.mjs) that tells a session the truth about its
// rule-adoption state. Drives the REAL hook as a child process against isolated
// PROJECT + GLOBAL-config dirs (never the real ~/.claude), reusing install.mjs
// itself to seed each fixture — the same technique adopt-installer.test.ts uses
// (install, then a targeted string edit) rather than hand-rolling a second classifier.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
// @ts-expect-error read-only JS plugin renderer has no TypeScript declaration
import { frontmatter } from '../../../../plugins/wt-rules-on-demand/scripts/rule-lifecycle-lib.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { quoteRemedyWord } from '../../../../plugin/bin/lib/remedy-quote.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-adopt-check-hook.mjs')
const INSTALL_RULES = join(REPO_ROOT, 'plugin/skills/adopt/scripts/install.mjs')
const RULE = 'wt-delegation-ladder.md'
const ON_DEMAND_FRONTMATTER = '---\non-demand:\n  triggers:\n    - tool: Edit\n---\n'
const ACT = 'wt-task-tracking-at-act.md'
const TRIGGER_MARKER = 'on-demand triggers behind the shipped spec'
const remedyWord = (value: string) => quoteRemedyWord(value, true)
function specHead() {
  const spec = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin/rules/wt-task-tracking-at-act.spec.json'), 'utf8'))
  return frontmatter({ ...spec, triggers: spec['on-demand'].triggers })
}
function specCopy(dir: string, script = INSTALL_RULES) {
  installInto(dir, script)
  writeFileSync(join(dir, ACT), specHead() + readFileSync(join(dir, ACT), 'utf8'))
  spawnSync(process.execPath, [script, '--set', 'rules', '--install', '--file', ACT, '--dir', dir], { encoding: 'utf8', env: sealedPluginCliEnv(dir) })
}

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function mkRoot(tag: string): string {
  const r = realpathSync(mkdtempSync(join(tmpdir(), `wt-adopt-check-${tag}-`)))
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
  return { root, proj, cfg, env: sealedPluginCliEnv(root, { HOME: home, CLAUDE_CONFIG_DIR: cfg }) }
}

function installInto(dir: string, script = INSTALL_RULES): void {
  const res = spawnSync(process.execPath, [script, '--install', '--set', 'rules', '--dir', dir], {
    encoding: 'utf8',
    env: sealedPluginCliEnv(dir),
  })
  if (res.status !== 0) throw new Error(`fixture install failed: ${res.stdout}${res.stderr}`)
}

function installOnDemand(dir: string, script = INSTALL_RULES): void {
  installInto(dir, script)
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.md'))) {
    const target = join(dir, file)
    const specFile = join(REPO_ROOT, 'plugin/rules', file.replace(/\.md$/, '.spec.json'))
    const spec = file.endsWith('-at-act.md') && readdirSync(join(REPO_ROOT, 'plugin/rules')).includes(file.replace(/\.md$/, '.spec.json'))
      ? JSON.parse(readFileSync(specFile, 'utf8')) : null
    const head = spec ? frontmatter({ ...spec, triggers: spec['on-demand'].triggers, compliance: spec.compliance ?? spec['on-demand'].compliance }) : ON_DEMAND_FRONTMATTER
    writeFileSync(target, head + readFileSync(target, 'utf8'))
  }
}

const DESTRUCTIVE_REMEDY = /\brm\s+(?:-\S+\s+)*--?\s|\bremove (?:one|the misplaced) copy|\bremoving the misplaced/i

function runHook(cwd: string, env: NodeJS.ProcessEnv, hook = HOOK): { stdout: string; context: string } {
  const res = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd }),
    encoding: 'utf8',
    env,
  })
  const stdout = (res.stdout ?? '').trim()
  // Invariant over EVERY hook run: a partial scan cannot prove a delete safe, so no remedy deletes.
  expect(stdout).not.toMatch(DESTRUCTIVE_REMEDY)
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

function ageManagedRule(file: string): void {
  const body = readFileSync(join(REPO_ROOT, 'plugin/rules', RULE), 'utf8') + '\nA PARAGRAPH SINCE REWRITTEN UPSTREAM\n'
  writeManagedRule(file, body, '0.0.1')
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
  it('reports an old static copy in the on-demand directory as a placement conflict, never a removal', () => {
    const f = fixture('misplaced-static')
    const staticDir = join(f.cfg, 'rules', 'wt')
    const demandDir = join(f.cfg, 'rules-on-demand')
    installInto(staticDir)
    mkdirSync(demandDir, { recursive: true })
    writeFileSync(join(demandDir, RULE), readFileSync(join(staticDir, RULE), 'utf8'))
    const context = runHook(f.proj, f.env).context
    expect(context).toContain(`${RULE}: MISPLACED`)
    expect(context).toContain('DOUBLE-LOAD')
    expect(context).toContain('Placement conflict')
    expect(context).not.toContain(`rm -- ${remedyWord(join(demandDir, RULE))}`)
    expect(context).not.toContain(`--install --dir ${remedyWord(demandDir)}`)
  })

  it('treats a static rule migrated to on-demand (its own on-demand head) as placed, never misplaced', () => {
    const f = fixture('migrated-static')
    const staticDir = join(f.cfg, 'rules', 'wt')
    const demandDir = join(f.cfg, 'rules-on-demand')
    installInto(staticDir)
    mkdirSync(demandDir, { recursive: true })
    const head = "---\non-demand:\n  triggers:\n    - kind: 'bash'\n      regex: '\\bgit\\s+commit\\b'\n---\n"
    writeFileSync(join(demandDir, RULE), head + readFileSync(join(staticDir, RULE), 'utf8'))
    rmSync(join(staticDir, RULE))
    const context = runHook(f.proj, f.env).context
    expect(context).not.toContain(`${RULE}: MISPLACED`)
    expect(context).not.toContain(`rm -- ${remedyWord(join(demandDir, RULE))}`)
    expect(context).not.toMatch(new RegExp(`NOT installed here:[^.]*${RULE.replace('.', '\\.')}`))
  })

  it('names a file symlink for inspection without a removal command', () => {
    const f = fixture('misplaced-file-link')
    const staticDir = join(f.cfg, 'rules', 'wt')
    const demandDir = join(f.cfg, 'rules-on-demand')
    installInto(staticDir)
    mkdirSync(demandDir)
    symlinkSync(join(staticDir, RULE), join(demandDir, RULE))
    const context = runHook(f.proj, f.env).context
    expect(context).toContain(`${RULE}: MISPLACED`)
    expect(context).toContain('Placement conflict')
    expect(context).not.toContain(`rm -- ${remedyWord(join(demandDir, RULE))}`)
  })

  it('does not recommend removing a misplaced file backing a checked static symlink', () => {
    const f = fixture('static-file-link')
    const staticDir = join(f.cfg, 'rules', 'wt')
    const demandDir = join(f.cfg, 'rules-on-demand')
    installInto(staticDir)
    mkdirSync(demandDir)
    const misplaced = join(demandDir, RULE)
    writeFileSync(misplaced, readFileSync(join(staticDir, RULE), 'utf8'))
    rmSync(join(staticDir, RULE))
    symlinkSync(misplaced, join(staticDir, RULE))
    const context = runHook(f.proj, f.env).context
    expect(context).toContain(`${RULE}: MISPLACED`)
    expect(context).toContain('Placement conflict')
    expect(context).not.toContain(`rm -- ${remedyWord(misplaced)}`)
  })

  it('requires preserving local edits before removing an edited misplaced copy', () => {
    const f = fixture('misplaced-edited')
    const staticDir = join(f.cfg, 'rules', 'wt')
    const demandDir = join(f.cfg, 'rules-on-demand')
    installInto(staticDir)
    mkdirSync(demandDir)
    writeFileSync(join(demandDir, RULE), readFileSync(join(staticDir, RULE), 'utf8') + '\nMY LOCAL EDIT\n')
    const context = runHook(f.proj, f.env).context
    expect(context).toContain(`${RULE}: MISPLACED`)
    expect(context).toMatch(/preserve any local edits/i)
  })

  it('never suggests installing static rules through a directory alias to on-demand', () => {
    const f = fixture('static-alias-to-demand')
    const staticAlias = join(f.proj, '.claude', 'rules', 'wt')
    const demandDir = join(f.cfg, 'rules-on-demand')
    installInto(demandDir)
    mkdirSync(join(f.proj, '.claude', 'rules'), { recursive: true })
    symlinkSync(demandDir, staticAlias, 'dir')
    const context = runHook(f.proj, f.env).context
    expect(context).toContain('NOT installed')
    expect(context).not.toContain(`--install --dir ${remedyWord(staticAlias)}`)
    expect(context).toContain(`--install --dir ${remedyWord(join(f.proj, '.claude', 'rules'))}`)
  })

  it('withholds a static-kind install remedy for a stale copy reached through an alias to on-demand', () => {
    const f = fixture('stale-through-alias')
    const demandDir = join(f.cfg, 'rules-on-demand')
    installOnDemand(demandDir)
    const older = readFileSync(join(REPO_ROOT, 'plugin/rules', ACT), 'utf8') + '\nOLDER SHIPPED BODY\n'
    writeManagedRule(join(demandDir, ACT), older, '0.0.1')
    const staticAlias = join(f.proj, '.claude', 'rules', 'wt')
    mkdirSync(join(f.proj, '.claude', 'rules'), { recursive: true })
    symlinkSync(demandDir, staticAlias, 'dir')
    const context = runHook(f.proj, f.env).context
    expect(context).toContain(ACT)
    expect(context).not.toContain(`--install --dir ${remedyWord(staticAlias)}`)
  })

  it('suggests only location-correct installs for stale static and on-demand copies', () => {
    const f = fixture('remedy-placement')
    const staticDir = join(f.cfg, 'rules', 'wt')
    const demandDir = join(f.cfg, 'rules-on-demand')
    installInto(staticDir)
    installInto(demandDir)
    writeFileSync(join(demandDir, RULE), readFileSync(join(staticDir, RULE), 'utf8'))
    ageManagedRule(join(staticDir, RULE))
    rmSync(join(staticDir, ACT))
    const older = readFileSync(join(REPO_ROOT, 'plugin/rules', ACT), 'utf8') + '\nOLDER SHIPPED BODY\n'
    writeManagedRule(join(demandDir, ACT), older, '0.0.1')
    const context = runHook(f.proj, f.env).context
    expect(context).toContain(`--install --dir ${remedyWord(staticDir)}`)
    expect(context).toContain(`--install --dir ${remedyWord(demandDir)}`)
    expect(context).toContain(`${ACT} (${demandDir})`)
    expect(context).toContain(`${RULE}: MISPLACED`)
  })
  it.each(['win32', 'linux'])('quotes printed remedies for injected %s', (platform) => {
    const f = fixture('platform remedy')
    const dir = join(f.cfg, 'rules-on-demand')
    specCopy(dir)
    writeFileSync(join(dir, ACT), readFileSync(join(dir, ACT), 'utf8').replace('  triggers:', '  triggers: # LOCAL'))
    const source = `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} }); const { main } = await import(${JSON.stringify(pathToFileURL(HOOK).href)}); main()`
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: f.proj }), encoding: 'utf8', env: f.env,
    })
    expect(result.status, result.stderr).toBe(0)
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string
    expect(context).toContain(`--refresh-triggers --file '${ACT}' --dir '${dir}'`)
  })
  it.each(['stale', 'edited', 'ahead'])('reports stale trigger-head remedy under a %s body bucket, including PostToolUse', (bucket) => {
    const f = fixture(`head-${bucket}`)
    const plugin = makeHookCopy()
    const dir = join(f.cfg, 'rules-on-demand')
    specCopy(dir, plugin.installer)
    const specFile = join(plugin.rulesDir, 'wt-task-tracking-at-act.spec.json')
    const spec = JSON.parse(readFileSync(specFile, 'utf8'))
    spec['on-demand'].triggers.push({ kind: 'tool', tool: '^NewTool$' })
    writeFileSync(specFile, JSON.stringify(spec))
    const file = join(dir, ACT)
    if (bucket === 'edited') writeFileSync(file, readFileSync(file, 'utf8') + '\nBODY EDIT\n')
    if (bucket === 'ahead') {
      const text = readFileSync(file, 'utf8') + '\nFUTURE BODY\n'
      const body = readFileSync(join(plugin.rulesDir, ACT), 'utf8') + '\nFUTURE BODY\n'
      const hash = createHash('sha256').update(body).digest('hex').slice(0, 12)
      writeFileSync(file, text.replace(/v\d+\.\d+\.\d+/, 'v999.0.0').replace(/content sha256:[0-9a-f]{12}/, `content sha256:${hash}`))
    }
    const checked = spawnSync(process.execPath, [plugin.installer, '--set', 'rules', '--check', '--dir', dir], { encoding: 'utf8', env: f.env }).stdout
    expect(checked).toContain('on-demand triggers behind the shipped spec')
    const context = runHook(f.proj, f.env, plugin.hook).context
    expect(context).toContain('on-demand triggers behind the shipped spec')
    expect(context).toContain(`--set rules --install --refresh-triggers --file ${remedyWord(ACT)} --dir ${remedyWord(dir)}`)
    if (bucket !== 'stale') expect(context).toContain('keeping the body as it is')
    if (bucket === 'edited') expect(context).toContain('body edit is left untouched')
    // The hook remains actionable after a push even when body EDITED is suppressed.
    const post = spawnSync(process.execPath, [plugin.hook], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: f.proj }), encoding: 'utf8', env: f.env })
    expect(post.stdout).toContain('on-demand triggers behind the shipped spec')
    if (bucket === 'stale') {
      expect(context.split(TRIGGER_MARKER).length - 1).toBe(1)
    }
  })

  it('does not promise an unchanged body when both body and trigger head are stale', () => {
    const f = fixture('head-body-both-stale')
    const plugin = makeHookCopy()
    const dir = join(f.cfg, 'rules-on-demand')
    specCopy(dir, plugin.installer)
    const specFile = join(plugin.rulesDir, 'wt-task-tracking-at-act.spec.json')
    const spec = JSON.parse(readFileSync(specFile, 'utf8'))
    spec['on-demand'].triggers.push({ kind: 'tool', tool: '^NewTool$' })
    writeFileSync(specFile, JSON.stringify(spec))
    const file = join(dir, ACT)
    const older = readFileSync(file, 'utf8') + '\nOLDER SHIPPED BODY\n'
    const hash = createHash('sha256').update(readFileSync(join(plugin.rulesDir, ACT), 'utf8') + '\nOLDER SHIPPED BODY\n').digest('hex').slice(0, 12)
    writeFileSync(file, older.replace(/content sha256:[0-9a-f]{12}/, `content sha256:${hash}`).replace(/v\d+\.\d+\.\d+/, 'v0.0.1'))
    const context = runHook(f.proj, f.env, plugin.hook).context
    expect(context).toContain(TRIGGER_MARKER)
    expect(context).not.toContain('keeping the body as it is')
    expect(context).toContain(`--set rules --install --dir ${remedyWord(dir)}`)
  })

  it('reports unresolved heads with both remedies, suppressing persistent trigger findings on PostToolUse', () => {
    const f = fixture('head-unresolved')
    const dir = join(f.cfg, 'rules-on-demand')
    specCopy(dir)
    const file = join(dir, ACT)
    writeFileSync(file, readFileSync(file, 'utf8').replace('  triggers:', '  triggers: # LOCAL'))
    const context = runHook(f.proj, f.env).context
    for (const flag of ['refresh', 'keep']) {
      expect(context).toContain(`--set rules --install --${flag}-triggers --file ${remedyWord(ACT)} --dir ${remedyWord(dir)}`)
    }
    expect(runPostToolUsePushHook(f.proj, f.env).context).not.toContain('--refresh-triggers')
  })

  it('keeps per-location trigger remedies next to a DOUBLE-LOAD finding', () => {
    const f = fixture('head-double-load')
    const project = join(f.proj, '.claude', 'rules-on-demand')
    const global = join(f.cfg, 'rules-on-demand')
    specCopy(project)
    specCopy(global)
    writeFileSync(join(project, ACT), readFileSync(join(project, ACT), 'utf8').replace('  triggers:', '  triggers: # LOCAL'))
    const context = runHook(f.proj, f.env).context
    expect(context).toContain(`${ACT}: DOUBLE-LOAD`)
    expect(context).toContain(`--refresh-triggers --file ${remedyWord(ACT)} --dir ${remedyWord(project)}`)
    expect(context).not.toContain(`--refresh-triggers --file ${remedyWord(ACT)} --dir ${remedyWord(global)}`)
  })

  it('does not mask a trigger finding when the flat and nested static rule locations duplicate', () => {
    const f = fixture('head-static-duplicate')
    const flat = join(f.cfg, 'rules')
    const nested = join(flat, 'wt')
    specCopy(flat)
    const file = join(flat, ACT)
    writeFileSync(file, readFileSync(file, 'utf8').replace('  triggers:', '  triggers: # LOCAL'))
    mkdirSync(nested)
    cpSync(file, join(nested, ACT))
    const context = runHook(f.proj, f.env).context
    expect(context).toContain(`${ACT}: DOUBLE-LOAD`)
    expect(context).toContain(`--refresh-triggers --file ${remedyWord(ACT)} --dir ${remedyWord(flat)}`)
  })
  it('offers a runnable per-file stale-head remedy beside flat/nested duplicates', () => {
    const f = fixture('stale-head-static-duplicate')
    const plugin = makeHookCopy()
    const flat = join(f.cfg, 'rules')
    const nested = join(flat, 'wt')
    specCopy(flat, plugin.installer)
    mkdirSync(nested)
    cpSync(join(flat, ACT), join(nested, ACT))
    const specFile = join(plugin.rulesDir, 'wt-task-tracking-at-act.spec.json')
    const spec = JSON.parse(readFileSync(specFile, 'utf8'))
    spec['on-demand'].triggers.push({ kind: 'tool', tool: '^NewTool$' })
    writeFileSync(specFile, JSON.stringify(spec))
    const context = runHook(f.proj, f.env, plugin.hook).context
    const command = `node ${remedyWord(plugin.installer)} --set rules --install --refresh-triggers --file ${remedyWord(ACT)} --dir ${remedyWord(flat)}`
    expect(context).toContain(`${ACT}: DOUBLE-LOAD`)
    expect(context).toContain(command)
    if (process.platform !== 'win32') {
      const result = spawnSync('sh', ['-c', command], { encoding: 'utf8', env: f.env })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain('TRIGGERS REFRESHED')
    }
  })
  it('describes body refresh separately when a duplicate has both stale body and stale head', () => {
    const f = fixture('stale-body-static-duplicate')
    const plugin = makeHookCopy()
    const flat = join(f.cfg, 'rules')
    const nested = join(flat, 'wt')
    specCopy(flat, plugin.installer)
    mkdirSync(nested)
    cpSync(join(flat, ACT), join(nested, ACT))
    const specFile = join(plugin.rulesDir, 'wt-task-tracking-at-act.spec.json')
    const spec = JSON.parse(readFileSync(specFile, 'utf8'))
    spec['on-demand'].triggers.push({ kind: 'tool', tool: '^NewTool$' })
    writeFileSync(specFile, JSON.stringify(spec))
    const file = join(flat, ACT)
    const body = readFileSync(join(plugin.rulesDir, ACT), 'utf8') + '\nOLDER SHIPPED BODY\n'
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 12)
    writeFileSync(file, readFileSync(file, 'utf8').replace(/content sha256:[0-9a-f]{12}/, `content sha256:${hash}`)
      .replace(/v\d+\.\d+\.\d+/, 'v0.0.1').replace(readFileSync(join(plugin.rulesDir, ACT), 'utf8'), body))
    const context = runHook(f.proj, f.env, plugin.hook).context
    expect(context).toContain(`--refresh-triggers --file ${remedyWord(ACT)} --dir ${remedyWord(flat)}`)
    expect(context).toContain('leaving body refresh for a separate normal install if needed')
    expect(context).not.toContain('also applying the normal body refresh')
  })
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
    expect(r.context).toContain(`--set rules --install --dir ${remedyWord(join(f.proj, '.claude', 'rules', 'wt'))}`)
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

  it.each([
    ['project', (f: ReturnType<typeof fixture>) => join(f.proj, '.claude', 'rules-on-demand')],
    ['global', (f: ReturnType<typeof fixture>) => join(f.cfg, 'rules-on-demand')],
  ])('reports missing static halves when adopted only on demand at the %s level', (_label, locate) => {
    const f = fixture('on-demand-current')
    installOnDemand(locate(f))

    const context = runHook(f.proj, f.env).context
    expect(context).toContain('rules NOT installed here:')
    expect(context).toContain(RULE)
  })

  it('reports stale on-demand content at its real location without calling it absent', () => {
    const f = fixture('on-demand-stale')
    const dir = join(f.cfg, 'rules-on-demand')
    installOnDemand(dir)
    const body = readFileSync(join(REPO_ROOT, 'plugin/rules', ACT), 'utf8') + '\nOLDER SHIPPED BODY\n'
    writeManagedRule(join(dir, ACT), body, '0.0.1')

    const result = runHook(f.proj, f.env)
    expect(result.context).toContain(`${ACT} (${dir})`)
    expect(result.context).toContain(`--set rules --install --dir ${remedyWord(dir)}`)
    expect(result.context).toContain('NOT installed')
  })

  it('reports a static plus on-demand copy as a double load', () => {
    const f = fixture('on-demand-duplicate')
    const staticDir = join(f.cfg, 'rules', 'wt')
    const onDemandDir = join(f.cfg, 'rules-on-demand')
    installInto(staticDir)
    installOnDemand(onDemandDir)

    const result = runHook(f.proj, f.env)
    expect(result.context).toContain('DOUBLE-LOAD')
    expect(result.context).toContain(staticDir)
    expect(result.context).toContain(onDemandDir)
  })

  it('reports project and config on-demand copies as a double load', () => {
    const f = fixture('on-demand-project-config-duplicate')
    const projectDir = join(f.proj, '.claude', 'rules-on-demand')
    const configDir = join(f.cfg, 'rules-on-demand')
    installOnDemand(projectDir)
    installOnDemand(configDir)

    const result = runHook(f.proj, f.env)
    expect(result.context).toContain('DOUBLE-LOAD')
    expect(result.context).toContain(projectDir)
    expect(result.context).toContain(configDir)
  })

  it('resolves directory symlinks before deciding a static and on-demand path are duplicates', () => {
    const f = fixture('on-demand-symlink')
    const staticDir = join(f.cfg, 'rules', 'wt')
    installInto(staticDir)
    symlinkSync(staticDir, join(f.cfg, 'rules-on-demand'), 'dir')

    expect(runHook(f.proj, f.env).stdout).toBe('')
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

  it('quotes the stale copy directory in the printed install command', () => {
    const f = fixture('stale-remedy-dir')
    const dir = join(f.cfg, 'rules', 'wt')
    installInto(dir)
    ageManagedRule(join(dir, RULE))

    const r = runHook(f.proj, f.env)
    expect(r.context).toContain(`--set rules --install --dir ${remedyWord(dir)}`)
  })

  it('orders the session to refresh an unedited stale copy, re-check it, and report one line', () => {
    const f = fixture('stale-session-action')
    const dir = join(f.cfg, 'rules', 'wt')
    installInto(dir)
    ageManagedRule(join(dir, RULE))

    const r = runHook(f.proj, f.env)
    expect(r.context).toContain('SESSION ACTION: run')
    expect(r.context).toContain(`--set rules --install --dir ${remedyWord(dir)}`)
    expect(r.context).toContain(`--set rules --check --dir ${remedyWord(dir)}`)
    expect(r.context).toContain('report one line')
    expect(r.context).not.toContain('TELL THE USER')

    const refreshed = spawnSync(
      process.execPath,
      [INSTALL_RULES, '--set', 'rules', '--install', '--dir', dir],
      { encoding: 'utf8', env: f.env },
    )
    expect(refreshed.status).toBe(0)
    expect(refreshed.stdout).toContain(`${RULE}: REFRESHED`)
    expect(readFileSync(join(dir, RULE), 'utf8')).not.toContain('A PARAGRAPH SINCE REWRITTEN UPSTREAM')
  })

  it('notice-only mode names the stale directory and hands the exact command to its owning session', () => {
    const f = fixture('stale-notice-only')
    const dir = join(f.cfg, 'rules', 'wt')
    installInto(dir)
    ageManagedRule(join(dir, RULE))
    const env = { ...f.env, WT_ADOPT_REFRESH: 'notice-only' }

    const r = runHook(f.proj, env)
    expect(r.context).toContain('NOTICE ONLY: hand this to the session that owns this directory')
    expect(r.context).toContain(`--set rules --install --dir ${remedyWord(dir)}`)
    expect(r.context).not.toContain('SESSION ACTION: run')
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

  it('orders the session to arbitrate an edited copy with the read-only three-way view', () => {
    const f = fixture('edited-session-action')
    const dir = join(f.proj, '.claude', 'rules')
    installInto(dir)
    writeFileSync(join(dir, RULE), readFileSync(join(dir, RULE), 'utf8') + '\nMY LOCAL EDIT\n')

    const r = runHook(f.proj, f.env)
    expect(r.context).toContain('SESSION ACTION: arbitrate the local edit')
    expect(r.context).toContain(`--set rules --diff ${remedyWord(RULE)} --dir ${remedyWord(dir)}`)
    expect(r.context).toContain('keep the edit and open a card against the shipped rule')
    expect(r.context).not.toContain('let them decide')
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
