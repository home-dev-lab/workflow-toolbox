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
  'wt-concurrent-sessions-worktree': { lines: 53, union: '94fd849c0f35b3c3e8fea29371ded3ebbad866f15fa59f1367e885ca5f55ada6', core: '8937b8dff80951f1d687e20488e697b41c1976e684871a18dce313212674bc55', act: 'be2414462b4f360d6136234641cdf361171bed524a242dcb0fdfe0970d129ab2' },
  'wt-delegation-ladder': { lines: 375, union: '55c21289b16c40ced332f21fdb7c0eb2495dfdbc03f5fc4e951e10c1973ce292', core: '3cb91c8722538c7230a62a791bd04c6f2322777711d5c27eda8930e2db0d7aa9', act: 'bb66df1a464e617eed82d91143fbdd817bbfe9fd01661c2cd9e2fa51c23418d3' },
  'wt-proportionate-verification': { lines: 130, union: '1684b58127c2d722158d9daae9cfedfdb666d9ed1d13ec3f38fffb00d484c9a1', core: 'af65d4a6ec1afccbaf63356b8f2b1b4d3c5dcd0219a4276b64d73db8a0cc7ea9', act: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  'wt-sdlc': { lines: 85, union: '8cd8209ce97cce7264e37b9e27a49d1958fc40daa67d8289b13291143151c7df', core: 'fcd43f45305c80d6c7f7f285d9ccecbc568448439dc7940e5915c1107ca145c8', act: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  'wt-task-tracking': { lines: 64, union: '4596f598a9972d55a6c821142378883eb5b5d1c64a1956bcb4552e9bd3605931', core: '9bf7869dc1535f99c3380e6a6e29e594fc49796b40991477b9ae00474bed0524', act: '49dce9023c7cc951fd0a1af3e42f8ca055961cfd6f4a79bed954d15ee8f8bdd7' },
  'wt-verify-by-ground-truth': { lines: 185, union: 'bc085bdd08c809224adf14b9b21ed343d1ada60d635eead97c12a2c620cd9295', core: 'fd155387c7492bc059f1b87b7d8e6edcb5f15a59a1e72c5cd34ae0decea7f399', act: 'ae56d485b63514f736b623b6fc13080a9c7e847c61ddf5b6874165ec93b28b1b' },
} as const
// Frozen from `git show 434b5cf2^:plugin/rules/<name>.md`, before the split.
const ORIGINAL_RULE_FIXTURE = {
  'wt-concurrent-sessions-worktree': { count: 7, union: '9a774e8cd7b092d0d15f3bf5e875759cbfd9916244ed37999adab7a1e4e1d4eb' },
  'wt-delegation-ladder': { count: 92, union: '7993b1d170c32aeb750f020a46f855d2cd3f084d8aec669b2336d4a3fb84ca95' },
  'wt-proportionate-verification': { count: 26, union: '8deb93f4a8a0c2c6191428d8e4adff9ba87e6ad17895f8e417a2a8602c2ef514' },
  'wt-sdlc': { count: 33, union: '2d26e483886d18200accf9b32252f8ad967fb8633d715fba180850cddd389561' },
  'wt-task-tracking': { count: 14, union: 'cb744c35ca8fc939bb340ecdfd7d73b275d97a0c1a251fddb3cc46781af34f9d' },
  'wt-verify-by-ground-truth': { count: 58, union: '76354be330b71110c5942bd60fb66dbfbfbd0b668c06d46f332028f268afdc43' },
} as const
const INTENDED_REWORDINGS: Partial<Record<typeof RULES[number], Array<{ original?: string, replacement: string, reason: string }>>> = {
  'wt-concurrent-sessions-worktree': [{ replacement: '81a8f744ca67daabd3935269eeee23fee18b43028e79d34c5f1b0b1a2e81496b', reason: 'Keep the pre-edit isolation decision in CORE while detailed procedures remain act-bound.' }],
  'wt-delegation-ladder': [{ original: 'dd43326cc967840a1b75ec45a81df9341c762c55ccb0b64a1a5ed5f1df2202c8', replacement: 'eaa70b4339040361e1d7825c01114980e56c37291f90bec6000de13a9fe7456e', reason: 'Point to the rationale file that owns the moved executor-report section.' }],
  'wt-proportionate-verification': [{ original: 'f517d36dd19493a3a01c20a577ce0af2c3b5093b8e80301c2598cc3c04e73e6e', replacement: '9c3bb05646a2b2f7a09443b22ec8337b3fdfc4f9538bbd6504482ba722efa5d8', reason: 'Make the breadth red-proof reference self-contained after the split.' }],
  'wt-sdlc': [{ original: 'dd778e92f5ea2be65f38c3f347147e6c6e459b89a879936a07ece01f59f78e51', replacement: '7036011fe8640af2cfa89cd1ea763b8c2d4daf1c3c42a20b1bdb600dbdbdc541', reason: 'Point to the rationale file that retains the moved E2E field case.' }],
  'wt-verify-by-ground-truth': [
    { original: '01352201c89226f231c65f565b157437c7809504628e5e07a620c57f45f0bc7f', replacement: '46f759682aa817b4f87f26b0983fa74606d3fa6be082a5e42ac9a453f4758391', reason: 'Resolve the control reference within CORE without weakening same capture path.' },
    { original: 'c9021da1f771bdfd33466c496770783e49bbb09c5eca37a16899f928f65fa962', replacement: 'a891018709b2b8389b9e9383e289c0f81b2d42f40f5e3b082c1836c08518a52e', reason: 'Point merge-chain rationale at its at-act rationale file.' },
    { original: '54510d09c69bb33c533f6f90c70512c6dff1f223d60b2c98f4a48a0ab66ae29a', replacement: 'e20564e150cd4f150cee0c7516d4da897f7c5db08177b775ff8b9741189f222c', reason: 'Point seam-review rationale at its at-act rationale file.' },
  ],
}

const digest = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex')
const nonBlank = (file: string) => readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
const paragraphs = (file: string, generated: RegExp) => readFileSync(file, 'utf8')
  .replace(/^<!-- embedded-copy:mutation-red-proof:(?:start|end) -->\n?/gm, '')
  .trim()
  .split(/\n\s*\n/)
  .slice(1)
  .filter((paragraph) => !generated.test(paragraph))

type Trigger = { kind?: string, regex?: string, tool?: string, flags?: string, unconditional?: boolean, 'before-first-act'?: boolean }
const COMMAND_HEAD = String.raw`^(?:(?:[^'";&|()\n]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')*(?:;|&&|\|\||\||&(?!&)|\()\s*)*\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;&|()]+))\s+)*(?:(?:timeout(?:\s+\S+)?|nice(?:\s+(?:-[^\s]+|\d+))*|time|nohup|setsid|sudo(?:\s+-[^\s]+)*|npx|pnpm\s+exec|env(?:\s+(?:-[^\s]+|[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;&|()]+)))*)\s+|(?:ba)?sh\s+-c\s+['"]\s*)*`
const triggersFor = (name: typeof RULES[number]) => JSON.parse(
  readFileSync(join(ROOT, 'plugin/rules', `${name}-at-act.spec.json`), 'utf8'),
)['on-demand'].triggers as Trigger[]
const matchesBash = (name: typeof RULES[number], command: string) => triggersFor(name)
  .some((trigger) => trigger.kind === 'bash' && new RegExp(trigger.regex ?? '', trigger.flags).test(command))

let target: string | undefined
afterEach(() => {
  if (target) rmSync(target, { recursive: true, force: true })
  target = undefined
})

describe('shipped split rules', () => {
  it('locks the reviewed R3 split and preserves each half order', () => {
    for (const name of RULES) {
      const generated = (line: string) => line.startsWith('The act-bound half')
        || line.startsWith('Its act-bound half')
        || line === 'served on demand where an engine is installed.'
        || line === 'where an engine is installed.'
        || line === 'demand where an engine is installed.'
        || line === 'on demand where an engine is installed.'
        || line === 'engine is installed.'
        || line === '## At-act companion'
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

  it('serves every trigger that governs its own call before that call', () => {
    const afterTheActAllowList: Record<string, string> = {}
    for (const name of RULES) {
      for (const [index, trigger] of triggersFor(name).entries()) {
        const identity = `${name}:${index}`
        expect(
          trigger['before-first-act'] === true || Boolean(afterTheActAllowList[identity]),
          `${identity} must set before-first-act or have an after-the-act reason`,
        ).toBe(true)
      }
    }
    expect(afterTheActAllowList).toEqual({})
  })

  it('keeps every frozen pre-split directive paragraph, with only the explicit rewording allow-list', () => {
    for (const name of RULES) {
      const core = paragraphs(join(ROOT, 'plugin/rules', `${name}.md`), /^(?:(?:The|Its) act-bound half|## At-act companion)/)
      const act = paragraphs(join(ROOT, 'plugin/rules', `${name}-at-act.md`), /$a/)
      const paragraphHashes = [...core, ...act].map((paragraph) => digest([paragraph]))
      const lock = ORIGINAL_RULE_FIXTURE[name]
      for (const change of INTENDED_REWORDINGS[name] ?? []) {
        expect(change.reason, `${name} rewording reason`).not.toBe('')
        const replacement = paragraphHashes.indexOf(change.replacement)
        expect(replacement, `${name} reviewed replacement`).toBeGreaterThanOrEqual(0)
        paragraphHashes.splice(replacement, 1)
        if (change.original) paragraphHashes.push(change.original)
      }
      expect(paragraphHashes, `${name} paragraph count`).toHaveLength(lock.count)
      expect(digest(paragraphHashes.sort()), `${name} whole-paragraph multiset`).toBe(lock.union)
    }
  })

  it('keeps decision-time and unavailable-service obligations in CORE', () => {
    const readRule = (name: string, atAct = false) => readFileSync(join(ROOT, 'plugin/rules', `${name}${atAct ? '-at-act' : ''}.md`), 'utf8')
    for (const [name, clause] of [
      ['wt-concurrent-sessions-worktree', 'before the\nfirst edit'],
      ['wt-delegation-ladder', 'A fence justified by a live condition carries its expiry'],
      ['wt-proportionate-verification', '2. Method diversity'],
      ['wt-sdlc', 'Never claim a check passed unless it ran'],
      ['wt-task-tracking', 'Tracker unreachable? Buffer task state'],
      ['wt-verify-by-ground-truth', 'same capture path'],
    ] satisfies Array<[string, string]>) {
      expect(readRule(name), `${name} CORE`).toContain(clause)
      expect(readRule(name, true), `${name} ACT`).not.toContain(clause)
    }
  })

  it('uses one command-head pattern and matches the shared repository command corpus without quoted-text false positives', () => {
    for (const name of RULES) {
      for (const trigger of triggersFor(name).filter((candidate) => candidate.kind === 'bash')) {
        expect(trigger.flags, `${name} uses multiline command heads`).toContain('m')
        expect(trigger.regex, `${name} uses COMMAND_HEAD`).toMatch(new RegExp(`^${COMMAND_HEAD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
      }
    }

    const positives: Array<[typeof RULES[number], string]> = [
      ['wt-concurrent-sessions-worktree', 'git -C .claude/worktrees/p1 reset --hard tip'],
      ['wt-concurrent-sessions-worktree', 'cd x && git -C y merge branch'],
      ['wt-concurrent-sessions-worktree', 'git --git-dir=.git merge branch'],
      ['wt-concurrent-sessions-worktree', 'git --no-pager pull'],
      ['wt-concurrent-sessions-worktree', 'git -c color.ui=false worktree add next'],
      ['wt-concurrent-sessions-worktree', 'gh pr merge 123'],
      ['wt-proportionate-verification', '(pnpm test)'],
      ['wt-proportionate-verification', 'env FOO=1 pnpm test'],
      ['wt-proportionate-verification', 'CI=1 pnpm test'],
      ['wt-proportionate-verification', 'timeout 600 pnpm test'],
      ['wt-proportionate-verification', 'nice pnpm test'],
      ['wt-proportionate-verification', 'time pnpm test'],
      ['wt-proportionate-verification', 'nohup pnpm test &'],
      ['wt-proportionate-verification', 'setsid pnpm test'],
      ['wt-proportionate-verification', 'sudo pnpm test'],
      ['wt-proportionate-verification', "bash -c 'pnpm test'"],
      ['wt-proportionate-verification', 'sh -c "pnpm test"'],
      ['wt-proportionate-verification', 'printf ready & pnpm test'],
      ['wt-proportionate-verification', 'printf ready\npnpm test'],
      ['wt-proportionate-verification', 'npx vitest run'],
      ['wt-proportionate-verification', 'pnpm vitest run'],
      ['wt-proportionate-verification', 'pnpm exec vitest run'],
      ['wt-proportionate-verification', 'pnpm -C toolkit test'],
      ['wt-proportionate-verification', 'pnpm --dir toolkit test'],
      ['wt-proportionate-verification', 'pnpm -F pkg test'],
      ['wt-proportionate-verification', 'pnpm --filter=pkg test'],
      ['wt-proportionate-verification', 'pnpm -r test'],
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
      ['wt-verify-by-ground-truth', 'curl -s http://127.0.0.1:5174/'],
      ['wt-verify-by-ground-truth', 'node ../plugin/bin/wt-observe.mjs start'],
      ['wt-task-tracking', 'gh issue close 123'],
      ['wt-task-tracking', 'gh project item-list 1'],
      ['wt-task-tracking', 'jira issue view PROJ-1'],
      ['wt-delegation-ladder', "cat > .lane/brief.md <<'EOF'"],
    ]
    for (const [name, command] of positives) expect(matchesBash(name, command), `${name}: ${command}`).toBe(true)

    const sharedCorpus: Array<[string, typeof RULES[number][]]> = [
      ['cd x && git -C y merge branch', ['wt-concurrent-sessions-worktree', 'wt-verify-by-ground-truth']],
      ['setsid nohup pnpm test', ['wt-proportionate-verification', 'wt-sdlc', 'wt-verify-by-ground-truth']],
      ["cat > .lane/brief.md <<'EOF'", ['wt-delegation-ladder']],
      ['gh issue close 123', ['wt-task-tracking']],
    ]
    for (const [command, expected] of sharedCorpus) {
      for (const name of RULES) expect(matchesBash(name, command), `${name}: ${command}`).toBe(expected.includes(name))
    }

    for (const command of ['cat toolkit/packages/build/src/x.ts', 'ls some/test/', 'curl https://example.test/latest', 'git diff --check', 'git commit -m "fix; pnpm test flake"', "grep '&& git merge'"]) {
      expect(RULES.some((name) => matchesBash(name, command)), command).toBe(false)
    }

    const delegation = triggersFor('wt-delegation-ladder')
    const briefPath = delegation.find((trigger) => trigger.kind === 'path')
    expect(briefPath?.tool).toBe('^(?:Write|Edit|MultiEdit)$')
    expect(new RegExp(briefPath?.regex ?? '').test('.lane/brief.md')).toBe(true)
    expect(new RegExp(briefPath?.regex ?? '').test('plans/briefs/executor.md')).toBe(true)
    expect(new RegExp(briefPath?.regex ?? '').test('plans/briefs/task.md')).toBe(true)
    expect(new RegExp(briefPath?.regex ?? '').test('debrief.md')).toBe(false)
    expect(new RegExp(briefPath?.regex ?? '').test('briefing-notes.md')).toBe(false)
    expect(new RegExp(briefPath?.regex ?? '').test('README.md')).toBe(false)
    expect(delegation).not.toContainEqual(expect.objectContaining({ kind: 'tool', tool: '^Skill$' }))

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
