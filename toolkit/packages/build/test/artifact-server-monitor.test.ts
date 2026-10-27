import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
// @ts-expect-error runtime .mjs helper shipped by the plugin has no TypeScript declaration
import { createHostAdapter } from '../../../../plugin/bin/lib/host/adapter.mjs'

// The direct entry is a seconds-long, IO-sealed selftest; Vitest runs the same cases.
const { describe, it } = await import(process.argv[1] === fileURLToPath(import.meta.url) ? 'node:test' : 'vitest')
const MONITOR = new URL('../../../../plugin/bin/wt-artifact-server-ensure.mjs', import.meta.url)
const LIBRARY = new URL('../../../../plugin/bin/lib/artifact-server.mjs', import.meta.url)
type Evidence = { status: string, reason?: string }
type Health = { pid: number | undefined, version: string }
type Attachment = { port: number, health: Health }

function sourceFunctions(source: string, start: string, end: string) {
  const offset = source.indexOf(start)
  return offset < 0 ? '' : source.slice(offset, source.indexOf(end, offset))
}

function monitorFlow(evidence: Evidence = { status: 'alive' }, pid: number | undefined = 42) {
  const source = readFileSync(MONITOR, 'utf8')
  const library = readFileSync(LIBRARY, 'utf8')
  const state = {
    now: 0, evidence, spawns: 0, output: '', direct: false, pid: pid as number | undefined, checks: [] as number[],
    candidate: null as Attachment | null, evidenceByPid: new Map<number, Evidence>(),
  }
  const health = (): Health => ({ pid: state.pid, version: '1.0.0' })
  const discover = async () => { state.spawns += 1; return { kind: 'found', port: 48001, health: health() } }
  const context = {
    Date: { now: () => state.now }, process: { stdout: { write: (line: string) => { state.output += line } } },
    hostAdapter: { readProcessExecutionState: (old: number) => {
      state.checks.push(old)
      return state.evidenceByPid.get(old) ?? state.evidence
    } },
    setTimeout: (done: () => void, ms: number) => { state.now += ms; done() },
    // Unconditional network/process seal, including when the production guard is mutated away.
    discoverOrStart: discover, probeArtifactServer: async () => state.direct ? { kind: 'ours', health: health() } : { kind: 'free' },
    probeCandidates: async () => ({ found: state.candidate }), testLog: () => {}, liveStartupClaimHolder: () => false,
    stopping: false, upgradeNoticed: false, firstPort: 48001, ARTIFACT_SERVER_VERSION: '1.0.0',
    compareVersions: () => 0, watchIntervalMs: () => 10, retryOverallCapMs: () => 300_000,
    retryWindowMs: () => 60_000, retryAttempts: () => 3,
  }
  const shared = sourceFunctions(library, 'export function artifactServerProcessStatus(', 'export function pathIsUnder(').replace('export function', 'function')
  const helpers = sourceFunctions(source, 'async function waitForAttachedServerExit(', 'async function main(')
  const body = sourceFunctions(source, '    const result = await discoverOrStart(firstPort)', '    const keepAlive = setInterval(')
  const entry = source.includes('function createMonitorState(')
    ? 'const result = await discoverOrStart(firstPort); const state = createMonitorState(result); reportInitialResult(result, state, firstPort); return { watchTick: () => watchTick(state, firstPort), retryTick: () => retryTick(state, firstPort), beginRetry: () => { state.pendingRetry = startRetry("lost") } }'
    : `${body}; return { watchTick, retryTick }`
  const create = runInNewContext(`${shared}\n${helpers}\n(async () => {${entry}})`, context)
  return { state, create, advance: () => { state.now += 20 } }
}

async function startFlow(evidence?: Evidence, pid?: number) {
  const flow = monitorFlow(evidence, pid)
  const ticks = await flow.create()
  flow.state.spawns = 0
  return { ...flow, ticks }
}

async function tick(flow: Awaited<ReturnType<typeof startFlow>>) {
  flow.advance()
  await flow.ticks.watchTick()
  await flow.ticks.retryTick()
}

