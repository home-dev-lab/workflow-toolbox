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
const SERVER = new URL('../../../../plugin/bin/wt-artifact-server.mjs', import.meta.url)
type Evidence = { status: string, reason?: string }
type Identity = Evidence & { pid?: number, startIdentity?: string }
type Health = { pid: number | undefined, version: string, processIdentity?: Identity }
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
    identities: new Map<number, Identity>(), identityChecks: [] as number[],
    onProbe: null as (() => void) | null, answers: [] as (Health | null)[], selfIdentity: false, initialScan: false,
  }
  const health = (): Health => ({ pid: state.pid, version: '1.0.0', ...(state.selfIdentity ? { processIdentity: identity(state.pid!) } : {}) })
  const identity = (old: number) => state.identities.get(old) ?? { status: 'known', pid: old, startIdentity: `birth-${old}` }
  const discover = async () => { state.spawns += 1; return { kind: 'found', port: 48001, health: health(), identity: identity(state.pid!) } }
  const context = {
    Date: { now: () => state.now }, process: { stdout: { write: (line: string) => { state.output += line } } },
    hostAdapter: { readProcessExecutionState: (old: number) => {
      state.checks.push(old)
      return state.evidenceByPid.get(old) ?? state.evidence
    }, readProcessIdentity: (old: number) => {
      state.identityChecks.push(old)
      return identity(old)
    } },
    setTimeout: (done: () => void, ms: number) => { state.now += ms; done() },
    // Unconditional network/process seal, including when the production guard is mutated away.
    discoverOrStart: discover, probeArtifactServer: async (port: number) => probeAnswer(state, port, health),
    useCandidateDiscovery: () => state.initialScan,
    portAttempts: () => 3, testLog: () => {}, liveStartupClaimHolder: () => false,
    stopping: false, upgradeNoticed: false, firstPort: 48001, ARTIFACT_SERVER_VERSION: '1.0.0',
    compareVersions: () => 0, watchIntervalMs: () => 10, retryOverallCapMs: () => 300_000,
    retryWindowMs: () => 60_000, retryAttempts: () => 3,
  }
  const shared = sourceFunctions(library, 'export function artifactServerProcessStatus(', 'export function pathIsUnder(').replaceAll('export function', 'function')
  const helpers = sourceFunctions(source, 'async function waitForAttachedServerExit(', 'async function main(')
  const entry = 'const result = useCandidateDiscovery() ? {kind: "found", ...(await probeCandidates(firstPort, 750)).found} : await discoverOrStart(firstPort); const state = createMonitorState(result); reportInitialResult(result, state, firstPort); return { records: () => [...state.attachedProcesses.values()], watchTick: () => watchTick(state, firstPort), retryTick: () => retryTick(state, firstPort), beginRetry: () => { state.pendingRetry = startRetry("lost") } }'
  const candidates = sourceFunctions(source, 'async function probeCandidates(', 'async function holdClaimForTest(')
  const create = runInNewContext(`${shared}\n${candidates}\n${helpers}\n(async () => {${entry}})`, context)
  return { state, create, advance: () => { state.now += 20 } }
}

