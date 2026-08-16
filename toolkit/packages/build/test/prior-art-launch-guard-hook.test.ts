import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-prior-art-launch-guard-hook.mjs')
const CORE = join(REPO_ROOT, 'plugin/bin/lib/prior-art-launch-guard-core.mjs')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function slug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-')
}

function scaffold(tag: string, cards: Array<{ id: string; name: string; listName: string }> | null) {
  const root = mkdtempSync(join(tmpdir(), `wt-prior-art-guard-${tag}-`))
  roots.push(root)
  const home = join(root, 'home')
  const state = join(root, 'state')
  const journal = join(root, 'journal')
  const cwd = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(state, { recursive: true })
  mkdirSync(journal, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  if (cards) {
    const priorArtDir = join(state, 'wt-prior-art')
    mkdirSync(priorArtDir, { recursive: true })
    writeFileSync(
      join(priorArtDir, `${slug(cwd)}.json`),
      JSON.stringify({ at: 1000, scanned: cards.length, cap: 500, truncated: false, cards }),
      'utf8',
    )
  }
  return {
    cwd,
    env: { ...process.env, HOME: home, XDG_STATE_HOME: state, WT_GUARD_JOURNAL_DIR: journal },
  }
}

function run(command: string, env: NodeJS.ProcessEnv, cwd: string) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      cwd,
    }),
    encoding: 'utf8',
    env,
  })
  return {
    warned: res.stdout.includes('hookSpecificOutput'),
    stdout: res.stdout,
    status: res.status,
  }
}

