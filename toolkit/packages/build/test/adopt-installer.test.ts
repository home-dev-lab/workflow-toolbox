// adopt-installer.test.ts — the COMMITTED drift-lock for the adopt
// installer's edit-safety contract (plugin/skills/adopt/scripts/install.mjs).
//
// The edit-safety logic (content fingerprint + EDITED classification + --force) was
// added under review pressure precisely so a routine `--install` refresh can never
// silently destroy a user's edits. It was originally proven by a standalone e2e that
// ran once and evaporated — verified-once, NOT drift-gated. This test moves those
// assertions INTO the suite (child-process execution against throwaway dirs, the same
// pattern as plugin-hooks.test.ts) so the contract is locked against future drift.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  symlinkSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  cpSync,
  renameSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, it, expect } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
// @ts-expect-error read-only JS plugin renderer has no TypeScript declaration
import { frontmatter } from '../../../../plugins/wt-rules-on-demand/scripts/rule-lifecycle-lib.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { quoteRemedyWord } from '../../../../plugin/bin/lib/remedy-quote.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/skills/adopt/scripts/install.mjs')
const ENV_ROOT = join(tmpdir(), `wt-adopt-installer-env-${process.pid}`)
const INSTALLER_ENV: NodeJS.ProcessEnv = sealedPluginCliEnv(ENV_ROOT, {
  CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin'),
})
const RULE = 'wt-delegation-ladder.md'
const AUTONOMY = 'AUTONOMY.md'
const ON_DEMAND_FRONTMATTER = '---\non-demand:\n  triggers:\n    - tool: Edit\n---\n'
const ACT = 'wt-task-tracking-at-act.md'
const remedyWord = (value: string) => quoteRemedyWord(value, true)
const specPath = join(REPO_ROOT, 'plugin/rules/wt-task-tracking-at-act.spec.json')
type ShippedSpec = { 'on-demand': { triggers: Record<string, string | boolean | number>[] }; compliance?: Record<string, string | boolean | number> }
const renderShippedHead = (spec: ShippedSpec) => frontmatter({ ...spec, triggers: spec['on-demand'].triggers })
const specHead = () => renderShippedHead(JSON.parse(readFileSync(specPath, 'utf8')))
const headFp = (head: string) => createHash('sha256').update(head.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12)
const installedHead = (text: string) => /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text)?.[0] ?? ''
const withoutHeadStamp = (text: string) => text.replace(/ (?:head sha256:[0-9a-f]{12}|kept sha256:[0-9a-f]{12} spec sha256:[0-9a-f]{12})(?= by the adopt skill)/, '')
function actFixture(): { dir: string; file: string; head: string } {
  const dir = join(mkDir(), 'rules-on-demand')
  run(['--set', 'rules', '--install'], dir)
  const file = join(dir, ACT)
  const head = specHead()
  writeFileSync(file, head + readFileSync(file, 'utf8'))
  return { dir, file, head }
}
function copiedPlugin(): { script: string; spec: string } {
  const plugin = join(mkDir(), 'plugin')
  for (const dir of ['.claude-plugin', 'rules', 'skills/adopt']) {
    cpSync(join(REPO_ROOT, 'plugin', dir), join(plugin, dir), { recursive: true })
  }
  mkdirSync(join(plugin, 'bin/lib'), { recursive: true })
  cpSync(join(REPO_ROOT, 'plugin/bin/lib/remedy-quote.mjs'), join(plugin, 'bin/lib/remedy-quote.mjs'))
  mkdirSync(join(plugin, 'bin/lib/host'))
  cpSync(join(REPO_ROOT, 'plugin/bin/lib/host/adopt-placement.mjs'), join(plugin, 'bin/lib/host/adopt-placement.mjs'))
  return { script: join(plugin, 'skills/adopt/scripts/install.mjs'), spec: join(plugin, 'rules/wt-task-tracking-at-act.spec.json') }
}
function runCopied(script: string, args: string[], dir: string) {
  return spawnSync(process.execPath, [script, '--set', 'rules', ...args, '--dir', dir], { encoding: 'utf8', env: INSTALLER_ENV }).stdout
}

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
afterAll(() => rmSync(ENV_ROOT, { recursive: true, force: true }))
function mkDir(): string {
  const r = realpathSync(mkdtempSync(join(tmpdir(), 'wt-adopt-')))
  roots.push(r)
  return r
}
function run(args: string[], dir: string): string {
  const res = spawnSync(process.execPath, [SCRIPT, ...args, '--dir', dir], { encoding: 'utf8', env: INSTALLER_ENV })
  return (res.stdout ?? '') + (res.stderr ?? '')
}
function runResult(args: string[], dir: string) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args, '--dir', dir], { encoding: 'utf8', env: INSTALLER_ENV })
  return { status: res.status, out: (res.stdout ?? '') + (res.stderr ?? '') }
}
// Run WITHOUT a forced --dir, at a chosen cwd, so the script uses each set's OWN
// default dir (.claude/rules, .claude/agents) under that cwd — the only way to
// exercise the `--set all` SUCCESS path, which rejects an explicit --dir.
function runInCwd(args: string[], cwd: string): string {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: INSTALLER_ENV })
  return (res.stdout ?? '') + (res.stderr ?? '')
}
function runInCwdResult(args: string[], cwd: string, env: NodeJS.ProcessEnv = INSTALLER_ENV) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env })
  return { status: res.status, out: (res.stdout ?? '') + (res.stderr ?? '') }
}
const rulePath = (dir: string) => join(dir, RULE)
const autonomyPath = (dir: string) => join(dir, '.claude', AUTONOMY)

// Age a managed RULE copy into "installed from an older release whose text has since
// changed": an older banner version, a body that genuinely differs from what ships now, and
// a fingerprint restamped over that body so the copy still classifies as UNEDITED ('clean')
// rather than as a user edit. Both halves matter — since STALE tracks CONTENT, a fixture
// that only lowered the version number would describe a copy that is legitimately up to
// date, and could no longer exercise staleness at all.
function ageRuleCopy(file: string, version = '0.0.1'): void {
  const body = readFileSync(join(REPO_ROOT, 'plugin/rules', basename(file)), 'utf8') + '\nA PARAGRAPH SINCE REWRITTEN UPSTREAM\n'
  const fp = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)
  writeFileSync(file, `<!-- installed from workflow-toolbox v${version} · content sha256:${fp} by the adopt skill -->\n\n${body}`)
}

function addOnDemandFrontmatter(dir: string): void {
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.md'))) {
    const target = join(dir, file)
    writeFileSync(target, ON_DEMAND_FRONTMATTER + readFileSync(target, 'utf8'))
  }
}

describe('adopt installer — edit-safety contract (committed drift lock)', () => {
  it('installs and refreshes only spec-backed rules in an on-demand directory, preserving misplaced static copies', () => {
    const dir = join(mkDir(), 'rules-on-demand')
    const first = runResult(['--set', 'rules', '--install'], dir)
    expect(first.status, first.out).toBe(0)
    expect(existsSync(join(dir, ACT))).toBe(true)
    const writtenRules = readdirSync(dir).filter((name) => name.endsWith('.md'))
    expect(writtenRules.length).toBeGreaterThan(0)
    for (const file of writtenRules) {
      expect(existsSync(join(REPO_ROOT, 'plugin/rules', file.replace(/\.md$/, '.spec.json'))), file).toBe(true)
    }
    const misplaced = join(dir, RULE)
    writeFileSync(misplaced, 'local static rule\n')
    const checked = run(['--set', 'rules', '--check'], dir)
    expect(checked).toContain(`${RULE}: MISPLACED`)
    run(['--set', 'rules', '--install', '--force'], dir)
    expect(readFileSync(misplaced, 'utf8')).toBe('local static rule\n')
    expect(existsSync(join(dir, ACT))).toBe(true)
  })

  it('does not report a static rule migrated to on-demand (own on-demand head) as misplaced', () => {
    const dir = join(mkDir(), 'rules-on-demand')
    mkdirSync(dir, { recursive: true })
    const migrated = join(dir, RULE)
    writeFileSync(migrated, ON_DEMAND_FRONTMATTER + readFileSync(join(REPO_ROOT, 'plugin/rules', RULE), 'utf8'))
    const checked = run(['--set', 'rules', '--check'], dir)
    expect(checked).not.toContain(`${RULE}: MISPLACED`)
    expect(checked).toContain(`${RULE}: ON-DEMAND`)
    const before = readFileSync(migrated, 'utf8')
    run(['--set', 'rules', '--install', '--force'], dir)
    expect(readFileSync(migrated, 'utf8')).toBe(before)
  })

  it('filters rules through a differently named symlink to an on-demand directory', () => {
    const root = mkDir()
    const demand = join(root, 'rules-on-demand')
    const alias = join(root, 'demand-alias')
    mkdirSync(demand)
    symlinkSync(demand, alias, 'dir')
    const result = runResult(['--set', 'rules', '--install'], alias)
    expect(result.status, result.out).toBe(0)
    const writtenRules = readdirSync(demand).filter((name) => name.endsWith('.md'))
    expect(writtenRules.length).toBeGreaterThan(0)
    for (const file of writtenRules) {
      expect(existsSync(join(REPO_ROOT, 'plugin/rules', file.replace(/\.md$/, '.spec.json'))), file).toBe(true)
    }
    expect(existsSync(join(demand, RULE))).toBe(false)
  })

  it.each(['win32', 'darwin'])('recognizes case-folded on-demand target on %s', (platform) => {
    const dir = join(mkDir(), 'RULES-ON-DEMAND')
    const source = `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} }); process.argv = [process.execPath, ${JSON.stringify(SCRIPT)}, '--set', 'rules', '--install', '--dir', ${JSON.stringify(dir)}]; await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})`
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8', env: INSTALLER_ENV })
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(dir, ACT))).toBe(true)
    expect(existsSync(join(dir, RULE))).toBe(false)
  })

  it('keeps the static target able to install both rule halves without an on-demand engine', () => {
    const dir = join(mkDir(), 'rules', 'wt')
    expect(runResult(['--set', 'rules', '--install'], dir).status).toBe(0)
    expect(existsSync(join(dir, RULE))).toBe(true)
    expect(existsSync(join(dir, ACT))).toBe(true)
  })
  it.each(['win32', 'linux'])('quotes printed trigger remedies for injected %s', (platform) => {
    const { dir, file } = actFixture()
    writeFileSync(file, readFileSync(file, 'utf8').replace('  triggers:', '  triggers: # LOCAL'))
    const source = `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} }); process.argv = [process.execPath, ${JSON.stringify(SCRIPT)}, '--set', 'rules', '--check', '--dir', ${JSON.stringify(dir)}]; await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})`
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8', env: INSTALLER_ENV })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`--refresh-triggers --file '${ACT}' --dir '${dir}'`)
  })
  it('ABSENT: --install writes the rule with a version banner AND a content fingerprint', () => {
    const d = mkDir()
    expect(run(['--check'], d)).toContain('ABSENT')
    const out = run(['--install'], d)
    expect(out).toMatch(/WROTE/)
    const body = readFileSync(rulePath(d), 'utf8')
    expect(body).toMatch(/installed from workflow-toolbox v\d+\.\d+\.\d+/)
    expect(body).toMatch(/content sha256:[0-9a-f]{12}/)
  })

  it('a fresh install is UP-TO-DATE (fingerprint round-trips)', () => {
    const d = mkDir()
    run(['--install'], d)
    expect(run(['--check'], d)).toContain('UP-TO-DATE')
  })

  it('STALE unedited (older release, text has since changed): --install REFRESHES it', () => {
    const d = mkDir()
    run(['--install'], d)
    const p = rulePath(d)
    ageRuleCopy(p)
    expect(run(['--check'], d)).toContain('STALE')
    expect(run(['--install'], d)).toMatch(/REFRESHED/)
    expect(run(['--check'], d)).toContain('UP-TO-DATE')
    // The refresh really replaced the text — not just re-stamped the banner over stale prose.
    expect(readFileSync(p, 'utf8')).not.toContain('A PARAGRAPH SINCE REWRITTEN UPSTREAM')
  })

  it('EDITED (fingerprint mismatch) SURVIVES --install; overwritten ONLY with --force', () => {
    const d = mkDir()
    run(['--install'], d)
    const p = rulePath(d)
    writeFileSync(p, readFileSync(p, 'utf8') + '\nMY LOCAL EDIT LINE\n')
    expect(run(['--check'], d)).toContain('EDITED')
    expect(run(['--install'], d)).toContain('SKIPPED')
    expect(readFileSync(p, 'utf8'), 'edit must survive a plain --install').toContain('MY LOCAL EDIT LINE')
    expect(run(['--install', '--force'], d)).toMatch(/OVERWROTE/)
    expect(readFileSync(p, 'utf8'), 'edit must be gone after --force').not.toContain('MY LOCAL EDIT LINE')
  })

  it('--diff prints adopted, local, and shipped texts for an edited file without writing', () => {
    const d = mkDir()
    run(['--install'], d)
    const p = rulePath(d)
    writeFileSync(p, readFileSync(p, 'utf8') + '\nMY LOCAL EDIT LINE\n')
    const before = readFileSync(p, 'utf8')

    const result = runResult(['--set', 'rules', '--diff', RULE], d)
    expect(result.status).toBe(0)
    expect(result.out).toContain('=== ADOPTED v')
    expect(result.out.split('=== LOCAL')[0]).not.toContain('MY LOCAL EDIT LINE')
    expect(result.out).toContain('=== LOCAL')
    expect(result.out).toContain('MY LOCAL EDIT LINE')
    expect(result.out).toContain('=== SHIPPED v')
    expect(result.out).toContain(readFileSync(join(REPO_ROOT, 'plugin/rules', RULE), 'utf8'))
    expect(readFileSync(p, 'utf8')).toBe(before)
  })

  it('--install --force --file overwrites only the arbitrated edited file', () => {
    const d = mkDir()
    run(['--install'], d)
    const chosen = rulePath(d)
    const other = join(d, 'wt-memory-hygiene.md')
    writeFileSync(chosen, readFileSync(chosen, 'utf8') + '\nCHOSEN LOCAL EDIT\n')
    writeFileSync(other, readFileSync(other, 'utf8') + '\nOTHER LOCAL EDIT\n')

    const result = runResult(['--set', 'rules', '--install', '--force', '--file', RULE], d)
    expect(result.status).toBe(0)
    expect(result.out).toContain(`${RULE}: OVERWROTE (--force)`)
    expect(readFileSync(chosen, 'utf8')).not.toContain('CHOSEN LOCAL EDIT')
    expect(readFileSync(other, 'utf8')).toContain('OTHER LOCAL EDIT')
  })

  it('old-format banner (version but NO fingerprint): conservative skip, --force overwrites', () => {
    const d = mkDir()
    writeFileSync(
      rulePath(d),
      '<!-- installed from workflow-toolbox v0.1.0 by the adopt skill -->\n\n# x\n\nold\n',
    )
    expect(run(['--check'], d)).toMatch(/pre-fingerprint/)
    expect(run(['--install'], d)).toContain('SKIPPED')
    expect(run(['--install', '--force'], d)).toMatch(/OVERWROTE/)
    expect(readFileSync(rulePath(d), 'utf8')).toContain('content sha256:')
  })

  it('hand-authored (no toolbox banner) is NEVER overwritten, even with --force', () => {
    const d = mkDir()
    writeFileSync(rulePath(d), '# my own rule\nno banner here\n')
    expect(run(['--install', '--force'], d)).toContain('SKIPPED')
    expect(readFileSync(rulePath(d), 'utf8')).toContain('no banner here')
  })

  it('--check is read-only: it writes nothing to disk', () => {
    const d = mkDir()
    run(['--check'], d)
    expect(existsSync(rulePath(d))).toBe(false)
  })
})

describe('adopt installer — explicit rules roots cannot create flat duplicates', () => {
  it('--dir <root-with-wt> refuses install, names files, and gives both remedies', () => {
    const root = mkDir()
    const wt = join(root, 'wt')
    run(['--install'], wt)

    const res = runResult(['--set', 'rules', '--install'], root)
    expect(res.status).not.toBe(0)
    expect(res.out).toMatch(/first banner files: .*\.md/)
    expect(res.out).toContain(`--dir ${wt}`)
    expect(res.out).toContain('--global')
  })

  it('--dir <root>/wt remains the exact install target', () => {
    const root = mkDir()
    const wt = join(root, 'wt')
    const res = runResult(['--set', 'rules', '--install'], wt)
    expect(res.status).toBe(0)
    expect(res.out).toContain('WROTE')
  })

  it('--check reports DUPLICATE for every flat copy beside its wt copy and exits non-zero', () => {
    const root = mkDir()
    const wt = join(root, 'wt')
    run(['--set', 'rules', '--install'], root)
    mkdirSync(wt)
    for (const file of readdirSync(root).filter((name) => name.endsWith('.md'))) {
      cpSync(join(root, file), join(wt, file))
    }

    const res = runResult(['--set', 'rules', '--check'], root)
    expect(res.status).not.toBe(0)
    expect(res.out).toContain(`${RULE}: DUPLICATE`)
  })
})