function probeAnswer(state: ReturnType<typeof monitorFlow>['state'], port: number, health: () => Health) {
  state.onProbe?.()
  if (state.answers.length > 0) {
    const answer = state.answers.shift()
    return answer ? { kind: 'ours', health: answer } : { kind: 'free' }
  }
  if (state.direct && port === 48001) return { kind: 'ours', health: health() }
  return state.candidate?.port === port ? { kind: 'ours', health: state.candidate.health } : { kind: 'free' }
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

async function healthyHandoff(samePort: boolean) {
  const flow = await startFlow()
  flow.state.candidate = { port: samePort ? 48001 : 48002, health: { pid: 43, version: '1.0.0' } }
  flow.state.pid = 43
  flow.state.direct = samePort
  await tick(flow)
  flow.state.candidate = null
  flow.state.direct = true
  return flow
}

async function loseB(flow: Awaited<ReturnType<typeof startFlow>>) {
  flow.state.evidenceByPid.set(43, { status: 'gone' })
  flow.state.direct = false
  flow.state.pid = 44
  await tick(flow)
}

function registerInstanceRetirementCases(samePort: boolean) {
  const location = samePort ? 'same port' : 'candidate port'
  it(`recovers after A exits during healthy B and its PID is reused (${location})`, async () => {
    const flow = await healthyHandoff(samePort)
    flow.state.evidenceByPid.set(42, { status: 'gone' })
    await tick(flow)
    flow.state.evidenceByPid.set(42, { status: 'alive' })
    flow.state.identities.set(42, { status: 'known', pid: 42, startIdentity: 'unrelated-birth' })
    await loseB(flow)
    assert.equal(flow.state.spawns, 1, 'a recycled historical PID must not block recovery after all attached instances exit')
    assert.doesNotMatch(flow.state.output, /RESTART DEFERRED: PID 42/)
  })
  it(`retires confirmed exits on healthy ticks without accumulating history (${location})`, async () => {
    const flow = await healthyHandoff(samePort)
    flow.state.evidenceByPid.set(42, { status: 'gone' })
    const before = flow.state.checks.filter((pid) => pid === 42).length
    await tick(flow)
    const after = flow.state.checks.filter((pid) => pid === 42).length
    assert.ok(after > before, 'healthy B must not skip checking historical A')
    for (let index = 0; index < 100; index += 1) await tick(flow)
    assert.equal(flow.state.checks.filter((pid) => pid === 42).length, after, 'confirmed exits must be retired permanently')
    assert.equal(flow.state.spawns, 0, 'healthy B needs no replacement')
  })
  it(`detects reuse between ticks without observing A absent (${location})`, async () => {
    const flow = await healthyHandoff(samePort)
    flow.state.identities.set(42, { status: 'known', pid: 42, startIdentity: 'unrelated-birth' })
    await loseB(flow)
    assert.equal(flow.state.spawns, 1, 'birth identity must distinguish a recycled PID even when exit was not polled')
  })
}

describe('artifact monitor retires process instances', () => {
  for (const samePort of [false, true]) registerInstanceRetirementCases(samePort)
  for (const reason of ['EACCES', 'PROCESS_IDENTITY_UNAVAILABLE on darwin', 'PROCESS_IDENTITY_UNAVAILABLE on win32']) {
    it(`reports unavailable current identity as unknown: ${reason}`, async () => {
      const flow = await healthyHandoff(false)
      flow.state.identities.set(42, { status: 'unknown', reason })
      await loseB(flow)
      assert.equal(flow.state.spawns, 0, 'unavailable birth identity never authorizes replacement')
      assert.ok(flow.state.output.includes(`PID 42 is unknown (${reason})`), 'identity uncertainty must be stated, not silently alive')
    })
  }
  it('never learns an initially unknown identity from a later unrelated process', async () => {
    const flow = monitorFlow()
    flow.state.identities.set(42, { status: 'unknown', reason: 'initial birth unavailable' })
    const ticks = await flow.create()
    flow.state.spawns = 0
    flow.state.identities.set(42, { status: 'known', pid: 42, startIdentity: 'unrelated-birth' })
    flow.advance()
    await ticks.watchTick()
    await ticks.retryTick()
    assert.equal(flow.state.spawns, 0)
    assert.match(flow.state.output, /PID 42 is unknown.*initial birth unavailable/)
  })
})

describe('artifact attachment observation and retirement', () => {
  for (const location of ['direct', 'candidate']) {
    it(`retains a same-PID successor born during the ${location} health probe`, async () => {
      const flow = await startFlow()
      flow.state.direct = location === 'direct'
      flow.state.candidate = location === 'candidate' ? { port: 48002, health: { pid: 42, version: '1.0.0' } } : null
      flow.state.onProbe = () => {
        flow.state.identities.set(42, { status: 'known', pid: 42, startIdentity: 'successor-birth' })
      }
      await tick(flow)
      flow.state.onProbe = null
      flow.state.direct = false
      flow.state.candidate = null
      await tick(flow)
      assert.equal(flow.state.spawns, 0, 'a same-PID health handoff must retain the still-running successor')
      assert.match(flow.state.output, /RESTART DEFERRED: PID 42/)
      if (location === 'direct') assert.match(flow.state.output, /unknown.*process identity changed during health probe/)
      flow.state.evidence = { status: 'gone' }
      await tick(flow)
      assert.equal(flow.state.spawns, 1, 'positive exit retires even an ambiguously bound successor')
    })
  }
  it('never resurrects an exited current attachment while a historical instance drains', async () => {
    const flow = await switchAttachment(false, { status: 'alive' })
    await tick(flow)
    const checks = flow.state.checks.filter((pid) => pid === 43).length
    flow.state.evidenceByPid.set(43, { status: 'alive' })
    flow.state.identities.set(43, { status: 'unknown', reason: 'already exited' })
    flow.state.evidenceByPid.set(42, { status: 'gone' })
    await tick(flow)
    assert.equal(flow.state.spawns, 1, 'a retired current attachment cannot become a permanent unknown barrier')
    assert.equal(flow.state.checks.filter((pid) => pid === 43).length, checks, 'retirement is permanent without a fresh health answer')
  })
  registerAmbiguousIdentityCases()
})

function registerAmbiguousIdentityCases() {
  for (const phase of ['before', 'after']) {
    it(`retains an unknown observation when identity is unavailable ${phase} health`, async () => {
      const flow = await startFlow()
      flow.state.direct = true
      if (phase === 'before') flow.state.identities.set(42, { status: 'unknown', reason: 'birth unreadable' })
      flow.state.onProbe = () => {
        flow.state.identities.set(42, phase === 'after'
          ? { status: 'unknown', reason: 'birth unreadable' }
          : { status: 'known', pid: 42, startIdentity: 'birth-42' })
      }
      await tick(flow)
      flow.state.direct = false
      flow.state.onProbe = null
      flow.state.identities.set(42, { status: 'known', pid: 42, startIdentity: 'stranger' })
      await tick(flow)
      assert.equal(flow.state.spawns, 0, 'an unbound health answer is a distinct unknown instance, never an older birth')
      assert.match(flow.state.output, /unknown.*birth unreadable/)
    })
  }
}

type Flow = Awaited<ReturnType<typeof startFlow>>

function answerFor(flow: Pick<Flow, 'state'>, pid: number, birth = `birth-${pid}`): Health {
  const processIdentity = { status: 'known', pid, startIdentity: birth }
  flow.state.identities.set(pid, processIdentity)
  flow.state.evidenceByPid.set(pid, { status: 'alive' })
  return { pid, version: '1.0.0', processIdentity }
}

async function confirmationHandoff(initial: boolean) {
  const flow = monitorFlow()
  const a = answerFor(flow, 44)
  const b = answerFor(flow, 43)
  flow.state.initialScan = initial
  flow.state.answers = initial ? [a, b] : []
  const ticks = await flow.create()
  flow.state.spawns = 0
  flow.state.evidenceByPid.set(42, { status: 'gone' })
  const started = { ...flow, ticks }
  if (!initial) {
    flow.state.answers = [null, a, b]
    await tick(started)
  }
  flow.state.evidenceByPid.set(43, { status: 'gone' })
  return started
}

describe('monotone artifact observation ledger', () => {
  for (const initial of [true, false]) {
    it(`retains the first responder when confirmation changes PID (${initial ? 'initial' : 'candidate'})`, async () => {
      const flow = await confirmationHandoff(initial)
      await tick(flow)
      assert.equal(flow.state.spawns, 0, 'confirmation must not forget live first responder PID 44')
      assert.match(flow.state.output, /RESTART DEFERRED: PID 44.*alive/)
      flow.state.evidenceByPid.set(44, { status: 'gone' })
      await tick(flow)
      assert.equal(flow.state.spawns, 1, 'both observed responders exited permits recovery')
    })
  }
  registerUnknownCoalescingCases()
  registerSelfIdentifiedHandoffCases()
})

function registerUnknownCoalescingCases() {
  for (const reason of ['PROCESS_IDENTITY_UNAVAILABLE on darwin', 'PROCESS_IDENTITY_UNAVAILABLE on win32', 'EACCES']) {
    it(`coalesces 1000 repeated unknown observations: ${reason}`, async () => {
      const flow = monitorFlow()
      flow.state.identities.set(42, { status: 'unknown', reason })
      flow.state.direct = true
      const ticks = await flow.create()
      flow.state.spawns = 0
      const started = { ...flow, ticks }
      for (let index = 0; index < 1_000; index += 1) await tick(started)
      assert.equal(ticks.records().length, 1, 'one unresolved PID must occupy one unknown record')
      flow.state.direct = false
      await tick(started)
      assert.equal(flow.state.spawns, 0)
      assert.equal(flow.state.output.split('RESTART DEFERRED:').length - 1, 1, 'one bounded verdict per unknown PID')
      flow.state.evidence = { status: 'gone' }
      await tick(started)
      assert.equal(flow.state.spawns, 1, 'explicit exit also retires coalesced unknown observations')
    })
  }
}

function registerSelfIdentifiedHandoffCases() {
  for (const candidate of [false, true]) {
    it(`retires a different-PID handoff after birth reuse without an unknown shadow (${candidate ? 'candidate' : 'direct'})`, async () => {
      const flow = await startFlow()
      const b = answerFor(flow, 43)
      flow.state.answers = candidate ? [null, b, b] : [b]
      await tick(flow)
      flow.state.answers = [b]
      await tick(flow)
      flow.state.evidenceByPid.set(42, { status: 'gone' })
      answerFor(flow, 43, 'unrelated-successor')
      await tick(flow)
      assert.equal(flow.state.spawns, 1, 'self-captured answering birth must retire without an unknown shadow')
    })
  }
}

function randomSource(seed: number) {
  let value = seed
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value >>> 8 }
}

