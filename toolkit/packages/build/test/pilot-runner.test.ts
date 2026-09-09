import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { laneLogFrom, loadProfileEnv, parsePilotRunnerArgs, runPilot } from '../../../../plugin/bin/lib/pilot-runner-core.mjs'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(ROOT, 'plugin/bin/wt-pilot-runner.mjs')
const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-pilot-runner-')); roots.push(root)
  const dir = join(root, 'worktree'); mkdirSync(join(dir, '.lane'), { recursive: true })
  const contract = join(root, 'contract.md'); writeFileSync(contract, '# contract\n')
  return { root, dir, contract }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('SDK pilot runner', () => {
  it('parses required arguments and refuses absent card, bad timeout, and malformed profile env', () => {
    expect(parsePilotRunnerArgs(['--dir', '/tmp/a'])).toMatchObject({ error: 'missing required --card or --dir' })
    expect(parsePilotRunnerArgs(['--card', '1', '--dir', '/tmp/a', '--timeout', '0'])).toMatchObject({ error: '--timeout must be a positive number of seconds' })
    const f = fixture(); const profile = join(f.root, 'profile.json'); writeFileSync(profile, '{"env":{"X":3}}')
    expect(() => loadProfileEnv(profile)).toThrow('--profile-env env.X must be a string')
    const result = spawnSync(process.execPath, [CLI, '--dir', f.dir], { encoding: 'utf8' })
    expect(result.status).toBe(2); expect(result.stderr).toContain('missing required --card or --dir')
  })

  it('turns mailbox input and a completed lane log into prompt turns, and writes measured shapes', async () => {
    const f = fixture(); const mailbox = join(f.root, 'mailbox.txt'); const log = join(f.dir, '.lane', 'executor.log')
    writeFileSync(mailbox, 'owner says proceed\n')
    const yielded: string[] = []
    const query = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      const first = await prompt.next(); yielded.push(first.value.message.content)
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'lane', name: 'Bash', input: { command: 'node plugin/bin/wt-lane.mjs --dir x' } }] } }
      yield { type: 'user', message: { content: `pid=12\nlog=${log}` } }
      writeFileSync(log, 'lane output\nEXIT=0\n')
      const laneDone = await prompt.next(); yielded.push(laneDone.value.message.content)
      yield { type: 'result', usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 } }
      const mail = await prompt.next(); yielded.push(mail.value.message.content)
      yield { type: 'result', usage: { input_tokens: 1, output_tokens: 2 } }
    })()
    const result = await runPilot({ card: '186', dir: f.dir, contract: f.contract, mailbox, timeout: 2, hard: false }, {
      query,
      resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } }),
      sleep: async () => {},
    })
    expect(yielded).toContain('lane done: EXIT=0, report 0 B at ' + join(f.dir, '.lane', 'report.md'))
    expect(result.summary.report_exists).toBe(false)
    expect(yielded).toContain('Message from the owner: owner says proceed')
    expect(result.usage).toMatchObject({ fresh_tokens: 73, tool_names: ['Bash'] })
    expect(result.usage.turns[1].tool_names).toEqual([])
    expect(result.summary).toMatchObject({ fresh_tokens: 73, turns: 2, longest_tool_call_ms: 0 })
    expect(JSON.parse(readFileSync(join(f.dir, '.lane', 'usage.json'), 'utf8')).turns).toHaveLength(2)
    expect(JSON.parse(readFileSync(join(f.dir, '.lane', 'summary.json'), 'utf8')).minutes).toBeTypeOf('number')
  })

  it('waits only on a lane answer carrying pid= and log= together, never on a gate record log=', () => {
    expect(laneLogFrom('pid=12\nlog=/w/.lane/executor.log')).toBe('/w/.lane/executor.log')
    expect(laneLogFrom('GATE test: exit=0 log=/records/logs/test.log exit-file=/records/logs/test.exit')).toBeNull()
    expect(laneLogFrom('log=/w/.lane/executor.log')).toBeNull()
  })

  it('stops on the pilot report, never on the lane report at .lane/report.md', async () => {
    const f = fixture(); writeFileSync(join(f.dir, '.lane', 'report.md'), 'lane report\n')
    const yielded: string[] = []
    const query = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      const first = await prompt.next(); yielded.push(first.value.message.content)
      writeFileSync(join(f.dir, '.lane', 'pilot-report.md'), '# pilot\n')
      yield { type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }
      const next = await prompt.next(); if (!next.done) yielded.push(next.value.message.content)
    })()
    const result = await runPilot({ card: '1', dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: false }, {
      query, resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } }), sleep: async () => {},
    })
    expect(yielded).toHaveLength(1)
    expect(result.summary.report_exists).toBe(true)
  })

  it('the launch-then-end eval quotes the contract verbatim (the eval sandbox cannot read the file)', () => {
    const contract = readFileSync(join(ROOT, 'plugin/autonomy/PILOT-CONTRACT.md'), 'utf8').replace(/\s+/g, ' ')
    const prompt = readFileSync(join(ROOT, 'plugin/evals/pilot-contract-launch-then-end/prompt.md'), 'utf8')
    const quoted = prompt.split('\n').filter((l) => l.startsWith('> ')).map((l) => l.slice(2)).join(' ').replace(/\s+/g, ' ')
    expect(quoted.length).toBeGreaterThan(200)
    expect(contract).toContain(quoted)
  })

  it('keeps the adopted contract under 6 KB', () => {
    expect(readFileSync(join(ROOT, 'plugin/autonomy/PILOT-CONTRACT.md')).byteLength).toBeLessThanOrEqual(6 * 1024)
    expect(readFileSync(join(ROOT, 'plugin/skills/adopt/scripts/install.mjs'), 'utf8')).toContain("{ file: 'PILOT-CONTRACT.md' }")
  })
})