function registerLifecycleCases() {
  it('never spawns beside a live old process after listener closure', async () => {
    const flow = await startFlow()
    await tick(flow)
    assert.equal(flow.state.spawns, 0, 'a still-draining process must not have a replacement spawned beside it')
    assert.match(flow.state.output, /RESTART DEFERRED: PID 42.*alive.*3000 ms/)
    assert.ok(flow.state.now >= 3_000, 'the monitor waits for the bounded drain interval')
    flow.state.evidence = { status: 'gone' }
    await tick(flow)
    assert.equal(flow.state.spawns, 1, 'the next watch restarts after confirmed process exit')
  })

  it('keeps the existing lost/retry/attached output for a genuinely dead process', async () => {
    const flow = await startFlow({ status: 'gone' })
    await tick(flow)
    assert.equal(flow.state.spawns, 1)
    assert.match(flow.state.output, /ARTIFACT SERVER LOST: server on port 48001 is no longer answering; restarting; registration retained\./)
    assert.match(flow.state.output, /ARTIFACT SERVER RETRY ATTEMPT 1\/3/)
    assert.match(flow.state.output, /ARTIFACT SERVER ATTACHED:/)
  })

}

function registerUnknownCases() {
  for (const reason of ['EIO', 'EACCES', 'PROCESS_STATE_UNAVAILABLE on win32', 'PROCESS_STATE_UNAVAILABLE on darwin']) {
    it(`retains unknown old-process evidence: ${reason}`, async () => {
      const flow = await startFlow({ status: 'unknown', reason })
      await tick(flow)
      assert.equal(flow.state.spawns, 0, 'unknown process evidence must never authorize replacement')
      assert.match(flow.state.output, /RESTART DEFERRED: PID 42.*unknown/)
      assert.ok(flow.state.output.includes(reason))
    })
  }

  it('retains missing attached PID evidence rather than treating it as gone', async () => {
    const flow = await startFlow({ status: 'gone' })
    flow.state.pid = undefined
    flow.state.direct = true
    await tick(flow)
    flow.state.direct = false
    await tick(flow)
    assert.equal(flow.state.spawns, 0, 'missing health PID is unknown, not gone')
    assert.match(flow.state.output, /unknown.*invalid PID/)
  })
}

describe('artifact monitor process handoff', () => {
  registerLifecycleCases()
  registerUnknownCases()
  it('refreshes the attached PID when a new server answers the same port', async () => {
    const flow = await startFlow({ status: 'gone' })
    flow.state.pid = 43
    flow.state.direct = true
    await tick(flow)
    flow.state.direct = false
    await tick(flow)
    assert.ok(flow.state.checks.includes(43), 'the barrier checks the last attached process, not stale health')
  })
})

async function switchAttachment(samePort: boolean, evidence: Evidence) {
  const flow = await startFlow(evidence)
  flow.state.candidate = { port: samePort ? 48001 : 48002, health: { pid: 43, version: '1.0.0' } }
  flow.state.pid = 43
  flow.state.direct = samePort
  await tick(flow)
  assert.equal(flow.state.spawns, 0, 'adopting an existing server never spawns')
  flow.state.candidate = null
  flow.state.direct = false
  flow.state.evidenceByPid.set(43, { status: 'gone' })
  return flow
}

describe('artifact monitor retains prior attachments', () => {
  for (const samePort of [false, true]) {
    const location = samePort ? 'the original port' : 'another candidate port'
    for (const status of ['alive', 'unknown']) {
      it(`blocks replacement after adopting B on ${location} while A is ${status}`, async () => {
        const evidence = status === 'unknown' ? { status, reason: 'EPERM' } : { status }
        const flow = await switchAttachment(samePort, evidence)
        await tick(flow)
        assert.equal(flow.state.spawns, 0, `retained PID 42 is ${status}; switching attachments must not authorize spawning`)
        assert.match(flow.state.output, new RegExp(`RESTART DEFERRED: PID 42.*${status}.*3000 ms`))
        assert.ok(flow.state.checks.includes(42), 'the barrier consults A after adopting B')
        assert.ok(flow.state.checks.includes(43), 'the barrier also consults B')
        if (status === 'unknown') assert.match(flow.state.output, /EPERM/)
      })
    }
    it(`restarts only once every retained process is gone after adopting B on ${location}`, async () => {
      const flow = await switchAttachment(samePort, { status: 'alive' })
      await tick(flow)
      assert.equal(flow.state.spawns, 0, 'A must remain a barrier after B exits')
      flow.state.evidenceByPid.set(42, { status: 'gone' })
      flow.state.pid = 44
      flow.state.evidenceByPid.set(44, { status: 'alive' })
      await tick(flow)
      assert.equal(flow.state.spawns, 1, 'all retained processes gone permits exactly one replacement')
      await tick(flow)
      assert.equal(flow.state.spawns, 1, 'the replacement itself becomes a retained attachment')
    })
  }
})