function randomObservation(flow: Flow, random: () => number, step: number) {
  const pid = 45 + random() % 5
  const action = random() % 4
  if (action === 0) { flow.state.evidenceByPid.set(pid, { status: 'gone' }); return }
  if (action === 1) { answerFor(flow, pid, `unrelated-${step}`); return }
  const a = answerFor(flow, pid, `answer-${step}`)
  const b = answerFor(flow, 50 + random() % 5, `confirmation-${step}`)
  flow.state.answers = action === 2 ? [a] : [null, a, b]
}

async function runLedgerProperty(seed: number) {
  const random = randomSource(seed)
  const flow = await confirmationHandoff(false)
  await tick(flow)
  assert.equal(flow.state.spawns, 0, `seed=${seed}: the first-response-only instance still drains`)
  const answered = new Map<number, string>([[42, 'birth-42'], [43, 'birth-43'], [44, 'birth-44']])
  flow.state.pid = 99
  // The oracle tracks response births separately from the production ledger.
  for (let step = 0; step < 80; step += 1) {
    if (step === 20) flow.state.evidenceByPid.set(44, { status: 'gone' })
    randomObservation(flow, random, step)
    for (const health of flow.state.answers) if (health) answered.set(health.pid!, health.processIdentity!.startIdentity!)
    const alive = modelHasAnsweredProcess(flow, answered)
    const before: number = flow.state.spawns
    const serving = flow.state.answers.some(Boolean)
    await tick(flow)
    assert.equal(flow.state.spawns, before + (alive || serving ? 0 : 1), `seed=${seed} step=${step}: match answered-process oracle`)
    if (flow.state.spawns > before) answered.set(99, 'birth-99')
  }
  flow.state.answers = []
  // Leave unrelated live PID occupants, proving recovery needs birth exit, not PID absence.
  for (const pid of [44, ...flow.state.identities.keys()]) answerFor(flow, pid, `final-stranger-${pid}`)
  const before: number = flow.state.spawns
  await tick(flow)
  assert.equal(flow.state.spawns, before + 1, `seed=${seed}: no barrier remains once all answered births exited`)
}

