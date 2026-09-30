import { afterEach, expect, it, vi } from 'vitest'
import fs, { appendFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
// The shipped plugin module lives outside the toolkit TypeScript project's root.
// @ts-expect-error TS7016 -- the plugin's plain-JavaScript module has no declaration file
import { announceable, detectRelays, dueRelays, eventBudget, parseTaskNotification, pendingQueueNotifications, readAgents, readNewMain, readThrottle, unresolvedWaits, writeResumed, writeThrottle } from '../../../../plugin/bin/lib/delegate-wake.mjs'

const sessionId = '00000000-0000-4000-8000-000000000001'
const owner = 'aowner1234567'
const parent = 'aparent123456'
const child = 'achild1234567'
const start = Date.parse('2026-09-29T20:20:08.160Z')
const iso = (offset: number) => new Date(start + offset).toISOString()
const notice = (id: string, tool = 'toolu_abc123', summary = 'Background command completed') => `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>${tool}</tool-use-id>\n<output-file>/tmp/claude-1000/-home-user-projects-example/00000000-0000-4000-8000-000000000001/tasks/result.output</output-file>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`
const enqueue = (body: string, offset = 0) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(offset), sessionId, content: body })
const assistant = (offset: number, reason = 'end_turn') => ({ type: 'assistant', timestamp: iso(offset), message: { role: 'assistant', stop_reason: reason, content: [{ type: 'text', text: 'done' }] } })
const inbound = (offset: number, body: string) => ({ type: 'user', timestamp: iso(offset), message: { role: 'user', content: body } })
const launch = (id: string, tool = 'toolu_abc123') => ({ type: 'user', timestamp: iso(-900), message: { role: 'user', content: [
  { type: 'tool_result', tool_use_id: tool, content: `Command running in background with ID: ${id}. Output is being written to: /tmp/claude-1000/-home-user-projects-example/tasks/${id}.output. You will be notified when it completes.` },
] }, toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id } })
let temp: string | undefined
afterEach(() => { if (temp) rmSync(temp, { recursive: true, force: true }); temp = undefined })

