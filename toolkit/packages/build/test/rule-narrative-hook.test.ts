import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { sealRuleNarrative, sealRuleNarrativeFile } from '../../../test-support/rule-narrative-stub.js'
import { runSplitChild } from '../../../../plugin/bin/lib/rule-narrative-split.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-rule-convention-guard-hook.mjs')
const MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')
const roots: string[] = []
const fileSeal = sealRuleNarrativeFile()
afterAll(fileSeal.restore)
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// One read decides liveness: a stat file that vanished between check and read (ENOENT/ESRCH) is not alive.
function aliveOnProc(stat: string): boolean {
  try { return !readFileSync(stat, 'utf8').includes(') Z ') }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ESRCH') return false
    throw error
  }
}

function fixture(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `wt-rule-narrative-${tag}-`))
  roots.push(root)
  return { root, env: { ...process.env, TEST_RULE_STUB_RECORD: join(root, 'record.json') } }
}

function runHook(payload: unknown, env: NodeJS.ProcessEnv) {
  const root = mkdtempSync(join(tmpdir(), 'wt-rule-narrative-seal-'))
  roots.push(root)
  const run = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8',
    env: sealRuleNarrative(root, env), timeout: 15000, killSignal: 'SIGKILL' })
  const stdout = run.stdout.trim()
  const output = stdout ? JSON.parse(stdout).hookSpecificOutput : {}
  return { status: run.status, stdout, decision: output.permissionDecision, reason: output.permissionDecisionReason ?? '' }
}

function writePayload(file_path: string, content: string, cwd: string) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Write', cwd, tool_input: { file_path, content } }
}