function modelHasAnsweredProcess(flow: Flow, answered: Map<number, string>) {
  return [...answered].some(([pid, birth]) => (flow.state.evidenceByPid.get(pid) ?? flow.state.evidence).status !== 'gone' &&
    (flow.state.identities.get(pid)?.startIdentity ?? `birth-${pid}`) === birth)
}

describe('artifact ledger randomized lifecycle property', () => {
  for (let seed = 1; seed <= 24; seed += 1) {
    it(`retains every answered instance and recovers after all exits (seed ${seed})`, async () => {
      await runLedgerProperty(seed)
    })
  }
})

describe('artifact health carries its own host birth evidence', () => {
  for (const status of ['known', 'unknown']) {
    it(`publishes self-read ${status} birth evidence rather than a monitor guess`, async () => {
      const identity = { status, pid: 42, startIdentity: 'self-birth', reason: 'unavailable' }
      const handler = sourceFunctions(readFileSync(SERVER, 'utf8'), '  async handler(', '  requestUrl(')
      let health: Record<string, unknown> = {}
      const context = {
        process: { pid: 42 }, ARTIFACT_SERVER_ID: 'test', ARTIFACT_SERVER_VERSION: '1.0.0', artifactUid: () => 'test',
        hostAdapter: { readProcessIdentity: (pid: number) => { assert.equal(pid, 42); return identity } },
        send: (_response: unknown, _method: string, _status: number, body: string) => { health = JSON.parse(body) as Record<string, unknown> },
      }
      const serve = runInNewContext(`class Service {${handler}}; Service.prototype.handler`, context)
      await serve.call({ requestMethod: async () => 'GET', requestedPort: 48001, startToken: 'self-token',
        requestUrl: () => ({ pathname: '/__wt-artifact-server/health' }), registrations: new Map() }, {}, {})
      assert.deepEqual(health.processIdentity, identity, 'health must carry the answering process own birth evidence')
    })
  }
})

