// adopt-check-hook.test.ts — behavior gate for the SessionStart check
// (plugin/bin/wt-adopt-check-hook.mjs) that tells a session the truth about its
// rule-adoption state. Drives the REAL hook as a child process against isolated
// PROJECT + GLOBAL-config dirs (never the real ~/.claude), reusing install.mjs
// itself to seed each fixture — the same technique adopt-installer.test.ts uses
// (install, then a targeted string edit) rather than hand-rolling a second classifier.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
const ON_DEMAND_FRONTMATTER = '---\non-demand:\n  triggers:\n    - kind: tool\n      tool: Edit\n      unconditional: true\n---\n'
// The head the rules-on-demand engine REJECTS (`unknown trigger kind: (missing)`): loaded nowhere.
const REJECTED_ON_DEMAND_FRONTMATTER = '---\non-demand:\n  triggers:\n    - tool: Edit\n---\n'
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
function fixture(tag: string, projectDirName = 'proj') {
  const root = mkRoot(tag)
  const proj = join(root, projectDirName)
  mkdirSync(proj, { recursive: true })
  const home = join(root, 'home')
  const cfg = join(root, 'cfg')
  mkdirSync(home, { recursive: true })
  mkdirSync(cfg, { recursive: true })
  return { root, proj, cfg, env: sealedPluginCliEnv(root, { HOME: home, CLAUDE_CONFIG_DIR: cfg, CLAUDE_PROJECT_DIR: proj }) }
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

function noticeHook(cwd: string, env: NodeJS.ProcessEnv, hook = HOOK) {
  return runHook(cwd, { ...env, WT_ADOPT_REFRESH: 'notice-only' }, hook)
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
  const fp = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)
  const banner = readFileSync(file, 'utf8').split('\n').find((line) => line.includes('installed from workflow-toolbox'))!
    .replace(/v\d+\.\d+\.\d+/, 'v0.0.1').replace(/content sha256:[0-9a-f]{12}/, `content sha256:${fp}`)
  writeFileSync(file, `${banner}\n\n${body}`)
}

