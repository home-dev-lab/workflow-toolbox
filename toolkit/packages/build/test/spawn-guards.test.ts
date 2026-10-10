import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { channelFalse, channelTrue, readonlyFalse, readonlyTrue, nestedFalse, nestedTrue } from './spawn-guard-precision-fixtures.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const BIN = join(REPO_ROOT, 'plugin/bin')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function fixture(name: string, tools?: string) {
  const root = mkdtempSync(join(tmpdir(), 'wt-spawn-guard-'))
  roots.push(root)
  const agents = join(root, '.claude', 'agents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, `${name}.md`), `---\nname: ${name}\ndescription: test agent${tools === undefined ? '' : `\ntools: ${tools}`}\n---\n`)
  const store = join(root, 'empty-config', 'plugins', 'store')
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'wt-secret-guard.json'), JSON.stringify({ salt: 'fixture', detections: { entries: [] } }))
  return root
}

function run(hook: string, payload: unknown, cwd: string) {
  const journal = join(cwd, 'journal')
  const result = spawnSync(process.execPath, [join(BIN, hook)], {
    input: JSON.stringify(payload), encoding: 'utf8',
    // The journal file is named by ISO week, so the clock is PINNED (WT_GUARD_JOURNAL_NOW): written on
    // 2026-09-06 (W36) this test read `2026-W36.ndjson` from the real clock and went red the next morning.
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(cwd, 'empty-config'), WT_GUARD_JOURNAL_DIR: journal, WT_GUARD_JOURNAL_NOW: '2026-09-06T12:00:00Z' },
  })
  const journalFile = join(journal, '2026-W36.ndjson')
  return { ...result, journal: existsSync(journalFile) ? readFileSync(journalFile, 'utf8') : '' }
}

function agent(type: string, prompt: string, cwd: string, agent_id?: string) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 's-1', ...(agent_id ? { agent_id } : {}), cwd, tool_input: { subagent_type: type, prompt } }
}

function silent(result: { status: number | null; stdout: string | Buffer | undefined; stderr: string | Buffer | undefined }) {
  expect(result.status).toBe(0)
  expect(String(result.stdout)).toBe('')
  expect(String(result.stderr)).toBe('')
}

function warns(result: { status: number | null; stdout: string | Buffer | undefined; journal: string }, cls: string) {
  expect(result.status).toBe(0)
  expect(String(result.stdout)).toContain('additionalContext')
  expect(String(result.stdout)).not.toContain('"deny"')
  expect(result.journal).toContain('"decision":"warned"')
  expect(String(result.journal)).toContain(`"class":"${cls}"`)
}

function denies(result: { stdout: string | Buffer | undefined; journal: string }, cls: string) {
  expect(String(result.stdout)).toContain('"permissionDecision":"deny"')
  expect(String(result.stdout)).toContain('args.perAgent.model')
  expect(String(result.journal)).toContain(`"class":"${cls}"`)
}

async function runObserveLaunch(args: unknown): Promise<{ stderr: string; fetchCalls: number }> {
  const { main } = await import('../../debugger/src/observe-cli.js')
  let stderr = ''
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk)
    return true
  })
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network blocked in test'))
  try {
    const argv = ['launch', 'example.js', ...(args === undefined ? [] : ['--args', JSON.stringify(args)])]
    await main(argv)
    return { stderr, fetchCalls: fetchSpy.mock.calls.length }
  } finally {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    fetchSpy.mockRestore()
  }
}

