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
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  cpSync,
} from 'node:fs'
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

// Age a managed RULE copy into "installed from an older release whose text has since
// changed": an older banner version, a body that genuinely differs from what ships now, and
// a fingerprint restamped over that body so the copy still classifies as UNEDITED ('clean')
// rather than as a user edit. Both halves matter — since STALE tracks CONTENT, a fixture
// that only lowered the version number would describe a copy that is legitimately up to
// date, and could no longer exercise staleness at all.
function ageRuleCopy(file: string, version = '0.0.1'): void {
  const body = readFileSync(join(REPO_ROOT, 'plugin/rules', RULE), 'utf8') + '\nA PARAGRAPH SINCE REWRITTEN UPSTREAM\n'
  const fp = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)
  writeFileSync(file, `<!-- installed from workflow-toolbox v${version} · content sha256:${fp} by the adopt-rules skill -->\n\n${body}`)
}

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

// Frontmatter preservation across a re-adoption (card #1828669764516447496): a `--force`
// overwrite must not silently drop a LOCAL, single-line frontmatter field the shipped def
// does not itself define (the standing example is a `model:` pin — the visible mechanism a
// user controls delegation routing with). Positive sense: a pinned file keeps its pin AND the
// tool announces what it kept. Negative sense: a file with no local field stays silent — no
// noise on the common case.
describe('adopt-rules installer — frontmatter preservation across --force (card #1828669764516447496)', () => {
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

describe('adopt-rules installer — CLI surface for the two-set engine', () => {
  function untouchedSetLine(out: string): string | undefined {
    return out
      .split(/\r?\n/)
      .find((line) => line.includes('set exists too; it was untouched here'))
  }

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

  it('--set rules names the agents set as untouched, factually and in one line', () => {
    const d = mkDir()
    const out = run(['--set', 'rules', '--check'], d)
    const line = untouchedSetLine(out)
    expect(line).not.toContain('⚠')
    expect(line).not.toMatch(/\bshould\b/i)
    expect(line).toBe('adopt-rules: the agents set exists too; it was untouched here, and --set agents covers it.')
  })

  it('--set agents names the rules set as untouched, factually and in one line', () => {
    const d = mkDir()
    const out = run(['--set', 'agents', '--check'], d)
    const line = untouchedSetLine(out)
    expect(line).not.toContain('⚠')
    expect(line).not.toMatch(/\bshould\b/i)
    expect(line).toBe('adopt-rules: the rules set exists too; it was untouched here, and --set rules covers it.')
  })

  it('--set all prints no untouched-set line at all', () => {
    const d = mkDir()
    const out = runInCwd(['--set', 'all', '--check'], d)
    expect(untouchedSetLine(out)).toBeUndefined()
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
describe('adopt-rules installer — --global targets the config dir, resolved not typed', () => {
  // A runner with full control of the environment: `configDir` sets CLAUDE_CONFIG_DIR,
  // and passing null DELETES it so the fallback branch is genuinely exercised (leaving the
  // parent process's own value would test nothing).
  function runEnv(args: string[], opts: { cwd: string; configDir: string | null; home?: string }): string {
    const env = { ...process.env }
    if (opts.configDir === null) delete env.CLAUDE_CONFIG_DIR
    else env.CLAUDE_CONFIG_DIR = opts.configDir
    if (opts.home) env.HOME = opts.home
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
    expect(out).toContain(`[rules] target=${join(home, '.claude', 'rules')}`)
  })

  it('--global --install writes into the config dir, and --set all splits by set', () => {
    const cwd = mkDir()
    const cfg = mkDir()
    const out = runEnv(['--set', 'all', '--install', '--global'], { cwd, configDir: cfg })
    expect(out).toContain(`[rules] target=${join(cfg, 'rules')}`)
    expect(out).toContain(`[agents] target=${join(cfg, 'agents')}`)
    expect(existsSync(join(cfg, 'rules', RULE))).toBe(true)
    for (const f of AGENTS) expect(existsSync(join(cfg, 'agents', f))).toBe(true)
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
describe('adopt-rules installer — STALE tracks CONTENT, not the version number', () => {
  // Write a managed copy that is internally consistent (its banner fingerprint matches its
  // own body, so it classifies as 'clean' rather than 'edited') but carries an OLD version —
  // i.e. exactly what an adopted copy looks like after the plugin releases again.
  function installedAt(dir: string, file: string, version: string, body: string): void {
    const fp = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)
    writeFileSync(
      join(dir, file),
      `<!-- installed from workflow-toolbox v${version} · content sha256:${fp} by the adopt-rules skill -->\n${body}`,
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

  it('AHEAD survives: a copy claiming a FUTURE version is still flagged, identical content or not', () => {
    const d = mkDir()
    seedAllAt(d, '0.0.1')
    installedAt(d, RULE, '999.0.0', shipped(RULE))
    const out = run(['--set', 'rules', '--check'], d)
    expect(out).toMatch(new RegExp(`${RULE}: AHEAD`))
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

// A flag that is parsed and stored in every mode but only ever READ by one of them has NO
// EFFECT when passed under a different mode — the installer used to accept it silently
// (card #1832848906090710813: `--check --user-dir <x>` reported on the --dir/cwd fallback
// while looking like it had honoured the caller's target). These three cases are the
// card's own discriminating closure criteria, plus a sweep of the OTHER flags that share
// the same asymmetry (`--dir`/`--global`/`--force`/`--replace-symlinks` under
// `--audit-overlap`) — the fix is an INVARIANT ("no flag is accepted where it does nothing"),
// not a special case for `--user-dir` alone, so the sweep is what proves that.
describe('adopt-rules installer — a flag with no effect in the resolved mode is REFUSED, not ignored', () => {
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

  it('--force and --replace-symlinks remain accepted under --check/--install (they ARE read there, informationally)', () => {
    const d = mkDir()
    expect(runRaw(['--check', '--dir', d, '--force']).status).toBe(0)
    expect(runRaw(['--check', '--dir', d, '--replace-symlinks']).status).toBe(0)
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
function makePluginCopy(): { pluginRoot: string; script: string; agentsDir: string } {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'wt-adopt-plugin-'))
  roots.push(pluginRoot)
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
  writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.0.1' }))
  cpSync(join(REPO_ROOT, 'plugin/agents'), join(pluginRoot, 'agents'), { recursive: true })
  cpSync(join(REPO_ROOT, 'plugin/agent-templates'), join(pluginRoot, 'agent-templates'), { recursive: true })
  const scriptDir = join(pluginRoot, 'skills/adopt-rules/scripts')
  mkdirSync(scriptDir, { recursive: true })
  cpSync(SCRIPT, join(scriptDir, 'install-rules.mjs'))
  return { pluginRoot, script: join(scriptDir, 'install-rules.mjs'), agentsDir: join(pluginRoot, 'agents') }
}

function runCopy(script: string, args: string[], dir: string): string {
  const res = spawnSync(process.execPath, [script, ...args, '--dir', dir], { encoding: 'utf8' })
  return (res.stdout ?? '') + (res.stderr ?? '')
}

function runCopyEnv(script: string, args: string[], dir: string, env: NodeJS.ProcessEnv): string {
  const res = spawnSync(process.execPath, [script, ...args, '--dir', dir], { encoding: 'utf8', env: { ...process.env, ...env } })
  return (res.stdout ?? '') + (res.stderr ?? '')
}

describe('adopt-rules installer — registered-agents note (derived, not hard-coded)', () => {
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

describe('adopt-rules installer — registered-agent shadowing note', () => {
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

  it('an absent config agents dir is skipped silently: no throw, no shadowing line', () => {
    const d = mkDir()
    const missingCfg = join(mkDir(), 'missing-config-root')
    const { script } = makePluginCopy()
    const out = runCopyEnv(script, ['--set', 'agents', '--check'], d, { CLAUDE_CONFIG_DIR: missingCfg })
    expect(out).toContain('other agent(s) ship with the plugin')
    expect(out).not.toContain('shadowing')
    expect(out).not.toContain('DIVERGED')
    expect(out).not.toContain('adopt-rules: ENOENT')
  })
})