function staleProjectCopies() {
  const f = fixture('explicit-event')
  const shipped = makeHookCopy()
  const dirs = [join(f.proj, '.claude', 'rules', 'wt'), join(f.proj, '.claude', 'agents')]
  for (const [index, set] of ['rules', 'agents'].entries()) {
    const dir = dirs[index]!
    const result = spawnSync(process.execPath, [shipped.installer, '--install', '--set', set, '--dir', dir], { env: f.env, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    const file = set === 'rules' ? RULE : 'pilot.md'
    const source = join(shipped.rulesDir, '..', set === 'rules' ? 'rules' : 'agent-templates', file)
    writeFileSync(source, readFileSync(source, 'utf8') + '\nUPSTREAM FIX\n')
  }
  return { ...f, shipped, dirs }
}

function directorySnapshot(dirs: string[]) {
  return dirs.flatMap((dir) => readdirSync(dir).sort().map((file) => {
    const target = join(dir, file)
    const stat = statSync(target)
    return { target, bytes: stat.isFile() ? readFileSync(target).toString('base64') : 'dir', mtime: stat.mtimeMs }
  }))
}

describe('wt-adopt-check-hook — explicit write event', () => {
  it.each([undefined, 'PostToolUse', null, 7, 'Other'])('preserves every byte, mtime and directory entry for event %s', (event) => {
    const f = staleProjectCopies()
    const before = directorySnapshot(f.dirs)
    const payload = { cwd: f.proj, tool_name: 'Bash', tool_input: { command: 'git push' }, ...(event === undefined ? {} : { hook_event_name: event }) }
    const result = spawnSync(process.execPath, [f.shipped.hook], { input: JSON.stringify(payload), env: { ...f.env, WT_ADOPT_REFRESH: 'session' }, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('SESSION ACTION: run')
    expect(directorySnapshot(f.dirs), 'non-SessionStart preserves bytes, mtimes and all directory entries').toEqual(before)
  })
})

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

function staleRootFixture() {
  const f = fixture('stale-root')
  const installedRoot = join(f.root, 'cache', 'workflow-toolbox', '999.0.0')
  mkdirSync(join(installedRoot, '.claude-plugin'), { recursive: true })
  writeFileSync(join(installedRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({
    ...JSON.parse(readFileSync(join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8')), version: '999.0.0',
  }))
  mkdirSync(join(f.cfg, 'plugins'), { recursive: true })
  writeFileSync(join(f.cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {
    'workflow-toolbox@workflow-toolbox': [{ installPath: installedRoot, version: '999.0.0' }],
  } }))
  writeFileSync(join(f.cfg, 'settings.json'), JSON.stringify({ enabledPlugins: { 'workflow-toolbox@workflow-toolbox': true } }))
  const dir = join(f.cfg, 'rules', 'wt')
  installInto(dir)
  ageManagedRule(join(dir, RULE))
  const otherRules = readdirSync(dir).filter((name) => name.endsWith('.md') && name !== RULE && name !== ACT)
  const missing = otherRules[0]
  const ahead = otherRules[1]
  expect(missing).toBeDefined()
  expect(ahead).toBeDefined()
  rmSync(join(dir, missing!))
  writeManagedRule(join(dir, ahead!), readFileSync(join(REPO_ROOT, 'plugin/rules', ahead!), 'utf8') + '\nFUTURE SHIPPED LINE\n', '9999.0.0')
  writeFileSync(join(dir, ACT), readFileSync(join(dir, ACT), 'utf8') + '\nMY LOCAL EDIT\n')
  const inlineEnv = { ...f.env, CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin'), CLAUDE_PLUGIN_DATA: join(f.cfg, 'plugins', 'data', 'workflow-toolbox-inline') }
  const staleEnv = { ...inlineEnv, CLAUDE_PLUGIN_DATA: join(f.cfg, 'plugins', 'data', 'workflow-toolbox-workflow-toolbox') }
  return { f, dir, missing: missing!, ahead: ahead!, installedRoot, inlineEnv, staleEnv }
}

describe('wt-adopt-check-hook — unedited refresh', () => {
  it.each(['rules', 'agents'])('auto-refreshes an unedited stale %s copy without installing absent copies', (set) => {
    const f = fixture(`auto-${set}`)
    const shipped = makeHookCopy()
    const dir = join(f.cfg, set === 'rules' ? 'rules/wt' : 'agents')
    const file = set === 'rules' ? RULE : 'pilot.md'
    const seeded = spawnSync(process.execPath, [shipped.installer, '--install', '--set', set, '--dir', dir], { encoding: 'utf8', env: f.env })
    expect(seeded.status, seeded.stderr).toBe(0)
    const expected = readFileSync(join(dir, file), 'utf8')
    const source = join(shipped.rulesDir, '..', set === 'rules' ? 'rules' : 'agent-templates', file)
    writeFileSync(source, readFileSync(source, 'utf8') + '\nUPSTREAM FIX\n')
    const other = readdirSync(dir).find((name) => name.endsWith('.md') && name !== file)!
    rmSync(join(dir, other))
    const result = runHook(f.proj, { ...f.env, WT_ADOPT_REFRESH: 'session' }, shipped.hook)
    expect(result.context).toContain('refreshed 1 unedited stale copy')
    expect(result.context).toContain(`${file} (${dir})`)
    expect(result.context).not.toContain('SESSION ACTION: run')
    expect(readFileSync(join(dir, file), 'utf8')).not.toBe(expected)
    expect(readFileSync(join(dir, file), 'utf8')).toContain('UPSTREAM FIX')
    expect(readdirSync(dir)).not.toContain(other)
  })
})
describe('wt-adopt-check-hook — physical refresh', () => {
  it('auto-refreshes each physical stale copy even when a current or edited copy wins the merge', () => {
    const f = fixture('auto-physical')
    const project = join(f.proj, '.claude', 'rules', 'wt')
    const global = join(f.cfg, 'rules', 'wt')
    installInto(project)
    installInto(global)
    const expected = readFileSync(join(global, RULE), 'utf8')
    for (const edited of [false, true]) {
      ageManagedRule(join(global, RULE))
      if (edited) writeFileSync(join(project, RULE), readFileSync(join(project, RULE), 'utf8') + '\nLOCAL EDIT\n')
      const before = readFileSync(join(project, RULE), 'utf8')
      expect(runHook(f.proj, { ...f.env, WT_ADOPT_REFRESH: 'session' }).context).toContain('refreshed 1 unedited stale copy')
      expect(readFileSync(join(global, RULE), 'utf8')).toBe(expected)
      expect(readFileSync(join(project, RULE), 'utf8')).toBe(before)
    }
  })
})
describe('wt-adopt-check-hook — both static copies', () => {
  it('refreshes both stale static physical copies in one session', () => {
    const f = fixture('auto-both')
    const dirs = [join(f.proj, '.claude', 'rules', 'wt'), join(f.cfg, 'rules', 'wt')]
    for (const dir of dirs) { installInto(dir); ageManagedRule(join(dir, RULE)) }
    const context = runHook(f.proj, f.env).context
    for (const dir of dirs) {
      expect(context).toContain(`${RULE} (${dir})`)
      expect(readFileSync(join(dir, RULE), 'utf8')).not.toContain('A PARAGRAPH SINCE REWRITTEN UPSTREAM')
    }
    expect(context).toContain('refreshed 2 unedited stale copies')
  })
})
describe('wt-adopt-check-hook — selection', () => {
  it('refreshes only selected files beside a duplicate on-demand copy', () => {
    const f = fixture('selected-files')
    const shipped = makeHookCopy()
    const project = join(f.proj, '.claude', 'rules-on-demand')
    const global = join(f.cfg, 'rules-on-demand')
    const ladder = 'wt-delegation-ladder-at-act.md'
    installOnDemand(project, shipped.installer)
    for (const file of [ACT, ladder]) {
      const enrolled = spawnSync(process.execPath, [shipped.installer, '--install', '--file', file, '--dir', project], { env: f.env, encoding: 'utf8' })
      expect(enrolled.status, enrolled.stderr).toBe(0)
      writeFileSync(join(shipped.rulesDir, file), readFileSync(join(shipped.rulesDir, file), 'utf8') + '\nUPSTREAM FIX\n')
    }
    installOnDemand(global, shipped.installer)
    for (const file of readdirSync(global).filter((name) => name.endsWith('.md') && name !== ladder)) rmSync(join(global, file))
    const before = readFileSync(join(project, ladder), 'utf8')
    const context = runHook(f.proj, f.env, shipped.hook).context
    expect(readFileSync(join(project, ladder), 'utf8')).toBe(before)
    expect(readFileSync(join(project, ACT), 'utf8')).toContain('UPSTREAM FIX')
    expect(context).toContain('refreshed 1 unedited stale copy')
    expect(context).toContain(`${ACT} (${project})`)
    expect(context).toContain(`${ladder}: DOUBLE-LOAD`)
  })
})
function injectedRecheck(output: string, status: number | null, timedOut = false) {
  const f = fixture('partial-recheck')
  const dir = join(f.cfg, 'agents')
  const initial = '  a.md: STALE (installed v0.0.1)\n  b.md: STALE (installed v0.0.1)\n  retired.md: ORPHAN (retired)\n'
  const source = `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    let refreshed = false;
    cp.spawnSync = (command, args) => {
      if (args.includes('--refresh-only')) { refreshed = true; return { status: 1 }; }
      if (!args.includes(${JSON.stringify(dir)})) return { status: 0, stdout: '' };
      if (!refreshed) return { status: 0, stdout: ${JSON.stringify(initial)} };
      return { status: ${status}, stdout: ${JSON.stringify(output)},
        stderr: ${JSON.stringify(status === 1 ? 'adopt: fatal read' : '')},
        error: ${timedOut ? "Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })" : 'undefined'} };
    };
    syncBuiltinESMExports();
    const { main } = await import(${JSON.stringify(pathToFileURL(HOOK).href)});
    main();`
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: f.proj }), encoding: 'utf8', env: f.env,
  })
  expect(result.status, result.stderr).toBe(0)
  return { dir, context: JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string }
}

describe('wt-adopt-check-hook — partial recheck', () => {
  it.each([
    ['timeout', null, true, ''],
    ['fatal read', 1, false, ''],
    ['successful truncated output', 0, false, ''],
    ['equal count with a different filename', 0, false, '  unrelated.md: UP-TO-DATE (v1.0.0)\n'],
  ] as const)('retains unreached findings and orphans after %s', (_label, status, timedOut, extra) => {
    const { dir, context } = injectedRecheck('  a.md: UP-TO-DATE (v1.0.0)\n' + extra, status, timedOut)
    expect(context, 'unreached b.md stays actionable').toContain(`b.md (${dir}): behind v`)
    expect(context, 'prior orphan survives an incomplete recheck').toContain(`retired.md (${dir}): ORPHAN`)
    expect(context).toContain('refreshed 1 unedited stale copy')
    expect(context).not.toContain(`a.md (${dir}): behind v`)
  })
})

describe('wt-adopt-check-hook — complete recheck', () => {
  it('supersedes prior findings and orphans only after a successful complete recheck', () => {
    const { context } = injectedRecheck('  a.md: UP-TO-DATE (v1.0.0)\n  b.md: UP-TO-DATE (v1.0.0)\n', 0)
    expect(context).toContain('refreshed 2 unedited stale copies')
    expect(context).not.toContain('ORPHAN')
    expect(context).not.toContain('SESSION ACTION: run')
  })
  it('retains prior orphans even when a failed recheck prints every requested filename', () => {
    const { dir, context } = injectedRecheck('  a.md: UP-TO-DATE (v1.0.0)\n  b.md: UP-TO-DATE (v1.0.0)\n', 1)
    expect(context, 'a fatal exit cannot clear prior orphans').toContain(`retired.md (${dir}): ORPHAN`)
    expect(context).toContain('refreshed 2 unedited stale copies')
  })
})

describe('wt-adopt-check-hook — nonzero recheck', () => {
  it('uses refreshed per-file output when an unrelated unverified finding makes recheck exit one', () => {
    const f = fixture('recheck-nonzero')
    const shipped = makeHookCopy()
    const dir = join(f.cfg, 'rules', 'wt')
    installInto(dir, shipped.installer)
    const other = 'wt-task-tracking.md'
    const demand = join(f.cfg, 'rules-on-demand')
    mkdirSync(demand, { recursive: true })
    writeFileSync(join(demand, other), REJECTED_ON_DEMAND_FRONTMATTER + readFileSync(join(dir, other), 'utf8'))
    rmSync(join(dir, other))
    writeFileSync(join(shipped.rulesDir, RULE), readFileSync(join(shipped.rulesDir, RULE), 'utf8') + '\nUPSTREAM FIX\n')
    const checked = spawnSync(process.execPath, [shipped.installer, '--check', '--dir', dir], { env: f.env, encoding: 'utf8' })
    expect(checked.status, checked.stderr).toBe(1)
    expect(checked.stdout).toContain(`${other}: ON-DEMAND-UNVERIFIED`)
    const context = runHook(f.proj, f.env, shipped.hook).context
    expect(context).toContain('refreshed 1 unedited stale copy')
    expect(context).not.toContain('SESSION ACTION: run')
    expect(context).toContain('ON-DEMAND-UNVERIFIED')
    expect(readFileSync(join(dir, RULE), 'utf8')).toContain('UPSTREAM FIX')
  })
})
describe('wt-adopt-check-hook — combined summary', () => {
  it('reports one refresh summary for rules and agents together', () => {
    const f = fixture('summary-across-sets')
    const shipped = makeHookCopy()
    const rules = join(f.cfg, 'rules', 'wt')
    const agents = join(f.cfg, 'agents')
    installInto(rules, shipped.installer)
    const seeded = spawnSync(process.execPath, [shipped.installer, '--install', '--set', 'agents', '--dir', agents], { env: f.env, encoding: 'utf8' })
    expect(seeded.status, seeded.stderr).toBe(0)
    for (const source of [join(shipped.rulesDir, RULE), join(shipped.rulesDir, '..', 'agent-templates', 'pilot.md')]) {
      writeFileSync(source, readFileSync(source, 'utf8') + '\nUPSTREAM FIX\n')
    }
    const context = runHook(f.proj, f.env, shipped.hook).context
    const lines = context.split('\n').filter((line) => line.startsWith('workflow-toolbox adopt: refreshed'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('refreshed 2 unedited stale copies')
    expect(lines[0]).toContain(`${RULE} (${rules})`)
    expect(lines[0]).toContain(`pilot.md (${agents})`)
  })
})
describe('wt-adopt-check-hook — alias count', () => {
  it('counts a stale copy reached through directory aliases only once', () => {
    const f = fixture('auto-alias')
    const dir = join(f.cfg, 'rules', 'wt')
    installInto(dir)
    ageManagedRule(join(dir, RULE))
    const alias = join(f.proj, '.claude', 'rules', 'wt')
    mkdirSync(join(f.proj, '.claude', 'rules'), { recursive: true })
    symlinkSync(dir, alias, 'dir')
    const context = runHook(f.proj, f.env).context
    expect(context).toContain('refreshed 1 unedited stale copy')
    expect(context).not.toContain('refreshed 2')
    expect(readFileSync(join(dir, RULE), 'utf8')).not.toContain('A PARAGRAPH SINCE REWRITTEN UPSTREAM')
  })
})
describe('wt-adopt-check-hook — head refresh', () => {
  it('refreshes a provenance-stamped stale on-demand head through the same install path', () => {
    const f = fixture('auto-head')
    const shipped = makeHookCopy()
    const dir = join(f.cfg, 'rules-on-demand')
    specCopy(dir, shipped.installer)
    const specFile = join(shipped.rulesDir, 'wt-task-tracking-at-act.spec.json')
    const spec = JSON.parse(readFileSync(specFile, 'utf8'))
    spec['on-demand'].triggers.push({ kind: 'tool', tool: '^NewTool$' })
    writeFileSync(specFile, JSON.stringify(spec))
    const context = runHook(f.proj, f.env, shipped.hook).context
    expect(context).toContain('refreshed 1 unedited stale copy')
    expect(readFileSync(join(dir, ACT), 'utf8')).toContain('^NewTool$')
    expect(context).not.toContain(TRIGGER_MARKER)
  })
})
describe('wt-adopt-check-hook — journal failure', () => {
  it('recognizes a publication followed by journal failure by re-checking disk', () => {
    const f = fixture('auto-journal-failure')
    const shipped = makeHookCopy()
    const dir = join(f.cfg, 'rules', 'wt')
    installInto(dir, shipped.installer)
    ageManagedRule(join(dir, RULE))
    writeFileSync(shipped.installer, readFileSync(shipped.installer, 'utf8')
      .replace('function appendAdoptionJournal(dir, entry) {', "function appendAdoptionJournal(dir, entry) {\n  throw new Error('simulated journal failure')"))
    expect(runHook(f.proj, f.env, shipped.hook).context).toContain('refreshed 1 unedited stale copy')
    expect(readFileSync(join(dir, RULE), 'utf8')).not.toContain('A PARAGRAPH SINCE REWRITTEN UPSTREAM')
  })
})
describe('wt-adopt-check-hook — elapsed budget', () => {
  it('starts no refresh child once the shared eight-second budget has elapsed', () => {
    const f = fixture('auto-budget')
    const dir = join(f.cfg, 'rules', 'wt')
    installInto(dir)
    ageManagedRule(join(dir, RULE))
    const before = readFileSync(join(dir, RULE), 'utf8')
    const source = `const { main } = await import(${JSON.stringify(pathToFileURL(HOOK).href)}); let ticks = 0; Date.now = () => ticks++ === 0 ? 0 : 8001; main()`
    const res = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: f.proj }), encoding: 'utf8', env: f.env,
    })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('SESSION ACTION: run')
    expect(readFileSync(join(dir, RULE), 'utf8')).toBe(before)
  })
})
describe('wt-adopt-check-hook — recheck reserve', () => {
  it('reserves two seconds for recheck inside the shared eight-second refresh budget', () => {
    const f = fixture('reserved-recheck')
    const dir = join(f.cfg, 'rules', 'wt')
    installInto(dir)
    ageManagedRule(join(dir, RULE))
    const source = `import cp from 'node:child_process'; import assert from 'node:assert/strict'; import { syncBuiltinESMExports } from 'node:module'; const original = cp.spawnSync; let now = 0; const timeouts = []; Date.now = () => now; cp.spawnSync = function(command, args, options) { if (args.includes('--refresh-only')) { timeouts.push(options.timeout); now = 6000; } else if (timeouts.length && args.includes('--check')) assert.ok(options.timeout >= 2000, 'recheck receives reserved two seconds'); return original.call(this, command, args, options) }; syncBuiltinESMExports(); const { main } = await import(${JSON.stringify(pathToFileURL(HOOK).href)}); main(); assert.deepEqual(timeouts, [6000], 'refresh timeout reserves two seconds for recheck')`
    const res = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: f.proj }), encoding: 'utf8', env: f.env })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('refreshed 1 unedited stale copy')
  })
})
describe('wt-adopt-check-hook — start reserve', () => {
  it('starts no refresh child when less than the reserved recheck budget remains', () => {
    const f = fixture('reserved-start')
    const dir = join(f.cfg, 'rules', 'wt')
    installInto(dir)
    ageManagedRule(join(dir, RULE))
    const before = readFileSync(join(dir, RULE), 'utf8')
    const source = `import cp from 'node:child_process'; import assert from 'node:assert/strict'; import { syncBuiltinESMExports } from 'node:module'; const original = cp.spawnSync; let ticks = 0; let refreshes = 0; Date.now = () => ticks++ === 0 ? 0 : 6001; cp.spawnSync = function(command, args, options) { if (args.includes('--refresh-only')) refreshes++; return original.call(this, command, args, options) }; syncBuiltinESMExports(); const { main } = await import(${JSON.stringify(pathToFileURL(HOOK).href)}); main(); assert.equal(refreshes, 0, 'no refresh starts without a two-second recheck reserve')`
    const res = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: f.proj }), encoding: 'utf8', env: f.env })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('SESSION ACTION: run')
    expect(readFileSync(join(dir, RULE), 'utf8')).toBe(before)
  })
})
describe('wt-adopt-check-hook — orphan names', () => {
  it.each(['retired rule.md', 'retired rule.MD'])('reports orphan %s with a quoted removal command, leaving it untouched', (file) => {
    const f = fixture('orphan spaces')
    const dir = join(f.cfg, 'rules', 'wt')
    installInto(dir)
    const target = join(dir, file)
    writeFileSync(target, readFileSync(join(dir, RULE), 'utf8'))
    const before = readFileSync(target, 'utf8')
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: f.proj }), encoding: 'utf8', env: f.env,
    })
    expect(result.status, result.stderr).toBe(0)
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string
    expect(context).toContain(`${file} (${dir}): ORPHAN`)
    expect(context).toContain(`rm -- ${remedyWord(target)}`)
    expect(readFileSync(target, 'utf8')).toBe(before)
    expect(context).not.toContain('NOT installed')
  })
})
describe('wt-adopt-check-hook — failed refresh', () => {
  it('keeps SESSION ACTION after a failed refresh child and never writes in notice-only mode', () => {
    const f = fixture('auto-failed')
    const shipped = makeHookCopy()
    const dir = join(f.cfg, 'rules', 'wt')
    installInto(dir, shipped.installer)
    ageManagedRule(join(dir, RULE))
    const before = readFileSync(join(dir, RULE), 'utf8')
    expect(runHook(f.proj, { ...f.env, WT_ADOPT_REFRESH: 'notice-only' }, shipped.hook).context).toContain('NOTICE ONLY:')
    expect(readFileSync(join(dir, RULE), 'utf8')).toBe(before)
    writeFileSync(shipped.installer, readFileSync(shipped.installer, 'utf8') + '\n')
    const source = readFileSync(shipped.installer, 'utf8').replace('async function main() {', "async function main() {\n  if (process.argv.includes('--refresh-only')) process.exit(1)")
    writeFileSync(shipped.installer, source)
    expect(runHook(f.proj, { ...f.env, WT_ADOPT_REFRESH: 'session' }, shipped.hook).context).toContain('SESSION ACTION: run')
    expect(readFileSync(join(dir, RULE), 'utf8')).toBe(before)
  })
})
describe('wt-adopt-check-hook — internal error', () => {
  it('stays silent and exits zero on a missing project internal spawn error', () => {
    const f = fixture('internal-error')
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: join(f.root, 'vanished') }), encoding: 'utf8', env: f.env,
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('')
  })
})
describe('wt-adopt-check-hook — registered inventory', () => {
  it('does not report still-registered agent names as orphans', () => {
    const f = fixture('registered-orphan')
    const shipped = makeHookCopy()
    const dir = join(f.cfg, 'agents')
    const installed = spawnSync(process.execPath, [shipped.installer, '--install', '--set', 'agents', '--dir', dir], { encoding: 'utf8', env: f.env })
    expect(installed.status, installed.stderr).toBe(0)
    const registered = readdirSync(join(shipped.rulesDir, '..', 'agents')).find((name) => name.endsWith('.md') && name !== 'README.md')!
    writeFileSync(join(dir, registered), readFileSync(join(dir, 'pilot.md'), 'utf8'))
    expect(runHook(f.proj, f.env, shipped.hook).context).not.toContain('ORPHAN')
  })
})
describe('wt-adopt-check-hook — live templates', () => {
  it('does not report a live agent template outside the managed agent list as orphan', () => {
    const f = fixture('live-template')
    const shipped = makeHookCopy()
    const dir = join(f.cfg, 'agents')
    const seeded = spawnSync(process.execPath, [shipped.installer, '--install', '--set', 'agents', '--dir', dir], { env: f.env, encoding: 'utf8' })
    expect(seeded.status, seeded.stderr).toBe(0)
    cpSync(join(shipped.rulesDir, '..', 'agent-templates', 'pilot.md'), join(shipped.rulesDir, '..', 'agent-templates', 'new-live-agent.md'))
    cpSync(join(dir, 'pilot.md'), join(dir, 'new-live-agent.md'))
    expect(runHook(f.proj, f.env, shipped.hook).context).not.toContain('ORPHAN')
    const checked = spawnSync(process.execPath, [shipped.installer, '--check', '--set', 'agents', '--dir', dir], { env: f.env, encoding: 'utf8' })
    expect(checked.status, checked.stderr).toBe(0)
    expect(checked.stdout).not.toContain('new-live-agent.md: ORPHAN')
  })
})
function symlinkTemplateFixture(kind: 'file' | 'dangling' | 'directory') {
  const f = fixture(`template-link-${kind}`)
  const shipped = makeHookCopy()
  const dir = join(f.cfg, 'agents')
  const seeded = spawnSync(process.execPath, [shipped.installer, '--install', '--set', 'agents', '--dir', dir], { env: f.env, encoding: 'utf8' })
  expect(seeded.status, seeded.stderr).toBe(0)
  const name = kind === 'file' ? 'pilot.md' : `${kind}-template.md`
  const template = join(shipped.rulesDir, '..', 'agent-templates', name)
  const target = join(f.root, 'template-target')
  if (kind === 'file') {
    cpSync(template, target)
    rmSync(template)
  } else {
    cpSync(join(dir, 'pilot.md'), join(dir, name))
    if (kind === 'directory') mkdirSync(target)
  }
  return { ...f, shipped, dir, name, template, target }
}

