import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { withRepositoryInstructions } from '../../../../plugin/bin/lib/sdk-role-profile.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/host/
import { declaredChecksForPhase } from '../../../../plugin/bin/lib/host/repo-instructions.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

type Entry = string | { link: string }
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' })

// Builds a committed repository in a temp directory. A `{ link }` entry is a symlink the commit stores as mode 120000.
function repo(files: Record<string, Entry>, { commit = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'wt-repo-instructions-')); roots.push(base)
  const root = join(base, 'repo'); mkdirSync(root)
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'commit.gpgSign', 'false')
  for (const [name, entry] of Object.entries(files)) {
    const file = join(root, ...name.split('/')); mkdirSync(dirname(file), { recursive: true })
    if (typeof entry === 'string') writeFileSync(file, entry); else symlinkSync(entry.link, file)
  }
  if (commit) { git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base') }
  return { base, root }
}
const build = (root: string, prompt = 'THE BRIEF') => withRepositoryInstructions(root, prompt) as string
const count = (text: string, needle: string) => text.split(needle).length - 1

describe('repository instructions from the committed tree', () => {
  it('injects the committed root guide content between markers, then the original prompt', () => {
    const { root } = repo({ 'CLAUDE.md': 'Mandatory: run `acme validate --strict` before shipping.\n' })
    const out = build(root)
    expect(out).toContain('## Repository contributor instructions (from the repository\'s committed files)')
    expect(out).toContain(`<!-- BEGIN repository guide: ${join(root, 'CLAUDE.md')} -->`)
    expect(out).toContain('Mandatory: run `acme validate --strict` before shipping.')
    expect(out).toContain(`<!-- END repository guide: ${join(root, 'CLAUDE.md')} -->`)
    expect(out.endsWith('\n\nTHE BRIEF')).toBe(true)
  })

  it('(a) a CLAUDE.md symlink to AGENTS.md injects the target once, under the target path', () => {
    const { root } = repo({ 'AGENTS.md': 'UNIQUE-AGENTS-TEXT\n', 'CLAUDE.md': { link: 'AGENTS.md' } })
    const out = build(root)
    expect(count(out, 'UNIQUE-AGENTS-TEXT')).toBe(1)
    expect(count(out, 'BEGIN repository guide:')).toBe(1)
    expect(out).toContain(`BEGIN repository guide: ${join(root, 'AGENTS.md')}`)
  })

  it('(b) a symlink leaving the repository or absolute is not followed and says so', () => {
    const { base, root } = repo({ 'CLAUDE.md': { link: '../outside.md' }, 'AGENTS.md': { link: '/etc/hostname' } })
    writeFileSync(join(base, 'outside.md'), 'OUTSIDE-SECRET\n')
    const out = build(root)
    expect(out).not.toContain('OUTSIDE-SECRET')
    expect(out).toContain('CLAUDE.md: symlink to ../outside.md not followed (outside the repository or not a regular file)')
    expect(out).toContain('AGENTS.md: symlink to /etc/hostname not followed (outside the repository or not a regular file)')
    expect(out).not.toContain('BEGIN repository guide:')
  })

  it('(c) a working-tree edit made after the commit does not change what is injected', () => {
    const { root } = repo({ 'CLAUDE.md': 'COMMITTED-TEXT\n' })
    writeFileSync(join(root, 'CLAUDE.md'), 'EDITED-BY-A-LANE\n')
    const out = build(root)
    expect(out).toContain('COMMITTED-TEXT')
    expect(out).not.toContain('EDITED-BY-A-LANE')
  })

  it('(c2) an uncommitted new guide is not injected', () => {
    const { root } = repo({ 'tracked.txt': 'x\n' })
    writeFileSync(join(root, 'CLAUDE.md'), 'NEVER-COMMITTED\n')
    expect(build(root)).not.toContain('NEVER-COMMITTED')
  })

  it('(d) huge guides are truncated with a marker while the gate and validation lists survive', () => {
    const big = `${'line of guide text\n'.repeat(1700)}` // ~30.6k chars
    const { root } = repo({ 'CLAUDE.md': big, 'AGENTS.md': big.replace(/line/g, 'LINE'), 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), '.claude-plugin/plugin.json': '{}' })
    const out = build(root)
    expect(out).toMatch(/\[truncated at \d+ of \d+ characters; read the rest at .*AGENTS\.md\]/)
    expect(out).toContain('`npm run test` → `vitest run` (source: package.json)')
    expect(out).toContain('`claude plugin validate . --strict` (derived from .claude-plugin/plugin.json)')
    expect(out.length - 'THE BRIEF'.length).toBeLessThanOrEqual(40_500)
  })

  it('(e) nested guides are listed as pointers, capped at 20 with a remainder count', () => {
    const files: Record<string, Entry> = { 'CLAUDE.md': 'root\n' }
    for (let i = 0; i < 23; i += 1) files[`d${String(i).padStart(2, '0')}/AGENTS.md`] = `NESTED-BODY-${i}\n`
    const { root } = repo(files)
    const out = build(root)
    expect(out).toContain('### Folder guides')
    expect(out).toContain(`- ${join(root, 'd00', 'AGENTS.md')}`)
    expect(out).toContain(`- ${join(root, 'd19', 'AGENTS.md')}`)
    expect(out).not.toContain(join(root, 'd20', 'AGENTS.md'))
    expect(out).toContain('… and 3 more')
    expect(out).not.toContain('NESTED-BODY-0')
  })

  it('(f) gate scripts are filtered by name, with package manager detection and source path', () => {
    const { root } = repo({
      'package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0', scripts: { test: 'vitest run', dev: 'vite', lint: 'eslint .', start: 'node x' } }),
      'toolkit/package.json': JSON.stringify({ scripts: { quality: 'node q.mjs', typecheck: 'tsc --noEmit' } }),
      'toolkit/pnpm-lock.yaml': '',
      'other/package.json': JSON.stringify({ scripts: { check: 'echo ok' } }),
      'broken/package.json': '{ not json',
    })
    const out = build(root)
    expect(out).toContain('### Gate commands the repository declares')
    expect(out).toContain('- .: `pnpm run test` → `vitest run` (source: package.json)')
    expect(out).toContain('- .: `pnpm run lint` → `eslint .` (source: package.json)')
    expect(out).toContain('- toolkit: `pnpm run quality` → `node q.mjs` (source: toolkit/package.json)')
    expect(out).toContain('- other: `npm run check` → `echo ok` (source: other/package.json)')
    expect(out).not.toContain('`vite`')
    expect(out).not.toContain('node x')
    expect(out).toContain('broken/package.json: not valid JSON, scripts not read')
  })

  it('(f2) a long script command is cut at 200 characters', () => {
    const { root } = repo({ 'package.json': JSON.stringify({ scripts: { test: 'a'.repeat(300) } }) })
    const out = build(root)
    expect(out).toContain(`\`${'a'.repeat(200)}…\``)
    expect(out).not.toContain('a'.repeat(201))
  })

  it('(g) plugin manifests at depth 0 and 2 produce validate lines', () => {
    const { root } = repo({ '.claude-plugin/marketplace.json': '{}', 'a/b/.claude-plugin/plugin.json': '{}', 'a/b/.claude-plugin/marketplace.json': '{}' })
    const out = build(root)
    expect(out).toContain('### Plugin validation')
    expect(out).toContain('- `claude plugin validate . --strict` (derived from .claude-plugin/marketplace.json)')
    expect(count(out, '`claude plugin validate a/b --strict`')).toBe(1)
  })

  it('(h) a directory that is not a git repository says so and falls back to the pointer lines', () => {
    const base = mkdtempSync(join(tmpdir(), 'wt-repo-instructions-nogit-')); roots.push(base)
    writeFileSync(join(base, 'CLAUDE.md'), '# Guide\n')
    const out = build(base)
    expect(out).toContain('Repository instructions unavailable:')
    expect(out).toContain("is the repository's contributor guide; read it before planning or changing code.")
    expect(out).not.toContain('BEGIN repository guide:')
    expect(out.endsWith('\n\nTHE BRIEF')).toBe(true)
  })

  it('(h2) a repository without a commit is stated unavailable', () => {
    const { root } = repo({ 'CLAUDE.md': 'x\n' }, { commit: false })
    expect(build(root)).toContain('Repository instructions unavailable:')
  })

  it('(j) a folder inside a repository is not its top level: stated unavailable, the parent repository is not read', () => {
    const { root } = repo({ 'CLAUDE.md': 'PARENT-GUIDE\n', 'sub/tracked.txt': 'x\n' })
    const out = build(join(root, 'sub'))
    expect(out).toContain('Repository instructions unavailable:')
    expect(out).toContain('is not the top level of its repository')
    expect(out).not.toContain('PARENT-GUIDE')
  })

  it('(k) .wt-gates.json gates are listed with their source; an invalid file is stated', () => {
    const { root } = repo({ '.wt-gates.json': JSON.stringify({ gates: [{ name: 'test', command: 'pnpm test:blocking', cwd: 'toolkit' }, { name: 'lint', command: 'pnpm lint' }] }) })
    const out = build(root)
    expect(out).toContain('- `pnpm test:blocking` in toolkit (gate `test`, source: .wt-gates.json)')
    expect(out).toContain('- `pnpm lint` in . (gate `lint`, source: .wt-gates.json)')
    const broken = repo({ '.wt-gates.json': '{ nope' })
    expect(build(broken.root)).toContain('.wt-gates.json: not valid JSON, gates not read')
  })

  it('(l) the plan-phase checks list the declared gates and validations, and nothing for other phases', () => {
    const { root } = repo({ 'CLAUDE.md': 'GUIDE-BODY\n', 'package.json': JSON.stringify({ scripts: { quality: 'q' } }), '.claude-plugin/plugin.json': '{}' })
    const plan = declaredChecksForPhase('plan', root) as string
    expect(plan).toContain('## Repository-declared checks for your plan (authoritative)')
    expect(plan).toContain('- .: `npm run quality` → `q` (source: package.json)')
    expect(plan).toContain('- `claude plugin validate . --strict` (derived from .claude-plugin/plugin.json)')
    expect(plan).not.toContain('GUIDE-BODY')
    expect(declaredChecksForPhase('critic', root)).toBe('')
    const empty = repo({ 'x.txt': 'x\n' })
    expect(declaredChecksForPhase('plan', empty.root)).toBe('')
  })

  it('(i) is deterministic', () => {
    const { root } = repo({ 'CLAUDE.md': 'x\n', 'package.json': JSON.stringify({ scripts: { test: 't', build: 'b' } }), 'z/AGENTS.md': 'n\n', '.claude-plugin/plugin.json': '{}' })
    expect(build(root)).toBe(build(root))
  })
})
