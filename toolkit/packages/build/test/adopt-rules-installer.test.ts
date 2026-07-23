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
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync, lstatSync } from 'node:fs'
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
// Run WITHOUT a forced --dir, at a chosen cwd, so the script uses each set's OWN
// default dir (.claude/rules, .claude/agents) under that cwd — the only way to
// exercise the `--set all` SUCCESS path, which rejects an explicit --dir.
function runInCwd(args: string[], cwd: string): string {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
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

  it('old-format agent banner (version but NO fingerprint, after the frontmatter): conservative skip, --force overwrites', () => {
    const d = mkDir()
    // A managed-looking banner with NO `content sha256:`, placed AFTER the frontmatter —
    // exercises bannerLine()'s agent-specific (frontmatter-relative) extraction path.
    writeFileSync(
      agentPath(d, 'pilot.md'),
      '---\nname: pilot\ndescription: x\n---\n<!-- installed from workflow-toolbox v0.1.0 by the adopt-rules skill -->\n\nold body\n',
    )
    expect(run(['--set', 'agents', '--check'], d)).toMatch(/pilot\.md:.*pre-fingerprint/)
    expect(run(['--set', 'agents', '--install'], d)).toContain('pilot.md: SKIPPED')
    expect(run(['--set', 'agents', '--install', '--force'], d)).toMatch(/pilot\.md: OVERWROTE/)
    expect(readFileSync(agentPath(d, 'pilot.md'), 'utf8')).toContain('content sha256:')
  })

  it('AHEAD (installed version > plugin, unedited): --install SKIPS it without --force', () => {
    const d = mkDir()
    run(['--set', 'agents', '--install'], d)
    const p = agentPath(d, 'pilot.md')
    // Raise ONLY the banner's version token above any real plugin version; fingerprint intact.
    const before = readFileSync(p, 'utf8')
    writeFileSync(p, before.replace(/(installed from workflow-toolbox )v\d+\.\d+\.\d+/, '$1v999.0.0'))
    expect(run(['--set', 'agents', '--check'], d)).toContain('pilot.md: AHEAD')
    expect(run(['--set', 'agents', '--install'], d)).toContain('pilot.md: SKIPPED')
    // untouched by a plain --install (still AHEAD, still v999)
    expect(readFileSync(p, 'utf8')).toContain('v999.0.0')
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

  it('--set all SUCCESS path: one invocation installs BOTH sets into their own default dirs', () => {
    const d = mkDir()
    const out = runInCwd(['--set', 'all', '--install'], d)
    // Both sets processed, each into its own default subdir under the cwd.
    expect(out).toMatch(/\[rules\] target=.*[/\\]\.claude[/\\]rules/)
    expect(out).toMatch(/\[agents\] target=.*[/\\]\.claude[/\\]agents/)
    expect(out).toContain('wt-delegation-ladder.md: WROTE')
    expect(out).toContain('pilot.md: WROTE')
    expect(existsSync(join(d, '.claude/rules/wt-delegation-ladder.md'))).toBe(true)
    for (const f of AGENTS) expect(existsSync(join(d, '.claude/agents', f))).toBe(true)
    // A re-check sees every item in BOTH sets as UP-TO-DATE (the loop ran end to end).
    const chk = runInCwd(['--set', 'all', '--check'], d)
    expect(chk).toContain('wt-delegation-ladder.md: UP-TO-DATE')
    expect(chk).toContain('pilot.md: UP-TO-DATE')
    expect(chk).toContain('nothing to do')
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

describe('adopt-rules installer — rules set sourced from the plugin/rules bundle', () => {
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
// replaces it under --replace-symlinks (unlink the link, then write a regular managed file
// in its place — the former target preserved).
describe('adopt-rules installer — symlink-aware install (never write through a symlink)', () => {
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