describe('spawn surface warn-only guards', () => {
  it.each(channelFalse)('spawn channel silence: %s', (_shape, prompt) => {
    const cwd = fixture('reader', 'Read')
    const result = run('wt-spawn-channel-guard-hook.mjs', agent('reader', prompt, cwd), cwd)
    silent(result)
    expect(result.journal).not.toContain('"decision":"warned"')
  })
  it.each(channelTrue)('spawn channel retention: %s', (_shape, prompt) => {
    const cwd = fixture('reader', 'Read')
    warns(run('wt-spawn-channel-guard-hook.mjs', agent('reader', prompt, cwd), cwd), 'spawn-channel-missing')
  })
  it.each(readonlyFalse)('spawn readonly resource label silence: %s', (_shape, prompt) => {
    const cwd = fixture('writer', 'Read, Bash')
    const result = run('wt-spawn-readonly-guard-hook.mjs', agent('writer', prompt, cwd), cwd)
    silent(result)
    expect(result.journal).not.toContain('"decision":"warned"')
  })
  it('spawn readonly: CRLF line endings keep the resource label and the agent-wide cases apart', () => {
    const cwd = fixture('writer', 'Read, Bash')
    const label = 'Implement the change.\r\nKnowledge base (read-only): memory/index.md\r\n'
    silent(run('wt-spawn-readonly-guard-hook.mjs', agent('writer', label, cwd), cwd))
    const agentWide = 'Implement the change.\r\nKnowledge base (read-only): memory/index.md\r\nYou are read-only.\r\n'
    warns(run('wt-spawn-readonly-guard-hook.mjs', agent('writer', agentWide, cwd), cwd), 'spawn-readonly-wide')
  })
  it.each(readonlyTrue)('spawn readonly retention: %s', (_shape, prompt) => {
    const cwd = fixture('writer', 'Read, Bash')
    warns(run('wt-spawn-readonly-guard-hook.mjs', agent('writer', prompt, cwd), cwd), 'spawn-readonly-wide')
  })
  it.each(nestedFalse)('nested spawn silence: %s', (_shape, prompt) => {
    const cwd = fixture('reader', 'Read')
    const result = run('wt-nested-spawn-guard-hook.mjs', agent('reader', prompt, cwd, 'delegate'), cwd)
    silent(result)
    expect(result.journal).not.toContain('"decision":"warned"')
  })
  it.each(nestedTrue)('nested spawn retention: %s', (_shape, prompt) => {
    const cwd = fixture('reader', 'Read')
    warns(run('wt-nested-spawn-guard-hook.mjs', agent('reader', prompt, cwd, 'delegate'), cwd), 'nested-self-verify')
  })
  it('spawn channel: warns when a reporting brief targets a type without SendMessage', () => {
    const cwd = fixture('reader', 'Read, Grep')
    warns(run('wt-spawn-channel-guard-hook.mjs', agent('reader', 'Inspect this and report back via SendMessage when done.', cwd), cwd), 'spawn-channel-missing')
  })

  it('spawn channel: stays silent for SendMessage', () => {
    const cwd = fixture('reader', 'Read, SendMessage')
    const safe = run('wt-spawn-channel-guard-hook.mjs', agent('reader', 'Inspect this and report back via SendMessage when done.', cwd), cwd)
    silent(safe)
  })
  it('spawn channel: strips quoted delivery instructions for a type without SendMessage', () => {
    const cwd = fixture('reader', 'Read')
    silent(run('wt-spawn-channel-guard-hook.mjs', agent('reader', 'Example only: "report back via SendMessage when done".', cwd), cwd))
  })

  it('spawn channel: unresolved types stay silent and journal type-unresolved once', () => {
    const cwd = fixture('reader', 'Read')
    const result = run('wt-spawn-channel-guard-hook.mjs', agent('missing', 'Report back via SendMessage when done.', cwd), cwd)
    silent(result)
    expect(result.journal).toContain('"class":"type-unresolved"')
  })

  it('spawn readonly: distinguishes wide and missing allowlists', () => {
    const wide = fixture('wide', 'Read, Bash')
    warns(run('wt-spawn-readonly-guard-hook.mjs', agent('wide', 'Investigate only. Do not modify.', wide), wide), 'spawn-readonly-wide')
    const absent = fixture('absent')
    warns(run('wt-spawn-readonly-guard-hook.mjs', agent('absent', 'Read-only investigation; do not modify.', absent), absent), 'spawn-readonly-no-allowlist')
  })

  it('spawn readonly: stays silent for a narrow list', () => {
    const cwd = fixture('reader', 'Read, Grep, Glob')
    silent(run('wt-spawn-readonly-guard-hook.mjs', agent('reader', 'Investigate only; do not modify.', cwd), cwd))
  })
  it('spawn readonly: strips quoted task constraints for a writer type', () => {
    const cwd = fixture('writer', 'Read, Bash')
    silent(run('wt-spawn-readonly-guard-hook.mjs', agent('writer', 'Example only: "Read-only investigation; do not modify anything".', cwd), cwd))
  })

  it('spawn readonly: unresolved types stay silent and journal type-unresolved once', () => {
    const cwd = fixture('reader', 'Read')
    const result = run('wt-spawn-readonly-guard-hook.mjs', agent('missing', 'Read-only investigation.', cwd), cwd)
    silent(result)
    expect(result.journal).toContain('"class":"type-unresolved"')
  })

  it('workflow model: denies when args do not declare perAgent.model', () => {
    const cwd = fixture('reader', 'Read')
    const result = run('wt-workflow-model-guard-hook.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Workflow', session_id: 's-1', tool_input: { args: { topic: 'x' } } }, cwd)
    denies(result, 'workflow-model-inherited')
  })

  it('workflow model: models and effort alone do not satisfy the perAgent.model floor', () => {
    const cwd = fixture('reader', 'Read')
    denies(run('wt-workflow-model-guard-hook.mjs', { tool_name: 'Workflow', tool_input: { args: { models: { review: 'sonnet' }, effort: { review: 'high' } } } }, cwd), 'workflow-model-inherited')
  })

  it('workflow model: stays silent for args.perAgent.model', () => {
    const cwd = fixture('reader', 'Read')
    const explicit = run('wt-workflow-model-guard-hook.mjs', { tool_name: 'Workflow', tool_input: { args: { perAgent: { model: 'sonnet' } } } }, cwd)
    silent(explicit)
  })

  it('workflow model: hook and CLI apply the same object-only model policy and refusal text', async () => {
    const cwd = fixture('reader', 'Read')
    const cases: Array<{ name: string; args: unknown; accepted: boolean }> = [
      { name: 'non-empty model', args: { perAgent: { model: 'sonnet' } }, accepted: true },
      { name: 'trimmed non-empty model', args: { perAgent: { model: '  sonnet  ' } }, accepted: true },
      { name: 'missing args', args: undefined, accepted: false },
      { name: 'models and effort only', args: { models: { review: 'sonnet' }, effort: { review: 'high' } }, accepted: false },
      { name: 'nested-only model', args: { stage: { perAgent: { model: 'sonnet' } } }, accepted: false },
      { name: 'null model', args: { perAgent: { model: null } }, accepted: false },
      { name: 'empty model', args: { perAgent: { model: '' } }, accepted: false },
      { name: 'whitespace-only model', args: { perAgent: { model: '   ' } }, accepted: false },
      { name: 'numeric model', args: { perAgent: { model: 0 } }, accepted: false },
      { name: 'boolean model', args: { perAgent: { model: false } }, accepted: false },
      { name: 'object model', args: { perAgent: { model: {} } }, accepted: false },
      // Workflow args is a JSON value. A string containing JSON text is still a string,
      // not the object envelope this guard requires.
      { name: 'JSON-encoded object string', args: '{"perAgent":{"model":"sonnet"}}', accepted: false },
    ]

    for (const testCase of cases) {
      const hook = run('wt-workflow-model-guard-hook.mjs', { tool_name: 'Workflow', tool_input: { args: testCase.args } }, cwd)
      const hookOutput = String(hook.stdout)
      const hookReason = hookOutput === ''
        ? null
        : JSON.parse(hookOutput).hookSpecificOutput.permissionDecisionReason as string
      const cli = await runObserveLaunch(testCase.args)
      const cliReason = cli.stderr.startsWith('wt-observe launch: [workflow-toolbox workflow-model] Refused:')
        ? cli.stderr.slice('wt-observe launch: '.length).trimEnd()
        : null

      expect(hookReason === null, `${testCase.name}: hook acceptance`).toBe(testCase.accepted)
      expect(cliReason === null, `${testCase.name}: CLI acceptance`).toBe(testCase.accepted)
      expect(cliReason, `${testCase.name}: refusal text parity`).toBe(hookReason)
      expect(cli.fetchCalls, `${testCase.name}: refused before network contact`).toBe(testCase.accepted ? 1 : 0)
    }
  })

  it('nested spawn: warns only when a subagent asks for a verifier of its own work', () => {
    const cwd = fixture('reader', 'Read')
    warns(run('wt-nested-spawn-guard-hook.mjs', agent('reader', 'Review my implementation and verify it.', cwd, 'a-1'), cwd), 'nested-self-verify')
    silent(run('wt-nested-spawn-guard-hook.mjs', agent('reader', 'Review the upstream patch.', cwd, 'a-1'), cwd))
    silent(run('wt-nested-spawn-guard-hook.mjs', agent('reader', 'Example only: "review my work".', cwd, 'a-1'), cwd))
  })
})