describe('wt-adopt-check-hook — symlinked template inventory', () => {
  for (const kind of ['file', 'dangling', 'directory'] as const) it(`classifies a template symlink to ${kind} by its target`, (context) => {
    const f = symlinkTemplateFixture(kind)
    try {
      symlinkSync(f.target, f.template, kind === 'directory' ? 'dir' : 'file')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(code ?? '')) {
        context.skip(`Windows cannot create this symlink: ${code}; requires symlink privileges or Developer Mode`)
      }
      throw error
    }
    const checked = spawnSync(process.execPath, [f.shipped.installer, '--check', '--set', 'agents', '--dir', f.dir], { env: f.env, encoding: 'utf8' })
    expect(checked.status, checked.stderr).toBe(0)
    if (kind === 'file') {
      expect(checked.stdout).toContain(`${f.name}: UP-TO-DATE`)
      expect(checked.stdout, 'a live symlinked template is not an orphan').not.toContain(`${f.name}: ORPHAN`)
      expect(runHook(f.proj, f.env, f.shipped.hook).context).not.toContain(`${f.name} (${f.dir}): ORPHAN`)
    } else {
      expect(checked.stdout, 'non-file symlink targets stay outside the shipped inventory').toContain(`${f.name}: ORPHAN`)
    }
  })
})