function cliFlow(recorded: Identity | null = { status: 'known', pid: 42, startIdentity: 'birth-42' }) {
  const source = readFileSync(SERVER, 'utf8')
  const functions = sourceFunctions(source, 'async function stopRunning(', 'function spawnServer(')
  let now = 0
  let signals = 0
  let output = ''
  const identity = () => ({ status: 'known', pid: 42, startIdentity: signals ? 'stranger' : 'birth-42' })
  const library = sourceFunctions(readFileSync(LIBRARY, 'utf8'), 'export function artifactServerProcessStatus(', 'export function pathIsUnder(')
  const context = {
    process: { platform: 'linux', stderr: { write: (line: string) => { output += line } } }, Date: { now: () => now },
    hostAdapter: { readProcessIdentity: identity, readProcessExecutionState: () => ({ status: 'alive' }) },
    readArtifactDiscovery: () => ({ pid: 42, port: 48001, processIdentity: recorded, startToken: 'launch' }),
    probeArtifactServer: async () => ({ kind: 'ours', health: { pid: 42, port: 48001, startToken: 'launch', registeredSessions: 0 } }),
    hostProcfs: { readCommandLine: () => 'node\0wt-artifact-server.mjs\0serve' },
    atomicWriteJson: () => {}, artifactIntentPath: () => 'sealed-intent', signalProcess: () => { signals += 1 },
    setTimeout: (done: () => void, ms: number) => { now += ms; done() },
  }
  const command = runInNewContext(`${library.replaceAll('export function', 'function')}\n${functions}\nstopRunning`, context)
  return { command, signals: () => signals, output: () => output }
}

