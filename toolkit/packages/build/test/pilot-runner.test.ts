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
    expect(parsePilotRunnerArgs(['--card', '1', '--dir', '/tmp/a', '--card-file', '/tmp/card.md'])).toMatchObject({ cardFile: '/tmp/card.md' })
    const f = fixture(); const profile = join(f.root, 'profile.json'); writeFileSync(profile, '{"env":{"X":3}}')
    expect(() => loadProfileEnv(profile)).toThrow('--profile-env env.X must be a string')
    const result = spawnSync(process.execPath, [CLI, '--dir', f.dir], { encoding: 'utf8' })
    expect(result.status).toBe(2); expect(result.stderr).toContain('missing required --card or --dir')
  })

  it('parses a positive lane-silence interval', () => {
    expect(parsePilotRunnerArgs(['--card', '1', '--dir', '/tmp/a'])).toMatchObject({ laneSilence: 12 })
    expect(parsePilotRunnerArgs(['--card', '1', '--dir', '/tmp/a', '--lane-silence', '3'])).toMatchObject({ laneSilence: 3 })
    expect(parsePilotRunnerArgs(['--card', '1', '--dir', '/tmp/a', '--lane-silence', '0'])).toMatchObject({ error: '--lane-silence must be a positive number of minutes' })
  })

  it('injects one silence turn for an inactive lane and records it', async () => {
    const f = fixture(); const log = join(f.dir, '.lane', 'executor.log'); writeFileSync(log, 'pid=12\n')
    const injected: string[] = []; let clock = 0
    const query = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      await prompt.next()
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node plugin/bin/wt-lane.mjs' } }] } }
      yield { type: 'user', message: { content: `pid=12\nlog=${log}` } }
      clock = 60_001
      const silence = await prompt.next(); injected.push(silence.value.message.content)
    })()
    const result = await runPilot({ card: '186', dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 120, laneSilence: 1, hard: false }, {
      query, resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } }),
      now: () => clock, sleep: async () => { clock = 120_001 }, newestMtime: () => 0, pidAlive: () => true,
    })
    expect(injected).toEqual(['lane silent: no write for 1 min, log 7 B, pid alive'])
    expect(result.summary).toMatchObject({ silence_injections: 1, injected_turns: 1 })
  })

  it('does not inject silence after worktree activity or an exit marker', async () => {
    for (const terminal of [false, true]) {
      const f = fixture(); const log = join(f.dir, '.lane', 'executor.log'); writeFileSync(log, terminal ? 'pid=12\nEXIT=0\n' : 'pid=12\n')
      const injected: string[] = []; let clock = 0
      const query = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
        await prompt.next()
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node plugin/bin/wt-lane.mjs' } }] } }
        yield { type: 'user', message: { content: `pid=12\nlog=${log}` } }
        clock = 60_001
        const next = await prompt.next(); if (!next.done) injected.push(next.value.message.content)
      })()
      const result = await runPilot({ card: '186', dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 120, laneSilence: 1, hard: false }, {
        query, resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } }),
        now: () => clock, sleep: async () => { clock = 120_001 }, newestMtime: () => terminal ? 0 : 60_000, pidAlive: () => true,
      })
      expect(injected).not.toContain(expect.stringContaining('lane silent:'))
      expect(result.summary.silence_injections).toBe(0)
    }
  })

  it('injects again only after activity opens a second silence window', async () => {
    const f = fixture(); const log = join(f.dir, '.lane', 'executor.log'); writeFileSync(log, 'pid=12\n')
    const injected: string[] = []; let clock = 0; let mtime = 0; let sleeps = 0
    const query = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      await prompt.next()
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node plugin/bin/wt-lane.mjs' } }] } }
      yield { type: 'user', message: { content: `pid=12\nlog=${log}` } }
      clock = 60_001; injected.push((await prompt.next()).value.message.content)
      mtime = 60_002; clock = 60_002
      injected.push((await prompt.next()).value.message.content)
    })()
    const result = await runPilot({ card: '186', dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 240, laneSilence: 1, hard: false }, {
      query, resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } }),
      now: () => clock, sleep: async () => { clock = ++sleeps === 1 ? 120_003 : 240_001 }, newestMtime: () => mtime, pidAlive: () => null,
    })
    expect(injected).toEqual([
      'lane silent: no write for 1 min, log 7 B, pid unknown',
      'lane silent: no write for 1 min, log 7 B, pid unknown',
    ])
    expect(result.summary.silence_injections).toBe(2)
  })

  it('places an arbiter card file verbatim in the first prompt without changing prompts that omit it', async () => {
    const f = fixture(); const cardFile = join(f.root, 'card.md'); const card = '# Card title\n\nDefinition of done: ship it.\n'
    writeFileSync(cardFile, card)
    const prompts: string[] = []
    const query = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      const first = await prompt.next(); prompts.push(first.value.message.content)
    })()
    const models = () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } })
    await runPilot({ card: '186', cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: false }, { query, resolvePilotModels: models })
    expect(prompts[0]).toContain(`## The card, verbatim\n\n${card}`)
    expect(prompts[0]).toContain('do not re-read the card from the board; the text above is the card')

    await runPilot({ card: '186', dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: false }, { query, resolvePilotModels: models })
    expect(prompts[1]).toBe(`Pilot card 186 in ${f.dir}. Launch executor lanes only with node ${join(f.root, '../bin/wt-lane.mjs')} and end your turn immediately after launch.`)
  })

  it('turns mailbox input and a completed lane log into prompt turns, and writes measured shapes', async () => {
    const f = fixture(); const mailbox = join(f.root, 'mailbox.txt'); const log = join(f.dir, '.lane', 'executor.log')
    writeFileSync(mailbox, 'owner says proceed\n')
    const yielded: string[] = []
    const logged: string[] = []
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
      log: (line: string) => logged.push(line),
    })
    expect(yielded).toContain('lane done: EXIT=0, report 0 B at ' + join(f.dir, '.lane', 'report.md'))
    expect(result.summary.report_exists).toBe(false)
    expect(yielded).toContain('Message from the owner: owner says proceed')
    expect(result.usage).toMatchObject({ fresh_tokens: 73, tool_names: ['Bash'] })
    expect(result.usage.turns[1].tool_names).toEqual([])
    expect(logged).toEqual([
      `injected: lane done: EXIT=0, report 0 B at ${join(f.dir, '.lane', 'report.md')}`,
      'injected: owner message Message from the owner: owner says proceed',
    ])
    expect(result.summary).toMatchObject({ fresh_tokens: 73, turns: 2, injected_turns: 2, longest_tool_call_ms: 0 })
    expect(JSON.parse(readFileSync(join(f.dir, '.lane', 'usage.json'), 'utf8')).turns).toHaveLength(2)
    expect(JSON.parse(readFileSync(join(f.dir, '.lane', 'summary.json'), 'utf8')).minutes).toBeTypeOf('number')
  })

  it('logs a timeout injection and counts it in the summary', async () => {
    const f = fixture(); const logged: string[] = []; let calls = 0
    const query = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      await prompt.next()
      const timeout = await prompt.next()
      expect(timeout.value.message.content).toContain('Runner timeout reached')
    })()
    const result = await runPilot({ card: '186', dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 1, hard: false }, {
      query,
      resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } }),
      now: () => calls++ === 0 ? 0 : 1001,
      log: (line: string) => logged.push(line),
    })
    expect(logged).toEqual(['injected: timeout Runner timeout reached. Write .lane/pilot-report.md with the current state and end your turn.'])
    expect(result.summary.injected_turns).toBe(1)
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
    const prompt = readFileSync(join(ROOT, 'plugin/evals-draft/pilot-contract-launch-then-end/prompt.md'), 'utf8')
    const quoted = prompt.split('\n').filter((l) => l.startsWith('> ')).map((l) => l.slice(2)).join(' ').replace(/\s+/g, ' ')
    expect(quoted.length).toBeGreaterThan(200)
    expect(contract).toContain(quoted)
  })

  it('keeps the adopted contract under 6 KB', () => {
    expect(readFileSync(join(ROOT, 'plugin/autonomy/PILOT-CONTRACT.md')).byteLength).toBeLessThanOrEqual(6 * 1024)
    expect(readFileSync(join(ROOT, 'plugin/skills/adopt/scripts/install.mjs'), 'utf8')).toContain("{ file: 'PILOT-CONTRACT.md' }")
  })
})
