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
const ACT_RULES = [
  'wt-concurrent-sessions-worktree',
  'wt-delegation-ladder',
  'wt-task-tracking',
  'wt-verify-by-ground-truth',
] as const
const SPLIT_LOCKS = {
  'wt-concurrent-sessions-worktree': { lines: 53, union: '94fd849c0f35b3c3e8fea29371ded3ebbad866f15fa59f1367e885ca5f55ada6', core: '8937b8dff80951f1d687e20488e697b41c1976e684871a18dce313212674bc55', act: 'be2414462b4f360d6136234641cdf361171bed524a242dcb0fdfe0970d129ab2' },
  'wt-delegation-ladder': { lines: 375, union: '55c21289b16c40ced332f21fdb7c0eb2495dfdbc03f5fc4e951e10c1973ce292', core: '3cb91c8722538c7230a62a791bd04c6f2322777711d5c27eda8930e2db0d7aa9', act: 'bb66df1a464e617eed82d91143fbdd817bbfe9fd01661c2cd9e2fa51c23418d3' },
  'wt-proportionate-verification': { lines: 130, union: '2443ca2df2e2b0941211f5b18856dcd580f05dcb3794097659bda5c9b147378e', core: 'fbb5ba1147da091297f9c9b729dabe162b227aff41bc8831ad62542b36280654', act: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  'wt-sdlc': { lines: 85, union: '1eed1690e088140915ca9362497e033dea21ce3d7c8da0cb3e06c9b3f5473ac2', core: '1828f149ae9560b83bd65d0b0de8278ca6e0fe9017e9f93d2ffa52b1b7a48d02', act: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  'wt-task-tracking': { lines: 64, union: '4596f598a9972d55a6c821142378883eb5b5d1c64a1956bcb4552e9bd3605931', core: '9bf7869dc1535f99c3380e6a6e29e594fc49796b40991477b9ae00474bed0524', act: '49dce9023c7cc951fd0a1af3e42f8ca055961cfd6f4a79bed954d15ee8f8bdd7' },
  'wt-verify-by-ground-truth': { lines: 185, union: '6442423a215eaf50efbcf34a7ed542224118cabad6be92d72728d2405caf1c81', core: 'de00f4263b887b4b4590875ecbb53799370e7b9637064fdb88ac804caa6eb070', act: 'ae56d485b63514f736b623b6fc13080a9c7e847c61ddf5b6874165ec93b28b1b' },
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
  'wt-verify-by-ground-truth': [
    { original: '01352201c89226f231c65f565b157437c7809504628e5e07a620c57f45f0bc7f', replacement: '8cbcc46abd5d0bfb7ed8e976d5889a9bce417634ba149bfea1ff8315d96cd061', reason: 'Retain the reviewed same-capture-path clarification; the control reference is restored.' },
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
const COMMAND_HEAD = String.raw`^(?:(?:(?:[^'";&|()\n]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')*(?:;|&&|\|\||\||&(?!&)|\()\s*)|(?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;&|()]+))\s+|(?:timeout(?:(?:\s+(?:-s|--signal|-k|--kill-after)\s+\S+|\s+--(?:signal|kill-after)=\S+|\s+--(?:foreground|preserve-status|verbose))*)\s+\S+|nice(?:\s+(?:-[^\s]+|\d+))*|time|nohup|setsid|sudo(?:\s+(?:-[ugChpRT]\s+\S+|--(?:user|group|close-from|host|prompt|role|type)(?:=\S+|\s+\S+)|-[^\s]+))*|npx|pnpm\s+exec|env(?:\s+(?:-[uC]\s+\S+|--(?:unset|chdir)(?:=\S+|\s+\S+)|-[^\s]+|[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;&|()]+)))*)\s+|(?:ba)?sh\s+-c\s+['"]\s*|(?:if|then|do|else|elif|while|until)\s+|\{\s*|!\s*)*`
const triggersFor = (name: typeof ACT_RULES[number]) => JSON.parse(
  readFileSync(join(ROOT, 'plugin/rules', `${name}-at-act.spec.json`), 'utf8'),
)['on-demand'].triggers as Trigger[]
const matchesBash = (name: typeof ACT_RULES[number], command: string) => triggersFor(name)
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
      const actPath = join(ROOT, 'plugin/rules', `${name}-at-act.md`)
      const act = existsSync(actPath) ? nonBlank(actPath).slice(1).filter((line) => !generated(line)) : []
      const lock = SPLIT_LOCKS[name]
      expect(core.length + act.length, `${name} line count`).toBe(lock.lines)
      expect(digest([...core, ...act].sort()), `${name} lossless multiset`).toBe(lock.union)
      expect(digest(core), `${name} core order`).toBe(lock.core)
      expect(digest(act), `${name} act order`).toBe(lock.act)
    }
  })

  it('serves every trigger that governs its own call before that call', () => {
    const afterTheActAllowList: Record<string, string> = {}
    for (const name of ACT_RULES) {
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
      const actPath = join(ROOT, 'plugin/rules', `${name}-at-act.md`)
      const act = existsSync(actPath) ? paragraphs(actPath, /$a/) : []
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
      if ((ACT_RULES as readonly string[]).includes(name)) expect(readRule(name, true), `${name} ACT`).not.toContain(clause)
    }
  })

  it('restores the original in-file control and red-proof references', () => {
    expect(readFileSync(join(ROOT, 'plugin/rules/wt-verify-by-ground-truth.md'), 'utf8'))
      .toContain('Same family as control readable in both outcomes')
    expect(readFileSync(join(ROOT, 'plugin/rules/wt-proportionate-verification.md'), 'utf8'))
      .toContain('Its lock proven red the same way as any other fix.')
  })

  it('limits tracker, brief-write, and merge triggers to acts governed by their rules', () => {
    const trackerTool = triggersFor('wt-task-tracking').find((trigger) => trigger.kind === 'tool')!
    expect(new RegExp(trackerTool.tool ?? '').test('mcp__github__get_pull_request')).toBe(false)
    expect(new RegExp(trackerTool.tool ?? '').test('mcp__planka__update_card')).toBe(true)
    expect(matchesBash('wt-delegation-ladder', 'cat .lane/brief.md')).toBe(false)
    expect(matchesBash('wt-delegation-ladder', 'cat > .lane/brief.md')).toBe(true)
    expect(matchesBash('wt-concurrent-sessions-worktree', 'git merge-base main HEAD')).toBe(false)
    expect(matchesBash('wt-verify-by-ground-truth', 'git merge-base main HEAD')).toBe(false)
  })

  it('documents the multiline quoted-text limit without claiming shell-parser precision', () => {
    const heredoc = "git commit -m \"$(cat <<'EOF'\nsummary\npnpm test\nEOF\n)\""
    expect(ACT_RULES.some((name) => matchesBash(name, heredoc))).toBe(true)
    expect(readFileSync(join(ROOT, 'plugin/rules/README.md'), 'utf8'))
      .toContain('This quote handling is line-local')
  })

  it('uses one command-head pattern and matches the shared repository command corpus without quoted-text false positives', () => {
    for (const name of ACT_RULES) {
      for (const trigger of triggersFor(name).filter((candidate) => candidate.kind === 'bash')) {
        expect(trigger.flags, `${name} uses multiline command heads`).toContain('m')
        expect(trigger.regex, `${name} uses COMMAND_HEAD`).toMatch(new RegExp(`^${COMMAND_HEAD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
      }
    }

    const positives: Array<[typeof ACT_RULES[number], string]> = [
      ['wt-concurrent-sessions-worktree', 'git -C .claude/worktrees/p1 reset --hard tip'],
      ['wt-concurrent-sessions-worktree', 'cd x && git -C y merge branch'],
      ['wt-concurrent-sessions-worktree', 'git --git-dir=.git merge branch'],
      ['wt-concurrent-sessions-worktree', 'git --no-pager pull'],
      ['wt-concurrent-sessions-worktree', 'git -c color.ui=false worktree add next'],
      ['wt-concurrent-sessions-worktree', 'gh pr merge 123'],
      ['wt-verify-by-ground-truth', '(pnpm test)'],
      ['wt-verify-by-ground-truth', 'env FOO=1 pnpm test'],
      ['wt-verify-by-ground-truth', 'env -u DEBUG pnpm test'],
      ['wt-verify-by-ground-truth', 'CI=1 pnpm test'],
      ['wt-verify-by-ground-truth', 'timeout 600 pnpm test'],
      ['wt-verify-by-ground-truth', 'timeout -s KILL 600 pnpm test'],
      ['wt-verify-by-ground-truth', 'nice pnpm test'],
      ['wt-verify-by-ground-truth', 'time pnpm test'],
      ['wt-verify-by-ground-truth', 'nohup pnpm test &'],
      ['wt-verify-by-ground-truth', 'setsid pnpm test'],
      ['wt-verify-by-ground-truth', 'sudo -u build pnpm test'],
      ['wt-verify-by-ground-truth', "bash -c 'pnpm test'"],
      ['wt-verify-by-ground-truth', 'sh -c "pnpm test"'],
      ['wt-verify-by-ground-truth', "nohup bash -c 'cd toolkit && pnpm test > log 2>&1; echo EXIT=$? >> log' &"],
      ['wt-verify-by-ground-truth', 'if ready; then pnpm test; fi'],
      ['wt-verify-by-ground-truth', 'for pkg in a; do pnpm test; done'],
      ['wt-verify-by-ground-truth', '{ pnpm test; }'],
      ['wt-verify-by-ground-truth', '! pnpm test'],
      ['wt-verify-by-ground-truth', 'printf ready & pnpm test'],
      ['wt-verify-by-ground-truth', 'printf ready\npnpm test'],
      ['wt-verify-by-ground-truth', 'npx vitest run'],
      ['wt-verify-by-ground-truth', 'pnpm vitest run'],
      ['wt-verify-by-ground-truth', 'pnpm exec vitest run'],
      ['wt-verify-by-ground-truth', 'pnpm -C toolkit test'],
      ['wt-verify-by-ground-truth', 'pnpm --dir toolkit test'],
      ['wt-verify-by-ground-truth', 'pnpm -F pkg test'],
      ['wt-verify-by-ground-truth', 'pnpm --filter=pkg test'],
      ['wt-verify-by-ground-truth', 'pnpm -r test'],
      ['wt-verify-by-ground-truth', 'pnpm --silent test'],
      ['wt-verify-by-ground-truth', 'pnpm --filter @scope/pkg run test'],
      ['wt-verify-by-ground-truth', 'npm --prefix toolkit test'],
      ['wt-verify-by-ground-truth', 'npm run test'],
      ['wt-verify-by-ground-truth', 'yarn test'],
      ['wt-verify-by-ground-truth', 'bun test'],
      ['wt-verify-by-ground-truth', 'node --test'],
      ['wt-verify-by-ground-truth', 'make test'],
      ['wt-verify-by-ground-truth', 'jest'],
      ['wt-verify-by-ground-truth', 'vitest run'],
      ['wt-verify-by-ground-truth', 'pytest'],
      ['wt-verify-by-ground-truth', 'go test ./...'],
      ['wt-verify-by-ground-truth', 'cargo test'],
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
      ['setsid nohup pnpm test', ['wt-verify-by-ground-truth']],
      ["cat > .lane/brief.md <<'EOF'", ['wt-delegation-ladder']],
      ['gh issue close 123', ['wt-task-tracking']],
    ]
    for (const [command, expected] of sharedCorpus) {
      for (const name of ACT_RULES) expect(matchesBash(name, command), `${name}: ${command}`).toBe(expected.includes(name))
    }

    for (const command of ['cat toolkit/packages/build/src/x.ts', 'ls some/test/', 'curl https://example.test/latest', 'git diff --check', 'git commit -m "fix; pnpm test flake"', "grep '&& git merge'"]) {
      expect(ACT_RULES.some((name) => matchesBash(name, command)), command).toBe(false)
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

    for (const name of ACT_RULES) {
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
    for (const name of ACT_RULES) expect(check.stdout).toContain(`${name}-at-act.md: UP-TO-DATE`)
    for (const name of ['wt-proportionate-verification', 'wt-sdlc']) {
      expect(existsSync(join(ROOT, 'plugin/rules', `${name}-at-act.md`))).toBe(false)
      expect(existsSync(join(ROOT, 'plugin/rules', `${name}-at-act.spec.json`))).toBe(false)
      expect(existsSync(join(target, `${name}-at-act.md`))).toBe(false)
    }
  })
})