describe('prior-art-launch-guard-core', () => {
  it('matchLaunchCommand: recognizes wt-observe launch', () => {
    const script = [
      `import { matchLaunchCommand } from ${JSON.stringify(new URL(CORE, 'file://').href)}`,
      `process.stdout.write(JSON.stringify(matchLaunchCommand('node plugin/bin/wt-observe.mjs launch pr-review.js')))`,
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(JSON.parse(res.stdout)).toBe(true)
  })

  it('matchLaunchCommand: recognizes a curl against /api/scripted-run', () => {
    const script = [
      `import { matchLaunchCommand } from ${JSON.stringify(new URL(CORE, 'file://').href)}`,
      `process.stdout.write(JSON.stringify(matchLaunchCommand("curl -X POST http://localhost:5174/api/scripted-run")))`,
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(JSON.parse(res.stdout)).toBe(true)
  })

  it('matchLaunchCommand: a non-launch wt-observe subcommand is not matched', () => {
    const script = [
      `import { matchLaunchCommand } from ${JSON.stringify(new URL(CORE, 'file://').href)}`,
      `process.stdout.write(JSON.stringify(matchLaunchCommand('node plugin/bin/wt-observe.mjs stop')))`,
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(JSON.parse(res.stdout)).toBe(false)
  })

  it('deriveKeywords: pulls the workflow basename and stem words', () => {
    const script = [
      `import { deriveKeywords } from ${JSON.stringify(new URL(CORE, 'file://').href)}`,
      `process.stdout.write(JSON.stringify(deriveKeywords('node plugin/bin/wt-observe.mjs launch docs-audit.js')))`,
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    const kws = JSON.parse(res.stdout) as string[]
    expect(kws).toContain('docs-audit')
    expect(kws).toContain('docs')
    expect(kws).toContain('audit')
  })

  it('matchCards: matches on name substring, case-insensitively', () => {
    const script = [
      `import { matchCards } from ${JSON.stringify(new URL(CORE, 'file://').href)}`,
      `const cards = [{id:'1', name:'Prove it: run a fully-scripted pipeline', listName:'Backlog'}, {id:'2', name:'Unrelated card', listName:'Next'}]`,
      `process.stdout.write(JSON.stringify(matchCards(cards, ['scripted'])))`,
    ].join('\n')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    const matched = JSON.parse(res.stdout)
    expect(matched).toHaveLength(1)
    expect(matched[0].id).toBe('1')
  })
})

describe('wt-prior-art-launch-guard-hook (integration)', () => {
  it('RED (guard absent behavior): a launch command with a matching card produces no warning when the matcher cannot fire', () => {
    // Proves the guard's warning is NOT a structural artifact of the input shape alone: feeding
    // the same fixture through a NON-launch command (the matcher inverted) never warns, even
    // though a matching card sits right there in the index. This is the RED half of the RED/GREEN
    // pair — with the launch-matching condition absent, the mechanism stays silent.
    const { cwd, env } = scaffold('red', [{ id: '1837209261243893380', name: 'Prove it: run a fully-scripted pipeline and a mixed one, observed', listName: 'Backlog' }])
    const r = run('echo "not a launch at all"', env, cwd)
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('GREEN: the SAME fixture, through an actual launch command, warns and names the card', () => {
    const { cwd, env } = scaffold('green', [{ id: '1837209261243893380', name: 'Prove it: run a fully-scripted pipeline and a mixed one, observed', listName: 'Backlog' }])
    const r = run('node plugin/bin/wt-observe.mjs launch scripted-pipeline-demo.js', env, cwd)
    expect(r.warned).toBe(true)
    expect(r.stdout).toContain('1837209261243893380')
    expect(r.stdout).toContain('possible prior art')
  })

  it('a non-launch Bash command produces nothing at all, even with a populated index', () => {
    const { cwd, env } = scaffold('nonlaunch', [{ id: '1', name: 'scripted pipeline card', listName: 'Backlog' }])
    const r = run('git status', env, cwd)
    expect(r.warned).toBe(false)
    expect(r.stdout).toBe('')
  })

  it('SILENCE A: no index on disk at all — distinct message from silence B', () => {
    const { cwd, env } = scaffold('no-index', null)
    const r = run('node plugin/bin/wt-observe.mjs launch anything.js', env, cwd)
    expect(r.warned).toBe(true)
    expect(r.stdout).toContain('no index on disk')
  })

  it('SILENCE B: index present, keywords derived, nothing matches — distinct message from silence A', () => {
    const { cwd, env } = scaffold('no-match', [{ id: '9', name: 'totally unrelated card about color contrast', listName: 'Backlog' }])
    const r = run('node plugin/bin/wt-observe.mjs launch zzz-unmatched-name.js', env, cwd)
    expect(r.warned).toBe(true)
    expect(r.stdout).toContain('no title matched')
    expect(r.stdout).not.toContain('no index on disk')
  })

  it('the two silences render DIFFERENT text — the defect this mechanism exists to avoid', () => {
    const noIndex = scaffold('silence-cmp-a', null)
    const noMatch = scaffold('silence-cmp-b', [{ id: '9', name: 'totally unrelated', listName: 'Backlog' }])
    const a = run('node plugin/bin/wt-observe.mjs launch zzz.js', noIndex.env, noIndex.cwd)
    const b = run('node plugin/bin/wt-observe.mjs launch zzz.js', noMatch.env, noMatch.cwd)
    expect(a.stdout).not.toBe(b.stdout)
    expect(a.stdout).toContain('no index on disk')
    expect(b.stdout).toContain('no title matched')
  })

  it('caps at 5 matches even when more cards match', () => {
    const cards = Array.from({ length: 8 }, (_, i) => ({ id: String(i), name: `scripted pipeline case ${i}`, listName: 'Backlog' }))
    const { cwd, env } = scaffold('cap', cards)
    const r = run('node plugin/bin/wt-observe.mjs launch scripted-pipeline.js', env, cwd)
    expect(r.warned).toBe(true)
    const occurrences = (r.stdout.match(/case \d/g) || []).length
    expect(occurrences).toBeLessThanOrEqual(5)
  })

  it('never throws on malformed hook input', () => {
    const { env } = scaffold('malformed', null)
    for (const payload of [null, [], 'broken', 42, { hook_event_name: 'PreToolUse' }]) {
      const res = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env })
      expect(res.status).toBe(0)
    }
    const raw = spawnSync(process.execPath, [HOOK], { input: '{', encoding: 'utf8', env })
    expect(raw.status).toBe(0)
  })

  it('is registered as a PreToolUse hook on Bash in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const entries = manifest.hooks?.PreToolUse ?? []
    const wired = entries
      .filter((e: { matcher?: string }) => e.matcher === 'Bash')
      .flatMap((e: { hooks?: { command?: string }[] }) => e.hooks ?? [])
      .some((h: { command?: string }) => h.command?.includes('wt-prior-art-launch-guard-hook.mjs'))
    expect(wired).toBe(true)
  })
})
