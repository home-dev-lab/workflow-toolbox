// dev-implement-plugin-root-resolution.test.ts — ground-truth verification that the cleanup
// prompt's plugin-root fallback expression (emitted when no pluginRoot input is supplied)
// actually RESOLVES in a real shell, not just that its text looks right.
//
// Split out of dev-implement.test.ts (card 1866211551, refutation R2): these are the only
// tests in that suite that spawn real subprocesses (bash / node), which is why they belong in
// the `process-spawning` vitest project (see toolkit/scripts/spawning-test-files.mjs) rather
// than in the ~1800-line FakeRuntime suite whose remaining tests assert prompt content only and
// need none of that project's reduced-concurrency protection.
//
// TDD: written before the implementation (RED step).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import wf from '../dev-implement.workflow.js'

// ---------------------------------------------------------------------------
// Fixtures — duplicated (not imported) from dev-implement.test.ts on purpose:
// this file must stand alone as its own small `process-spawning` test file,
// and only the plugin-root-resolution tests need real subprocess execution.
// ---------------------------------------------------------------------------

const WT_ARTIFACT = {
  goal: 'Add validation helpers',
  context: {
    projectDir: '/repo',
    testCommand: 'pnpm test',
    buildCommand: '',
    conventions: 'TypeScript strict; vitest',
  },
  tasks: [
    {
      id: 'T1',
      title: 'Add validate()',
      intent: 'Pure helper.',
      files: [{ path: 'src/validate.ts', status: 'new', role: 'impl' }],
      contracts: 'export function validate(raw: unknown): boolean',
      testPlan: 'Failing unit test first.',
      doneCriteria: ['unit tests pass'],
      dependsOn: [],
      snippet: '', // new file — nothing existing to quote
    },
    {
      id: 'T2',
      title: 'Add sanitize()',
      intent: 'Pure helper.',
      files: [{ path: 'src/sanitize.ts', status: 'new', role: 'impl' }],
      contracts: 'export function sanitize(raw: string): string',
      testPlan: 'Failing unit test first.',
      doneCriteria: ['unit tests pass'],
      dependsOn: [],
      snippet: '', // new file — nothing existing to quote
    },
    {
      id: 'T3',
      title: 'Wire both into the CLI',
      intent: 'Integration point.',
      files: [{ path: 'src/cli.ts', status: 'existing', role: 'integration' }],
      contracts: 'main() validates then sanitizes',
      testPlan: 'Failing CLI test first.',
      doneCriteria: ['CLI tests pass'],
      dependsOn: ['T1', 'T2'],
      // Existing integration point — router-phrase-free verbatim quote.
      snippet: 'function main(argv) { return parseArgs(argv) } // src/cli.ts:3-9',
    },
  ],
  risks: [],
  outOfScope: [],
}

const WT_INPUT = { artifact: WT_ARTIFACT, mutation: 'worktree' }

/**
 * Worktree-mode runtime: routes the SIX new agent kinds plus the three TDD
 * stages on the call's LABEL. See the identically-named helper in
 * dev-implement.test.ts for the full rationale.
 */
function makeWtRuntime(overrides?: {
  setup?: (prompt: string) => unknown
  create?: (prompt: string, wave: number) => unknown
  lanesCreate?: (prompt: string) => unknown
  prepare?: (prompt: string) => unknown
  finalize?: (prompt: string) => unknown
  merge?: (prompt: string, index: number) => unknown
  integration?: (prompt: string, index: number) => unknown
  revert?: (prompt: string) => unknown
  cleanup?: (prompt: string) => unknown
  red?: (prompt: string) => unknown
  green?: (prompt: string) => unknown
  check?: (prompt: string) => unknown
}): FakeRuntime {
  let createCalls = 0
  let mergeCalls = 0
  let integrationCalls = 0
  let revertCalls = 0
  return new FakeRuntime({
    onAgent: ({ prompt, opts }: { prompt: string; opts?: { label?: string }; index: number }) => {
      const label = opts?.label ?? ''
      if (label.startsWith('dev-implement:worktrees:')) {
        const i = createCalls++
        if (overrides?.create) return overrides.create(prompt, i)
        const ids = [...prompt.matchAll(/wt-task\/(T\d+)/g)].map((m) => m[1])
        return { created: [...new Set(ids)], failures: [], note: 'worktrees added' }
      }
      if (label.startsWith('dev-implement:lanes:')) {
        if (overrides?.lanesCreate) return overrides.lanesCreate(prompt)
        const keys = [...prompt.matchAll(/wt-lane\/(\S+)/g)].map((m) => m[1])
        return { created: [...new Set(keys)], failures: [], note: 'lane worktrees added' }
      }
      if (label.startsWith('dev-implement:prepare:')) {
        if (overrides?.prepare) return overrides.prepare(prompt)
        return { ok: true, note: 'setup command ran' }
      }
      if (label === 'dev-implement:setup') {
        if (overrides?.setup) return overrides.setup(prompt)
        return { isGitRepo: true, headSha: 'base000', gitRoot: '/repo', note: 'git repo confirmed' }
      }
      if (label.startsWith('dev-implement:finalize:')) {
        if (overrides?.finalize) return overrides.finalize(prompt)
        return { committed: true, sha: 'c0ffee1', note: 'committed' }
      }
      if (label.startsWith('dev-implement:merge:')) {
        const i = mergeCalls++
        if (overrides?.merge) return overrides.merge(prompt, i)
        return { merged: true, conflict: false, preMergeSha: `pre${i}`, mergeSha: `mrg${i}`, note: 'merged clean' }
      }
      if (label.startsWith('dev-implement:integration:')) {
        const i = integrationCalls++
        if (overrides?.integration) return overrides.integration(prompt, i)
        return { green: true, evidence: 'suite green on main', failureSummary: '' }
      }
      if (label.startsWith('dev-implement:revert:')) {
        revertCalls++
        if (overrides?.revert) return overrides.revert(prompt)
        const sha = /git reset --hard (\S+)/.exec(prompt)?.[1] ?? `pre${revertCalls - 1}`
        return { reverted: true, headSha: sha, note: 'reset done' }
      }
      if (label === 'dev-implement:cleanup') {
        if (overrides?.cleanup) return overrides.cleanup(prompt)
        const ids = [...prompt.matchAll(/^(\S+): \S+ \([^)]+\)$/gm)].map((m) => m[1])
        return { removed: ids, failures: [], note: 'cleaned' }
      }
      if (label.startsWith('dev-implement:check:')) {
        if (overrides?.check) return overrides.check(prompt)
        return { green: true, evidence: 'Test suite passed: 12/12', failureSummary: '' }
      }
      if (label.startsWith('dev-implement:red:')) {
        if (overrides?.red) return overrides.red(prompt)
        return { written: true, testFiles: ['test/x.test.ts'], note: 'failing tests written' }
      }
      if (label.startsWith('dev-implement:green:')) {
        if (overrides?.green) return overrides.green(prompt)
        return { done: true, filesTouched: ['src/x.ts'], note: 'implemented' }
      }
      throw new Error(`makeWtRuntime: unrouted label "${label}" — prompt: ${prompt.slice(0, 100)}`)
    },
  })
}