describe('briefScopesAgentReadOnly', () => {
  const load = async () => (await import(pathToFileURL(join(BIN, 'lib/readonly-brief-scope.mjs')).href)).briefScopesAgentReadOnly as (prompt: string) => boolean
  it.each([
    ['rule 2a: followed by "for you"', 'Notes: memory/ is read-only for you.', false],
    ['rule 2b: a non-you copula precedes it', 'The copies are read-only.', false],
    ['rule 2b excluded subject: task', 'The task is read-only.', true],
    ['rule 2b excluded by "everywhere"', 'The copies are read-only everywhere.', true],
    ['rule 2c: label position after a resource noun', 'Knowledge base (read-only): memory/index.md', false],
    ['rule 2c: a task noun before the parenthesis is not a label', 'Verification (read-only): check the diff.', true],
    ['rule 3: do not modify is never a label', 'Index (do not modify): memory/index.md', true],
    ['rule 3: investigate only is never a label', 'Investigate only the index file.', true],
    ['rule 4: a label plus an occurrence that is not a label warns', 'Index (read-only): memory/index.md. Be read-only on the rest.', true],
    ['rule 4: an agent-wide prohibition beside a label warns', 'Index (read-only): memory/index.md. You cannot write anything.', true],
    ['no trigger', 'Implement the change.', false],
    ['a quoted example does not count', 'Example only: "you are read-only".', false],
  ])('%s', async (_name, prompt, expected) => {
    expect((await load())(prompt)).toBe(expected)
  })
})