describe('wt-adopt-check-hook — stale-root orphan suppression', () => {
  it('suppresses orphan advice from a stale running plugin root', () => {
    const { f, dir, staleEnv } = staleRootFixture()
    writeFileSync(join(dir, 'retired rule.md'), readFileSync(join(dir, RULE), 'utf8'))
    expect(runHook(f.proj, staleEnv).context).not.toContain('ORPHAN')
  })
})
describe('wt-adopt-check-hook — SessionStart version advice', () => {
  it('T5: a stale session skips version-dependent advice but retains missing and edited findings', () => {
    const { f, dir, missing, ahead, installedRoot, inlineEnv, staleEnv } = staleRootFixture()
    writeFileSync(join(dir, RULE), readFileSync(join(dir, RULE), 'utf8').replace('-->', '--> LOCAL BANNER NOTE'))
    const control = runHook(f.proj, { ...inlineEnv, WT_ADOPT_REFRESH: 'session' }).context
    expect(control).toContain(`${RULE} (${dir}): behind v`)
    expect(control).toContain('SESSION ACTION: run')
    expect(control).toContain(`${ahead} (${dir}): ahead of v`)
    expect(control).toContain('SESSION ACTION: arbitrate this fork')

    const context = runHook(f.proj, staleEnv).context
    expect(context).toContain(`Comparison skipped for `)
    expect(context).toContain(`${RULE} (${dir})`)
    expect(context).toContain(`${ahead} (${dir})`)
    expect(context).toContain(`v999.0.0 is installed at ${installedRoot}`)
    expect(context).toContain('until /reload-plugins or a restart')
    expect(context).not.toContain('downgrade')
    expect(context).not.toMatch(/\bolder\b/)
    expect(context).toContain('not reliable until /reload-plugins or a restart')
    expect(context).toContain(`NOT installed here: ${missing}`)
    expect(context).toContain(`Locally modified (supported, left untouched by any refresh): ${ACT} (${dir})`)
    expect(context).toContain('SESSION ACTION: arbitrate the local edit')
    expect(context).not.toContain('SESSION ACTION: run')
    expect(context).not.toContain('SESSION ACTION: arbitrate this fork')
    expect(context).not.toContain('NOTICE ONLY: hand this to the session that owns this directory: run')
    // The adoption hook never prints the registry hook's message; the assertion that can fail is the single skip line.
    expect(context.match(/Comparison skipped for /g)).toHaveLength(1)
  })
})
describe('wt-adopt-check-hook — SessionStart rule-adoption truth check', () => {
  it('T5 at PostToolUse: a stale root skips comparisons after a git push instead of recommending a downgrade', () => {
    const { f, dir, ahead, staleEnv, inlineEnv } = staleRootFixture()
    const control = runPostToolUsePushHook(f.proj, inlineEnv).context
    expect(control).toContain(`${ahead} (${dir}): ahead of v`)
    const context = runPostToolUsePushHook(f.proj, staleEnv).context
    expect(context).toContain('Comparison skipped for ')
    expect(context).toContain(`${ahead} (${dir})`)
    expect(context).not.toContain('ahead of v')
    expect(context).not.toContain('SESSION ACTION: run')
    expect(context.match(/Comparison skipped for /g)).toHaveLength(1)
  })

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
    expect(context).not.toContain('DOUBLE-LOAD')
  })

  it('does not stay silent about a static rule whose on-demand head the engine rejects, and orders no install', () => {
    const f = fixture('migrated-static-rejected')
    const staticDir = join(f.cfg, 'rules', 'wt')
    const demandDir = join(f.cfg, 'rules-on-demand')
    installInto(staticDir)
    mkdirSync(demandDir, { recursive: true })
    writeFileSync(join(demandDir, RULE), REJECTED_ON_DEMAND_FRONTMATTER + readFileSync(join(staticDir, RULE), 'utf8'))
    rmSync(join(staticDir, RULE))
    const context = runHook(f.proj, f.env).context
    expect(context).toContain(`${RULE}: ON-DEMAND-UNVERIFIED in `)
    expect(context).toContain('rejects it (unknown trigger kind')
    expect(context).toContain('fix the on-demand head')
    expect(context).not.toMatch(new RegExp(`NOT installed here:[^\\n]*${RULE.replace('.', '\\.')}`))
    expect(context).not.toContain(`${RULE}: MISPLACED`)
  })

  it('surfaces a migrated rule it cannot validate because the engine is missing, and orders no install', () => {
    const f = fixture('migrated-static-no-engine')
    const staticDir = join(f.cfg, 'rules', 'wt')
    const demandDir = join(f.cfg, 'rules-on-demand')
    installInto(staticDir)
    mkdirSync(demandDir, { recursive: true })
    writeFileSync(join(demandDir, RULE), ON_DEMAND_FRONTMATTER + readFileSync(join(staticDir, RULE), 'utf8'))
    rmSync(join(staticDir, RULE))
    const context = runHook(f.proj, { ...f.env, WT_RULES_ON_DEMAND_ROOT: join(f.root, 'no-engine-here') }).context
    expect(context).toContain(`${RULE}: ON-DEMAND-UNVERIFIED in `)
    expect(context).toContain('the rules-on-demand engine was not found (tried ')
    expect(context).toContain('set WT_RULES_ON_DEMAND_ROOT to the root of the rules-on-demand engine the session actually runs')
    expect(context).not.toMatch(new RegExp(`NOT installed here:[^\\n]*${RULE.replace('.', '\\.')}`))
    expect(context).not.toContain(`${RULE}: MISPLACED`)
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
    const context = noticeHook(f.proj, f.env).context
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
    const context = noticeHook(f.proj, f.env, plugin.hook).context
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
    const context = noticeHook(f.proj, f.env, plugin.hook).context
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

    const result = noticeHook(f.proj, f.env)
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
    const hooked = noticeHook(f.proj, f.env, shipped.hook)
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

    const hooked = noticeHook(f.proj, f.env, shipped.hook)
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

    const hooked = noticeHook(f.proj, f.env, shipped.hook)
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

    const hooked = noticeHook(f.proj, f.env, shipped.hook)
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
    const r = noticeHook(f.proj, f.env)
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
    const r = noticeHook(f.proj, f.env)
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

    const r = noticeHook(f.proj, f.env)
    expect(r.context).toContain(`--set rules --install --dir ${remedyWord(dir)}`)
  })

  it('orders the session to refresh an unedited stale copy, re-check it, and report one line', () => {
    const f = fixture('stale-session-action')
    const dir = join(f.cfg, 'rules', 'wt')
    installInto(dir)
    ageManagedRule(join(dir, RULE))
    writeFileSync(join(dir, RULE), readFileSync(join(dir, RULE), 'utf8').replace('-->', '--> LOCAL BANNER NOTE'))

    const r = runHook(f.proj, { ...f.env, WT_ADOPT_REFRESH: 'session' })
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

  it('leaves already-current fixture files unchanged after the check', () => {
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
      encoding: 'utf8', env: sealedPluginCliEnv(mkRoot('missing-cwd')),
    })
    expect((res.stdout ?? '').trim()).toBe('')
    expect(res.status).toBe(0)
  })

  it('fail-safe SILENT on empty stdin', () => {
    const res = spawnSync(process.execPath, [HOOK], { input: '', encoding: 'utf8', env: sealedPluginCliEnv(mkRoot('empty-input')) })
    expect((res.stdout ?? '').trim()).toBe('')
    expect(res.status).toBe(0)
  })
})