function fixture() {
  temp = mkdtempSync(join(tmpdir(), 'delegate-wake-'))
  const subs = join(temp, 'subagents')
  mkdirSync(subs)
  const registry = join(temp, `${sessionId}.jsonl`)
  const wait = { t: 'waiting', agentId: owner, name: 'worker', artifact: 'gates', path: '/tmp/claude-1000/result', at: iso(-1000) }
  writeFileSync(registry, `${JSON.stringify(wait)}\n`)
  const write = (records: unknown[]) => writeFileSync(join(subs, `agent-${owner}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return { subs, registry, write }
}

it('F1 blocked SubagentStop and same-turn tool do not clear declared wait; real tool-less next turn does', () => {
  const f = fixture()
  const sameTurnTool = { type: 'user', timestamp: iso(150), message: { role: 'user', content: [{
    type: 'tool_result', tool_use_id: 'toolu_abc123', content: 'Command running in background with ID: task1234.',
  }] }, toolUseResult: { backgroundTaskId: 'task1234' } }
  f.write([assistant(-500), inbound(100, 'Stop hook feedback: SendMessage before stopping'), sameTurnTool, assistant(200, 'tool_use')])
  expect(writeResumed(f.registry, f.subs)).toBe(0)
  expect(unresolvedWaits(readFileSync(f.registry, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).has(owner)).toBe(true)
  f.write([assistant(-500), inbound(100, 'Stop hook feedback: SendMessage before stopping'), sameTurnTool, assistant(200, 'tool_use'),
    assistant(300), { type: 'attachment', timestamp: iso(400), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: notice('task1234') } }, assistant(500)])
  expect(writeResumed(f.registry, f.subs)).toBe(1)
  expect(writeResumed(f.registry, f.subs)).toBe(0)
  expect(unresolvedWaits(readFileSync(f.registry, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).has(owner)).toBe(false)
})

it('F2 a teammate with no SubagentStop clears on a real next turn but not a Stop-hook re-prompt', () => {
  const f = fixture()
  appendFileSync(f.registry, readFileSync(f.registry, 'utf8')) // duplicate hook registration
  f.write([assistant(100), inbound(200, 'Stop hook feedback: retry'), assistant(300)])
  expect(writeResumed(f.registry, f.subs)).toBe(0)
  f.write([assistant(100), inbound(200, 'Stop hook feedback: retry'), assistant(300), inbound(400, 'New assignment'), assistant(500)])
  expect(writeResumed(f.registry, f.subs)).toBe(1)
  expect(writeResumed(f.registry, f.subs)).toBe(0)
})

it('WAKE requires end_turn, honors tool-use-id ahead of task-id and does not alert after resumption', () => {
  const main = [enqueue(notice('task1234'))]
  const input = { sessionId, main, agents: { [owner]: [launch('task1234'), assistant(-100, 'tool_use')] }, meta: { [owner]: { agentType: 'worker' } }, now: start + 100000, grace: 90000 }
  expect(detectRelays(input).lines).toHaveLength(0)
  input.agents[owner][1] = assistant(-100)
  expect(detectRelays(input).lines[0]?.line).toContain(`SendMessage to "${owner}"`)
  const other = 'aother1234567'
  expect(detectRelays({ ...input, agents: { ...input.agents, [other]: [launch('task1234', 'toolu_other123'), assistant(-100)] },
    meta: { ...input.meta, [other]: { agentType: 'another' } } }).lines[0]?.line).toContain(`SendMessage to "${owner}"`)
  input.agents[owner].push(assistant(100))
  expect(detectRelays(input).lines).toHaveLength(0)
  expect(detectRelays({ ...input, now: start - 1 })).toMatchObject({ lines: [] })
  expect(detectRelays({ ...input, now: start + 90000 })).toMatchObject({ lines: [] })
})

it('F3 FORWARD settles by exact relay marker, not an outbound mention or unrelated inbound', () => {
  const body = notice(child)
  const input = { sessionId, main: [inbound(0, body)], agents: { [parent]: [assistant(-10)] as unknown[] },
    meta: { [parent]: { agentType: 'pilot' }, [child]: { parentAgentId: parent, agentType: 'critic' } }, now: start + 100000, grace: 90000 }
  const line = detectRelays(input).lines[0]?.line
  expect(line).toContain(`SendMessage to "${parent}"`)
  expect(line).toMatch(/\[wt-relay [a-f0-9]{12}\]/)
  const marker = line!.match(/\[wt-relay [a-f0-9]{12}\]/)![0]
  input.agents[parent].push(inbound(100, 'unrelated send'), {
    ...assistant(200), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: body }] },
  })
  expect(detectRelays(input).lines).toHaveLength(1)
  input.agents[parent].push(inbound(300, `The short relay ${marker}`))
  expect(detectRelays(input).lines).toHaveLength(0)
})

it('F3 identical notices consume inbound receipts in order; different bodies cannot cross-settle', () => {
  const body = notice(child)
  const main = [inbound(0, body), inbound(1, body)]
  const agents = { [parent]: [inbound(50, body)] }
  const meta = { [parent]: { agentType: 'pilot' }, [child]: { parentAgentId: parent, agentType: 'critic' } }
  expect(detectRelays({ sessionId, main, agents, meta, now: start + 100000, grace: 0 }).lines).toHaveLength(1)
  main[1] = inbound(1, notice(child, 'toolu_abc123', 'different summary'))
  expect(detectRelays({ sessionId, main, agents, meta, now: start + 100000, grace: 0 }).lines).toHaveLength(1)
  const queuedMain = [{ type: 'attachment', timestamp: iso(0), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: body } }]
  expect(detectRelays({ sessionId, main: queuedMain, agents: { [parent]: [] }, meta, now: start + 100000 }).lines).toHaveLength(1)
})

it('F4 one budget carries unprinted candidates into the next polls and retries after backoff', () => {
  const candidates = Array.from({ length: 25 }, (_, i) => ({ key: `WAKE:${i}`, at: i, line: `WAKE ${i}` }))
  const state: Record<string, { lastEmittedAt: number, count: number }> = {}
  const first = dueRelays(candidates, state, 1000, 20)
  expect(first).toHaveLength(20)
  // A degraded poll computes eligibility but cannot advance the throttle.
  expect(dueRelays(candidates, state, 1001, 20)).toHaveLength(20)
  first.forEach((p) => { state[p.key] = { lastEmittedAt: 1000, count: 1 } })
  expect(dueRelays(candidates, state, 1001, 20)).toHaveLength(5)
  expect(dueRelays(candidates, state, 1000 + 600000, 20)).toHaveLength(20)
  expect(dueRelays(candidates.slice(0, 1), { 'WAKE:0': { lastEmittedAt: 0, count: 4 } }, 3600001, 20).some((p) => p.key === 'WAKE:0')).toBe(true)
  const out: string[] = []
  const budget = eventBudget((line: string) => out.push(line))
  first.forEach((p) => budget.emit(p.line))
  budget.emit('STALE: ordinary')
  budget.close()
  expect(out).toHaveLength(20)
  expect(out.every((line) => line.startsWith('WAKE'))).toBe(true)
})

it('F6 deleted/corrupt throttle restarts empty; unique temp names allow racing writers', () => {
  const f = fixture()
  const file = join(temp!, 'state.json')
  expect(readThrottle(file)).toMatchObject({ state: {}, degraded: 'throttle state absent' })
  writeFileSync(file, '{')
  expect(readThrottle(file).degraded).toBe('throttle state unreadable')
  expect(writeThrottle(file, { a: { lastEmittedAt: 10, count: 1 } })).toBeNull()
  expect(writeThrottle(file, { b: { lastEmittedAt: 20, count: 1 } })).toBeNull()
  expect(readThrottle(file).state).toHaveProperty('b')
  expect(writeThrottle(join(file, 'cannot-write.json'), {})).toBe('throttle state unwritable')
  rmSync(file)
  const rebuilt = readThrottle(file)
  expect(rebuilt.state).toEqual({})
  expect(dueRelays([{ key: 'WAKE:new', at: start, line: 'WAKE:new' }], rebuilt.state, start + 100000)).toHaveLength(1)
  expect(f.registry).toBeTruthy()
})

it('F6 concurrent writers leave one complete throttle document and no shared temporary name', async () => {
  fixture()
  const file = join(temp!, 'race.json')
  const moduleUrl = new URL('../../../../plugin/bin/lib/delegate-wake.mjs', import.meta.url).href
  const script = `const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.moduleUrl).then(({ writeThrottle }) => {
      parentPort.postMessage(writeThrottle(workerData.file, { [workerData.key]: { count: 1, lastEmittedAt: 1 } }))
    }).catch((error) => parentPort.postMessage(error.message))`
  const run = (key: string) => new Promise<string | null>((resolve, reject) => {
    const worker = new Worker(script, { eval: true, workerData: { moduleUrl, file, key } })
    worker.once('message', resolve)
    worker.once('error', reject)
  })
  expect(await Promise.all([run('one'), run('two')])).toEqual([null, null])
  expect(Object.keys(readThrottle(file).state)).toHaveLength(1)
})

it('attribution is scoped to this session: no main notice means no alert; unowned and monitor notices stay silent, ambiguous and malformed ones degrade', () => {
  const own = detectRelays({ sessionId, main: [], agents: { [owner]: [launch('task1234'), assistant(-100)] },
    meta: { [owner]: { agentType: 'worker' } }, now: start + 100000 })
  expect(own.lines).toHaveLength(0)
  expect(detectRelays({ sessionId, main: [enqueue(notice('task1234'))],
    agents: { [owner]: [launch('task1234'), assistant(-100)] },
    meta: { [owner]: { agentType: 'worker' } }, now: start + 100000 }).lines).toHaveLength(1)
  // D7: a background command no subagent of this session launched is main's own — silent, never DEGRADED.
  expect(detectRelays({ sessionId, main: [enqueue(notice('task1234'))], agents: {}, meta: {},
    now: start + 100000 })).toMatchObject({ lines: [], degraded: [] })
  // Two subagents claiming the same task id is ambiguous: degrade, never guess.
  expect(detectRelays({ sessionId, main: [enqueue(bashDone())],
    agents: { [owner]: [launch('task1234', 'toolu_aaa111'), assistant(-100)], [parent]: [launch('task1234', 'toolu_bbb222'), assistant(-100)] },
    meta: { [owner]: { agentType: 'worker' }, [parent]: { agentType: 'worker' } }, now: start + 100000 }).degraded)
    .toContain('background owner ambiguous for task task1234')
  expect(detectRelays({ sessionId, main: [enqueue(notice('monitor123', 'toolu_mon123', 'Monitor event: ready'))],
    agents: {}, meta: {}, now: start + 100000 })).toMatchObject({ lines: [], degraded: [] })
  expect(detectRelays({ sessionId, main: [enqueue('<task-notification><task-id>task1234</task-id></task-notification>')],
    agents: {}, meta: {}, now: start + 100000 }).degraded).toContain('task notification malformed; attribution unavailable')
  expect(detectRelays({ sessionId, main: [inbound(0, notice(child))], agents: {}, meta: {},
    now: start + 100000 }).degraded).toContain(`meta unknown for delegate ${child}`)
})

it('queue removal matches the exact notification; dequeue without content does not erase it', () => {
  const body = notice('task1234')
  const records = [enqueue(body), { type: 'queue-operation', operation: 'dequeue', timestamp: iso(1) }]
  expect(pendingQueueNotifications(records)).toHaveLength(1)
  records.push({ ...enqueue(body, 2), operation: 'remove' })
  expect(pendingQueueNotifications(records)).toHaveLength(0)
})

it('F4 main session transcript is read by byte offset, including partial lines', () => {
  const f = fixture()
  const file = join(temp!, `${sessionId}.jsonl`)
  const cursor = { offset: 0, tailBytes: Buffer.alloc(0), records: [] as unknown[] }
  writeFileSync(file, JSON.stringify(enqueue(notice('task1234'))).slice(0, 50))
  expect(readNewMain(file, cursor)).toHaveLength(0)
  writeFileSync(file, `${JSON.stringify(enqueue(notice('task1234')))}\n`)
  expect(readNewMain(file, cursor)).toHaveLength(1)
  expect(readNewMain(file, cursor)).toHaveLength(1)
  const unicode = Buffer.from(`${JSON.stringify(enqueue(notice('task5678', 'toolu_def456', 'étape terminée'), 100))}\n`)
  const split = unicode.indexOf(Buffer.from('é')) + 1
  writeFileSync(file, Buffer.concat([Buffer.from(`${JSON.stringify(enqueue(notice('task1234')))}\n`), unicode.subarray(0, split)]))
  expect(readNewMain(file, cursor)).toHaveLength(1)
  writeFileSync(file, Buffer.concat([Buffer.from(`${JSON.stringify(enqueue(notice('task1234')))}\n`), unicode]))
  expect(readNewMain(file, cursor)[1]?.content).toContain('étape terminée')
  expect(f.registry).toBeTruthy()
})

it('D2 an inbound enqueued before the wait but written after it still proves the resume (selected by file position)', () => {
  const f = fixture()
  // waiting at iso(-1000); the queued prompt carries its ENQUEUE time (-1005) yet sits after the end_turn record.
  f.write([assistant(-990), { type: 'attachment', timestamp: iso(-1005), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: notice('task1234') } }, assistant(-980)])
  expect(writeResumed(f.registry, f.subs)).toBe(1)
  expect(unresolvedWaits(readFileSync(f.registry, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).has(owner)).toBe(false)
})

const filler = (offset: number, bytes = 200_000) => JSON.stringify({ type: 'assistant', timestamp: iso(offset),
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x'.repeat(bytes) }] } })

it('D1 main: many large non-notification lines plus two notices retain exactly the two relevant records', () => {
  fixture()
  const file = join(temp!, `${sessionId}.jsonl`)
  const decoy = JSON.stringify({ type: 'assistant', timestamp: iso(1), message: { role: 'assistant', content: [{ type: 'text', text: `${'y'.repeat(50_000)} task-notification ${'y'.repeat(50_000)}` }] } })
  const lines = [...Array.from({ length: 20 }, (_, i) => filler(i)), decoy,
    JSON.stringify(enqueue(notice('task1234'), 30)), JSON.stringify(inbound(40, notice(child)))]
  writeFileSync(file, `${lines.join('\n')}\n`)
  const cursor = { offset: 0, tailBytes: Buffer.alloc(0), records: [] as unknown[] }
  const records = readNewMain(file, cursor)
  expect(records).toHaveLength(2)
  expect(cursor.records).toHaveLength(2)
  expect(JSON.stringify(cursor.records).length).toBeLessThan(5_000)
})

function agentSession(records: unknown[]) {
  temp = mkdtempSync(join(tmpdir(), 'delegate-wake-'))
  mkdirSync(join(temp, 'subagents'))
  const file = join(temp, 'subagents', `agent-${owner}.jsonl`)
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  writeFileSync(join(temp, 'subagents', `agent-${owner}.meta.json`), JSON.stringify({ agentType: 'worker' }))
  return { dir: temp, file }
}

it('D1 agent: the retained projection drops bulk tool_result text, caps inbound text, and detection still works', () => {
  const bulkResult = { type: 'user', timestamp: iso(-800), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bulk1', content: `BULK-TOOL-RESULT ${'z'.repeat(300_000)}` }] } }
  const bigInbound = inbound(-700, `INBOUND-HEAD ${'q'.repeat(300_000)}`)
  const { dir } = agentSession([launch('task1234'), bulkResult, bigInbound, assistant(-100)])
  const { agents, meta } = readAgents(dir)
  const serialized = JSON.stringify(agents)
  expect(serialized).not.toContain('BULK-TOOL-RESULT')
  expect(serialized.length).toBeLessThan(140_000)
  expect(serialized).toContain('INBOUND-HEAD')
  expect(detectRelays({ sessionId, main: [enqueue(notice('task1234'))], agents, meta, now: start + 100000 }).lines).toHaveLength(1)
})

it('D1 agent: a transcript is read incrementally by byte offset, including a partial last line, without duplicates', () => {
  const { dir, file } = agentSession([launch('task1234'), assistant(-100)])
  const cache = new Map()
  expect(readAgents(dir, cache).agents[owner]).toHaveLength(2)
  expect(readAgents(dir, cache).agents[owner]).toHaveLength(2)
  const next = JSON.stringify(assistant(50))
  appendFileSync(file, next.slice(0, 20))
  expect(readAgents(dir, cache).agents[owner]).toHaveLength(2)
  appendFileSync(file, `${next.slice(20)}\n`)
  expect(readAgents(dir, cache).agents[owner]).toHaveLength(3)
})

it('D1 CLI: a session transcript larger than the read buffer is streamed, never read whole, with the same result', () => {
  temp = mkdtempSync(join(tmpdir(), 'delegate-wake-'))
  const mainFile = join(temp, `${sessionId}.jsonl`)
  const subs = join(temp, sessionId, 'subagents')
  mkdirSync(subs, { recursive: true })
  const bulk = (offset: number, bytes: number) => filler(offset, bytes)
  writeFileSync(mainFile, [bulk(-2000, 700_000), JSON.stringify(enqueue(notice('task1234'))), bulk(-1900, 2_500_000), bulk(-1800, 300_000)].join('\n') + '\n')
  writeFileSync(join(subs, `agent-${owner}.jsonl`), [JSON.stringify(launch('task1234')), bulk(-950, 1_600_000), JSON.stringify(assistant(-100))].join('\n') + '\n')
  writeFileSync(join(subs, `agent-${owner}.meta.json`), JSON.stringify({ agentType: 'worker' }))
  // Any whole-file read of a transcript over 1 MiB fails: the CLI must stream.
  const guard = join(temp, 'no-whole-read.cjs')
  writeFileSync(guard, `const fs = require('node:fs'); const read = fs.readFileSync
fs.readFileSync = function (target, ...rest) {
  if (typeof target === 'string' && target.endsWith('.jsonl') && fs.statSync(target).size > 1048576) throw Object.assign(new Error('whole transcript read'), { code: 'EWHOLE' })
  return read.call(this, target, ...rest)
}
`)
  const cli = new URL('../../../../plugin/bin/wt-delegate-wake-scan.mjs', import.meta.url).pathname
  const result = spawnSync(process.execPath, [cli, '--session', mainFile, '--at', iso(100000), '--grace', '90'], {
    encoding: 'utf8', env: { PATH: process.env.PATH ?? '', NODE_OPTIONS: `--require ${guard}`, WT_OUTBOUND_GUARD_DIR: temp } })
  expect(result.stdout).toContain(`WAKE: ${owner}`)
  expect(result.stdout).not.toContain('ARC WATCH DEGRADED')
  expect(result.status).toBe(0)
})

// Real enqueue shapes measured in a 373 MB main transcript (neutral ids and paths).
const OUT = '/tmp/claude-1000/-home-user-projects-example/00000000-0000-4000-8000-000000000001/tasks'
const shape = (o: { ids: string[], tool?: string, out?: string, status?: string, summary: string, tail?: string }) => `<task-notification>\n${o.ids.map((id) => `<task-id>${id}</task-id>\n`).join('')}${o.tool ? `<tool-use-id>${o.tool}</tool-use-id>\n` : ''}${o.out ? `<output-file>${o.out}</output-file>\n` : ''}${o.status ? `<status>${o.status}</status>\n` : ''}<summary>${o.summary}</summary>\n${o.tail ?? ''}</task-notification>`
const monitorEvent = shape({ ids: ['bmon123456'], summary: 'Monitor event: "Arc watch"', tail: '<event>ARC WATCH ARMED: stale=10min poll=60s</event>\nIf this event is something the user would act on now, send a PushNotification.\n' })
const monitorStopped = shape({ ids: ['bmon123457'], out: `${OUT}/bmon123457.output`, status: 'killed', summary: 'Monitor "Arc watch" stopped' })
const monitorEnded = shape({ ids: ['bmon123458'], tool: 'toolu_mon456', out: `${OUT}/bmon123458.output`, status: 'completed', summary: 'Monitor "wait for batch" stream ended', tail: '<event>"inspected": 95504</event>\n' })
const orphanMulti = shape({ ids: ['bshell1111', 'bshell2222', 'bshell3333', '__orphan_summary__:shell'], status: 'stopped',
  summary: "3 background shell command tasks didn't finish before the previous session ended. Task ids: bshell1111, bshell2222, bshell3333.",
  tail: '<note>No completion record was found for them in the previous session.</note>\n' })
const orphanSingle = shape({ ids: ['bshell4444'], tool: 'toolu_orph789', status: 'stopped', summary: "Background shell command didn't finish before the previous session ended",
  tail: '<note>No completion record was found for it in the previous session.</note>\n' })
const agentDone = (withTool: boolean, withOut = true) => shape({ ids: [child], tool: withTool ? 'toolu_agent123' : undefined, out: withOut ? `${OUT}/${child}.output` : undefined,
  status: 'completed', summary: 'Agent "Review the change" finished', tail: '<note>A task-notification fires each time this agent stops.</note>\n<result>Nothing further to deliver</result>\n' })
const bashDone = (tool?: string, out?: string) => shape({ ids: ['task1234'], tool, out, status: 'completed', summary: 'Background command "Wait for the gates" completed (exit code 0)' })

it('D5 a notice naming one task and a status parses without tool-use-id or output-file; several task ids do not', () => {
  expect(parseTaskNotification(agentDone(false))).toMatchObject({ taskId: child, status: 'completed', toolUseId: null, outputFile: `${OUT}/${child}.output` })
  expect(parseTaskNotification(agentDone(false, false))).toMatchObject({ taskId: child, toolUseId: null, outputFile: null })
  expect(parseTaskNotification(agentDone(true))).toMatchObject({ toolUseId: 'toolu_agent123' })
  expect(parseTaskNotification(orphanMulti)).toBeNull()
})

it('D5 monitor events, Monitor stopped/ended and orphan summaries are skipped silently, queued or inbound', () => {
  for (const body of [monitorEvent, monitorStopped, monitorEnded, orphanMulti, orphanSingle]) {
    expect(detectRelays({ sessionId, main: [enqueue(body), inbound(0, body)], agents: {}, meta: {}, now: start + 100000 }))
      .toEqual({ lines: [], degraded: [], stale: [] })
  }
})

it('D5 FORWARD reaches the non-main parent of an agent notice with or without tool-use-id and output-file', () => {
  const meta = { [parent]: { agentType: 'pilot' }, [child]: { parentAgentId: parent, agentType: 'critic' } }
  for (const body of [agentDone(true), agentDone(false), agentDone(false, false)]) {
    const result = detectRelays({ sessionId, main: [inbound(0, body)], agents: { [parent]: [assistant(-10)] }, meta, now: start + 100000 })
    expect(result.degraded).toEqual([])
    expect(result.lines).toHaveLength(1)
    const line = result.lines[0].line as string
    expect(line).toContain(`SendMessage to "${parent}"`)
    expect(line).toContain(child)
    expect(line).not.toMatch(/null|undefined/)
    expect(line).toMatch(/\[wt-relay [a-f0-9]{12}\]/)
  }
  // the same notice queued (not yet delivered to main) is neither a WAKE nor a degraded read
  expect(detectRelays({ sessionId, main: [enqueue(agentDone(false))], agents: { [parent]: [assistant(-10)] }, meta, now: start + 100000 }))
    .toEqual({ lines: [], degraded: [], stale: [] })
})

it('D5 WAKE falls back to the launch task id without a tool-use-id and names the task when there is no output file', () => {
  const meta = { [owner]: { agentType: 'worker' } }
  for (const body of [bashDone(undefined, `${OUT}/task1234.output`), bashDone(undefined, undefined), bashDone('toolu_abc123', undefined)]) {
    const result = detectRelays({ sessionId, main: [enqueue(body)], agents: { [owner]: [launch('task1234'), assistant(-100)] }, meta, now: start + 100000 })
    expect(result.degraded).toEqual([])
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0].line).toContain(`SendMessage to "${owner}"`)
    expect(result.lines[0].line).not.toMatch(/null|undefined/)
    expect(result.lines[0].line).toContain('task1234')
  }
})

it('D6 the resumed record is never dated before its waiting record', () => {
  const f = fixture()
  f.write([assistant(-990), { type: 'attachment', timestamp: iso(-1005), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: notice('task1234') } }, assistant(-980)])
  expect(writeResumed(f.registry, f.subs)).toBe(1)
  const records = readFileSync(f.registry, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const resumed = records.find((r: { t: string }) => r.t === 'resumed')
  expect(Date.parse(resumed.at)).toBeGreaterThanOrEqual(Date.parse(records[0].at))
})

// Route (b): FORWARD's precision is unmeasured, so the live watcher announces WAKE only and the
// one-shot scanner lists FORWARD as an unverified diagnostic candidate.
const forwardScenario = () => {
  const meta = { [owner]: { agentType: 'worker' }, [parent]: { agentType: 'pilot' }, [child]: { parentAgentId: parent, agentType: 'critic' } }
  return { sessionId, main: [enqueue(notice('task1234')), inbound(0, notice(child))],
    agents: { [owner]: [launch('task1234'), assistant(-100)], [parent]: [assistant(-10)], [child]: [assistant(-20)] }, meta, now: start + 100000 }
}

it('route b: a result holding one WAKE and one FORWARD announces exactly the WAKE line, and the watcher uses that selector', () => {
  const result = detectRelays(forwardScenario())
  expect(result.lines.map((l: { kind: string }) => l.kind).sort()).toEqual(['FORWARD', 'WAKE'])
  const announced = announceable(result.lines)
  expect(announced).toHaveLength(1)
  expect(announced[0].kind).toBe('WAKE')
  expect(announced[0].line).toContain(`SendMessage to "${owner}"`)
  const watcher = readFileSync(new URL('../../../../plugin/bin/wt-arc-watch.mjs', import.meta.url), 'utf8')
  expect(watcher).toContain('candidates = announceable(result.lines)')
})

it('route b: the one-shot scanner prefixes FORWARD candidates as unverified, keeps WAKE plain, and its help says why', () => {
  temp = mkdtempSync(join(tmpdir(), 'delegate-wake-'))
  const scenario = forwardScenario()
  const mainFile = join(temp, `${sessionId}.jsonl`)
  const subs = join(temp, sessionId, 'subagents')
  mkdirSync(subs, { recursive: true })
  writeFileSync(mainFile, scenario.main.map((r: unknown) => JSON.stringify(r)).join('\n') + '\n')
  for (const [id, records] of Object.entries(scenario.agents)) {
    writeFileSync(join(subs, `agent-${id}.jsonl`), (records as unknown[]).map((r) => JSON.stringify(r)).join('\n') + '\n')
    writeFileSync(join(subs, `agent-${id}.meta.json`), JSON.stringify((scenario.meta as Record<string, unknown>)[id]))
  }
  const cli = new URL('../../../../plugin/bin/wt-delegate-wake-scan.mjs', import.meta.url).pathname
  const env = { PATH: process.env.PATH ?? '', WT_OUTBOUND_GUARD_DIR: temp }
  const run = spawnSync(process.execPath, [cli, '--session', mainFile, '--at', iso(100000), '--grace', '90'], { encoding: 'utf8', env })
  const lines = run.stdout.trim().split('\n')
  expect(lines.filter((l: string) => l.startsWith('WAKE: '))).toHaveLength(1)
  expect(lines.filter((l: string) => l.startsWith('FORWARD (unverified): '))).toHaveLength(1)
  expect(lines.filter((l: string) => l.startsWith('FORWARD: '))).toHaveLength(0)
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', env })
  expect(help.stdout).toContain('FORWARD')
  expect(help.stdout).toMatch(/diagnostic candidate/)
  expect(help.stdout).toMatch(/precision is unmeasured/)
})

it('F5 every delegate-facing doc states the measured self-wake rate as a majority, never as a guarantee or as never', () => {
  const docs = [
    'plugin/agents/wt-implementer-opus.md',
    'plugin/agents/wt-implementer-sonnet.md',
    'plugin/launch-agents/agents/wt-implementer-opus.md',
    'plugin/launch-agents/agents/wt-implementer-sonnet.md',
    'plugin/agent-templates/pilot.md',
    'plugin/agent-templates/pilot-orchestrator.md',
    'plugin/launch-agents/agents/pilot.md',
    'plugin/launch-agents/agents/pilot-orchestrator.md',
    'plugin/monitors/README.md',
  ]
  for (const doc of docs) {
    const text = readFileSync(new URL(`../../../../${doc}`, import.meta.url), 'utf8').replace(/\s+/g, ' ')
    expect(text, doc).toMatch(/606(\/| of )628/)
    expect(text, doc).toMatch(/168(\/| of )173/)
    expect(text, doc).toMatch(/not invariably|not every case/)
    expect(text, doc).not.toMatch(/only reliably re-woken by an inbound SendMessage/)
  }
})

it('fix5 #1 resume evidence for W1 cannot clear W2 appended before the resume write', () => {
  const f = fixture()
  f.write([assistant(-500), inbound(100, 'Continue'), assistant(200)])
  const w2 = { t: 'waiting', agentId: owner, artifact: 'next gates', at: iso(300) }
  const open = fs.openSync
  let inserted = false
  // The observer has read W1 when it opens the transcript; a second writer now declares W2.
  const spy = vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (!inserted && String(args[0]).endsWith(`agent-${owner}.jsonl`)) {
      inserted = true
      appendFileSync(f.registry, `${JSON.stringify(w2)}\n`)
    }
    return open(...args)
  })
  try {
    writeResumed(f.registry, f.subs, start + 100000)
    const records = readFileSync(f.registry, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(inserted).toBe(true)
    expect(unresolvedWaits(records).get(owner)).toEqual(w2)
  } finally { spy.mockRestore() }
})

it('fix5 #1 resumed identity matches its waiting occurrence; legacy resumed and out still clear', () => {
  const w1 = { t: 'waiting', agentId: owner, artifact: 'first', at: iso(-1000) }
  const w2 = { ...w1, artifact: 'second', at: iso(300) }
  const resume = { t: 'resumed', agentId: owner, at: iso(400), waitingAt: w1.at, waitingArtifact: w1.artifact }
  expect(unresolvedWaits([w1, resume]).size).toBe(0)
  expect(unresolvedWaits([w1, w2, resume]).get(owner)).toEqual(w2)
  expect(unresolvedWaits([w1, { ...w2, at: w1.at }, resume]).get(owner)?.artifact).toBe('second')
  for (const t of ['resumed', 'out']) expect(unresolvedWaits([w1, w2, { t, agentId: owner }]).size).toBe(0)
})

it('fix5 #2 quoted Read/Grep launch text without a structured receipt is neither owner nor ambiguity', () => {
  const quote = { ...launch('task1234'), toolUseResult: undefined }
  const { dir } = agentSession([quote, assistant(-100)])
  const projected = readAgents(dir)
  const input = { sessionId, main: [enqueue(notice('task1234'))], ...projected, now: start + 100000 }
  expect(detectRelays(input)).toEqual({ lines: [], degraded: [], stale: [] })
  const competing = 'aother1234567'
  const real = detectRelays({ ...input, agents: { ...projected.agents, [competing]: [launch('task1234'), assistant(-100)] } })
  expect(real.degraded).toEqual([])
  expect(real.lines).toHaveLength(1)
  expect(real.lines[0].line).toContain(`WAKE: ${competing}`)
})

it('fix5 #2 structured receipt must agree with text and survives the slim projection', () => {
  const { dir } = agentSession([{ ...launch('task1234'), toolUseResult: { backgroundTaskId: 'different123' } }, assistant(-100)])
  const input = { sessionId, main: [enqueue(notice('task1234'))], ...readAgents(dir), now: start + 100000 }
  expect(detectRelays(input)).toEqual({ lines: [], degraded: [], stale: [] })
  writeFileSync(join(dir, 'subagents', `agent-${owner}.jsonl`), [launch('task1234'), assistant(-100)].map((r) => JSON.stringify(r)).join('\n') + '\n')
  const projected = readAgents(dir)
  expect(projected.agents[owner][0].toolUseResult.backgroundTaskId).toBe('task1234')
  expect(detectRelays({ ...input, ...projected }).lines).toHaveLength(1)
})

it('fix5 #2 a main-owned tool-use-id never falls back to a subagent task-id match', () => {
  const result = detectRelays({ sessionId, main: [enqueue(notice('task1234', 'toolu_main123'))],
    agents: { [owner]: [launch('task1234'), assistant(-100)] }, meta: { [owner]: { agentType: 'worker' } }, now: start + 100000 })
  expect(result).toEqual({ lines: [], degraded: [], stale: [] })
})

function scanScenario() {
  temp = mkdtempSync(join(tmpdir(), 'delegate-wake-'))
  const scenario = forwardScenario()
  const mainFile = join(temp, `${sessionId}.jsonl`)
  const subs = join(temp, sessionId, 'subagents')
  mkdirSync(subs, { recursive: true })
  writeFileSync(mainFile, scenario.main.map((r) => JSON.stringify(r)).join('\n') + '\n')
  for (const [id, records] of Object.entries(scenario.agents)) {
    writeFileSync(join(subs, `agent-${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
    writeFileSync(join(subs, `agent-${id}.meta.json`), JSON.stringify(scenario.meta[id as keyof typeof scenario.meta]))
  }
  return mainFile
}

it('fix5 #3 route b JSON labels FORWARD unverified and non-actionable, and WAKE actionable', () => {
  const mainFile = scanScenario()
  const cli = fileURLToPath(new URL('../../../../plugin/bin/wt-delegate-wake-scan.mjs', import.meta.url))
  const run = spawnSync(process.execPath, [cli, '--session', mainFile, '--at', iso(100000), '--json'], { encoding: 'utf8' })
  expect(run.status).toBe(0)
  const result = JSON.parse(run.stdout)
  expect(result.lines).toHaveLength(2)
  expect(result.lines.find((entry: { kind: string }) => entry.kind === 'FORWARD')).toMatchObject({ actionable: false, verification: 'unverified', line: expect.stringMatching(/^FORWARD \(unverified\):/) })
  expect(result.lines.find((entry: { kind: string }) => entry.kind === 'WAKE')).toMatchObject({ actionable: true, line: expect.stringMatching(/^WAKE:/) })
})

// Exercise the shipped watcher itself. A preload fixes its clock and advances exactly three
// real polls without wall-clock sleeps; stdout poll boundaries expose the shared line budget.
function watcherFixture(diagnostics = 0, wakeCount = 1) {
  temp = mkdtempSync(join(tmpdir(), 'delegate-wake-'))
  const project = resolve(temp, 'project')
  const config = join(temp, 'config')
  const sessions = join(config, 'projects', project.replace(/[^A-Za-z0-9-]/g, '-'))
  const subs = join(sessions, sessionId, 'subagents')
  const stateDir = join(temp, 'state')
  const registryDir = join(temp, 'registry')
  mkdirSync(subs, { recursive: true })
  mkdirSync(stateDir)
  mkdirSync(registryDir)
  const tasks = Array.from({ length: wakeCount }, (_, i) => ({ task: i === 0 ? 'task1234' : `task${String(i).padStart(6, '0')}`, tool: i === 0 ? 'toolu_abc123' : `toolu_launch${i}` }))
  const main = [...tasks.map(({ task, tool }) => enqueue(notice(task, tool))), ...Array.from({ length: diagnostics }, (_, i) => inbound(0, notice(`aunknown${String(i).padStart(6, '0')}`)))]
  writeFileSync(join(sessions, `${sessionId}.jsonl`), main.map((r) => JSON.stringify(r)).join('\n') + '\n')
  writeFileSync(join(subs, `agent-${owner}.jsonl`), [...tasks.map(({ task, tool }) => launch(task, tool)), assistant(-100)].map((r) => JSON.stringify(r)).join('\n') + '\n')
  utimesSync(join(subs, `agent-${owner}.jsonl`), new Date(start), new Date(start))
  writeFileSync(join(subs, `agent-${owner}.meta.json`), JSON.stringify({ agentType: 'worker' }))
  writeFileSync(join(registryDir, `${sessionId}.jsonl`), '')
  const stateFile = join(stateDir, `${sessionId}.json`)
  writeFileSync(stateFile, '{}')
  const preload = join(temp, 'polls.cjs')
  writeFileSync(preload, `Date.now = () => ${start + 100000};
const timer = global.setTimeout; let polls = 0;
global.setTimeout = (fn, ms, ...args) => {
  if (ms === 5000) {
    process.stdout.write('FIX5 POLL END\\n');
    if (++polls === 3) process.exit(0);
    return timer(fn, 0, ...args);
  }
  return timer(fn, ms, ...args);
};\n`)
  const run = () => {
    const watcher = fileURLToPath(new URL('../../../../plugin/bin/wt-arc-watch.mjs', import.meta.url))
    const result = spawnSync(process.execPath, ['--require', preload, watcher, '--project', project, '--poll', '5'], {
      encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: sessionId,
        WT_OUTBOUND_GUARD_DIR: registryDir, WT_DELEGATE_WAKE_DIR: stateDir, WT_LIVENESS_DIR: join(temp!, 'liveness') },
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    return result.stdout.split('FIX5 POLL END\n').slice(0, 3).map((poll) => poll.trim().split('\n').filter((line) => line && !/^ARC WATCH (ARMED|BASELINE):/.test(line)))
  }
  return { run, stateDir, stateFile }
}

it('fix5 #4 watcher serves WAKE before 20 diagnostics and drains pending diagnostics within the 20-line poll cap', () => {
  const f = watcherFixture(20)
  const polls = f.run()
  expect(polls).toHaveLength(3)
  expect(polls[0][0]).toMatch(/^WAKE:/)
  expect(polls[0]).toHaveLength(20)
  expect(polls[1]).toHaveLength(1)
  expect(polls[2]).toHaveLength(0)
  expect(polls.every((poll) => poll.length <= 20)).toBe(true)
  const diagnostics = polls.flat().filter((line) => line.startsWith('ARC WATCH DEGRADED: meta unknown'))
  expect(diagnostics).toHaveLength(20)
  expect(new Set(diagnostics).size).toBe(20)
})

it('fix5 #5 watcher uses empty eligibility for a valid fully-throttled state in an unwritable directory', (context) => {
  if (process.getuid?.() === 0) context.skip('chmod cannot make a directory unwritable for root')
  if (process.platform === 'win32') context.skip('POSIX chmod directory permissions unavailable on Windows')
  const f = watcherFixture()
  const candidate = detectRelays(forwardScenario()).lines.find((entry: { kind: string }) => entry.kind === 'WAKE')
  writeFileSync(f.stateFile, JSON.stringify({ [candidate.key]: { lastEmittedAt: start + 100000, count: 1 } }))
  chmodSync(f.stateDir, 0o500)
  try {
    const polls = f.run()
    expect(polls[0].filter((line) => line.startsWith('WAKE:'))).toHaveLength(1)
    expect(polls.flat().filter((line) => line.startsWith('ARC WATCH DEGRADED: throttle state'))).toEqual(['ARC WATCH DEGRADED: throttle state unwritable'])
  } finally { chmodSync(f.stateDir, 0o700) }
})

it('fix5 #4 watcher retains an unprinted transient throttle diagnostic after the state is repaired', () => {
  const f = watcherFixture(0, 20)
  rmSync(f.stateFile)
  const polls = f.run()
  expect(polls[0]).toHaveLength(20)
  expect(polls[0].every((line) => line.startsWith('WAKE:'))).toBe(true)
  expect(polls[1]).toEqual(['ARC WATCH DEGRADED: throttle state absent'])
  expect(polls[2]).toHaveLength(0)
})

it('fix5 #6 replay cannot attribute a completion to a launch dated after now', () => {
  const result = detectRelays({ sessionId, main: [enqueue(notice('task1234'))],
    agents: { [owner]: [{ ...launch('task1234'), timestamp: iso(100001) }, assistant(-100)] },
    meta: { [owner]: { agentType: 'worker' } }, now: start + 100000 })
  expect(result).toEqual({ lines: [], degraded: [], stale: [] })
})

it('fix5 #6 a future competing launch does not make the past owner ambiguous', () => {
  const result = detectRelays({ sessionId, main: [enqueue(notice('task1234'))],
    agents: { [owner]: [launch('task1234'), assistant(-100)], [parent]: [{ ...launch('task1234'), timestamp: iso(100001) }, assistant(-100)] },
    meta: { [owner]: { agentType: 'worker' }, [parent]: { agentType: 'pilot' } }, now: start + 100000 })
  expect(result.degraded).toEqual([])
  expect(result.lines).toHaveLength(1)
  expect(result.lines[0].line).toContain(`WAKE: ${owner}`)
})

it('fix5 #7 streaming 200000 retained records does not overflow the argument stack and retains the exact count', () => {
  const began = performance.now()
  const { dir, file } = agentSession([])
  // Generate once, then exercise the production streaming reader rather than repeated reads.
  writeFileSync(file, `${JSON.stringify(inbound(-100, 'continue'))}\n`.repeat(200000))
  const records = readAgents(dir).agents[owner]
  expect(records).toHaveLength(200000)
  expect(records[199999].message.content).toBe('continue')
  console.info(`fix5 #7 200000-record test (generate + stream + count): ${Math.round(performance.now() - began)}ms`)
})

it('fix6 a completion older than the WAKE age ceiling is never relayed, only listed as stale', () => {
  const hour = 3_600_000
  const main = [enqueue(notice('task1234'))]
  const input = { sessionId, main, agents: { [owner]: [launch('task1234'), assistant(-100)] }, meta: { [owner]: { agentType: 'worker' } }, grace: 90000 }
  const fresh = detectRelays({ ...input, now: start + 23 * hour })
  expect(fresh.lines[0]?.line).toContain(`SendMessage to "${owner}"`)
  expect(fresh.stale).toEqual([])
  const old = detectRelays({ ...input, now: start + 25 * hour })
  expect(old.lines).toEqual([])
  expect(old.stale).toEqual([{ owner, taskId: 'task1234', at: iso(0) }])
  expect(detectRelays({ ...input, now: start + 25 * hour, maxAge: 26 * hour }).lines).toHaveLength(1)
})