describe('cleanup prompt plugin-root resolution — ground truth, not a string match', () => {
  if (process.platform === 'win32') {
    it.skip('bash-execution lock skipped on win32 (POSIX-only Bash-tool shell)', () => {})
    return
  }

  let fixtureRoot: string
  let configDir: string
  let pluginContentRoot: string

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'wt-dev-implement-plugin-root-'))
    configDir = join(fixtureRoot, 'home', '.claude')
    pluginContentRoot = join(fixtureRoot, 'cache', 'workflow-toolbox', 'workflow-toolbox', '9.9.9')
    mkdirSync(join(configDir, 'plugins'), { recursive: true })
    mkdirSync(join(pluginContentRoot, 'bin'), { recursive: true })
    writeFileSync(join(pluginContentRoot, 'bin', 'wt-worktree-remove.mjs'), '// fixture\n')
    writeFileSync(
      join(configDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'workflow-toolbox@workflow-toolbox': [
            { scope: 'user', installPath: pluginContentRoot, version: '9.9.9' },
          ],
        },
      }),
    )
  })

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  // EXTRACTS the resolution expression from the PROMPT THE WORKFLOW ACTUALLY
  // EMITS (not from a copy-pasted constant) — a string match on "the
  // expansion looks right" is not evidence the expansion RESOLVES with
  // both variables unset (see opencode-plugin-root-resolution.test.ts).
  function extractExprFromPrompt(prompt: string): string {
    const m = /node "(\$\{CLAUDE_PLUGIN_ROOT:-[^]*?)\/bin\/wt-worktree-remove\.mjs"/.exec(prompt)
    if (!m) throw new Error('resolution expression not found in the emitted cleanup prompt')
    return m[1]!
  }

  it('the fallback expression the workflow actually emits resolves to the fixture installPath with CLAUDE_PLUGIN_ROOT, WT_PLUGIN_ROOT and HOME all unset (the Workflow-tool case)', async () => {
    const rt = makeWtRuntime()
    await wf.run(rt, JSON.stringify(WT_INPUT))
    const cleanup = rt.calls.find((c) => c.opts?.label === 'dev-implement:cleanup')!
    const expr = extractExprFromPrompt(cleanup.prompt)
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir }
    delete env.CLAUDE_PLUGIN_ROOT
    delete env.WT_PLUGIN_ROOT
    delete env.HOME
    // `set -e` makes the exit status below load-bearing: without it, a
    // failing command substitution inside the resolution expression still
    // exits 0 (bash does not abort on a failed substitution by default), so
    // `expect(res.status).toBe(0)` would pass even when resolution is broken.
    const script = `set -e\nRESOLVED="${expr}"\nprintf '%s' "$RESOLVED"`
    const res = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toBe(pluginContentRoot)
  })

  it('still prefers pluginRoot when supplied — the fallback expression is never emitted at all', async () => {
    const rt = makeWtRuntime()
    await wf.run(rt, JSON.stringify({ ...WT_INPUT, pluginRoot: '/opt/wt-plugin' }))
    const cleanup = rt.calls.find((c) => c.opts?.label === 'dev-implement:cleanup')!
    expect(() => extractExprFromPrompt(cleanup.prompt)).toThrow()
  })
})