// Compaction re-fires SessionStart with source "compact". Adopted-copy drift does not change across a compaction and
// the session start already reported it, so the hook prints nothing there; every other source is unchanged.
function runHookWithSource(cwd: string, env: NodeJS.ProcessEnv, source: string | undefined, hook = HOOK): string {
  const payload: Record<string, unknown> = { hook_event_name: 'SessionStart', cwd }
  if (source !== undefined) payload['source'] = source
  const res = spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: 'utf8', env })
  const stdout = (res.stdout ?? '').trim()
  return stdout ? ((JSON.parse(stdout).hookSpecificOutput?.additionalContext as string) ?? '') : ''
}

/** Many edited files and one stale copy in the project dir, plus an unresolved trigger head. */
function busyFixture(tag: string, projectDirName?: string) {
  const f = fixture(tag, projectDirName)
  const dir = join(f.proj, '.claude', 'rules')
  installInto(dir)
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.md') && name !== RULE)) {
    writeFileSync(join(dir, file), readFileSync(join(dir, file), 'utf8') + '\nMY LOCAL EDIT\n')
  }
  ageManagedRule(join(dir, RULE))
  const onDemand = join(f.cfg, 'rules-on-demand')
  specCopy(onDemand)
  const act = join(onDemand, ACT)
  writeFileSync(act, readFileSync(act, 'utf8').replace('  triggers:', '  triggers: # LOCAL'))
  return f
}