describe('CLI shares monitor instance-exit evidence', () => {
  for (const action of ['stop', 'restart']) {
    it(`confirms ${action} when a stranger reuses the verified PID before exit polling`, async () => {
      const flow = cliFlow()
      const result = await flow.command(action, true)
      assert.equal(result.ok, true, 'CLI must retire the verified birth even while its PID belongs to a live stranger')
      assert.match(result.message, /stopped/)
      assert.equal(flow.signals(), 1, 'only the verified original receives a signal')
    })
  }
  it('states why a legacy discovery without recorded identity cannot be stopped', async () => {
    const flow = cliFlow(null)
    const result = await flow.command('stop', true)
    assert.equal(result.ok, false)
    assert.match(result.message, /no recorded process identity/)
    assert.equal(flow.signals(), 0)
  })
})

function sharedStatus() {
  const source = sourceFunctions(readFileSync(LIBRARY, 'utf8'), 'export function artifactServerProcessStatus(', 'export function pathIsUnder(')
  return runInNewContext(`${source.replaceAll('export function', 'function')}; artifactServerProcessStatus`)
}

describe('shared artifact process-instance evidence', () => {
  const original = { status: 'known', pid: 42, startIdentity: 'original-birth' }
  for (const identity of [undefined, {}, { ...original, pid: 43 }, { ...original, startIdentity: '' }, { status: 'unknown', reason: 'EPERM' }]) {
    it(`retains malformed or unavailable birth evidence: ${JSON.stringify(identity)}`, () => {
      const check = sharedStatus()
      // Undefined is an unavailable captured identity, not the legacy no-identity call.
      assert.equal(check(42, () => ({ status: 'alive' }), identity ?? {}, () => original).status, 'unknown')
      assert.equal(check(42, () => ({ status: 'alive' }), original, () => identity).status, 'unknown')
    })
  }
  it('names a throwing identity check as unknown without mistaking it for exit', () => {
    const result = sharedStatus()(42, () => ({ status: 'alive' }), original, () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
    assert.equal(result.status, 'unknown')
    assert.equal(result.reason, 'EACCES')
  })
  it('recognizes a different birth even when execution-state evidence is unavailable', () => {
    const result = sharedStatus()(42, () => ({ status: 'unknown', reason: 'EIO' }), original, () => ({ ...original, startIdentity: 'recycled-birth' }))
    assert.equal(result.status, 'gone')
    assert.equal(result.reason, 'PID reused')
  })
  it('confirms explicit exit even when the captured identity was unavailable', () => {
    const result = sharedStatus()(42, () => ({ status: 'gone' }), {}, () => assert.fail('exit needs no identity read'))
    assert.equal(result.status, 'gone')
  })
})

describe('artifact birth evidence through host adapters', () => {
  it('distinguishes Linux PID reuse using full-precision birth ticks and boot identity', () => {
    let ticks = '9007199254740992'
    let boot = '12345678-1234-1234-1234-123456789abc'
    const host = createHostAdapter({ platform: 'linux', invoke: {
      kill: () => {}, read: (file: string) => ({ status: 'read', value: file.endsWith('/stat')
        ? `42 (server) ${['S', ...Array<string>(18).fill('1'), ticks].join(' ')}` : boot }),
    } })
    const birth = host.readProcessIdentity(42)
    const check = () => sharedStatus()(42, host.readProcessExecutionState, birth, host.readProcessIdentity)
    assert.equal(check().status, 'alive')
    ticks = '9007199254740993'
    assert.equal(check().status, 'gone', 'birth ticks must not lose precision')
    ticks = '9007199254740992'
    boot = '87654321-1234-1234-1234-123456789abc'
    assert.equal(check().status, 'gone', 'another boot must not reuse a birth identity')
  })
  for (const platform of ['darwin', 'win32']) {
    it(`states unknown birth identity on ${platform} without inferring it from existence`, () => {
      const host = createHostAdapter({ platform, invoke: { kill: () => {}, read: () => assert.fail('no identity evidence path') } })
      const birth = host.readProcessIdentity(42)
      assert.equal(birth.status, 'unknown')
      assert.equal(birth.reason, `PROCESS_IDENTITY_UNAVAILABLE on ${platform}`)
      assert.equal(sharedStatus()(42, () => ({ status: 'alive' }), birth, host.readProcessIdentity).status, 'unknown')
    })
  }
})

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
