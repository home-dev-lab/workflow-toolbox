import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(ROOT, 'plugin/skills/adopt/scripts/install.mjs')
const RULES = [
  'wt-concurrent-sessions-worktree',
  'wt-delegation-ladder',
  'wt-proportionate-verification',
  'wt-sdlc',
  'wt-task-tracking',
  'wt-verify-by-ground-truth',
] as const
const SPLIT_LOCKS = {
  'wt-concurrent-sessions-worktree': { lines: 50, union: 'effcf924b2232d98780d858d8ef1fc050c82c429a74a2244393a90e9d667d9a6', core: '49eea270c79b5533453152aff5347732ab0684a185438adc0bd83e961f18ce1a', act: 'be2414462b4f360d6136234641cdf361171bed524a242dcb0fdfe0970d129ab2' },
  'wt-delegation-ladder': { lines: 375, union: '55c21289b16c40ced332f21fdb7c0eb2495dfdbc03f5fc4e951e10c1973ce292', core: 'fa529e9e7d638f901d228c06c7b0bbef878173d4a2ae89fb3e49e0db32b9c96e', act: '601ac81399087378c6c238fa5b0039b42edda62f0e1c32867a733bcdce5a90ca' },
  'wt-proportionate-verification': { lines: 130, union: '1684b58127c2d722158d9daae9cfedfdb666d9ed1d13ec3f38fffb00d484c9a1', core: '770570e4766d8aa57755df18276b511c5144b893ce92eb9d2124877854099a41', act: 'a07b8f5d71c0b63e1377e7eab25e67214d4b9e785672fa18a6b30bdcb3edb621' },
  'wt-sdlc': { lines: 85, union: '8cd8209ce97cce7264e37b9e27a49d1958fc40daa67d8289b13291143151c7df', core: '825e16d6b8efba3bf7969a79ad464a9350e3d0da877d6db211f284e5bbb88c78', act: '891e5a96fed7c4ab6a8a3f2474a920b4c3cf6bf028d511ac0df5b14893a42fd5' },
  'wt-task-tracking': { lines: 64, union: '4596f598a9972d55a6c821142378883eb5b5d1c64a1956bcb4552e9bd3605931', core: '8766ec60114db0fb79bfe56182a9c94bfd88c2a6efa2f60c7b2e35621651d45d', act: 'c60b649865deba809aeb82fd933ab1ab2694a4e373b1b569da4527c0fe209a92' },
  'wt-verify-by-ground-truth': { lines: 185, union: '2a374984a839e029efd41a3542106342ffd06880cac642ade55241bd282b0a5f', core: '6e0d4f7c9c5ac4cff0f252e869a22f20aed4ebafe05bc54b3afaf63f4d58c418', act: 'ae56d485b63514f736b623b6fc13080a9c7e847c61ddf5b6874165ec93b28b1b' },
} as const
const PARAGRAPH_LOCKS = {
  'wt-concurrent-sessions-worktree': { count: 7, union: '9a774e8cd7b092d0d15f3bf5e875759cbfd9916244ed37999adab7a1e4e1d4eb' },
  'wt-delegation-ladder': { count: 92, union: '60a41f59c75e344028881c0be9105b471872a857126d34b19cf854c52494bcc8' },
  'wt-proportionate-verification': { count: 26, union: 'a8db32781410335f96237bfe54c3c2a5b7beb8d6c483e7236d476eef598687bd' },
  'wt-sdlc': { count: 33, union: '20b7b6ff59677ad8596e317036f725e77cdd9b082d89067c74b91b94ff35c355' },
  'wt-task-tracking': { count: 14, union: 'cb744c35ca8fc939bb340ecdfd7d73b275d97a0c1a251fddb3cc46781af34f9d' },
  'wt-verify-by-ground-truth': { count: 58, union: '7a6a814fe05252d5afdb5de8b33e1466a7dbfaa30257c5e43562d3319684c9cc' },
} as const

const digest = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex')
const nonBlank = (file: string) => readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
const paragraphs = (file: string, generated: RegExp) => readFileSync(file, 'utf8')
  .replace(/^<!-- embedded-copy:mutation-red-proof:(?:start|end) -->\n?/gm, '')
  .trim()
  .split(/\n\s*\n/)
  .slice(1)
  .filter((paragraph) => !generated.test(paragraph))

type Trigger = { kind?: string, regex?: string, tool?: string }
const triggersFor = (name: typeof RULES[number]) => JSON.parse(
  readFileSync(join(ROOT, 'plugin/rules', `${name}-at-act.spec.json`), 'utf8'),
)['on-demand'].triggers as Trigger[]
const matchesBash = (name: typeof RULES[number], command: string) => triggersFor(name)
  .some((trigger) => trigger.kind === 'bash' && new RegExp(trigger.regex ?? '').test(command))

let target: string | undefined
afterEach(() => {
  if (target) rmSync(target, { recursive: true, force: true })
  target = undefined
})