// These end-to-end stub launches need POSIX executable scripts. Windows's
// native launcher limitation is exercised through the injectable runner locks.
describe.skipIf(process.platform === 'win32')('rule narrative hook', () => {
  it.each([
    ['Alice (28 Sept 2026 11:45)', 'DATE (MONTH)'],
    ['Alice said at 16h50 to retry.', 'DATED ATTRIBUTION'],
    ['See #5797 for the report.', 'MESSAGE ID'],
    ['Yesterday retries failed.', 'INCIDENT'],
    ['Run backups (02:30 UTC).', 'DATED ATTRIBUTION'],
  ])('warns without a permission decision for %s', (text, detector) => {
    const f = fixture('warn')
    const run = runHook(writePayload(join(f.root, 'rules', 'x.md'), text, f.root), f.env)
    const output = JSON.parse(run.stdout).hookSpecificOutput
    expect(output.permissionDecision).toBeUndefined()
    expect(output.additionalContext).toContain(detector)
    expect(output.additionalContext.split('HISTORY —')[1].split('RULE —')[0]).toContain(`line 1: ${text}`)
    expect(output.additionalContext).toContain('Keep retries enabled.')
  })

  it('warns on an allow-marker attribution while preserving the original HISTORY', () => {
    const f = fixture('marker')
    const text = 'Alice (2026 11:45) 2026-10-01 <!-- rule-lint: allow -->'
    const run = runHook(writePayload(join(f.root, 'rules', 'x.md'), text, f.root), f.env)
    expect(run.decision).toBeUndefined()
    expect(JSON.parse(run.stdout).hookSpecificOutput.additionalContext.split('HISTORY —')[1].split('RULE —')[0]).toContain(`line 1: ${text}`)
  })

  it('ignores legacy dated Edit context and Write text already on disk', () => {
    const f = fixture('legacy')
    const file = join(f.root, 'rules', 'x.md')
    mkdirSync(join(f.root, 'rules'))
    writeFileSync(file, 'legacy 2026-10-01')
    const edit = { hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: f.root,
      tool_input: { file_path: file, old_string: 'legacy 2026-10-01', new_string: 'legacy 2026-10-01\nKeep retries.' } }
    expect(runHook(edit, f.env).stdout).toBe('')
    expect(runHook(writePayload(file, 'legacy 2026-10-01\nKeep retries.', f.root), f.env).stdout).toBe('')
    expect(existsSync(f.env.TEST_RULE_STUB_RECORD!)).toBe(false)
  })

  it('sends exact isolation argv, context, tmp cwd, and a scrubbed child environment', () => {
    const f = fixture('isolation')
    const run = runHook(writePayload(join(f.root, 'rules', 'x.md'), 'Context\nAlice (11:45)\nAfter', f.root), {
      ...f.env, ATRIUM_IDENTITY: 'test identity', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'test',
    })
    expect(run.status).toBe(0)
    const record = JSON.parse(readFileSync(f.env.TEST_RULE_STUB_RECORD!, 'utf8'))
    expect(record.argv.slice(2, -2)).toEqual(['--model', 'haiku', '--setting-sources', '', '--strict-mcp-config',
      '--disable-slash-commands', '--tools', '', '--no-session-persistence'])
    expect(record.argv[0]).toBe('-p')
    expect(record.argv.at(-2)).toBe('--system-prompt')
    expect(record.argv[1]).not.toContain('Alice')
    expect(record.stdin).toContain('Alice (11:45)')
    expect(record.stdin).toContain('Context')
    expect(record.stdin).toContain('After')
    // The stub reports process.cwd(), which the OS resolves through symlinks (macOS /var -> /private/var).
    expect(realpathSync(record.cwd)).toBe(realpathSync(tmpdir()))
    expect(record.env).toEqual({ CLAUDE_CODE_DISABLE_THINKING: '1', WT_RULE_NARRATIVE_SPLIT_CHILD: '1' })
  })

  it.each([
    ['fenced', 'Keep retries enabled.'], ['dated', 'proposal still contains narrative'],
    ['missing', 'proposal coverage'], ['empty', 'empty proposal'], ['invalid', 'invalid JSON'],
    ['exit', 'child exited with code 1'], ['absent', 'spawn error ENOENT'], ['flood', 'child stdout exceeds cap'],
  ])('keeps a denial when the model fixture is %s', (mode, expected) => {
    const f = fixture('proposal')
    const run = runHook(writePayload(join(f.root, 'rules', 'x.md'), 'Keep retries since 2026-10-01.', f.root), {
      ...f.env, TEST_RULE_STUB_MODE: mode,
    })
    expect(run.status).toBe(0)
    expect(run.decision).toBe('deny')
    expect(run.reason).toContain(expected)
    expect(run.reason).toContain('line 1: Keep retries since 2026-10-01.')
  })

  it.each(['stall', 'grandchild', 'exit-descendant'])('bounds a hostile %s child and prints the decision', (mode) => {
    const f = fixture('deadline')
    const start = Date.now()
    const run = runHook(writePayload(join(f.root, 'rules', 'x.md'), 'Keep retries since 2026-10-01.', f.root), {
      ...f.env, TEST_RULE_STUB_MODE: mode, WT_RULE_NARRATIVE_SPLIT_TIMEOUT_MS: '1000',
    })
    expect(Date.now() - start).toBeLessThan(3000)
    expect(run.status).toBe(0)
    expect(run.decision).toBe('deny')
    expect(run.reason).toContain('no proposal available')
    if (mode !== 'exit-descendant') expect(run.reason).toContain('split deadline exceeded')
  }, 5000)

  it('kills a process-group grandchild positively observed alive before the kill', async (context) => {
    const f = fixture('cleanup')
    const env = sealRuleNarrative(f.root, { ...f.env, TEST_RULE_STUB_MODE: 'grandchild' })
    const controller = new AbortController()
    const result = runSplitChild({ instruction: 'fixture', stdin: '{"lines":[]}', timeoutMs: 20000,
      env, signal: controller.signal })
    let record: { pid: number; grandchild: number } | undefined
    try {
      const readyUntil = Date.now() + 15000
      while (Date.now() < readyUntil && !record) {
        await new Promise(resolve => setTimeout(resolve, 10))
        if (existsSync(env.TEST_RULE_STUB_RECORD!)) record = JSON.parse(readFileSync(env.TEST_RULE_STUB_RECORD!, 'utf8'))
      }
      expect(record?.grandchild).toBeGreaterThan(0)
      const stat = `/proc/${record!.grandchild}/stat`
      if (!existsSync(stat)) context.skip('Grandchild liveness assertion requires readable /proc/<pid>/stat; unavailable on this host.')
      let before: string
      try { before = readFileSync(stat, 'utf8') }
      catch { context.skip('Grandchild liveness assertion requires readable /proc/<pid>/stat; unavailable on this host.'); return }
      expect(before).not.toContain(') Z ')
      controller.abort()
      expect(await result).toEqual({ ok: false, reason: 'split deadline exceeded' })
      const goneUntil = Date.now() + 15000
      while (Date.now() < goneUntil && aliveOnProc(stat)) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      // A vanished pid is termination only after we witnessed it alive on /proc.
      expect(aliveOnProc(stat)).toBe(false)
    } finally {
      controller.abort()
      await result
      if (record?.pid) { try { process.kill(-record.pid, 'SIGKILL') } catch { /* gone */ } }
    }
  }, 30000)

  it('emits the decision and exits on its own watchdog when an injected split never resolves', () => {
    const f = fixture('watchdog')
    const file = join(f.root, 'rules', 'x.md')
    const script = `import { enrichDecision } from ${JSON.stringify(new URL('../../../../plugin/bin/wt-rule-convention-guard-hook.mjs', import.meta.url).href)};
      const keepAlive = setInterval(() => {}, 1000);
      await enrichDecision(${JSON.stringify(writePayload(file, '2026-10-01', f.root))},
        [{lineNumber:1,tier:'deny',detector:'DATE (ISO)',match:'2026-10-01',snippet:'2026-10-01'}],
        [{lineNumber:1,text:'2026-10-01'}], () => new Promise(() => {}));
      clearInterval(keepAlive);`
    const start = Date.now()
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL',
      env: { ...f.env, WT_RULE_NARRATIVE_SPLIT_TIMEOUT_MS: '1000' },
    })
    expect(Date.now() - start).toBeLessThan(3000)
    expect(run.status).toBe(0)
    const output = JSON.parse(run.stdout).hookSpecificOutput
    expect(output.permissionDecision).toBe('deny')
    expect(output.permissionDecisionReason).toContain('split deadline exceeded')
    expect(existsSync(f.env.TEST_RULE_STUB_RECORD!)).toBe(false)
  }, 20000)

  it('escapes HISTORY controls in the decoded hook output', () => {
    const f = fixture('controls')
    const run = runHook(writePayload(join(f.root, 'rules', 'x.md'), 'Yesterday\u001b[2J\u0000\r\u200b\t```', f.root), f.env)
    const message = JSON.parse(run.stdout).hookSpecificOutput.additionalContext
    expect(message.split('HISTORY —')[1].split('RULE —')[0]).toContain('line 1: Yesterday\\u001b[2J\\u0000\\r\\u200b\t```')
    expect(message.replaceAll('\n', '').replaceAll('\t', '')).not.toMatch(/[\p{Cc}\p{Cf}]/u)
  })

  it('does not invoke the stub for clean writes, a kill switch, or recursive calls', () => {
    const f = fixture('no-child')
    const file = join(f.root, 'rules', 'x.md')
    expect(runHook(writePayload(file, 'Keep retries.', f.root), f.env).stdout).toBe('')
    const off = runHook(writePayload(file, '2026-10-01', f.root), { ...f.env, WT_RULE_NARRATIVE_SPLIT: 'off' })
    expect(off.decision).toBe('deny')
    expect(off.reason).toContain('split disabled')
    const largeOff = runHook(writePayload(file, `2026-10-01 ${'x'.repeat(13000)}`, f.root), {
      ...f.env, WT_RULE_NARRATIVE_SPLIT: 'off',
    })
    expect(largeOff.decision).toBe('deny')
    expect(largeOff.reason).toContain('split disabled')
    expect(runHook(writePayload(file, '2026-10-01', f.root), { ...f.env, WT_RULE_NARRATIVE_SPLIT_CHILD: '1' }).stdout).toBe('')
    expect(existsSync(f.env.TEST_RULE_STUB_RECORD!)).toBe(false)
  })

  it('caps a 50 kB Write with closed fences and explicit incomplete HISTORY', () => {
    const f = fixture('large')
    const run = runHook(writePayload(join(f.root, 'rules', 'x.md'), 'Yesterday failures happened.\n'.repeat(1850), f.root), f.env)
    const message = JSON.parse(run.stdout).hookSpecificOutput.additionalContext
    expect(run.stdout.length).toBeLessThan(9500)
    expect(message.match(/^`{3,}$/gm)).toHaveLength(4)
    expect(message).toMatch(/\d+ more flagged lines not shown/)
    expect(message).toContain('no proposal available (split input exceeds cap)')
    expect(existsSync(f.env.TEST_RULE_STUB_RECORD!)).toBe(false)
  })

  it('journals one decision with sorted unique detector classes', () => {
    const f = fixture('journal')
    const dir = join(f.root, 'journal')
    for (const text of ['2026-10-01 Yesterday #5797', 'Yesterday #5797']) {
      runHook(writePayload(join(f.root, 'rules', 'x.md'), text, f.root), {
        ...f.env, WT_GUARD_JOURNAL_DIR: dir, WT_GUARD_JOURNAL_NOW: '2026-10-01T00:00:00Z',
      })
    }
    const records = readFileSync(join(dir, '2026-W40.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(records.map(record => record.decision)).toEqual(['blocked', 'warned'])
    expect(records.map(record => record.class)).toEqual(['DATE (ISO),INCIDENT,MESSAGE ID', 'INCIDENT,MESSAGE ID'])
  })

  it('registers a thirty-second timeout for the rule convention hook', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    const hook = manifest.hooks.PreToolUse.flatMap((entry: { hooks: { command: string; timeout?: number }[] }) => entry.hooks)
      .find((entry: { command: string }) => entry.command.includes('wt-rule-convention-guard-hook.mjs'))
    expect(hook.timeout).toBe(30)
  })
})

describe('aliveOnProc', () => {
  it('reads a vanished /proc stat file as not alive instead of throwing', () => {
    expect(aliveOnProc('/proc/999999999/stat')).toBe(false)
  })
})