describe('wt-adopt-check-hook — silent after a compaction', () => {
  it('prints nothing on compact, even with drift, an unresolved trigger head, notice-only mode or a stale root', () => {
    const f = busyFixture('compact-silent')
    expect(runHookWithSource(f.proj, { ...f.env, WT_ADOPT_REFRESH: 'notice-only' }, 'startup')).toContain('NOTICE ONLY:')
    expect(runHookWithSource(f.proj, f.env, 'compact')).toBe('')
    expect(runHookWithSource(f.proj, { ...f.env, WT_ADOPT_REFRESH: 'notice-only' }, 'compact')).toBe('')
    const { f: stale, staleEnv } = staleRootFixture()
    expect(runHookWithSource(stale.proj, staleEnv, 'startup')).toContain('Comparison skipped for ')
    expect(runHookWithSource(stale.proj, staleEnv, 'compact')).toBe('')
  })

  it('keeps startup, resume, clear and absent-source output byte-for-byte', () => {
    const f = busyFixture('compact-others')
    const env = { ...f.env, WT_ADOPT_REFRESH: 'notice-only' }
    const before = directorySnapshot([join(f.proj, '.claude', 'rules')])
    const startup = runHookWithSource(f.proj, env, 'startup')
    expect(startup.length).toBeGreaterThan(3000)
    for (const source of ['resume', 'clear', undefined, 'unknown']) {
      expect(runHookWithSource(f.proj, env, source)).toBe(startup)
    }
    expect(directorySnapshot([join(f.proj, '.claude', 'rules')])).toEqual(before)
  })
})

// Card 1874754605787645076, route C: a static-named alias of the on-demand root store is on-demand
// storage by filesystem identity, so the hook never proposes installing static rules into it.
describe('wt-adopt-check-hook — on-demand placement by root identity', () => {
  it('E: proposes no static install into a directory that shares the on-demand root identity', () => {
    const f = fixture('identity-alias')
    const store = join(f.root, 'store')
    mkdirSync(store, { recursive: true })
    symlinkSync(store, join(f.cfg, 'rules-on-demand'), 'dir')
    const alias = join(f.proj, '.claude', 'rules', 'wt')
    mkdirSync(join(f.proj, '.claude', 'rules'), { recursive: true })
    symlinkSync(store, alias, 'dir')
    const context = runHook(f.proj, f.env).context
    expect(context).toContain('NOT installed')
    expect(context).not.toContain(`--install --dir ${remedyWord(alias)}`)
    expect(context).not.toContain(`--install --dir ${remedyWord(store)}`)
  })
})
