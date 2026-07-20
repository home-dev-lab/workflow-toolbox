// adopt-rules-installer.test.ts — the COMMITTED drift-lock for the adopt-rules
// installer's edit-safety contract (plugin/skills/adopt-rules/scripts/install-rules.mjs).
//
// The edit-safety logic (content fingerprint + EDITED classification + --force) was
// added under review pressure precisely so a routine `--install` refresh can never
// silently destroy a user's edits. It was originally proven by a standalone e2e that
// ran once and evaporated — verified-once, NOT drift-gated. This test moves those
// assertions INTO the suite (child-process execution against throwaway dirs, the same
// pattern as plugin-hooks.test.ts) so the contract is locked against future drift.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/skills/adopt-rules/scripts/install-rules.mjs')
const RULE = 'wt-delegation-ladder.md'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function mkDir(): string {
  const r = mkdtempSync(join(tmpdir(), 'wt-adopt-'))
  roots.push(r)
  return r
}
function run(args: string[], dir: string): string {
  const res = spawnSync(process.execPath, [SCRIPT, ...args, '--dir', dir], { encoding: 'utf8' })
  return (res.stdout ?? '') + (res.stderr ?? '')
}
const rulePath = (dir: string) => join(dir, RULE)

describe('adopt-rules installer — edit-safety contract (committed drift lock)', () => {
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

  it('STALE unedited (version behind, body intact): --install REFRESHES it', () => {
    const d = mkDir()
    run(['--install'], d)
    const p = rulePath(d)
    // Lower ONLY the banner version; the body (and thus its fingerprint) is untouched.
    writeFileSync(p, readFileSync(p, 'utf8').replace(/ v\d+\.\d+\.\d+ /, ' v0.0.1 '))
    expect(run(['--check'], d)).toContain('STALE')
    expect(run(['--install'], d)).toMatch(/REFRESHED/)
    expect(run(['--check'], d)).toContain('UP-TO-DATE')
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

  it('old-format banner (version but NO fingerprint): conservative skip, --force overwrites', () => {
    const d = mkDir()
    writeFileSync(
      rulePath(d),
      '<!-- installed from workflow-toolbox v0.1.0 by the adopt-rules skill -->\n\n# x\n\nold\n',
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

// The agent-copies set (--set agents) reuses the same engine (banner + fingerprint +
// EDITED/--force safety) but SOURCES its content from plugin/agents/*.md at run time
// and places the banner AFTER the YAML frontmatter (an agent def must start with ---).
// A project copy of these defs is what lets the pilot-watchdog `observer:` pairing
// attach, so the copy must carry the plugin source VERBATIM under its banner.
const AGENTS = ['pilot.md', 'pilot-watchdog.md', 'pilot-orchestrator.md']
const AGENTS_SRC_DIR = join(REPO_ROOT, 'plugin/agents')
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

describe('adopt-rules installer — agent-copies set (--set agents; committed drift lock)', () => {
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

  it('STALE unedited (version behind, body intact): --install REFRESHES it', () => {
    const d = mkDir()
    run(['--set', 'agents', '--install'], d)
    const p = agentPath(d, 'pilot.md')
    // Lower ONLY the banner's version token (anchored to the banner, not the frontmatter);
    // body + fingerprint stay intact so the copy is clean-but-behind.
    writeFileSync(p, readFileSync(p, 'utf8').replace(/(installed from workflow-toolbox )v\d+\.\d+\.\d+/, '$1v0.0.1'))
    expect(run(['--set', 'agents', '--check'], d)).toContain('pilot.md: STALE')
    expect(run(['--set', 'agents', '--install'], d)).toMatch(/pilot\.md: REFRESHED/)
    expect(run(['--set', 'agents', '--check'], d)).toContain('pilot.md: UP-TO-DATE')
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
})

describe('adopt-rules installer — CLI surface for the two-set engine', () => {
  it('--set all with --dir is rejected (a single dir cannot target two sets)', () => {
    const d = mkDir()
    // run() appends `--dir d`, so this is `--set all --check --dir d`.
    expect(run(['--set', 'all', '--check'], d)).toMatch(/--dir requires a single --set/)
  })

  it('an unknown --set value fails loudly', () => {
    const d = mkDir()
    expect(run(['--set', 'bogus', '--check'], d)).toMatch(/unknown --set/)
  })
})