describe('adopt installer — rules-on-demand copies', () => {
  it.each([
    ['block value', '---\non-demand:\n  triggers: [Edit]\n---\n'],
    ['trailing comment', '---\non-demand: # engine\n---\n'],
    ['inline map', '---\non-demand: {triggers: [Edit]}\n---\n'],
  ])('recognizes the top-level on-demand key with a %s', (_label, frontmatter) => {
    const dir = join(mkDir(), 'rules', 'wt')
    run(['--set', 'rules', '--install'], dir)
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.md'))) {
      const target = join(dir, file)
      writeFileSync(target, frontmatter + readFileSync(target, 'utf8'))
    }

    expect(run(['--set', 'rules', '--check'], dir)).toContain(`${RULE}: UP-TO-DATE`)
    writeFileSync(rulePath(dir), readFileSync(rulePath(dir), 'utf8') + '\nVISIBLE BODY EDIT\n')
    expect(run(['--set', 'rules', '--check'], dir)).toContain(`${RULE}: EDITED`)
  })

  it('classifies the adopted BODY behind on-demand frontmatter and detects a real body edit', () => {
    const dir = join(mkDir(), 'rules', 'wt')
    run(['--set', 'rules', '--install'], dir)
    addOnDemandFrontmatter(dir)

    expect(run(['--set', 'rules', '--check'], dir)).toContain(`${RULE}: UP-TO-DATE`)
    writeFileSync(rulePath(dir), readFileSync(rulePath(dir), 'utf8') + '\nMY LOCAL ON-DEMAND EDIT\n')
    expect(run(['--set', 'rules', '--check'], dir)).toContain(`${RULE}: EDITED`)
  })

  it('refreshes a stale on-demand copy in place and preserves its frontmatter byte for byte', () => {
    const dir = join(mkDir(), 'rules', 'wt')
    run(['--set', 'rules', '--install'], dir)
    addOnDemandFrontmatter(dir)
    ageRuleCopy(rulePath(dir))
    writeFileSync(rulePath(dir), ON_DEMAND_FRONTMATTER + readFileSync(rulePath(dir), 'utf8'))

    expect(run(['--set', 'rules', '--check'], dir)).toContain(`${RULE}: STALE`)
    expect(run(['--set', 'rules', '--install'], dir)).toContain(`${RULE}: REFRESHED`)
    const refreshed = readFileSync(rulePath(dir), 'utf8')
    expect(refreshed.startsWith(ON_DEMAND_FRONTMATTER)).toBe(true)
    expect(refreshed.slice(0, ON_DEMAND_FRONTMATTER.length)).toBe(ON_DEMAND_FRONTMATTER)
    expect(refreshed).not.toContain('A PARAGRAPH SINCE REWRITTEN UPSTREAM')
  })

  it('an implicit install finds and refreshes the config rules-on-demand copy without writing rules/wt', () => {
    const root = mkDir()
    const project = join(root, 'project')
    const config = join(root, 'config')
    const target = join(config, 'rules-on-demand')
    mkdirSync(project, { recursive: true })
    run(['--set', 'rules', '--install'], target)
    addOnDemandFrontmatter(target)
    ageRuleCopy(join(target, ACT))
    writeFileSync(join(target, ACT), specHead() + readFileSync(join(target, ACT), 'utf8'))
    const env = sealedPluginCliEnv(root, { CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin') })

    const result = runInCwdResult(['--set', 'rules', '--install'], project, env)
    expect(result.status).toBe(0)
    expect(result.out).toContain(`[rules] target=${target}`)
    expect(result.out).toContain(`${ACT}: REFRESHED`)
    expect(existsSync(join(config, 'rules', 'wt', RULE))).toBe(false)
    // Static rules missing everywhere go to the project's static default, never the on-demand dir.
    expect(existsSync(join(target, RULE))).toBe(false)
    expect(existsSync(join(project, '.claude', 'rules', 'wt', RULE))).toBe(true)
  })

  it('reports copies present in both rules/wt and rules-on-demand instead of choosing one', () => {
    const root = mkDir()
    const project = join(root, 'project')
    const config = join(root, 'config')
    const staticDir = join(config, 'rules', 'wt')
    const onDemandDir = join(config, 'rules-on-demand')
    mkdirSync(project, { recursive: true })
    run(['--set', 'rules', '--install'], staticDir)
    run(['--set', 'rules', '--install'], onDemandDir)
    addOnDemandFrontmatter(onDemandDir)
    const env = sealedPluginCliEnv(root, { CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin') })

    const result = runInCwdResult(['--set', 'rules', '--check', '--global'], project, env)
    expect(result.status).not.toBe(0)
    expect(result.out).toContain('DUPLICATE')
    expect(result.out).toContain(staticDir)
    expect(result.out).toContain(onDemandDir)
  })

  it('does not report a duplicate when rules-on-demand is a directory symlink to rules/wt', () => {
    const root = mkDir()
    const project = join(root, 'project')
    const config = join(root, 'config')
    const staticDir = join(config, 'rules', 'wt')
    const onDemandDir = join(config, 'rules-on-demand')
    mkdirSync(project, { recursive: true })
    run(['--set', 'rules', '--install'], staticDir)
    symlinkSync(staticDir, onDemandDir, 'dir')
    const env = sealedPluginCliEnv(root, { CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin') })

    const result = runInCwdResult(['--set', 'rules', '--check', '--global'], project, env)
    expect(result.status).toBe(0)
    expect(result.out).not.toContain('DUPLICATE')
    expect(result.out).toContain(`${RULE}: UP-TO-DATE`)
  })

  it('an explicit static install does not recreate a rule moved to sibling rules-on-demand', () => {
    const root = mkDir()
    const config = join(root, 'config')
    const staticDir = join(config, 'rules', 'wt')
    const onDemandDir = join(config, 'rules-on-demand')
    const moved = 'wt-memory-hygiene-at-act.md'
    run(['--set', 'rules', '--install'], staticDir)
    mkdirSync(onDemandDir, { recursive: true })
    renameSync(join(staticDir, moved), join(onDemandDir, moved))
    writeFileSync(join(onDemandDir, moved), ON_DEMAND_FRONTMATTER + readFileSync(join(onDemandDir, moved), 'utf8'))

    const result = runResult(['--set', 'rules', '--install'], staticDir)
    expect(result.status).not.toBe(0)
    expect(result.out).toContain(`${moved}: SKIPPED`)
    expect(result.out).toContain(onDemandDir)
    expect(existsSync(join(staticDir, moved))).toBe(false)
  })

  it('routes disjoint static and on-demand copies per file without a false duplicate', () => {
    const root = mkDir()
    const project = join(root, 'project')
    const config = join(root, 'config')
    const staticDir = join(config, 'rules', 'wt')
    const onDemandDir = join(config, 'rules-on-demand')
    const moved = 'wt-memory-hygiene-at-act.md'
    mkdirSync(project, { recursive: true })
    run(['--set', 'rules', '--install'], staticDir)
    mkdirSync(onDemandDir, { recursive: true })
    renameSync(join(staticDir, moved), join(onDemandDir, moved))
    writeFileSync(join(onDemandDir, moved), ON_DEMAND_FRONTMATTER + readFileSync(join(onDemandDir, moved), 'utf8'))
    const env = sealedPluginCliEnv(root, { CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin') })

    const checked = runInCwdResult(['--set', 'rules', '--check', '--global'], project, env)
    expect(checked.status).toBe(0)
    expect(checked.out).not.toContain('DUPLICATE')
    expect(checked.out).toContain(`[rules] target=${staticDir}`)
    expect(checked.out).toContain(`[rules] target=${onDemandDir}`)

    const installed = runInCwdResult(['--set', 'rules', '--install', '--global'], project, env)
    expect(installed.status).toBe(0)
    expect(existsSync(join(staticDir, moved))).toBe(false)
    expect(existsSync(join(onDemandDir, moved))).toBe(true)
  })

  it('deduplicates on-demand directories that are profile aliases of the same real directory', () => {
    const root = mkDir()
    const project = join(root, 'project')
    const home = join(root, 'home')
    const defaultConfig = join(home, '.claude')
    const activeConfig = join(home, '.claude-second')
    const target = join(defaultConfig, 'rules-on-demand')
    mkdirSync(project, { recursive: true })
    run(['--set', 'rules', '--install'], target)
    addOnDemandFrontmatter(target)
    mkdirSync(activeConfig, { recursive: true })
    symlinkSync(target, join(activeConfig, 'rules-on-demand'), 'dir')
    const env = sealedPluginCliEnv(root, {
      HOME: home,
      CLAUDE_CONFIG_DIR: activeConfig,
      CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin'),
    })

    const result = runInCwdResult(['--set', 'rules', '--install'], project, env)
    expect(result.status).toBe(0)
    expect(result.out).not.toContain('DUPLICATE')
    expect(existsSync(join(activeConfig, 'rules', 'wt', RULE))).toBe(false)
  })
})

// A STATIC rule the owner migrated into the sibling rules-on-demand dir, where it carries its own
// on-demand head, is served from there. Every mode must recognise it and never write a static copy
// back beside it: that copy would load the rule twice.
describe('adopt installer — static rule migrated to the sibling on-demand dir', () => {
  function migratedLayout(base: string): { staticDir: string; onDemandDir: string; migrated: string } {
    const staticDir = join(base, 'rules', 'wt')
    const onDemandDir = join(base, 'rules-on-demand')
    run(['--set', 'rules', '--install'], staticDir)
    run(['--set', 'rules', '--install'], onDemandDir)
    // As on a real profile: the spec-backed halves live on demand only, so nothing else loads twice.
    for (const file of readdirSync(onDemandDir).filter((name) => name.endsWith('.md'))) rmSync(join(staticDir, file), { force: true })
    const migrated = join(onDemandDir, RULE)
    renameSync(join(staticDir, RULE), migrated)
    writeFileSync(migrated, ON_DEMAND_FRONTMATTER + readFileSync(migrated, 'utf8'))
    return { staticDir, onDemandDir, migrated }
  }
  function expectRecognised(check: { status: number | null; out: string }) {
    expect(check.status, check.out).toBe(0)
    expect(check.out).toContain(`${RULE}: MIGRATED-ON-DEMAND`)
    expect(check.out).not.toContain(`${RULE}: ABSENT`)
  }
  function expectNotWritten(install: { status: number | null; out: string }, staticDir: string, migrated: string, before: string) {
    expect(install.status, install.out).toBe(0)
    expect(install.out).toContain(`${RULE}: SKIPPED — MIGRATED-ON-DEMAND`)
    expect(existsSync(join(staticDir, RULE))).toBe(false)
    expect(readFileSync(migrated, 'utf8')).toBe(before)
  }

  it('--global: check reports it migrated and install writes no static copy', () => {
    const root = mkDir()
    const project = join(root, 'project')
    mkdirSync(project, { recursive: true })
    const config = join(root, 'config')
    const { staticDir, migrated } = migratedLayout(config)
    const before = readFileSync(migrated, 'utf8')
    const env = sealedPluginCliEnv(root, { CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin') })

    expectRecognised(runInCwdResult(['--set', 'rules', '--check', '--global'], project, env))
    expectNotWritten(runInCwdResult(['--set', 'rules', '--install', '--global'], project, env), staticDir, migrated, before)
    expectNotWritten(runInCwdResult(['--set', 'rules', '--install', '--global', '--force'], project, env), staticDir, migrated, before)
    expectNotWritten(runInCwdResult(['--set', 'rules', '--install', '--global', '--file', RULE], project, env), staticDir, migrated, before)
    // Settings are written by now, so the only thing that could still ask for an install is the rule.
    const recheck = runInCwdResult(['--set', 'rules', '--check', '--global'], project, env)
    expectRecognised(recheck)
    expect(recheck.out).not.toContain('write the ABSENT')
  })

  it('--dir on the static dir: check reports it migrated and install writes no static copy', () => {
    const { staticDir, migrated } = migratedLayout(join(mkDir(), 'config'))
    const before = readFileSync(migrated, 'utf8')

    expectRecognised(runResult(['--set', 'rules', '--check'], staticDir))
    expectNotWritten(runResult(['--set', 'rules', '--install'], staticDir), staticDir, migrated, before)
    expectNotWritten(runResult(['--set', 'rules', '--install', '--file', RULE], staticDir), staticDir, migrated, before)
  })

  it('project level: check reports it migrated and install writes no static copy', () => {
    const root = mkDir()
    const project = join(root, 'project')
    const { staticDir, migrated } = migratedLayout(join(project, '.claude'))
    const before = readFileSync(migrated, 'utf8')
    const env = sealedPluginCliEnv(root, { CLAUDE_CONFIG_DIR: join(root, 'empty-config'), CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin') })

    expectRecognised(runInCwdResult(['--set', 'rules', '--check'], project, env))
    expectNotWritten(runInCwdResult(['--set', 'rules', '--install'], project, env), staticDir, migrated, before)
  })

  it('a project install never writes a static copy of a rule the config dir serves on demand', () => {
    const root = mkDir()
    const project = join(root, 'project')
    mkdirSync(project, { recursive: true })
    const config = join(root, 'config')
    const { migrated } = migratedLayout(config)
    const env = sealedPluginCliEnv(root, { CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin') })

    const install = runInCwdResult(['--set', 'rules', '--install'], project, env)
    expect(install.out).toContain(`${RULE}: SKIPPED — MIGRATED-ON-DEMAND (served from ${migrated}`)
    expect(existsSync(join(project, '.claude', 'rules', 'wt', RULE))).toBe(false)
  })

  it('--global through a profile whose rules dir is a symlink to another profile recognises that profile\'s migration', () => {
    const root = mkDir()
    const project = join(root, 'project')
    mkdirSync(project, { recursive: true })
    const { staticDir, migrated } = migratedLayout(join(root, 'first'))
    const second = join(root, 'second')
    mkdirSync(second, { recursive: true })
    symlinkSync(join(root, 'first', 'rules'), join(second, 'rules'), 'dir')
    const before = readFileSync(migrated, 'utf8')
    const env = sealedPluginCliEnv(root, { CLAUDE_CONFIG_DIR: second, CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin') })

    const check = runInCwdResult(['--set', 'rules', '--check', '--global'], project, env)
    expectRecognised(check)
    expect(check.out).toContain('so the rule is not loaded here')
    expectNotWritten(runInCwdResult(['--set', 'rules', '--install', '--global'], project, env), staticDir, migrated, before)
  })

  it('follows a linked rules directory whose wt subdirectory does not exist yet', () => {
    const root = mkDir()
    const first = join(root, 'first')
    mkdirSync(join(first, 'rules'), { recursive: true })
    mkdirSync(join(first, 'rules-on-demand'), { recursive: true })
    const migrated = join(first, 'rules-on-demand', RULE)
    writeFileSync(migrated, ON_DEMAND_FRONTMATTER + readFileSync(join(REPO_ROOT, 'plugin/rules', RULE), 'utf8'))
    const third = join(root, 'third')
    mkdirSync(third, { recursive: true })
    symlinkSync(join(first, 'rules'), join(third, 'rules'), 'dir')

    const check = runResult(['--set', 'rules', '--check'], join(third, 'rules', 'wt'))
    expect(check.out).toContain(`${RULE}: MIGRATED-ON-DEMAND (migrated to ${migrated}`)
  })

  it('refuses a --file that no set manages, whichever groups the implicit resolution builds', () => {
    const root = mkDir()
    const project = join(root, 'project')
    mkdirSync(project, { recursive: true })
    const config = join(root, 'config')
    const { staticDir } = migratedLayout(config)
    const env = sealedPluginCliEnv(root, { CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin') })

    const install = runInCwdResult(['--set', 'rules', '--install', '--global', '--file', 'no-such-rule.md'], project, env)
    expect(install.status).not.toBe(0)
    expect(install.out).toContain('--file is not managed by --set rules: no-such-rule.md')
    expect(existsSync(join(staticDir, 'no-such-rule.md'))).toBe(false)
  })

  it('recognises a migrated copy without an adoption banner, as the on-demand side does', () => {
    const { staticDir, onDemandDir, migrated } = migratedLayout(join(mkDir(), 'config'))
    writeFileSync(migrated, ON_DEMAND_FRONTMATTER + readFileSync(join(REPO_ROOT, 'plugin/rules', RULE), 'utf8'))
    const before = readFileSync(migrated, 'utf8')

    expect(runResult(['--set', 'rules', '--check'], onDemandDir).out).toContain(`${RULE}: ON-DEMAND`)
    expectRecognised(runResult(['--set', 'rules', '--check'], staticDir))
    expectNotWritten(runResult(['--set', 'rules', '--install'], staticDir), staticDir, migrated, before)
  })

  it('a sibling copy WITHOUT its own on-demand head is not taken for a migration', () => {
    const { staticDir, onDemandDir, migrated } = migratedLayout(join(mkDir(), 'config'))
    writeFileSync(migrated, readFileSync(migrated, 'utf8').slice(ON_DEMAND_FRONTMATTER.length))

    const check = runResult(['--set', 'rules', '--check'], staticDir)
    expect(check.out).not.toContain('MIGRATED-ON-DEMAND')
    expect(check.out).toContain(`${RULE}: ABSENT`)
    expect(runResult(['--set', 'rules', '--check'], onDemandDir).out).toContain(`${RULE}: MISPLACED`)
  })

  it('a copy present in BOTH dirs is still reported, never hidden as a migration', () => {
    const base = mkDir()
    const { staticDir, migrated } = migratedLayout(join(base, 'config'))
    const scratch = join(base, 'scratch', 'rules', 'wt')
    run(['--set', 'rules', '--install', '--file', RULE], scratch)
    cpSync(join(scratch, RULE), join(staticDir, RULE))
    expect(existsSync(migrated)).toBe(true)

    const install = runResult(['--set', 'rules', '--install'], staticDir)
    expect(install.out).not.toContain('MIGRATED-ON-DEMAND')
    expect(install.out).toContain(`${RULE}: SKIPPED — DUPLICATE`)
    expect(install.status).not.toBe(0)
  })
})

describe('adopt installer — spec-backed on-demand trigger heads', () => {
  it.each([
    '<!-- installed from workflow-toolbox v0.189.1 · content sha256:f3eafead0d07 head sha256:735fd0df79d7 by the adopt skill kept sha256:735fd0df79d7 spec sha256:943497e58261 by the adopt skill — editable copy. -->',
    ' <!-- installed from workflow-toolbox v0.0.1 · content sha256:d32f269f3009 head sha256:735fd0df79d7 by the adopt skill — editable copy. -->',
    ' <!-- installed from workflow-toolbox v0.189.1 by the adopt skill — editable copy. -->',
  ])('rejects the review banner verbatim on check and two plain installs: %s', (banner) => {
    const { dir, file } = actFixture()
    const text = readFileSync(file, 'utf8').replace('  triggers:', '  triggers: # LOCAL')
    const line = text.slice(installedHead(text).length).split('\n')[0] ?? ''
    writeFileSync(file, text.replace(line, banner))
    const head = installedHead(text)
    expect(run(['--set', 'rules', '--check'], dir)).toContain('on-demand triggers unresolved (unverified)')
    for (let i = 0; i < 2; i++) {
      run(['--set', 'rules', '--install', '--file', ACT], dir)
      expect(installedHead(readFileSync(file, 'utf8'))).toBe(head)
      expect(run(['--set', 'rules', '--check'], dir)).toContain('on-demand triggers unresolved (unverified)')
    }
  })

  it('treats duplicated provenance tokens as unverified and never overwrites a local head', () => {
    const { dir, file, head } = actFixture()
    run(['--set', 'rules', '--install', '--file', ACT], dir)
    const edited = readFileSync(file, 'utf8').replace('  triggers:', '  triggers: # LOCAL')
    const bad = edited.replace(`head sha256:${headFp(head)} by the adopt skill`,
      `kept sha256:${headFp(installedHead(edited))} spec sha256:${headFp(head)} content sha256:f3eafead0d07 head sha256:${headFp(installedHead(edited))} by the adopt skill`)
    writeFileSync(file, bad)
    expect(run(['--set', 'rules', '--check'], dir)).toContain('on-demand triggers unresolved (unverified)')
    run(['--set', 'rules', '--install', '--file', ACT], dir)
    expect(installedHead(readFileSync(file, 'utf8'))).toBe(installedHead(edited))
  })

  it.each([
    ['head plus kept (review #1)', (line: string) => line.replace(' by the adopt skill', ' kept sha256:735fd0df79d7 spec sha256:943497e58261 by the adopt skill')],
    ['leading space (review #2)', (line: string) => ` ${line}`],
    ['pre-fingerprint leading space (review #3)', (line: string) => ` ${line.replace(/ · content sha256:[0-9a-f]{12}/, '').replace(/ head sha256:[0-9a-f]{12}/, '')}`],
    ['trailing space', (line: string) => `${line} `],
    ['duplicate head', (line: string) => line.replace(' by the adopt skill', ' head sha256:735fd0df79d7 by the adopt skill')],
    ['duplicate content', (line: string) => line.replace(' head sha256:', ' · content sha256:f3eafead0d07 head sha256:')],
    ['reordered fields', (line: string) => line.replace(/ · content sha256:([0-9a-f]{12}) head sha256:([0-9a-f]{12})/, ' head sha256:$2 · content sha256:$1')],
    ['head then kept', (line: string) => line.replace(' by the adopt skill', ' kept sha256:735fd0df79d7 spec sha256:943497e58261 by the adopt skill')],
    ['second by the adopt skill', (line: string) => line.replace(' by the adopt skill', ' by the adopt skill kept sha256:735fd0df79d7 spec sha256:943497e58261 by the adopt skill')],
    ['trailing text', (line: string) => `${line} EXTRA`],
    ['CRLF banner line', (line: string) => `${line}\r`],
    ['truncated head hash', (line: string) => line.replace(/head sha256:([0-9a-f]{12})/, (_m, h: string) => `head sha256:${h.slice(0, 11)}`)],
  ])('rejects mutated banner provenance: %s, including after two body refreshes', (_label, mutate) => {
    const { dir, file } = actFixture()
    run(['--set', 'rules', '--install', '--file', ACT], dir)
    const initial = readFileSync(file, 'utf8')
    const local = initial.replace('  triggers:', '  triggers: # LOCAL')
    const line = local.slice(installedHead(local).length).split('\n')[0] ?? ''
    const olderBody = readFileSync(join(REPO_ROOT, 'plugin/rules', ACT), 'utf8') + '\nOLD BODY\n'
    const changed = local.replace(line, mutate(line.replace(/head sha256:[0-9a-f]{12}/, `head sha256:${headFp(installedHead(local))}`)))
      .replace(/content sha256:[0-9a-f]{12}/, `content sha256:${headFp(olderBody)}`)
      .replace(/v\d+\.\d+\.\d+/, 'v0.0.1')
      .replace(readFileSync(join(REPO_ROOT, 'plugin/rules', ACT), 'utf8'), olderBody)
    writeFileSync(file, changed)
    const head = installedHead(changed)
    const args = ['--set', 'rules', '--install', '--file', ACT]
    expect(run(['--set', 'rules', '--check'], dir)).toContain('on-demand triggers unresolved (unverified)')
    for (let i = 0; i < 2; i++) {
      run(args, dir)
      expect(installedHead(readFileSync(file, 'utf8'))).toBe(head)
      expect(run(['--set', 'rules', '--check'], dir)).toContain('on-demand triggers unresolved (unverified)')
    }
  })

  it('an accepted kept head is visible on an otherwise current or stale body status', () => {
    const { dir, file } = actFixture()
    writeFileSync(file, readFileSync(file, 'utf8').replace('  triggers:', '  triggers: # LOCAL'))
    run(['--set', 'rules', '--install', '--keep-triggers', '--file', ACT], dir)
    const note = ` · on-demand triggers kept locally (against ${ACT.replace('.md', '.spec.json')})`
    expect(run(['--set', 'rules', '--check'], dir)).toContain(`${ACT}: UP-TO-DATE`)
    expect(run(['--set', 'rules', '--check'], dir)).toContain(note)
    const olderBody = readFileSync(join(REPO_ROOT, 'plugin/rules', ACT), 'utf8') + '\nOLD BODY\n'
    writeFileSync(file, readFileSync(file, 'utf8').replace(/content sha256:[0-9a-f]{12}/, `content sha256:${headFp(olderBody)}`)
      .replace(/v\d+\.\d+\.\d+/, 'v0.0.1').replace(readFileSync(join(REPO_ROOT, 'plugin/rules', ACT), 'utf8'), olderBody))
    const checked = run(['--set', 'rules', '--check'], dir)
    expect(checked).toContain(`${ACT}: STALE`)
    expect(checked).toContain(note)
  })

  it('still reports trigger findings on a duplicate and accepts a head-only remedy at that explicit file', () => {
    const root = mkDir()
    const flat = join(root, 'rules')
    const nested = join(flat, 'wt')
    run(['--set', 'rules', '--install'], flat)
    const file = join(flat, ACT)
    writeFileSync(file, specHead() + readFileSync(file, 'utf8'))
    run(['--set', 'rules', '--install', '--file', ACT], flat)
    writeFileSync(file, readFileSync(file, 'utf8').replace('  triggers:', '  triggers: # LOCAL'))
    mkdirSync(nested)
    cpSync(file, join(nested, ACT))
    const check = run(['--set', 'rules', '--check'], flat)
    expect(check).toContain(`${ACT}: DUPLICATE`)
    expect(check).toContain('on-demand triggers unresolved')
    expect(runResult(['--set', 'rules', '--install', '--refresh-triggers', '--file', ACT], flat).status).toBe(0)
    expect(installedHead(readFileSync(file, 'utf8'))).toBe(specHead())
    expect(run(['--set', 'rules', '--check'], nested)).toContain('on-demand triggers unresolved')
  })

  it('head-only commands work on a pre-fingerprint banner and later spec changes refresh the accepted shipped head', () => {
    const { dir, file } = actFixture()
    const copy = copiedPlugin()
    writeFileSync(file, readFileSync(file, 'utf8').replace(/ · content sha256:[0-9a-f]{12}/, '').replace('  triggers:', '  triggers: # LOCAL'))
    expect(runCopied(copy.script, ['--install', '--keep-triggers', '--file', ACT], dir)).toContain('TRIGGERS KEPT')
    expect(runCopied(copy.script, ['--check'], dir)).not.toContain('on-demand triggers unresolved')
    expect(runCopied(copy.script, ['--install', '--refresh-triggers', '--file', ACT], dir)).toContain('TRIGGERS REFRESHED')
    const spec = JSON.parse(readFileSync(copy.spec, 'utf8'))
    spec['on-demand'].triggers.push({ kind: 'tool', tool: '^NewTool$' })
    writeFileSync(copy.spec, JSON.stringify(spec))
    expect(runCopied(copy.script, ['--check'], dir)).toContain('on-demand triggers behind the shipped spec')
    expect(runCopied(copy.script, ['--install', '--file', ACT], dir)).toContain('TRIGGERS REFRESHED')
    expect(installedHead(readFileSync(file, 'utf8'))).toBe(renderShippedHead(spec))
  })

  it('canonicalizes a leading-space pre-fingerprint banner on explicit keep and refresh', () => {
    const { dir, file } = actFixture()
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^<!-- installed/m, ' <!-- installed')
      .replace(/ · content sha256:[0-9a-f]{12}/, '').replace('  triggers:', '  triggers: # LOCAL'))
    expect(run(['--set', 'rules', '--install', '--keep-triggers', '--file', ACT], dir)).toContain('TRIGGERS KEPT')
    expect(run(['--set', 'rules', '--check'], dir)).not.toContain('on-demand triggers unresolved')
    expect(readFileSync(file, 'utf8').slice(installedHead(readFileSync(file, 'utf8')).length)).toMatch(/^<!-- installed/)
    expect(run(['--set', 'rules', '--install', '--refresh-triggers', '--file', ACT], dir)).toContain('TRIGGERS REFRESHED')
    expect(run(['--set', 'rules', '--check'], dir)).not.toContain('on-demand triggers unresolved')
  })

  it('restamps a current head with an old valid stamp before the next spec change', () => {
    const { dir, file } = actFixture()
    const copy = copiedPlugin()
    runCopied(copy.script, ['--install', '--file', ACT], dir)
    const spec = JSON.parse(readFileSync(copy.spec, 'utf8'))
    spec['on-demand'].triggers.push({ kind: 'tool', tool: '^NewTool$' })
    writeFileSync(copy.spec, JSON.stringify(spec))
    const before = readFileSync(file, 'utf8')
    writeFileSync(file, renderShippedHead(spec) + before.slice(installedHead(before).length))
    expect(runCopied(copy.script, ['--install', '--file', ACT], dir)).toContain('TRIGGERS ENROLLED')
    spec['on-demand'].triggers.push({ kind: 'tool', tool: '^AnotherTool$' })
    writeFileSync(copy.spec, JSON.stringify(spec))
    expect(runCopied(copy.script, ['--install', '--file', ACT], dir)).toContain('TRIGGERS REFRESHED')
  })

  it('reports resolved status on head-only and body+head writes', () => {
    const { dir, file } = actFixture()
    writeFileSync(file, readFileSync(file, 'utf8').replace('  triggers:', '  triggers: # LOCAL'))
    const resolved = run(['--set', 'rules', '--install', '--refresh-triggers', '--file', ACT], dir)
    expect(resolved).toContain('TRIGGERS REFRESHED')
    expect(resolved.split('\n').find((line) => line.includes(`${ACT}:`))).not.toContain('on-demand triggers unresolved')
  })
  it('reports a resolved head after simultaneous body and head refresh, including keep and automatic refresh', () => {
    const { dir, file } = actFixture()
    const copy = copiedPlugin()
    runCopied(copy.script, ['--install', '--file', ACT], dir)
    const spec = JSON.parse(readFileSync(copy.spec, 'utf8'))
    spec['on-demand'].triggers.push({ kind: 'tool', tool: '^NewTool$' })
    writeFileSync(copy.spec, JSON.stringify(spec))
    const olderBody = readFileSync(join(REPO_ROOT, 'plugin/rules', ACT), 'utf8') + '\nOLD BODY\n'
    writeFileSync(file, readFileSync(file, 'utf8').replace(/content sha256:[0-9a-f]{12}/, `content sha256:${headFp(olderBody)}`)
      .replace(/v\d+\.\d+\.\d+/, 'v0.0.1').replace(readFileSync(join(REPO_ROOT, 'plugin/rules', ACT), 'utf8'), olderBody))
    const refreshed = runCopied(copy.script, ['--install', '--file', ACT], dir).split('\n').find((line) => line.includes(`${ACT}:`)) ?? ''
    expect(refreshed).toContain('REFRESHED')
    expect(refreshed).toContain('on-demand triggers refreshed from shipped spec')
    expect(refreshed).not.toContain('behind the shipped spec')
    writeFileSync(file, readFileSync(file, 'utf8').replace('  triggers:', '  triggers: # LOCAL'))
    const kept = runCopied(copy.script, ['--install', '--keep-triggers', '--file', ACT], dir).split('\n').find((line) => line.includes(`${ACT}:`)) ?? ''
    expect(kept).toContain('TRIGGERS KEPT')
    expect(kept).toContain('on-demand triggers accepted local head')
    expect(kept).not.toContain('on-demand triggers unresolved')
    const afterKeep = runCopied(copy.script, ['--install', '--file', ACT], dir)
    expect(afterKeep).not.toContain('behind the shipped spec')
  })
  it('renders all shipped specs byte-for-byte like the lifecycle renderer', () => {
    const copy = copiedPlugin()
    for (const name of readdirSync(join(REPO_ROOT, 'plugin/rules')).filter((n) => n.endsWith('-at-act.spec.json'))) {
      const spec = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin/rules', name), 'utf8'))
      const dir = join(mkDir(), 'rules-on-demand')
      run(['--set', 'rules', '--install'], dir)
      const rule = name.replace('.spec.json', '.md')
      const file = join(dir, rule)
      writeFileSync(file, renderShippedHead(spec) + readFileSync(file, 'utf8'))
      runCopied(copy.script, ['--install', '--file', rule], dir)
      expect(installedHead(readFileSync(file, 'utf8')), name).toBe(renderShippedHead(spec))
      spec['on-demand'].triggers.push({ kind: 'tool', tool: '^NewTool$' })
      writeFileSync(join(copy.script, '../../../..', 'rules', name), JSON.stringify(spec))
      runCopied(copy.script, ['--install', '--file', rule], dir)
      expect(installedHead(readFileSync(file, 'utf8')), `${name} after spec change`).toBe(renderShippedHead(spec))
    }
  })

  it('enrolls a matching head and refreshes it after a real shipped spec change, leaving the body and banner fingerprint intact', () => {
    const { dir, file, head } = actFixture()
    const copy = copiedPlugin()
    expect(runCopied(copy.script, ['--install', '--file', ACT], dir)).toContain('TRIGGERS ENROLLED')
    const before = readFileSync(file, 'utf8')
    expect(before).toContain(`head sha256:${headFp(head)}`)
    const spec = JSON.parse(readFileSync(copy.spec, 'utf8'))
    spec['on-demand'].triggers.push({ kind: 'tool', tool: '^NewTool$' })
    writeFileSync(copy.spec, JSON.stringify(spec))
    expect(runCopied(copy.script, ['--check'], dir)).toContain(`${ACT}: STALE (on-demand triggers behind the shipped spec`)
    expect(runCopied(copy.script, ['--install', '--file', ACT], dir)).toContain('TRIGGERS REFRESHED (head only')
    const after = readFileSync(file, 'utf8')
    expect(installedHead(after)).toBe(renderShippedHead(spec))
    expect(withoutHeadStamp(after.slice(installedHead(after).length))).toBe(withoutHeadStamp(before.slice(head.length)))
    expect(runCopied(copy.script, ['--check'], dir)).toContain(`${ACT}: UP-TO-DATE`)
  })

  it('refreshes a stale head even with an edited body, without changing the body or its banner version', () => {
    const { dir, file } = actFixture()
    const copy = copiedPlugin()
    runCopied(copy.script, ['--install', '--file', ACT], dir)
    const spec = JSON.parse(readFileSync(copy.spec, 'utf8'))
    spec['on-demand'].triggers.push({ kind: 'tool', tool: '^NewTool$' })
    writeFileSync(copy.spec, JSON.stringify(spec))
    writeFileSync(file, readFileSync(file, 'utf8') + '\nLOCAL BODY EDIT\n')
    const before = readFileSync(file, 'utf8')
    expect(runCopied(copy.script, ['--install', '--file', ACT], dir)).toContain('TRIGGERS REFRESHED (head only')
    expect(withoutHeadStamp(readFileSync(file, 'utf8').slice(installedHead(readFileSync(file, 'utf8')).length))).toBe(withoutHeadStamp(before.slice(installedHead(before).length)))
    expect(runCopied(copy.script, ['--check'], dir)).toContain(`${ACT}: EDITED`)
  })

  it('reports edited and unverified heads with exact remedies and preserves their stamps through a stale-body refresh', () => {
    for (const stamped of [true, false]) {
      const { dir, file, head } = actFixture()
      if (stamped) run(['--set', 'rules', '--install', '--file', ACT], dir)
      const changed = readFileSync(file, 'utf8').replace('  triggers:', '  triggers: # LOCAL')
      writeFileSync(file, changed)
      const check = run(['--set', 'rules', '--check'], dir)
      expect(check).toContain('on-demand triggers unresolved')
      for (const flag of ['refresh', 'keep']) {
        expect(check).toContain(`node ${remedyWord(SCRIPT)} --set rules --install --${flag}-triggers --file ${remedyWord(ACT)} --dir ${remedyWord(dir)}`)
      }
      const oldHead = installedHead(changed)
      const oldStamp = stamped ? `head sha256:${headFp(head)}` : null
      const agedBody = readFileSync(join(REPO_ROOT, 'plugin/rules', ACT), 'utf8') + '\nOLDER TEXT\n'
      const bodyFp = headFp(agedBody)
      writeFileSync(file, changed.replace(/content sha256:[0-9a-f]{12}/, `content sha256:${bodyFp}`).replace(/v\d+\.\d+\.\d+/, 'v0.0.1').replace(readFileSync(join(REPO_ROOT, 'plugin/rules', ACT), 'utf8'), agedBody))
      expect(run(['--set', 'rules', '--install', '--file', ACT], dir)).toContain('on-demand triggers unresolved')
      const after = readFileSync(file, 'utf8')
      expect(installedHead(after)).toBe(oldHead)
      if (oldStamp) expect(after).toContain(oldStamp)
      expect(after).not.toContain('OLDER TEXT')
      expect(run(['--set', 'rules', '--check'], dir)).toContain('on-demand triggers unresolved')
    }
  })

  it('explicit refresh and keep are head-only; a changed spec reopens an accepted keep', () => {
    const { dir, file } = actFixture()
    writeFileSync(file, readFileSync(file, 'utf8').replace('  triggers:', '  triggers: # LOCAL') + '\nBODY EDIT\n')
    const before = readFileSync(file, 'utf8')
    expect(run(['--set', 'rules', '--install', '--keep-triggers', '--file', ACT], dir)).toContain('TRIGGERS KEPT (head only')
    expect(installedHead(readFileSync(file, 'utf8'))).toBe(installedHead(before))
    expect(run(['--set', 'rules', '--check'], dir)).not.toContain('on-demand triggers unresolved')
    const copy = copiedPlugin()
    const spec = JSON.parse(readFileSync(copy.spec, 'utf8'))
    spec['on-demand'].triggers.push({ kind: 'tool', tool: '^NewTool$' })
    writeFileSync(copy.spec, JSON.stringify(spec))
    expect(runCopied(copy.script, ['--check'], dir)).toContain('on-demand triggers unresolved')
    expect(runCopied(copy.script, ['--install', '--refresh-triggers', '--file', ACT], dir)).toContain('TRIGGERS REFRESHED (head only')
    const after = readFileSync(file, 'utf8')
    expect(withoutHeadStamp(after.slice(installedHead(after).length))).toBe(withoutHeadStamp(before.slice(installedHead(before).length)))
    expect(runCopied(copy.script, ['--check'], dir)).toContain(`${ACT}: EDITED`)
  })

  it('--force takes both shipped body and head; flags refuse invalid combinations or targets', () => {
    const { dir, file, head } = actFixture()
    writeFileSync(file, readFileSync(file, 'utf8').replace('  triggers:', '  triggers: # LOCAL') + '\nBODY EDIT\n')
    expect(runResult(['--set', 'rules', '--install', '--force', '--keep-triggers', '--file', ACT], dir).status).not.toBe(0)
    for (const args of [
      ['--install', '--refresh-triggers'], ['--check', '--refresh-triggers', '--file', ACT],
      ['--install', '--refresh-triggers', '--file', RULE],
    ]) expect(runResult(['--set', 'rules', ...args], dir).status).not.toBe(0)
    expect(run(['--set', 'rules', '--install', '--force', '--file', ACT], dir)).toContain('OVERWROTE')
    expect(installedHead(readFileSync(file, 'utf8'))).toBe(head)
    expect(readFileSync(file, 'utf8')).not.toContain('BODY EDIT')
  })

  it('head-only journal entries cannot replace the previous body baseline for --diff', () => {
    const { dir, file } = actFixture()
    run(['--set', 'rules', '--install', '--file', ACT], dir)
    run(['--set', 'rules', '--install', '--keep-triggers', '--file', ACT], dir)
    const entries = readFileSync(join(dir, '.workflow-toolbox-adopt-journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(entries.at(-1).action).toBe('TRIGGERS KEPT')
    expect(entries.at(-1)).not.toHaveProperty('adoptedText')
    entries.at(-1).adoptedText = 'HEAD ONLY SENTINEL MUST NEVER BE BASELINE'
    writeFileSync(join(dir, '.workflow-toolbox-adopt-journal.jsonl'), entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    writeFileSync(file, readFileSync(file, 'utf8') + '\nBODY EDIT\n')
    const adopted = run(['--set', 'rules', '--diff', ACT], dir).split('=== LOCAL')[0]
    expect(adopted).toContain(readFileSync(join(REPO_ROOT, 'plugin/rules', ACT), 'utf8'))
    expect(adopted).not.toContain('[unavailable:')
    expect(adopted).not.toContain('HEAD ONLY SENTINEL MUST NEVER BE BASELINE')
  })

  it('treats CRLF-converted heads as current and prints a head diff for divergent heads', () => {
    const { dir, file } = actFixture()
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, installedHead(original).replace(/\n/g, '\r\n') + original.slice(installedHead(original).length))
    expect(run(['--set', 'rules', '--check'], dir)).not.toContain('on-demand triggers unresolved')
    writeFileSync(file, readFileSync(file, 'utf8').replace('  triggers:', '  triggers: # LOCAL'))
    expect(run(['--set', 'rules', '--diff', ACT], dir)).toContain('=== SHIPPED TRIGGERS')
  })
})

describe('adopt installer — omitted --dir resolves existing adoption level', () => {
  it('bare --check preserves migration reporting when flat rules and rules/wt are disjoint', () => {
    const root = mkDir()
    const project = join(root, 'project')
    const flat = join(project, '.claude', 'rules')
    const wt = join(flat, 'wt')
    const moved = 'wt-memory-hygiene.md'
    mkdirSync(project, { recursive: true })
    run(['--set', 'rules', '--install'], flat)
    mkdirSync(wt)
    renameSync(join(flat, moved), join(wt, moved))
    const env = sealedPluginCliEnv(root, { CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin') })

    const result = runInCwdResult(['--set', 'rules', '--check'], project, env)
    expect(result.status).toBe(0)
    expect(result.out).not.toContain('DUPLICATE adopted targets')
    expect(result.out).toContain(`${RULE}: MIGRATION-PENDING`)
    expect(result.out).toContain(`${moved}: UP-TO-DATE`)
  })

  it('legacy-only --install --global reports migration pending instead of refreshing the flat directory', () => {
    const root = mkDir()
    const project = join(root, 'project')
    const config = join(root, 'config')
    const flat = join(config, 'rules')
    const wt = join(flat, 'wt')
    mkdirSync(project, { recursive: true })
    run(['--set', 'rules', '--install'], flat)
    const before = readFileSync(join(flat, RULE), 'utf8')
    const env = sealedPluginCliEnv(root, { CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin') })

    const result = runInCwdResult(['--set', 'rules', '--install', '--global'], project, env)
    expect(result.status).toBe(0)
    expect(result.out).toContain(`${RULE}: SKIPPED — MIGRATION-PENDING`)
    expect(readFileSync(join(flat, RULE), 'utf8')).toBe(before)
    expect(existsSync(join(wt, RULE))).toBe(false)
  })

  it('refreshes the one existing config-dir copy instead of creating a project duplicate', () => {
    const root = mkDir()
    const project = join(root, 'project')
    const home = join(root, 'home')
    const config = join(home, '.claude-work')
    const target = join(config, 'rules', 'wt')
    mkdirSync(project, { recursive: true })
    const env = sealedPluginCliEnv(root, { HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin') })
    expect(runResult(['--set', 'rules', '--install'], target).status).toBe(0)
    ageRuleCopy(join(target, RULE))

    const res = runInCwdResult(['--set', 'rules', '--install'], project, env)
    expect(res.status).toBe(0)
    expect(res.out).toContain(`[rules] target=${target}`)
    expect(res.out).toContain(`${RULE}: REFRESHED`)
    expect(existsSync(join(project, '.claude', 'rules', 'wt', RULE))).toBe(false)
  })

  it('refuses to guess between project and config-dir copies and names both levels', () => {
    const root = mkDir()
    const project = join(root, 'project')
    const home = join(root, 'home')
    const config = join(home, '.claude-work')
    const projectTarget = join(project, '.claude', 'rules', 'wt')
    const configTarget = join(config, 'rules', 'wt')
    mkdirSync(project, { recursive: true })
    const env = sealedPluginCliEnv(root, { HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin') })
    expect(runResult(['--set', 'rules', '--install'], projectTarget).status).toBe(0)
    expect(runResult(['--set', 'rules', '--install'], configTarget).status).toBe(0)

    const res = runInCwdResult(['--set', 'rules', '--install'], project, env)
    expect(res.status).not.toBe(0)
    expect(res.out).toContain(`project real directory: ${projectTarget}`)
    expect(res.out).toContain(`config real directory: ${configTarget}`)
    expect(res.out).toContain('refusing to guess; pass --dir')
  })

  it('lists default and active config paths separately, including a symlinked profile', () => {
    const root = mkDir()
    const project = join(root, 'project')
    const home = join(root, 'home')
    const defaultConfig = join(home, '.claude')
    const linkedConfig = join(home, '.claude-work')
    const realTarget = join(defaultConfig, 'rules', 'wt')
    const linkedTarget = join(linkedConfig, 'rules', 'wt')
    mkdirSync(project, { recursive: true })
    expect(runResult(['--set', 'rules', '--install'], realTarget).status).toBe(0)
    symlinkSync(defaultConfig, linkedConfig, 'dir')
    const env = sealedPluginCliEnv(root, { HOME: home, CLAUDE_CONFIG_DIR: linkedConfig, CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin') })

    const res = runInCwdResult(['--set', 'rules', '--install'], project, env)
    expect(res.status).not.toBe(0)
    expect(res.out).toContain(`config real directory: ${realTarget}`)
    expect(res.out).toContain(`config symlinked directory -> ${realTarget}: ${linkedTarget}`)
  })
})

// The agent-copies set (--set agents) reuses the same engine (banner + fingerprint +
// EDITED/--force safety) but SOURCES its content from plugin/agent-templates/*.md at run
// time and places the banner AFTER the YAML frontmatter (an agent def must start with ---).
// The pilot suite lives in agent-templates/, NOT plugin/agents/ (which the plugin registers
// directly) — Claude Code silently ignores a plugin-installed agent's `observer:` field, so
// only an adopted project copy under a bare name gets the pilot-watchdog pairing. A project
// copy of these defs is what lets that pairing attach, so the copy must carry the source
// VERBATIM under its banner.
const AGENTS = ['pilot.md', 'pilot-watchdog.md', 'pilot-orchestrator.md']
const AGENTS_SRC_DIR = join(REPO_ROOT, 'plugin/agent-templates')
const agentPath = (dir: string, f: string) => join(dir, f)

// Independent re-derivation (NOT importing the engine): drop the banner comment line
// that sits just after the frontmatter, plus the single blank line before the body.
function stripInstalledAgentBanner(text: string): string {
  const fm = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)/.exec(text)
  const head = fm?.[1]
  if (head === undefined) return text
  const after = text.slice(head.length)
  const nl = after.indexOf('\n')
  const first = nl === -1 ? after : after.slice(0, nl)
  if (/installed from workflow-toolbox v\d+\.\d+\.\d+/.test(first)) {
    return head + after.slice(nl + 1).replace(/^\n/, '')
  }
  return text
}

describe('adopt installer — agent-copies set (--set agents; committed drift lock)', () => {
  it('ABSENT: --install writes each agent with an HTML banner AFTER the frontmatter (file still starts with ---)', () => {
    const d = mkDir()
    const chk = run(['--set', 'agents', '--check'], d)
    for (const f of AGENTS) expect(chk, `${f} should be ABSENT`).toContain(`${f}: ABSENT`)
    const out = run(['--set', 'agents', '--install'], d)
    for (const f of AGENTS) expect(out, `${f} should be WROTE`).toContain(`${f}: WROTE`)
    const body = readFileSync(agentPath(d, 'pilot.md'), 'utf8')
    // line 1 stays the frontmatter open — the banner is NOT line 1.
    expect(body.split('\n')[0]).toBe('---')
    // banner sits right after the closing frontmatter delimiter, carrying version + fingerprint.
    expect(body).toMatch(
      /^---\r?\n[\s\S]*?\r?\n---\r?\n<!-- installed from workflow-toolbox v\d+\.\d+\.\d+ · content sha256:[0-9a-f]{12}/,
    )
  })

  it('a fresh install is UP-TO-DATE for every agent (fingerprint round-trips through the frontmatter)', () => {
    const d = mkDir()
    run(['--set', 'agents', '--install'], d)
    const chk = run(['--set', 'agents', '--check'], d)
    for (const f of AGENTS) expect(chk).toContain(`${f}: UP-TO-DATE`)
  })

  it('the installed copy carries the plugin agent def VERBATIM under its banner (strip === source)', () => {
    const d = mkDir()
    run(['--set', 'agents', '--install'], d)
    for (const f of AGENTS) {
      const installed = readFileSync(agentPath(d, f), 'utf8')
      const source = readFileSync(join(AGENTS_SRC_DIR, f), 'utf8')
      expect(stripInstalledAgentBanner(installed), `${f}: stripped copy must equal the plugin source`).toBe(source)
    }
  })

  it('STALE unedited (older release, def has since changed): --install REFRESHES it', () => {
    const d = mkDir()
    run(['--set', 'agents', '--install'], d)
    const p = agentPath(d, 'pilot.md')
    // Age it into a copy from an older release whose def has since changed upstream: alter
    // the body, RESTAMP the fingerprint over the altered body (so it still reads as unedited
    // rather than as a user edit), and lower the banner version. Lowering the version alone
    // would no longer describe a stale copy at all — staleness tracks CONTENT.
    let text = readFileSync(p, 'utf8') + '\nA PARAGRAPH SINCE REWRITTEN UPSTREAM\n'
    const fp = createHash('sha256').update(stripInstalledAgentBanner(text), 'utf8').digest('hex').slice(0, 12)
    text = text
      .replace(/(installed from workflow-toolbox )v\d+\.\d+\.\d+/, '$1v0.0.1')
      .replace(/content sha256:[0-9a-f]{12}/, `content sha256:${fp}`)
    writeFileSync(p, text)
    expect(run(['--set', 'agents', '--check'], d)).toContain('pilot.md: STALE')
    expect(run(['--set', 'agents', '--install'], d)).toMatch(/pilot\.md: REFRESHED/)
    expect(run(['--set', 'agents', '--check'], d)).toContain('pilot.md: UP-TO-DATE')
    expect(readFileSync(p, 'utf8')).not.toContain('A PARAGRAPH SINCE REWRITTEN UPSTREAM')
  })

  it('EDITED (fingerprint mismatch) SURVIVES --install; overwritten ONLY with --force', () => {
    const d = mkDir()
    run(['--set', 'agents', '--install'], d)
    const p = agentPath(d, 'pilot.md')
    writeFileSync(p, readFileSync(p, 'utf8') + '\nMY LOCAL PILOT EDIT\n')
    expect(run(['--set', 'agents', '--check'], d)).toContain('pilot.md: EDITED')
    expect(run(['--set', 'agents', '--install'], d)).toContain('pilot.md: SKIPPED')
    expect(readFileSync(p, 'utf8'), 'edit must survive a plain --install').toContain('MY LOCAL PILOT EDIT')
    expect(run(['--set', 'agents', '--install', '--force'], d)).toMatch(/pilot\.md: OVERWROTE/)
    expect(readFileSync(p, 'utf8'), 'edit must be gone after --force').not.toContain('MY LOCAL PILOT EDIT')
  })

  it('hand-authored agent (frontmatter, no toolbox banner) is NEVER overwritten, even with --force', () => {
    const d = mkDir()
    const p = agentPath(d, 'pilot.md')
    writeFileSync(p, '---\nname: pilot\ndescription: my own hand-rolled pilot\n---\n\nMy own pilot body.\n')
    expect(run(['--set', 'agents', '--install', '--force'], d)).toContain('pilot.md: SKIPPED')
    expect(readFileSync(p, 'utf8')).toContain('My own pilot body.')
  })

  it('--check is read-only for the agents set: it writes nothing to disk', () => {
    const d = mkDir()
    run(['--set', 'agents', '--check'], d)
    for (const f of AGENTS) expect(existsSync(agentPath(d, f))).toBe(false)
  })

  it('old-format agent banner (version but NO fingerprint, after the frontmatter): conservative skip, --force overwrites', () => {
    const d = mkDir()
    // A managed-looking banner with NO `content sha256:`, placed AFTER the frontmatter —
    // exercises bannerLine()'s agent-specific (frontmatter-relative) extraction path.
    writeFileSync(
      agentPath(d, 'pilot.md'),
      '---\nname: pilot\ndescription: x\n---\n<!-- installed from workflow-toolbox v0.1.0 by the adopt skill -->\n\nold body\n',
    )
    expect(run(['--set', 'agents', '--check'], d)).toMatch(/pilot\.md:.*pre-fingerprint/)
    expect(run(['--set', 'agents', '--install'], d)).toContain('pilot.md: SKIPPED')
    expect(run(['--set', 'agents', '--install', '--force'], d)).toMatch(/pilot\.md: OVERWROTE/)
    expect(readFileSync(agentPath(d, 'pilot.md'), 'utf8')).toContain('content sha256:')
  })

  it('AHEAD/FORKED (installed version > plugin, differing unedited content): --install SKIPS it without --force', () => {
    const d = mkDir()
    run(['--set', 'agents', '--install'], d)
    const p = agentPath(d, 'pilot.md')
    let before = readFileSync(p, 'utf8') + '\nA FORKED FUTURE LINE\n'
    const fp = createHash('sha256').update(stripInstalledAgentBanner(before), 'utf8').digest('hex').slice(0, 12)
    before = before
      .replace(/(installed from workflow-toolbox )v\d+\.\d+\.\d+/, '$1v999.0.0')
      .replace(/content sha256:[0-9a-f]{12}/, `content sha256:${fp}`)
    writeFileSync(p, before)
    expect(run(['--set', 'agents', '--check'], d)).toContain('pilot.md: AHEAD/FORKED')
    expect(run(['--set', 'agents', '--install'], d)).toContain('pilot.md: SKIPPED')
    // untouched by a plain --install (still AHEAD, still v999)
    expect(readFileSync(p, 'utf8')).toContain('v999.0.0')
  })
})

// Frontmatter preservation across a re-adoption (card #1828669764516447496): a `--force`
// overwrite must not silently drop a LOCAL, single-line frontmatter field the shipped def
// does not itself define (the standing example is a `model:` pin — the visible mechanism a
// user controls delegation routing with). Positive sense: a pinned file keeps its pin AND the
// tool announces what it kept. Negative sense: a file with no local field stays silent — no
// noise on the common case.
describe('adopt installer — frontmatter preservation across --force (card #1828669764516447496)', () => {
  it('a locally-added `model:` pin SURVIVES a --force re-adoption, and the tool announces it', () => {
    const d = mkDir()
    run(['--set', 'agents', '--install'], d)
    const p = agentPath(d, 'pilot.md')
    const withPin = readFileSync(p, 'utf8').replace(/^(description:.*\n)/m, '$1model: sonnet\n')
    expect(withPin).toContain('model: sonnet')
    writeFileSync(p, withPin)

    // Plain --install must SKIP (EDITED), same contract as any other local edit.
    expect(run(['--set', 'agents', '--install'], d)).toContain('pilot.md: SKIPPED')
    expect(readFileSync(p, 'utf8')).toContain('model: sonnet')

    const out = run(['--set', 'agents', '--install', '--force'], d)
    expect(out).toMatch(/pilot\.md: OVERWROTE/)
    expect(out).toContain('pilot.md: PRESERVING local frontmatter field(s) not defined by the shipped def: model')
    const after = readFileSync(p, 'utf8')
    expect(after, 'the model pin must survive the forced overwrite').toContain('model: sonnet')
    // The pin sits INSIDE the frontmatter block, not dumped into the body.
    const frontmatter = after.split(/\r?\n---\r?\n/)[0] + '\n---\n'
    expect(frontmatter).toContain('model: sonnet')
  })

  // Card #1837055541864564170: the banner used to be stamped with the SHIPPED-ONLY content's
  // fingerprint, then the preserved field was spliced in AFTER — so a file the installer had
  // just written from its own template could never reproduce its own stamp. `--check`
  // immediately read it back as EDITED, permanently excluding it from every future `--install`
  // (only `--force` could touch it again, and `--force` re-created the same divergence).
  it('a preserved pin re-reads UP-TO-DATE immediately after the --force that wrote it (round trip)', () => {
    const d = mkDir()
    run(['--set', 'agents', '--install'], d)
    const p = agentPath(d, 'pilot.md')
    const withPin = readFileSync(p, 'utf8').replace(/^(description:.*\n)/m, '$1model: sonnet\n')
    writeFileSync(p, withPin)

    const out = run(['--set', 'agents', '--install', '--force'], d)
    expect(out).toMatch(/pilot\.md: OVERWROTE/)
    expect(out).toContain('pilot.md: PRESERVING local frontmatter field(s) not defined by the shipped def: model')

    // The install-then-check the card's definition of done names: the file the installer just
    // wrote, re-checked in the very next invocation.
    const check = run(['--set', 'agents', '--check'], d)
    expect(check, 'a copy the installer just wrote must read back UP-TO-DATE, not EDITED').toContain(
      'pilot.md: UP-TO-DATE',
    )
    expect(check).not.toContain('pilot.md: EDITED')
    // The pin itself must still be there — a passing check on an empty/truncated file would be
    // a false green.
    expect(readFileSync(p, 'utf8')).toContain('model: sonnet')
  })

  // Direction 2 of the round-trip lock: proves the fix did not simply blind the detector. A
  // genuine hand edit to the BODY (never touched by frontmatter preservation) must still read
  // EDITED after the fix, exactly as before it.
  it('a genuine body edit on a preserved-pin copy still reads EDITED (the fix does not blind the detector)', () => {
    const d = mkDir()
    run(['--set', 'agents', '--install'], d)
    const p = agentPath(d, 'pilot.md')
    const withPin = readFileSync(p, 'utf8').replace(/^(description:.*\n)/m, '$1model: sonnet\n')
    writeFileSync(p, withPin)
    run(['--set', 'agents', '--install', '--force'], d)
    expect(run(['--set', 'agents', '--check'], d)).toContain('pilot.md: UP-TO-DATE')

    // Now hand-edit the BODY of the freshly round-tripped, UP-TO-DATE copy.
    writeFileSync(p, readFileSync(p, 'utf8') + '\nA GENUINE HAND EDIT TO THE BODY\n')
    const check = run(['--set', 'agents', '--check'], d)
    expect(check, 'a real body edit must still be detected').toContain('pilot.md: EDITED')
    expect(check).not.toContain('pilot.md: UP-TO-DATE')
  })

  // Direction 3: staleness against a NEWER plugin release must still be detectable on a
  // preserved-pin copy — the fix must not make every future release read as "unchanged" just
  // because the banner now reproduces itself right after install.
  it('a preserved-pin copy installed at an older release is still detected STALE and refreshes', () => {
    const d = mkDir()
    run(['--set', 'agents', '--install'], d)
    const p = agentPath(d, 'pilot.md')
    const withPin = readFileSync(p, 'utf8').replace(/^(description:.*\n)/m, '$1model: sonnet\n')
    writeFileSync(p, withPin)
    run(['--set', 'agents', '--install', '--force'], d)
    expect(run(['--set', 'agents', '--check'], d)).toContain('pilot.md: UP-TO-DATE')

    // Simulate "this pin-carrying copy was installed at an older release": lower ONLY the
    // banner's version token — the stamped fingerprint stays self-consistent with the file's
    // own content, exactly like a copy genuinely installed under an earlier release and never
    // touched since.
    const before = readFileSync(p, 'utf8')
    writeFileSync(p, before.replace(/(installed from workflow-toolbox )v\d+\.\d+\.\d+/, '$1v0.0.1'))

    expect(run(['--set', 'agents', '--check'], d)).toMatch(/pilot\.md: STALE/)
    const out = run(['--set', 'agents', '--install'], d) // no --force: STALE always refreshes
    expect(out).toMatch(/pilot\.md: REFRESHED/)
    expect(run(['--set', 'agents', '--check'], d)).toContain('pilot.md: UP-TO-DATE')
  })

  it('a --force re-adoption on a file with NO local frontmatter field stays silent (no PRESERVING noise)', () => {
    const d = mkDir()
    run(['--set', 'agents', '--install'], d)
    const p = agentPath(d, 'pilot.md')
    // A body-only edit (no frontmatter change) — must still classify EDITED and overwrite
    // cleanly under --force, with no PRESERVING line since there is nothing local to carry.
    writeFileSync(p, readFileSync(p, 'utf8') + '\nMY LOCAL BODY EDIT\n')

    const out = run(['--set', 'agents', '--install', '--force'], d)
    expect(out).toMatch(/pilot\.md: OVERWROTE/)
    expect(out).not.toContain('PRESERVING')
    expect(readFileSync(p, 'utf8')).not.toContain('MY LOCAL BODY EDIT')
  })

  // Cross-family review finding (opencode gpt-5.6-terra, 27/07): a plain STALE refresh (no
  // --force, `clean` classification — the file was never locally edited, just installed from
  // an older release) must NOT run preservation. A key present only in that older, unedited
  // copy is a field the PLUGIN itself retired upstream, not something the user added — carrying
  // it forward would silently resurrect retired content on every routine refresh.
  it('a plain STALE refresh (unedited, older release) does NOT resurrect a field the plugin has since retired', () => {
    const d = mkDir()
    run(['--set', 'agents', '--install'], d)
    const p = agentPath(d, 'pilot.md')
    // Age the copy: append a frontmatter-shaped line the CURRENT shipped def does not define,
    // then restamp version+fingerprint over that content so it classifies as `clean` (unedited)
    // rather than `edited` — genuinely simulating "installed from an older release that used to
    // ship this field".
    const before = readFileSync(p, 'utf8')
    const aged = before.replace(/^(description:.*\n)/m, '$1retired-field: from-an-older-release\n')
    const fp = createHash('sha256').update(stripInstalledAgentBanner(aged), 'utf8').digest('hex').slice(0, 12)
    const restamped = aged
      .replace(/(installed from workflow-toolbox )v\d+\.\d+\.\d+/, '$1v0.0.1')
      .replace(/content sha256:[0-9a-f]{12}/, `content sha256:${fp}`)
    writeFileSync(p, restamped)
    expect(run(['--set', 'agents', '--check'], d)).toContain('pilot.md: STALE')

    const out = run(['--set', 'agents', '--install'], d) // no --force: STALE always refreshes
    expect(out).toMatch(/pilot\.md: REFRESHED/)
    expect(out).not.toContain('PRESERVING')
    expect(readFileSync(p, 'utf8')).not.toContain('retired-field')
  })

  // Second cross-family finding: a YAML block-scalar value (`notes: |`) followed by a BLANK
  // line before its own indented continuation must never be treated as a "simple" one-line
  // key — the naive next-line-only continuation check would preserve just the `notes: |`
  // header and silently drop the continuation, corrupting the field's meaning. The correct,
  // conservative behavior is to leave it alone entirely (same as any other multi-line field):
  // not preserved, not partially reproduced.
  it('a block-scalar (`notes: |`) frontmatter value followed by a blank continuation line is never partially preserved', () => {
    const d = mkDir()
    run(['--set', 'agents', '--install'], d)
    const p = agentPath(d, 'pilot.md')
    const withBlockScalar = readFileSync(p, 'utf8').replace(
      /^(description:.*\n)/m,
      '$1notes: |\n\n  continued after a blank line\n',
    )
    expect(withBlockScalar).toContain('notes: |')
    writeFileSync(p, withBlockScalar)
    expect(run(['--set', 'agents', '--check'], d)).toContain('pilot.md: EDITED')

    const out = run(['--set', 'agents', '--install', '--force'], d)
    expect(out).toMatch(/pilot\.md: OVERWROTE/)
    // Not preserved at all — neither the truncated header nor the continuation survives.
    expect(out).not.toContain('PRESERVING')
    const after = readFileSync(p, 'utf8')
    expect(after).not.toContain('notes: |')
    expect(after).not.toContain('continued after a blank line')
  })
})

describe('adopt installer — autonomy set (--set autonomy; committed drift lock)', () => {
  it('ABSENT: --install writes .claude/AUTONOMY.md with the rule-style versioned fingerprint banner', () => {
    const d = mkDir()
    expect(runInCwd(['--set', 'autonomy', '--check'], d)).toContain('AUTONOMY.md: ABSENT')
    const out = runInCwd(['--set', 'autonomy', '--install'], d)
    expect(out).toContain(`[autonomy] target=${join(d, '.claude')}`)
    expect(out).toContain('AUTONOMY.md: WROTE')
    const body = readFileSync(autonomyPath(d), 'utf8')
    expect(body).toMatch(/installed from workflow-toolbox v\d+\.\d+\.\d+/)
    expect(body).toMatch(/content sha256:[0-9a-f]{12}/)
  })

  it('a fresh autonomy install is UP-TO-DATE', () => {
    const d = mkDir()
    runInCwd(['--set', 'autonomy', '--install'], d)
    expect(runInCwd(['--set', 'autonomy', '--check'], d)).toContain('AUTONOMY.md: UP-TO-DATE')
  })

  it('EDITED autonomy content SURVIVES --install; overwritten ONLY with --force', () => {
    const d = mkDir()
    runInCwd(['--set', 'autonomy', '--install'], d)
    const p = autonomyPath(d)
    writeFileSync(p, readFileSync(p, 'utf8') + '\nMY LOCAL AUTONOMY EDIT\n')
    expect(runInCwd(['--set', 'autonomy', '--check'], d)).toContain('AUTONOMY.md: EDITED')
    expect(runInCwd(['--set', 'autonomy', '--install'], d)).toContain('AUTONOMY.md: SKIPPED')
    expect(readFileSync(p, 'utf8')).toContain('MY LOCAL AUTONOMY EDIT')
    expect(runInCwd(['--set', 'autonomy', '--install', '--force'], d)).toContain('AUTONOMY.md: OVERWROTE')
    expect(readFileSync(p, 'utf8')).not.toContain('MY LOCAL AUTONOMY EDIT')
  })
})

describe('adopt installer — CLI surface for the managed-set engine', () => {
  function untouchedSetLine(out: string): string | undefined {
    return out
      .split(/\r?\n/)
      .find((line) => line.includes('untouched here, and --set'))
  }

  it('--set all with --dir is rejected (a single dir cannot target multiple sets)', () => {
    const d = mkDir()
    // run() appends `--dir d`, so this is `--set all --check --dir d`.
    expect(run(['--set', 'all', '--check'], d)).toMatch(/--dir requires a single --set/)
  })

  it('an unknown --set value fails loudly', () => {
    const d = mkDir()
    expect(run(['--set', 'bogus', '--check'], d)).toMatch(/unknown --set/)
  })

  it('--set all SUCCESS path: one invocation installs ALL managed sets into their own default dirs', () => {
    const d = mkDir()
    const out = runInCwd(['--set', 'all', '--install'], d)
    // All sets processed, each into its own default subdir under the cwd.
    expect(out).toMatch(/\[rules\] target=.*[/\\]\.claude[/\\]rules/)
    expect(out).toMatch(/\[agents\] target=.*[/\\]\.claude[/\\]agents/)
    expect(out).toMatch(/\[autonomy\] target=.*[/\\]\.claude/)
    // The retired docs set is not processed and installs nothing.
    expect(out).not.toContain('[docs]')
    expect(existsSync(join(d, '.claude/docs'))).toBe(false)
    expect(out).toContain('wt-delegation-ladder.md: WROTE')
    expect(out).toContain('pilot.md: WROTE')
    expect(out).toContain('AUTONOMY.md: WROTE')
    expect(existsSync(join(d, '.claude/rules/wt/wt-delegation-ladder.md'))).toBe(true)
    for (const f of AGENTS) expect(existsSync(join(d, '.claude/agents', f))).toBe(true)
    expect(existsSync(autonomyPath(d))).toBe(true)
    // A re-check sees every item in every set as UP-TO-DATE (the loop ran end to end).
    const chk = runInCwd(['--set', 'all', '--check'], d)
    expect(chk).toContain('wt-delegation-ladder.md: UP-TO-DATE')
    expect(chk).toContain('pilot.md: UP-TO-DATE')
    expect(chk).toContain('AUTONOMY.md: UP-TO-DATE')
    expect(chk).toContain('nothing to do')
  })

  it('--set rules names the untouched agents, autonomy, and scripts sets, factually and in one line', () => {
    const d = mkDir()
    const out = run(['--set', 'rules', '--check'], d)
    const line = untouchedSetLine(out)
    expect(line).not.toContain('⚠')
    expect(line).not.toMatch(/\bshould\b/i)
    expect(line).toBe('adopt: the agents, autonomy, and scripts sets exist too; they were untouched here, and --set agents, --set autonomy, --set scripts covers them.')
  })

  it('--set agents names the untouched rules, autonomy, and scripts sets, factually and in one line', () => {
    const d = mkDir()
    const out = run(['--set', 'agents', '--check'], d)
    const line = untouchedSetLine(out)
    expect(line).not.toContain('⚠')
    expect(line).not.toMatch(/\bshould\b/i)
    expect(line).toBe('adopt: the rules, autonomy, and scripts sets exist too; they were untouched here, and --set rules, --set autonomy, --set scripts covers them.')
  })

  it('--set autonomy names the untouched rules, agents, and scripts sets, factually and in one line', () => {
    const d = mkDir()
    const out = runInCwd(['--set', 'autonomy', '--check'], d)
    const line = untouchedSetLine(out)
    expect(line).not.toContain('⚠')
    expect(line).not.toMatch(/\bshould\b/i)
    expect(line).toBe('adopt: the rules, agents, and scripts sets exist too; they were untouched here, and --set rules, --set agents, --set scripts covers them.')
  })

  it('--set docs is retired: it exits non-zero, says why, and writes nothing', () => {
    const d = mkDir()
    const result = runInCwdResult(['--set', 'docs', '--install'], d)
    expect(result.status).toBe(1)
    expect(result.out).toContain("the 'docs' set is retired")
    expect(result.out).toContain('may be deleted')
    expect(existsSync(join(d, '.claude'))).toBe(false)
  })

  it('--set all prints no untouched-set line at all', () => {
    const d = mkDir()
    const out = runInCwd(['--set', 'all', '--check'], d)
    expect(untouchedSetLine(out)).toBeUndefined()
  })
})

describe('adopt installer — scripts set', () => {
  it('installs a bannered standalone wt-lane launcher, detects local edits, and its help runs', () => {
    const d = mkDir()
    const out = run(['--set', 'scripts', '--install'], d)
    const installed = join(d, 'wt-lane.mjs')
    const installedWait = join(d, 'wt-lane-wait.mjs')
    expect(out).toContain('wt-lane.mjs: WROTE')
    expect(out).toContain('wt-lane-wait.mjs: WROTE')
    expect(readFileSync(installed, 'utf8').split('\n')[1]).toMatch(/^\/\/ installed from workflow-toolbox v\d+\.\d+\.\d+/)
    expect(readFileSync(installedWait, 'utf8')).not.toContain("from './lib/lane-supervisor-core.mjs'")
    expect(readFileSync(installedWait, 'utf8')).toContain('plugin is too old for this adopted waiter')
    expect(run(['--set', 'scripts', '--check'], d)).toContain('wt-lane.mjs: UP-TO-DATE')
    const help = spawnSync(process.execPath, [installed, '--help'], { encoding: 'utf8' })
    expect(help.status, help.stderr).toBe(0)
    const waitHelp = spawnSync(process.execPath, [installedWait, '--help'], { encoding: 'utf8', env: INSTALLER_ENV })
    expect(waitHelp.status, waitHelp.stderr).toBe(0)
    writeFileSync(installed, readFileSync(installed, 'utf8') + '\n// local edit\n')
    expect(run(['--set', 'scripts', '--check'], d)).toContain('wt-lane.mjs: EDITED')
  })

  it('an adopted launcher against a plugin root without the lane host module still answers --help and refuses a launch by name, never with a module error', () => {
    const d = mkDir()
    run(['--set', 'scripts', '--install'], d)
    // An installed plugin one release older: every runtime module except the lane host module.
    const olderRoot = mkDir()
    cpSync(join(REPO_ROOT, 'plugin', 'bin'), join(olderRoot, 'bin'), { recursive: true })
    rmSync(join(olderRoot, 'bin', 'lib', 'host', 'lane-host-dir.mjs'))
    // The older release's sandbox module predates the lane host module and does not import it.
    const sandboxModule = join(olderRoot, 'bin', 'lib', 'host', 'lane-sandbox.mjs')
    const importLine = "import { laneHostStateRoot } from './lane-host-dir.mjs'\n"
    expect(readFileSync(sandboxModule, 'utf8')).toContain(importLine)
    writeFileSync(sandboxModule, readFileSync(sandboxModule, 'utf8').replace(importLine, "const laneHostStateRoot = () => '/nonexistent/wt-lane-host'\n"))
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: olderRoot, WT_PLUGIN_ROOT: '' }
    const help = spawnSync(process.execPath, [join(d, 'wt-lane.mjs'), '--help'], { encoding: 'utf8', env })
    expect(help.stderr).not.toContain('ERR_MODULE_NOT_FOUND')
    expect(help.status, help.stderr).toBe(0)
    const brief = join(d, 'brief.md')
    writeFileSync(brief, '# brief\n')
    const launch = spawnSync(process.execPath, [join(d, 'wt-lane.mjs'), '--dir', d, '--model', 'openai/gpt-5.6-luna', '--brief', brief, '--allow-no-git'], { encoding: 'utf8', env })
    expect(launch.stderr).not.toContain('ERR_MODULE_NOT_FOUND')
    expect(launch.status).not.toBe(0)
    expect(launch.stderr).toMatch(/older or incompatible|unavailable/)
  })
})

// --global: target the CONFIG dir without anyone having to construct its path.
//
// WHY THIS EXISTS. Adopting into a config dir (rather than one project) is a supported,
// common shape, but the engine had no notion of one: the caller had to build the path and
// pass --dir. The skill's prose named the right source ("their CLAUDE_CONFIG_DIR rules dir")
// and then, one clause later, handed out a literal "typically ~/.claude/rules/" — and the
// literal is what gets copied. On a machine whose CLAUDE_CONFIG_DIR is NOT ~/.claude (a
// separate work profile, say), that silently inspects the wrong directory and answers with
// confidence about files it never looked at.
//
// The fix is mechanical rather than instructional: the engine resolves the config dir
// itself, using the same rule the SessionStart hook already uses — CLAUDE_CONFIG_DIR, and
// ~/.claude only when it is unset. A path nobody hand-builds is a path nobody gets wrong.
describe('adopt installer — --global targets the config dir, resolved not typed', () => {
  // A runner with full control of the environment: `configDir` sets CLAUDE_CONFIG_DIR,
  // and passing null DELETES it so the fallback branch is genuinely exercised (leaving the
  // parent process's own value would test nothing).
  function runEnv(args: string[], opts: { cwd: string; configDir: string | null; home?: string }): string {
    const env = { ...INSTALLER_ENV }
    if (opts.configDir === null) delete env.CLAUDE_CONFIG_DIR
    else env.CLAUDE_CONFIG_DIR = opts.configDir
    if (opts.home) { env.HOME = opts.home; env.USERPROFILE = opts.home }
    const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: opts.cwd, env, encoding: 'utf8' })
    return (res.stdout ?? '') + (res.stderr ?? '')
  }

  it('resolves the target from CLAUDE_CONFIG_DIR, NOT from the cwd', () => {
    const cwd = mkDir()
    const cfg = mkDir()
    const out = runEnv(['--set', 'rules', '--check', '--global'], { cwd, configDir: cfg })
    expect(out).toContain(`[rules] target=${join(cfg, 'rules')}`)
    // The decisive half: it must NOT have fallen back to the project default under cwd.
    expect(out).not.toContain(join(cwd, '.claude', 'rules'))
  })

  it('falls back to ~/.claude ONLY when CLAUDE_CONFIG_DIR is unset', () => {
    const cwd = mkDir()
    const home = mkDir()
    const out = runEnv(['--set', 'rules', '--check', '--global'], { cwd, configDir: null, home })
    expect(out).toContain(`[rules] target=${join(home, '.claude', 'rules', 'wt')}`)
  })

  it('--global --install writes into the config dir, and --set all splits by set', () => {
    const cwd = mkDir()
    const cfg = mkDir()
    // A docs copy adopted before the docs set was retired stays exactly as it was.
    const legacyDoc = join(cfg, 'docs', 'wt', 'wt-sdlc.md')
    mkdirSync(join(cfg, 'docs', 'wt'), { recursive: true })
    writeFileSync(legacyDoc, 'legacy rationale copy\n')
    const out = runEnv(['--set', 'all', '--install', '--global'], { cwd, configDir: cfg })
    expect(out).not.toContain('[docs]')
    expect(readFileSync(legacyDoc, 'utf8')).toBe('legacy rationale copy\n')
    expect(readdirSync(join(cfg, 'docs', 'wt'))).toEqual(['wt-sdlc.md'])
    expect(out).toContain(`[rules] target=${join(cfg, 'rules', 'wt')}`)
    expect(out).toContain(`[agents] target=${join(cfg, 'agents')}`)
    expect(out).toContain(`[autonomy] target=${cfg}`)
    expect(existsSync(join(cfg, 'rules', 'wt', RULE))).toBe(true)
    for (const f of AGENTS) expect(existsSync(join(cfg, 'agents', f))).toBe(true)
    expect(existsSync(join(cfg, AUTONOMY))).toBe(true)
    // Nothing leaked into the project dir — --global means the config dir, exclusively.
    expect(existsSync(join(cwd, '.claude'))).toBe(false)
  })

  it('--global and --dir together are rejected rather than one silently winning', () => {
    const cwd = mkDir()
    const cfg = mkDir()
    const out = runEnv(['--set', 'rules', '--check', '--global', '--dir', cwd], { cwd, configDir: cfg })
    expect(out).toMatch(/--global and --dir/)
  })
})

describe('adopt installer — account-level env prerequisites in settings.json', () => {
  function runSettings(args: string[], opts: { cwd: string; configDir: string | null; home?: string }): string {
    const env = { ...INSTALLER_ENV }
    if (opts.configDir === null) delete env.CLAUDE_CONFIG_DIR
    else env.CLAUDE_CONFIG_DIR = opts.configDir
    if (opts.home) env.HOME = opts.home
    const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: opts.cwd, env, encoding: 'utf8' })
    return (res.stdout ?? '') + (res.stderr ?? '')
  }

  it('--check proposes the universal spawn-depth prerequisite by NAME only, at the active config profile', () => {
    const cwd = mkDir()
    const cfg = mkDir()
    const out = runSettings(['--set', 'rules', '--check'], { cwd, configDir: cfg })
    expect(out).toContain(`[settings] target=${join(cfg, 'settings.json')}`)
    expect(out).toContain('CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: ABSENT')
    expect(out).not.toContain('CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS')
    expect(out).toContain('rerun under each profile')
    expect(out).not.toContain('=3')
  })

  it('--check on the agents set proposes the observer gate too, still by NAME only', () => {
    const cwd = mkDir()
    const cfg = mkDir()
    const out = runSettings(['--set', 'agents', '--check'], { cwd, configDir: cfg })
    expect(out).toContain('CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: ABSENT')
    expect(out).toContain('CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS: ABSENT')
    expect(out).not.toContain('=1')
  })

  it('--install adds ONLY absent keys, preserves existing structure, creates a backup, and records traceability out of band', () => {
    const cwd = mkDir()
    const cfg = mkDir()
    writeFileSync(
      join(cfg, 'settings.json'),
      JSON.stringify({ theme: 'dark', env: { KEEP_ME: 'present', CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS: 'user-choice' } }),
    )

    const out = runSettings(['--set', 'agents', '--install'], { cwd, configDir: cfg })
    expect(out).toContain('CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: WROTE')
    expect(out).toContain('CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS: PRESENT (differs from the managed default; left intact)')

    const settings = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8'))
    expect(settings.theme).toBe('dark')
    expect(settings.env.KEEP_ME).toBe('present')
    expect(settings.env.CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS).toBe('user-choice')
    expect(settings.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe('3')

    const backups = readdirSync(cfg).filter((name) => /^settings\.json\.workflow-toolbox\.bak\./.test(name))
    expect(backups.length).toBe(1)

    const trace = JSON.parse(readFileSync(join(cfg, 'workflow-toolbox', 'adopt-settings-trace.json'), 'utf8'))
    expect(trace.keys.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH.value).toBe('3')
    expect(trace.keys.CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS).toBeUndefined()
  })

  it('a present DIFFERENT value is left intact and never echoed back to output', () => {
    const cwd = mkDir()
    const cfg = mkDir()
    const secret = 'TOPSECRET_EXISTING_VALUE'
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: secret } }))

    const out = runSettings(['--set', 'rules', '--check'], { cwd, configDir: cfg })
    expect(out).toContain('CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: PRESENT')
    expect(out).toContain('left intact')
    expect(out).not.toContain(secret)
  })
})

// STALE must mean "the text you hold differs from the text that ships" — not "the plugin
// released since you installed".
//
// WHY. The verdict was a pure version comparison, so EVERY release marked EVERY adopted copy
// stale, including copies byte-identical to the shipped file. A release touching one skill's
// prose made twelve untouched rules announce themselves as out of date. That is how a signal
// dies: a reader who is told to act four times for nothing stops reading the fourth, and the
// release that genuinely changes a rule arrives into an audience that has learned to skip it.
//
// The fingerprint needed to answer this was ALREADY in the banner — it was just never
// consulted for staleness, only for detecting user edits. These lock both directions,
// because a fix that only silences is indistinguishable from a fix that also blinds.
describe('adopt installer — STALE tracks CONTENT, not the version number', () => {
  // Write a managed copy that is internally consistent (its banner fingerprint matches its
  // own body, so it classifies as 'clean' rather than 'edited') but carries an OLD version —
  // i.e. exactly what an adopted copy looks like after the plugin releases again.
  function installedAt(dir: string, file: string, version: string, body: string): void {
    const fp = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)
    writeFileSync(
      join(dir, file),
      `<!-- installed from workflow-toolbox v${version} · content sha256:${fp} by the adopt skill -->\n${body}`,
    )
  }
  const shipped = (file: string) => readFileSync(join(REPO_ROOT, 'plugin/rules', file), 'utf8')
  const shippedRules = () =>
    readdirSync(join(REPO_ROOT, 'plugin/rules')).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')

  // Populate the target with EVERY shipped rule at an old version. Seeding only one file
  // leaves eleven ABSENT, and the check-mode hint reports absence in preference to staleness —
  // so an assertion about the STALE hint would be decided by the missing files rather than by
  // the behaviour under test. A fixture must not be able to produce the expected output for a
  // reason other than the one being asserted.
  function seedAllAt(dir: string, version: string): void {
    for (const f of shippedRules()) installedAt(dir, f, version, shipped(f))
  }

  it('identical shipped content under rules/wt is UP-TO-DATE even when its stored fingerprint is stale', () => {
    const target = join(mkDir(), 'rules', 'wt')
    mkdirSync(target, { recursive: true })
    const { pluginRoot, script } = makePluginCopy('1.0.0')
    const body = readFileSync(join(pluginRoot, 'rules', RULE), 'utf8').replace(/[ \t\r\n]+$/u, '')
    writeFileSync(
      join(target, RULE),
      `<!-- installed from workflow-toolbox v0.0.1 · content sha256:000000000000 by the adopt skill -->\n\n${body}\n`,
    )

    const out = runCopy(script, ['--set', 'rules', '--check'], target)
    expect(out).toContain(`${RULE}: UP-TO-DATE`)
    expect(out).not.toContain(`${RULE}: EDITED`)
  })

  it('identical content behind a newer plugin version is UP-TO-DATE, not STALE', () => {
    const d = mkDir()
    seedAllAt(d, '0.0.1')
    const out = run(['--set', 'rules', '--check'], d)
    expect(out).toMatch(new RegExp(`${RULE}: UP-TO-DATE`))
    expect(out).not.toContain('STALE')
    expect(out).toContain('nothing to do')
  })

  it('CHANGED content behind a newer plugin version is still STALE (the fix must not blind it)', () => {
    const d = mkDir()
    seedAllAt(d, '0.0.1')
    installedAt(d, RULE, '0.0.1', shipped(RULE) + '\nA LINE FROM AN OLDER RELEASE\n')
    const out = run(['--set', 'rules', '--check'], d)
    expect(out).toMatch(new RegExp(`${RULE}: STALE`))
    expect(out).toContain('run with --install to refresh the STALE item(s)')
    // ONLY the changed one — its untouched neighbours must not be swept along.
    expect(out).toMatch(/wt-memory-hygiene\.md: UP-TO-DATE/)
  })

  it('--install refreshes the changed copy and leaves the identical ones alone', () => {
    const d = mkDir()
    seedAllAt(d, '0.0.1')
    installedAt(d, RULE, '0.0.1', shipped(RULE) + '\nA LINE FROM AN OLDER RELEASE\n')
    const out = run(['--set', 'rules', '--install'], d)
    expect(out).toMatch(new RegExp(`${RULE}: (REFRESHED|WROTE|UPDATED)`))
    expect(readFileSync(join(d, RULE), 'utf8')).not.toContain('A LINE FROM AN OLDER RELEASE')
  })

  it('a FUTURE banner with identical content is still UP-TO-DATE', () => {
    const d = mkDir()
    seedAllAt(d, '0.0.1')
    installedAt(d, RULE, '999.0.0', shipped(RULE))
    const out = run(['--set', 'rules', '--check'], d)
    expect(out).toMatch(new RegExp(`${RULE}: UP-TO-DATE`))
  })

  it('a FUTURE banner with different content is AHEAD/FORKED, never STALE', () => {
    const d = mkDir()
    seedAllAt(d, '0.0.1')
    installedAt(d, RULE, '999.0.0', shipped(RULE) + '\nA FORKED FUTURE LINE\n')
    const out = run(['--set', 'rules', '--check'], d)
    expect(out).toMatch(new RegExp(`${RULE}: AHEAD/FORKED`))
    expect(out).not.toMatch(new RegExp(`${RULE}: STALE`))
  })

  it('a trailing-newline-only difference is UP-TO-DATE', () => {
    const d = mkDir()
    seedAllAt(d, '0.0.1')
    installedAt(d, RULE, '0.0.1', shipped(RULE).replace(/[ \t\r\n]+$/u, '') + '\n\n')
    const out = run(['--set', 'rules', '--check'], d)
    expect(out).toMatch(new RegExp(`${RULE}: UP-TO-DATE`))
    expect(out).not.toMatch(new RegExp(`${RULE}: STALE|${RULE}: EDITED`))
  })
})

// The rules set no longer INLINES its content: like the agents set it reads each managed
// file VERBATIM from a bundle dir (plugin/rules/) at run time, discovering every *.md there
// EXCEPT README.md, and banners it at line 1 (rule files carry no YAML frontmatter). These
// lock the content-source relationship so a revert to an inline body — or a discovery that
// swallows README.md as a rule — fails a gate here.
const RULES_SRC_DIR = join(REPO_ROOT, 'plugin/rules')

// Independent re-derivation of stripRuleBanner (NOT importing the engine): drop line 1
// (the banner) plus any leading blank lines, leaving the source's own body.
function stripInstalledRuleBanner(text: string): string {
  const nl = text.indexOf('\n')
  if (nl === -1) return ''
  return text.slice(nl + 1).replace(/^\n+/, '')
}

describe('adopt installer — rules set sourced from the plugin/rules bundle', () => {
  it('the installed rule copy carries the plugin/rules bundle source VERBATIM under its banner (strip === source)', () => {
    const d = mkDir()
    run(['--set', 'rules', '--install'], d)
    const installed = readFileSync(rulePath(d), 'utf8')
    const source = readFileSync(join(RULES_SRC_DIR, RULE), 'utf8')
    expect(stripInstalledRuleBanner(installed), 'stripped rule copy must equal the plugin/rules bundle source').toBe(source)
  })

  it('discovers every *.md rule in the bundle but EXCLUDES README.md', () => {
    const d = mkDir()
    const chk = run(['--set', 'rules', '--check'], d)
    expect(chk).toContain(`${RULE}: ABSENT`)
    expect(chk, 'README.md is documentation, never a managed rule').not.toContain('README.md')
  })
})

// SYMLINK-AWARENESS: a target <config-dir>/rules/<name>.md that is a symlink (e.g. a config
// dir whose rules are symlinked from another one) must NEVER be written THROUGH — a naive
// writeFileSync follows the link and clobbers the REAL file it points at. The installer
// reports the symlink, leaves it (and its target) untouched on a plain --install, and only
// replaces it under --replace-symlinks (atomically publish a regular managed file over the
// link after rendering — the former target preserved).
describe('adopt installer — symlink-aware install (never write through a symlink)', () => {
  const CANON = 'CANONICAL ORIGINAL — MUST STAY UNTOUCHED\n'
  // A symlink whose target is a plain hand-authored file.
  function handAuthoredSymlink(): { dir: string; canonical: string } {
    const dir = mkDir() // the rules TARGET dir (holds the symlink)
    const canonDir = mkDir() // a separate "other config dir" the link points into
    const canonical = join(canonDir, RULE)
    writeFileSync(canonical, CANON)
    symlinkSync(canonical, rulePath(dir)) // dir/RULE -> canonDir/RULE
    return { dir, canonical }
  }
  // A symlink whose target is a CLEAN-but-STALE managed copy: a write-through engine would
  // "refresh" it and thereby clobber the target — the genuinely dangerous case.
  function staleManagedSymlink(): { dir: string; canonical: string } {
    const dir = mkDir()
    const canonDir = mkDir()
    const canonical = join(canonDir, RULE)
    run(['--set', 'rules', '--install'], canonDir) // canonDir/RULE = clean managed copy
    // lower ONLY the banner version → clean-but-stale (would be REFRESHED through the link)
    writeFileSync(canonical, readFileSync(canonical, 'utf8').replace(/ v\d+\.\d+\.\d+ /, ' v0.0.1 '))
    symlinkSync(canonical, rulePath(dir))
    return { dir, canonical }
  }

  it('--check reports a SYMLINK and points at --replace-symlinks', () => {
    const { dir } = handAuthoredSymlink()
    const chk = run(['--set', 'rules', '--check'], dir)
    expect(chk).toContain('SYMLINK')
    expect(chk).toContain('--replace-symlinks')
  })

  it('--check --replace-symlinks previews the replacement and drops the contradictory "pass the flag" nag (still read-only)', () => {
    const { dir } = handAuthoredSymlink()
    const chk = run(['--set', 'rules', '--check', '--replace-symlinks'], dir)
    expect(chk).toContain('SYMLINK')
    expect(chk).toContain('will be replaced')
    expect(chk, 'must not tell the user to pass a flag they already passed').not.toContain('pass --replace-symlinks')
    expect(lstatSync(rulePath(dir)).isSymbolicLink(), '--check must never mutate the symlink').toBe(true)
  })

  it('a plain --install NEVER writes through a symlink, even when the target is a STALE managed copy that would otherwise be refreshed', () => {
    const { dir, canonical } = staleManagedSymlink()
    const before = readFileSync(canonical, 'utf8')
    const out = run(['--set', 'rules', '--install'], dir)
    expect(out, 'a symlinked target must not be refreshed through the link').not.toMatch(/REFRESHED/)
    expect(lstatSync(rulePath(dir)).isSymbolicLink(), 'the symlink must remain a symlink').toBe(true)
    expect(readFileSync(canonical, 'utf8'), 'the symlink target must be byte-for-byte unchanged').toBe(before)
  })

  it('--replace-symlinks replaces the link with a managed copy IN PLACE, leaving the original target untouched', () => {
    const { dir, canonical } = handAuthoredSymlink()
    const out = run(['--set', 'rules', '--install', '--replace-symlinks'], dir)
    expect(out).toMatch(/REPLACED/)
    expect(lstatSync(rulePath(dir)).isSymbolicLink(), 'the symlink must be replaced by a regular file').toBe(false)
    const body = readFileSync(rulePath(dir), 'utf8')
    expect(body).toMatch(/installed from workflow-toolbox v\d+\.\d+\.\d+/)
    expect(body).toMatch(/content sha256:[0-9a-f]{12}/)
    expect(readFileSync(canonical, 'utf8'), 'replacing the symlink must not touch its former target').toBe(CANON)
  })
})

// A flag that is parsed and stored in every mode but only ever READ by one of them has NO
// EFFECT when passed under a different mode — the installer used to accept it silently
// (card #1832848906090710813: `--check --user-dir <x>` reported on the --dir/cwd fallback
// while looking like it had honoured the caller's target). These three cases are the
// card's own discriminating closure criteria, plus a sweep of the OTHER flags that share
// the same asymmetry (`--dir`/`--global`/`--force`/`--replace-symlinks` under
// `--audit-overlap`) — the fix is an INVARIANT ("no flag is accepted where it does nothing"),
// not a special case for `--user-dir` alone, so the sweep is what proves that.
describe('adopt installer — a flag with no effect in the resolved mode is REFUSED, not ignored', () => {
  function runRaw(args: string[]) {
    const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
    return { ...res, out: (res.stdout ?? '') + (res.stderr ?? '') }
  }

  it('--check --user-dir <x>: non-zero exit, message names --dir', () => {
    const d = mkDir()
    const res = runRaw(['--check', '--user-dir', d])
    expect(res.status).not.toBe(0)
    expect(res.out).toContain('--user-dir')
    expect(res.out).toContain('--dir')
  })

  it('--check --dir <x>: unaffected — still works, and names the effective target', () => {
    const d = mkDir()
    const res = runRaw(['--check', '--dir', d])
    expect(res.status).toBe(0)
    expect(res.out).toContain(`target=${d}`)
  })

  it('--audit-overlap --user-dir <x>: unaffected — still works exactly as before', () => {
    const d = mkDir()
    const res = runRaw(['--audit-overlap', '--user-dir', d])
    expect(res.status).toBe(0)
    expect(res.out).toContain(`target=${d}`)
  })

  it('--install --user-dir <x>: also refused (not just --check)', () => {
    const d = mkDir()
    const res = runRaw(['--install', '--user-dir', d])
    expect(res.status).not.toBe(0)
    expect(res.out).toContain('--user-dir')
  })

  // INVARIANT lock, not an enumeration: the table is the source of truth, so a flag
  // added later with a `sets` scope is covered without touching this test. A list of
  // known flag names would stay green the day someone adds the next one.
  it('every flag declaring a `sets` scope is REFUSED for every set outside it', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    const table = src.slice(src.indexOf('const FLAG_EFFECTIVE_MODES'))
    const allSets = [...src.matchAll(/^const SETS = \{([\s\S]*?)^\}/gm)]
      .flatMap((m) => [...(m[1] ?? '').matchAll(/^\s{2}(\w+):/gm)].map((e) => e[1] ?? ''))
      .filter((s): s is string => s.length > 0)
    expect(allSets.length).toBeGreaterThan(1) // else this test proves nothing

    const scoped = [...table.matchAll(/(\w+): \{ cli: '([^']+)'[^}]*?sets: \[([^\]]+)\]/g)]
      .map((m) => ({ cli: m[2] ?? '', sets: (m[3] ?? '').split(',').map((s) => s.trim().replace(/'/g, '')) }))
    expect(scoped.length).toBeGreaterThan(0) // else the mechanism silently vanished

    for (const { cli, sets } of scoped) {
      for (const s of allSets.filter((x) => !sets.includes(x))) {
        const d = mkDir()
        const res = runRaw(['--audit-overlap', '--set', s, '--user-dir', d, cli, join(d, 'x.json')])
        expect(res.status, `${cli} with --set ${s} must be refused`).not.toBe(0)
        expect(res.out).toContain(cli)
        expect(res.out).toContain(`--set ${s}`)
      }
    }
  })

  it('a set-scoped flag still WORKS inside its declared set (the refusal is not blanket)', () => {
    const d = mkDir()
    writeFileSync(join(d, 'decl.json'), '[]')
    const res = runRaw(['--audit-overlap', '--set', 'rules', '--user-dir', d, '--declarations-file', join(d, 'decl.json')])
    expect(res.status).toBe(0)
  })

  it('sweep: --audit-overlap --dir <x> is refused too (--dir has no effect in that mode)', () => {
    const d = mkDir()
    const res = runRaw(['--audit-overlap', '--user-dir', d, '--dir', d])
    expect(res.status).not.toBe(0)
    expect(res.out).toContain('--dir')
  })

  it('sweep: --audit-overlap --global is refused too', () => {
    const d = mkDir()
    const res = runRaw(['--audit-overlap', '--user-dir', d, '--global'])
    expect(res.status).not.toBe(0)
    expect(res.out).toContain('--global')
  })

  it('sweep: --audit-overlap --force is refused too', () => {
    const d = mkDir()
    const res = runRaw(['--audit-overlap', '--user-dir', d, '--force'])
    expect(res.status).not.toBe(0)
    expect(res.out).toContain('--force')
  })

  it('sweep: --audit-overlap --replace-symlinks is refused too', () => {
    const d = mkDir()
    const res = runRaw(['--audit-overlap', '--user-dir', d, '--replace-symlinks'])
    expect(res.status).not.toBe(0)
    expect(res.out).toContain('--replace-symlinks')
  })

  it('sweep: --check --pairs-file <x> is refused (pairs-file only honoured under --audit-overlap)', () => {
    const d = mkDir()
    const res = runRaw(['--check', '--dir', d, '--pairs-file', join(d, 'x.json')])
    expect(res.status).not.toBe(0)
    expect(res.out).toContain('--pairs-file')
  })

  it('--check --force: refused, message names --install (card #1834247430221072122)', () => {
    const d = mkDir()
    const res = runRaw(['--check', '--dir', d, '--force'])
    expect(res.status).not.toBe(0)
    expect(res.out).toContain('--force')
    expect(res.out).toContain('--install')
  })

  it('--replace-symlinks remains accepted under --check/--install (informational preview, unaffected by the --force fix)', () => {
    const d = mkDir()
    expect(runRaw(['--check', '--dir', d, '--replace-symlinks']).status).toBe(0)
    expect(runRaw(['--install', '--dir', d, '--replace-symlinks']).status).toBe(0)
  })

  it('--install --force: still accepted and still overwrites normally', () => {
    const d = mkDir()
    expect(runRaw(['--install', '--dir', d, '--force']).status).toBe(0)
  })
})

// The registered-agents note (card: "an adoptant asked why two already-available agents
// hadn't been added" — they had, under workflow-toolbox:<name>, and nothing said so).
// The list MUST be derived from plugin/agents/ at run time — never hard-coded — or the 7th
// agent added there stays invisible, exactly the enumerating-guard defect this closes.
//
// Proving the derivation is REAL (not just moved) requires a plugin/agents/ whose contents
// this test controls. The real plugin/agents/ must stay untouched (a fixture written there
// would trip the plugin/agents/ ↔ plugin/launch-agents/agents/ byte-identity mirror gate and
// ship) — so this builds a throwaway COPY of the plugin skeleton (manifest + agents/ +
// the script itself) under a temp dir, adds a fixture agent to the COPY's agents/, and runs
// the COPIED script — whose pluginRoot() resolution walks up from ITS OWN location, landing
// on the temp copy, never the real one.
function makePluginCopy(version = '0.0.1'): { pluginRoot: string; script: string; agentsDir: string } {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'wt-adopt-plugin-'))
  roots.push(pluginRoot)
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
  writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }))
  cpSync(join(REPO_ROOT, 'plugin/rules'), join(pluginRoot, 'rules'), { recursive: true })
  cpSync(join(REPO_ROOT, 'plugin/agents'), join(pluginRoot, 'agents'), { recursive: true })
  cpSync(join(REPO_ROOT, 'plugin/agent-templates'), join(pluginRoot, 'agent-templates'), { recursive: true })
  const scriptDir = join(pluginRoot, 'skills/adopt/scripts')
  mkdirSync(scriptDir, { recursive: true })
  cpSync(SCRIPT, join(scriptDir, 'install.mjs'))
  mkdirSync(join(pluginRoot, 'bin/lib'), { recursive: true })
  cpSync(join(REPO_ROOT, 'plugin/bin/lib/remedy-quote.mjs'), join(pluginRoot, 'bin/lib/remedy-quote.mjs'))
  mkdirSync(join(pluginRoot, 'bin/lib/host'))
  cpSync(join(REPO_ROOT, 'plugin/bin/lib/host/adopt-placement.mjs'), join(pluginRoot, 'bin/lib/host/adopt-placement.mjs'))
  return { pluginRoot, script: join(scriptDir, 'install.mjs'), agentsDir: join(pluginRoot, 'agents') }
}

function runCopy(script: string, args: string[], dir: string): string {
  const res = spawnSync(process.execPath, [script, ...args, '--dir', dir], { encoding: 'utf8' })
  return (res.stdout ?? '') + (res.stderr ?? '')
}

function runCopyEnv(script: string, args: string[], dir: string, env: NodeJS.ProcessEnv): string {
  const res = spawnSync(process.execPath, [script, ...args, '--dir', dir], { encoding: 'utf8', env: { ...process.env, ...env } })
  return (res.stdout ?? '') + (res.stderr ?? '')
}

describe('adopt installer — registered-agents note (derived, not hard-coded)', () => {
  it('--set agents lists every plugin/agents/*.md under workflow-toolbox:<name>, distinct from ABSENT pilot-suite items', () => {
    const d = mkDir()
    const { script, agentsDir } = makePluginCopy()
    const realNames = readdirSync(agentsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort()
    const out = runCopy(script, ['--set', 'agents', '--check'], d)
    for (const name of realNames) expect(out, `${name} should be listed as registered`).toContain(`workflow-toolbox:${name}`)
    // The pilot suite (agent-templates/, a DIFFERENT mechanism) stays a distinct ABSENT line —
    // this note must never blur the two into looking the same.
    expect(out).toContain('pilot.md: ABSENT')
    expect(out).toMatch(/\d+ other agent\(s\) ship with the plugin/)
  })

  it('an agent ADDED to plugin/agents/ after this fix appears in the note with nobody editing a list', () => {
    const d = mkDir()
    const { script, agentsDir } = makePluginCopy()
    const before = runCopy(script, ['--set', 'agents', '--check'], d)
    expect(before).not.toContain('workflow-toolbox:brand-new-fixture-agent')

    // Add a fixture agent to the COPY only — the real plugin/agents/ is never touched.
    writeFileSync(
      join(agentsDir, 'brand-new-fixture-agent.md'),
      '---\nname: brand-new-fixture-agent\ndescription: a fixture added mid-test\n---\n\nfixture body\n',
    )
    const after = runCopy(script, ['--set', 'agents', '--check'], d)
    expect(after).toContain('workflow-toolbox:brand-new-fixture-agent')
    // The count grew by exactly one, and no other line needed touching to make that true.
    const beforeCount = Number(/(\d+) other agent\(s\) ship with the plugin/.exec(before)?.[1])
    const afterCount = Number(/(\d+) other agent\(s\) ship with the plugin/.exec(after)?.[1])
    expect(afterCount).toBe(beforeCount + 1)
  })

  it('an EMPTY plugin/agents/ prints no note at all (graceful, mirrors discoverRuleItems)', () => {
    const d = mkDir()
    const { script, agentsDir } = makePluginCopy()
    for (const f of readdirSync(agentsDir)) rmSync(join(agentsDir, f))
    const out = runCopy(script, ['--set', 'agents', '--check'], d)
    expect(out).not.toContain('other agent(s) ship with the plugin')
  })

  it('the note is printed for --install too (informational, not tied to a write)', () => {
    const d = mkDir()
    const { script, agentsDir } = makePluginCopy()
    const realNames = readdirSync(agentsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
    const out = runCopy(script, ['--set', 'agents', '--install'], d)
    for (const name of realNames) expect(out).toContain(`workflow-toolbox:${name}`)
  })

  it('a README.md dropped into plugin/agents/ is never listed as a registered agent (parity with discoverRuleItems)', () => {
    const d = mkDir()
    const { script, agentsDir } = makePluginCopy()
    writeFileSync(join(agentsDir, 'README.md'), '# not an agent\n')
    const out = runCopy(script, ['--set', 'agents', '--check'], d)
    expect(out).not.toContain('workflow-toolbox:README')
  })

  it('the note is absent from the rules-only set (agents-specific, never printed for --set rules)', () => {
    const d = mkDir()
    const { script } = makePluginCopy()
    const out = runCopy(script, ['--set', 'rules', '--check'], d)
    expect(out).not.toContain('other agent(s) ship with the plugin')
  })
})

describe('adopt installer — registered-agent shadowing note', () => {
  function firstRegisteredAgentName(agentsDir: string): string {
    const first = readdirSync(agentsDir)
      .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
      .sort()[0]
    expect(first, 'fixture plugin copy should have at least one registered agent').toBeTruthy()
    if (!first) throw new Error('fixture plugin copy should have at least one registered agent')
    return first.replace(/\.md$/, '')
  }

  it('no user-level copy: the note contains no shadowing line at all', () => {
    const d = mkDir()
    const cfg = mkDir()
    const { script } = makePluginCopy()
    const out = runCopyEnv(script, ['--set', 'agents', '--check'], d, { CLAUDE_CONFIG_DIR: cfg })
    expect(out).not.toContain('shadowing')
    expect(out).not.toContain('DIVERGED')
  })

  it('an identical user-level copy is reported as shadowing and matching', () => {
    const d = mkDir()
    const cfg = mkDir()
    const { script, agentsDir } = makePluginCopy()
    const name = firstRegisteredAgentName(agentsDir)
    mkdirSync(join(cfg, 'agents'), { recursive: true })
    writeFileSync(join(cfg, 'agents', `${name}.md`), readFileSync(join(agentsDir, `${name}.md`), 'utf8'))

    const out = runCopyEnv(script, ['--set', 'agents', '--check'], d, { CLAUDE_CONFIG_DIR: cfg })
    expect(out).toContain(`workflow-toolbox:${name} is shadowed by`)
    expect(out).toContain('(matches the plugin copy)')
  })

  it('a differing user-level copy is reported as shadowing and DIVERGED, with both mtimes', () => {
    const d = mkDir()
    const cfg = mkDir()
    const { script, agentsDir } = makePluginCopy()
    const name = firstRegisteredAgentName(agentsDir)
    mkdirSync(join(cfg, 'agents'), { recursive: true })
    writeFileSync(join(cfg, 'agents', `${name}.md`), readFileSync(join(agentsDir, `${name}.md`), 'utf8') + '\nlocal divergence\n')

    const out = runCopyEnv(script, ['--set', 'agents', '--check'], d, { CLAUDE_CONFIG_DIR: cfg })
    expect(out).toContain(`workflow-toolbox:${name} is shadowed by`)
    expect(out).toContain('DIVERGED')
    expect(out).toMatch(/plugin mtime=.*user mtime=.*/)
  })

  it('a BODY divergence is classified as "body differs" — appending a trailing line after the frontmatter changes the instruction text', () => {
    const d = mkDir()
    const cfg = mkDir()
    const { script, agentsDir } = makePluginCopy()
    const name = firstRegisteredAgentName(agentsDir)
    mkdirSync(join(cfg, 'agents'), { recursive: true })
    writeFileSync(join(cfg, 'agents', `${name}.md`), readFileSync(join(agentsDir, `${name}.md`), 'utf8') + '\nlocal divergence\n')

    const out = runCopyEnv(script, ['--set', 'agents', '--check'], d, { CLAUDE_CONFIG_DIR: cfg })
    expect(out).toContain('DIVERGED')
    expect(out).toContain('body differs')
    expect(out).not.toContain('frontmatter-only')
  })

  it('a FRONTMATTER-only divergence names the diverging key(s) and never claims the body differs', () => {
    const d = mkDir()
    const cfg = mkDir()
    const { script, agentsDir } = makePluginCopy()
    const name = firstRegisteredAgentName(agentsDir)
    const pluginSource = readFileSync(join(agentsDir, `${name}.md`), 'utf8')
    // Add a single-line frontmatter key (a model pin) with nothing else touched — the body
    // after the closing `---` stays byte-identical to the plugin copy.
    const userSource = pluginSource.replace(/\n---\n/, '\nmodel: opus\n---\n')
    expect(userSource, 'fixture must actually gain a new frontmatter line').not.toBe(pluginSource)
    mkdirSync(join(cfg, 'agents'), { recursive: true })
    writeFileSync(join(cfg, 'agents', `${name}.md`), userSource)

    const out = runCopyEnv(script, ['--set', 'agents', '--check'], d, { CLAUDE_CONFIG_DIR: cfg })
    expect(out).toContain('DIVERGED')
    expect(out).toContain('frontmatter-only: model')
    expect(out).not.toContain('body differs')
  })

  it('an absent config agents dir is skipped silently: no throw, no shadowing line', () => {
    const d = mkDir()
    const missingCfg = join(mkDir(), 'missing-config-root')
    const { script } = makePluginCopy()
    const out = runCopyEnv(script, ['--set', 'agents', '--check'], d, { CLAUDE_CONFIG_DIR: missingCfg })
    expect(out).toContain('other agent(s) ship with the plugin')
    expect(out).not.toContain('shadowing')
    expect(out).not.toContain('DIVERGED')
    expect(out).not.toContain('adopt: ENOENT')
  })
})

// Card 1874754605787645076, route C: on-demand identity is decided against the engine-owned roots
// (by name, case-insensitively, or by filesystem identity), and every rule write goes through one
// placement chokepoint, migrate included.
describe('adopt installer — on-demand placement by root identity (one write chokepoint)', () => {
  function runWith(args: string[], cwd: string, config: string) {
    const env = sealedPluginCliEnv(join(cwd, '..', 'env'), { CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin') })
    const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env })
    return { status: res.status, out: (res.stdout ?? '') + (res.stderr ?? '') }
  }
  function expectOnlySpecBacked(dir: string): void {
    const written = readdirSync(dir).filter((name) => name.endsWith('.md'))
    for (const file of written) {
      expect(existsSync(join(REPO_ROOT, 'plugin/rules', file.replace(/\.md$/, '.spec.json'))), file).toBe(true)
    }
    expect(existsSync(join(dir, RULE))).toBe(false)
  }
  function symlinkedConfigRoot() {
    const root = mkDir()
    const project = join(root, 'proj')
    const config = join(root, 'cfg')
    const store = join(root, 'store')
    for (const dir of [project, config, store]) mkdirSync(dir, { recursive: true })
    symlinkSync(store, join(config, 'rules-on-demand'), 'dir')
    return { root, project, config, store }
  }

  it.each(['store', 'config alias'])('A: a symlinked config on-demand root receives only spec-backed rules (--dir = %s)', (via) => {
    const f = symlinkedConfigRoot()
    const dir = via === 'store' ? f.store : join(f.config, 'rules-on-demand')
    const result = runWith(['--set', 'rules', '--install', '--dir', dir], f.project, f.config)
    expect(result.status, result.out).toBe(0)
    expectOnlySpecBacked(f.store)
  })

  it('B: a static-named alias of the on-demand root store receives only spec-backed rules', () => {
    const f = symlinkedConfigRoot()
    const alias = join(f.project, '.claude', 'rules', 'wt')
    mkdirSync(join(f.project, '.claude', 'rules'), { recursive: true })
    symlinkSync(f.store, alias, 'dir')
    const result = runWith(['--set', 'rules', '--install', '--dir', alias], f.project, f.config)
    expect(result.status, result.out).toBe(0)
    expectOnlySpecBacked(f.store)
  })

  it('C: migrate refuses, before any move, to move a static rule into an on-demand root', () => {
    const root = mkDir()
    const project = join(root, 'proj')
    const config = join(root, 'cfg')
    const flat = join(project, '.claude', 'rules')
    const demand = join(project, '.claude', 'rules-on-demand')
    mkdirSync(config, { recursive: true })
    mkdirSync(demand, { recursive: true })
    expect(runWith(['--set', 'rules', '--install', '--dir', flat], project, config).status).toBe(0)
    expect(existsSync(join(flat, RULE))).toBe(true)
    symlinkSync(demand, join(flat, 'wt'), 'dir')
    const result = runWith(['--set', 'rules', '--migrate', '--execute', '--ignore-secondary', '--dir', join(flat, 'wt')], project, config)
    expect(result.status, result.out).not.toBe(0)
    expect(existsSync(join(flat, RULE))).toBe(true)
    expect(readdirSync(demand).filter((name) => name.endsWith('.md'))).toEqual([])
  })

  it('D: a case-variant on-demand directory name filters static rules on Linux too', () => {
    const root = mkDir()
    const dir = join(root, 'cfg', 'RULES-ON-DEMAND')
    const result = runResult(['--set', 'rules', '--install'], dir)
    expect(result.status, result.out).toBe(0)
    expect(existsSync(join(dir, ACT))).toBe(true)
    expectOnlySpecBacked(dir)
  })

  it('F: onDemandRoots mirrors the engine ruleDirectories()', async () => {
    const engine = await import(pathToFileURL(join(REPO_ROOT, 'plugins/wt-rules-on-demand/paths.js')).href)
    const placement = await import(pathToFileURL(join(REPO_ROOT, 'plugin/bin/lib/host/adopt-placement.mjs')).href)
    for (const [project, config] of [['/p/proj', '/h/.claude'], ['/p/proj//', '/h/cfg/']]) {
      const expected = engine.ruleDirectories(project, config)
      expect(placement.onDemandRoots({ project, config })).toEqual({ project: expected.project, user: expected.user })
    }
  })
})