describe('shipped split rules', () => {
  it('keeps every original nonblank line exactly once and preserves each half order', () => {
    for (const name of RULES) {
      const generated = (line: string) => line.startsWith('The act-bound half')
        || line.startsWith('Its act-bound half')
        || line === 'served on demand where an engine is installed.'
        || line === 'where an engine is installed.'
        || line === 'demand where an engine is installed.'
        || line === 'on demand where an engine is installed.'
        || line === 'engine is installed.'
        || /^<!-- embedded-copy:mutation-red-proof:(?:start|end) -->$/.test(line)
      const core = nonBlank(join(ROOT, 'plugin/rules', `${name}.md`)).filter((line) => !generated(line))
      const act = nonBlank(join(ROOT, 'plugin/rules', `${name}-at-act.md`)).slice(1).filter((line) => !generated(line))
      const lock = SPLIT_LOCKS[name]
      expect(core.length + act.length, `${name} line count`).toBe(lock.lines)
      expect(digest([...core, ...act].sort()), `${name} lossless multiset`).toBe(lock.union)
      expect(digest(core), `${name} core order`).toBe(lock.core)
      expect(digest(act), `${name} act order`).toBe(lock.act)
    }
  })

  it('keeps every original paragraph whole, ordered within its half, and in exactly one half', () => {
    for (const name of RULES) {
      const core = paragraphs(join(ROOT, 'plugin/rules', `${name}.md`), /^(?:The|Its) act-bound half/)
      const act = paragraphs(join(ROOT, 'plugin/rules', `${name}-at-act.md`), /$a/)
      const paragraphHashes = [...core, ...act].map((paragraph) => digest([paragraph]))
      const lock = PARAGRAPH_LOCKS[name]
      expect(paragraphHashes, `${name} paragraph count`).toHaveLength(lock.count)
      expect(digest(paragraphHashes.sort()), `${name} whole-paragraph multiset`).toBe(lock.union)
    }
  })

  it('matches governed command words without matching substrings inside paths or unrelated options', () => {
    const positives: Array<[typeof RULES[number], string]> = [
      ['wt-concurrent-sessions-worktree', 'git -C .claude/worktrees/p1 reset --hard tip'],
      ['wt-concurrent-sessions-worktree', 'git --no-pager pull'],
      ['wt-concurrent-sessions-worktree', 'git -c color.ui=false worktree add next'],
      ['wt-concurrent-sessions-worktree', 'gh pr merge 123'],
      ['wt-proportionate-verification', 'pnpm -C toolkit test'],
      ['wt-proportionate-verification', 'pnpm --filter @scope/pkg run test'],
      ['wt-proportionate-verification', 'npm run test'],
      ['wt-proportionate-verification', 'yarn test'],
      ['wt-proportionate-verification', 'bun test'],
      ['wt-proportionate-verification', 'node --test'],
      ['wt-proportionate-verification', 'make test'],
      ['wt-proportionate-verification', 'vitest run'],
      ['wt-proportionate-verification', 'pytest'],
      ['wt-proportionate-verification', 'go test ./...'],
      ['wt-proportionate-verification', 'cargo test'],
      ['wt-verify-by-ground-truth', 'tsc --noEmit'],
      ['wt-verify-by-ground-truth', 'mypy src'],
      ['wt-verify-by-ground-truth', 'ruff check .'],
      ['wt-verify-by-ground-truth', 'eslint .'],
      ['wt-verify-by-ground-truth', 'cargo clippy'],
      ['wt-verify-by-ground-truth', 'ps aux'],
      ['wt-verify-by-ground-truth', 'curl :5174'],
      ['wt-verify-by-ground-truth', 'wt-observe start'],
      ['wt-task-tracking', 'gh issue close 123'],
      ['wt-task-tracking', 'gh project item-list 1'],
      ['wt-task-tracking', 'jira issue view PROJ-1'],
    ]
    for (const [name, command] of positives) expect(matchesBash(name, command), `${name}: ${command}`).toBe(true)

    for (const command of ['cat toolkit/packages/build/src/x.ts', 'ls some/test/', 'curl https://example.test/latest', 'git diff --check']) {
      expect(RULES.some((name) => matchesBash(name, command)), command).toBe(false)
    }

    const delegation = triggersFor('wt-delegation-ladder')
    const briefPath = delegation.find((trigger) => trigger.kind === 'path')
    expect(briefPath?.tool).toBe('^(?:Write|Edit)$')
    expect(new RegExp(briefPath?.regex ?? '').test('.lane/brief.md')).toBe(true)
    expect(new RegExp(briefPath?.regex ?? '').test('plans/brief-executor.md')).toBe(true)
    expect(new RegExp(briefPath?.regex ?? '').test('README.md')).toBe(false)
    expect(delegation).toContainEqual({ kind: 'tool', tool: '^Skill$', unconditional: true })

    expect(triggersFor('wt-sdlc').some((trigger) => trigger.kind === 'tool' && /Edit|Write/.test(trigger.tool ?? ''))).toBe(false)
    expect(JSON.stringify(triggersFor('wt-task-tracking'))).not.toMatch(/board-list|planka-tool/)
  })

  it('ships machine-triggered at-act halves and adopts both halves statically', () => {
    target = mkdtempSync(join(tmpdir(), 'wt-rule-splits-'))
    const env = sealedPluginCliEnv(join(target, 'env'), { CLAUDE_PLUGIN_ROOT: join(ROOT, 'plugin') })
    const install = spawnSync(process.execPath, [SCRIPT, '--set', 'rules', '--install', '--dir', target], {
      encoding: 'utf8',
      env,
    })
    expect(install.status, install.stderr).toBe(0)

    for (const name of RULES) {
      const atAct = `${name}-at-act.md`
      const specPath = join(ROOT, 'plugin/rules', `${name}-at-act.spec.json`)
      expect(existsSync(join(target, `${name}.md`)), `${name} core`).toBe(true)
      expect(existsSync(join(target, atAct)), `${name} at-act`).toBe(true)
      expect(install.stdout).toContain(`${atAct}: WROTE`)

      const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { 'on-demand'?: { triggers?: unknown[] } }
      expect(spec['on-demand']?.triggers?.length, `${name} trigger spec`).toBeGreaterThan(0)
    }

    const check = spawnSync(process.execPath, [SCRIPT, '--set', 'rules', '--check', '--dir', target], {
      encoding: 'utf8',
      env,
    })
    expect(check.status, check.stderr).toBe(0)
    for (const name of RULES) expect(check.stdout).toContain(`${name}-at-act.md: UP-TO-DATE`)
  })
})