describe('artifact monitor restart barrier', () => {
  it('checks retained processes at retry entry after candidate discovery attaches B', async () => {
    const flow = await startFlow()
    flow.ticks.beginRetry()
    flow.state.candidate = { port: 48002, health: { pid: 43, version: '1.0.0' } }
    await flow.ticks.retryTick()
    flow.state.candidate = null
    flow.state.evidenceByPid.set(43, { status: 'gone' })
    flow.ticks.beginRetry()
    await flow.ticks.retryTick()
    assert.equal(flow.state.spawns, 0, 'the retry spawn path must consult retained PID 42 independently')
    assert.match(flow.state.output, /RESTART DEFERRED: PID 42.*alive/)
    flow.state.evidenceByPid.set(42, { status: 'gone' })
    await flow.ticks.retryTick()
    assert.equal(flow.state.spawns, 1)
  })

  it('retains every unresolved attachment across more than one handoff', async () => {
    const flow = await switchAttachment(false, { status: 'alive' })
    flow.state.evidenceByPid.set(43, { status: 'unknown', reason: 'EIO' })
    flow.state.candidate = { port: 48003, health: { pid: 44, version: '1.0.0' } }
    await tick(flow)
    flow.state.candidate = null
    flow.state.evidenceByPid.set(42, { status: 'gone' })
    flow.state.evidenceByPid.set(44, { status: 'gone' })
    await tick(flow)
    assert.equal(flow.state.spawns, 0, 'the middle attachment must not be forgotten')
    assert.match(flow.state.output, /RESTART DEFERRED: PID 43.*unknown.*EIO/)
    flow.state.evidenceByPid.set(43, { status: 'gone' })
    await tick(flow)
    assert.equal(flow.state.spawns, 1)
  })
})

function sharedStatus() {
  const source = sourceFunctions(readFileSync(LIBRARY, 'utf8'), 'export function artifactServerProcessStatus(', 'export function pathIsUnder(')
  return runInNewContext(`${source.replace('export function', 'function')}; artifactServerProcessStatus`)
}

describe('shared artifact process-exit evidence', () => {
  for (const status of ['alive', 'gone', 'unknown']) {
    it(`preserves host execution evidence: ${status}`, () => {
      assert.equal(sharedStatus()(42, () => ({ status })).status, status)
    })
  }
  for (const pid of [undefined, 0, -1, '42', 1.5]) {
    it(`keeps invalid PID ${pid} unknown without consulting the host`, () => {
      const evidence = sharedStatus()(pid, () => assert.fail('invalid PID must not reach the host'))
      assert.equal(evidence.status, 'unknown')
    })
  }
  it('names unavailable, malformed and throwing checks as unknown', () => {
    for (const value of [undefined, null, {}, { status: 'denied', reason: 'EPERM' }]) {
      assert.equal(sharedStatus()(42, () => value).status, 'unknown')
    }
    const evidence = sharedStatus()(42, () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
    assert.equal(evidence.status, 'unknown')
    assert.equal(evidence.reason, 'EACCES')
  })
})

describe('shared process-exit evidence through host adapters', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const code of [undefined, 'ESRCH', 'EPERM', 'EIO']) {
      it(`${platform} signal-zero ${code ?? 'success'} has a conservative execution verdict`, () => {
        const host = createHostAdapter({ platform, invoke: {
          kill: () => { if (code) throw Object.assign(new Error(code), { code }) },
          read: () => ({ status: 'unavailable', reason: 'EACCES' }),
        } })
        const evidence = sharedStatus()(42, host.readProcessExecutionState)
        assert.equal(evidence.status, code === 'ESRCH' ? 'gone' : 'unknown')
      })
    }
  }
  it('confirms Linux zombies but preserves running and unreadable process states', () => {
    for (const state of ['Z', 'S', '?']) {
      const host = createHostAdapter({ platform: 'linux', invoke: {
        kill: () => {}, read: () => ({ status: 'read', value: `42 (server) ${state} 1` }),
      } })
      const expected = state === 'Z' ? 'gone' : state === 'S' ? 'alive' : 'unknown'
      assert.equal(sharedStatus()(42, host.readProcessExecutionState).status, expected)
    }
  })
})
