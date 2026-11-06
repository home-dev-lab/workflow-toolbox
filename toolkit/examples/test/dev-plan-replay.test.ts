import { readFileSync } from 'node:fs'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import dgram from 'node:dgram'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import { assertSchema } from './dev-plan-test-schema.js'

interface RecordedTask { title: string; files: { path: string }[] }
interface Recording {
  input: { goal: string; areas: string[]; projectDir: string }
  agents: Record<string, unknown>
}
const fixturePath = process.env.DEV_PLAN_REPLAY_FIXTURE ??
  new URL('./fixtures/dev-plan-zero-survivors.replay.json', import.meta.url)
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Recording
const candidates = Object.entries(fixture.agents)
  .filter(([label]) => /^planAndExecute:work:\d+$/.test(label))
  .sort(([a], [b]) => Number(a.split(':').at(-1)) - Number(b.split(':').at(-1)))
  .flatMap(([, result]) => (result as { tasks: RecordedTask[] }).tasks)
const attempts: string[] = []
let workflow: typeof import('../dev-plan.workflow.js')

function denyNetwork(api: string): never {
  attempts.push(api)
  throw new Error(`Replay attempted network access: ${api}`)
}

beforeAll(async () => {
  vi.stubGlobal('fetch', () => denyNetwork('fetch'))
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => denyNetwork('net.connect'))
  vi.spyOn(http, 'request').mockImplementation(() => denyNetwork('http.request'))
  vi.spyOn(https, 'request').mockImplementation(() => denyNetwork('https.request'))
  vi.spyOn(dns, 'lookup').mockImplementation(() => denyNetwork('dns.lookup'))
  vi.spyOn(dgram, 'createSocket').mockImplementation(() => denyNetwork('dgram.createSocket'))
  workflow = await import('../dev-plan.workflow.js')
})
afterEach(() => { expect(attempts).toEqual([]) })
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function replayRuntime(agents: Recording['agents']) {
  const requested: string[] = [], missing: string[] = [], invalid: string[] = []
  const rt = new FakeRuntime({ onAgent: ({ opts }) => {
    const label = opts?.label ?? ''
    requested.push(label)
    if (!Object.hasOwn(agents, label)) {
      missing.push(label)
      throw new Error(`Missing recorded agent: ${label}`)
    }
    const result = agents[label]
    if (opts?.schema) {
      try { assertSchema(result, opts.schema) }
      catch (error) { invalid.push(`${label}: ${String(error)}`); throw error }
    }
    return result
  } })
  return { rt, requested, missing, invalid }
}

function assertVoteBindings(rt: FakeRuntime): void {
  const bindings = new Map<number, string>()
  for (const call of rt.calls) {
    const match = /^adversarialVerification:verify:(\d+):\d+$/.exec(call.opts?.label ?? '')
    if (!match) continue
    const claim = Number(match[1])
    const titles = candidates.filter(task => call.prompt.includes(task.title)).map(task => task.title)
    expect(titles).toEqual([candidates[claim]!.title])
    if (bindings.has(claim)) expect(bindings.get(claim)).toBe(titles[0])
    bindings.set(claim, titles[0]!)
  }
  expect(bindings.size).toBe(candidates.length)
  expect(new Set(bindings.values()).size).toBe(candidates.length)
}

function assertReplay(run: ReturnType<typeof replayRuntime>, synthesized: boolean): void {
  expect.soft(run.missing).toEqual([])
  expect.soft(run.invalid).toEqual([])
  const expected = Object.keys(fixture.agents).filter(label => synthesized || label !== 'dev-plan:synthesize')
  expect.soft([...run.requested].sort()).toEqual(expected.sort())
  assertVoteBindings(run.rt)
  expect(attempts).toEqual([])
}

function reasonsFor(claim: number): string[] {
  return Object.entries(fixture.agents)
    .filter(([label]) => label.startsWith(`adversarialVerification:verify:${claim}:`))
    .map(([, result]) => result as { verdict: string; reason: string })
    .filter(vote => vote.verdict === 'refuted').map(vote => vote.reason)
}

function assertTaskDiagnostics(message: string): void {
  candidates.forEach((task, claim) => {
    const start = message.indexOf(`${task.title} — files:`)
    expect(start).toBeGreaterThanOrEqual(0)
    const next = candidates[claim + 1]
    const end = next ? message.indexOf(`${next.title} — files:`, start + 1) : message.length
    const block = message.slice(start, end)
    for (const file of task.files) expect(block).toContain(file.path)
    for (const reason of reasonsFor(claim)) expect(block).toContain(reason)
  })
}

async function replayRecordedStop(): Promise<void> {
  const run = replayRuntime(fixture.agents)
  const promise = workflow.default.run(run.rt, JSON.stringify(fixture.input))
  const error: unknown = await promise.catch((failure: unknown) => failure)
  assertReplay(run, false)
  await expect(promise).rejects.toThrow(/0 of 8.*accepted.*no plan is emitted/is)
  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  assertTaskDiagnostics(message)
}

async function replayPartialSurvival(): Promise<void> {
  const agents = structuredClone(fixture.agents)
  for (const label of Object.keys(agents)) {
    if (label.startsWith('adversarialVerification:verify:0:')) {
      agents[label] = { verdict: 'confirmed', reason: 'Confirmed for the partial-survival replay' }
    }
  }
  const run = replayRuntime(agents)
  try {
    const result = await workflow.default.run(run.rt, JSON.stringify(fixture.input))
    const rejected = candidates.slice(1).map((task, index) => ({
      title: task.title, files: task.files.map(file => file.path), verdict: 'refuted',
      reason: reasonsFor(index + 1).join('; '),
    }))
    expect(result.artifact.rejected).toEqual(rejected)
    expect(result.artifact.rejected).toEqual(result.rejected)
    expect(result.artifact.rejected).toHaveLength(7)
    expect(result.artifact.rejected.map(task => task.title)).not.toContain(candidates[0]!.title)
    assertSchema(result.artifact, workflow.PLAN_ARTIFACT_SCHEMA)
  } finally { assertReplay(run, true) }
}

describe('dev-plan offline recorded replay', () => {
  it('stops the recorded all-refuted run before synthesis, preserving every rejection', replayRecordedStop)
  it('publishes the seven rejected tasks when one recorded claim is accepted', replayPartialSurvival)
})
