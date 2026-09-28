import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createSuiteLockBroker } from '../../../../plugin/bin/lib/host/lane-suite-lock-broker.mjs'

const REPETITIONS = 40
const INVALID_CLIENTS = 16
const BOUNDS = { errors: 5_000, closed: 3_000, grant: 5_000 }
type Step = keyof typeof BOUNDS
type Events = { connect?: number, data?: number, end?: number, close?: number, error?: [number, string] }
type Client = { socket: net.Socket, events: Events, text: () => string }
type StepResult = { completed: boolean, elapsedMs: number }

function timedClient(address: string, now: () => number, request?: unknown, halfOpen = false, onConnect?: () => void): Client {
  const socket = net.connect({ path: address, allowHalfOpen: halfOpen })
  const events: Events = {}
  let text = ''
  socket.on('connect', () => { events.connect = now(); onConnect?.() })
  socket.on('data', (chunk) => { events.data ??= now(); text += String(chunk) })
  socket.on('end', () => { events.end = now() })
  socket.on('close', () => { events.close = now() })
  socket.on('error', (error: NodeJS.ErrnoException) => { events.error = [now(), error.code ?? error.message] })
  if (request !== undefined) socket.write(`${typeof request === 'string' ? request : JSON.stringify(request)}\n`)
  return { socket, events, text: () => text }
}

async function measure(predicate: () => boolean | Promise<boolean>, budgetMs: number): Promise<StepResult> {
  const start = performance.now()
  const deadline = start + budgetMs
  while (performance.now() < deadline) {
    if (await predicate()) return { completed: true, elapsedMs: Math.round(performance.now() - start) }
    await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, deadline - performance.now()))))
  }
  return { completed: false, elapsedMs: Math.round(performance.now() - start) }
}

function stats(values: number[]) {
  const sorted = values.sort((a, b) => a - b)
  return { min: sorted[0], p50: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) }
}

async function repetition(rep: number) {
  const root = mkdtempSync(join(tmpdir(), 'wt-lock-local-broker-diag-'))
  const previous = process.env.WT_SUITE_LOCK_DIR
  const previousBroker = process.env.WT_SUITE_LOCK_BROKER
  process.env.WT_SUITE_LOCK_DIR = join(root, 'locks')
  // The in-process broker must acquire from its fresh lock dir, not recurse into an ambient lane broker.
  delete process.env.WT_SUITE_LOCK_BROKER
  const since = performance.now()
  const now = () => Math.round(performance.now() - since)
  const server = createSuiteLockBroker() as net.Server
  const accepted: Array<{ events: Events, socket: net.Socket }> = []
  const rejected: Client[] = []
  let next: Client | undefined
  const nextAtConnect: { at?: number, count?: number, error?: string } = {}
  const steps = {} as Record<Step, StepResult>
  const stalls: Array<{ step: Step | 'setup', elapsedMs: number, state: unknown }> = []
  server.on('connection', (socket) => {
    const events: Events = { connect: now() }
    accepted.push({ events, socket })
    socket.on('end', () => { events.end = now() })
    socket.on('close', () => { events.close = now() })
    socket.on('error', (error: NodeJS.ErrnoException) => { events.error = [now(), error.code ?? error.message] })
  })
  const connectionCount = () => new Promise<number>((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)))
  const state = async () => ({
    at: now(),
    serverConnections: await connectionCount().catch((error: Error) => `error: ${error.message}`),
    rejected: rejected.map((client) => ({ text: client.text(), events: { ...client.events } })),
    accepted: accepted.map((peer) => ({ events: { ...peer.events } })),
    next: next && { text: next.text(), events: { ...next.events } },
    nextAtConnect: { ...nextAtConnect },
  })
  let detail: Awaited<ReturnType<typeof state>> | undefined
  try {
    const address = join(root, 'broker.sock')
    await new Promise<void>((resolve) => server.listen(address, resolve))
    for (let i = 0; i < INVALID_CLIENTS; i++) rejected.push(timedClient(address, now, '{bad', true))
    steps.errors = await measure(() => rejected.every((client) => client.text().startsWith('error ')), BOUNDS.errors)
    if (!steps.errors.completed) stalls.push({ step: 'errors', elapsedMs: steps.errors.elapsedMs, state: await state() })
    steps.closed = await measure(async () => await connectionCount() === 0, BOUNDS.closed)
    if (!steps.closed.completed) stalls.push({ step: 'closed', elapsedMs: steps.closed.elapsedMs, state: await state() })
    next = timedClient(address, now, { argv: ['next'], waitS: 1 }, false, () => {
      nextAtConnect.at = now()
      server.getConnections((error, count) => {
        if (error) nextAtConnect.error = error.message
        else nextAtConnect.count = count
      })
    })
    steps.grant = await measure(() => next!.text().includes('granted '), BOUNDS.grant)
    if (!steps.grant.completed) stalls.push({ step: 'grant', elapsedMs: steps.grant.elapsedMs, state: await state() })
  } catch (error) {
    stalls.push({ step: 'setup', elapsedMs: now(), state: { error: String(error), ...(await state()) } })
  } finally {
    detail = await state()
    next?.socket.destroy()
    for (const client of rejected) client.socket.destroy()
    for (const peer of accepted) peer.socket.destroy()
    if (server.listening) server.close()
    if (previous === undefined) delete process.env.WT_SUITE_LOCK_DIR
    else process.env.WT_SUITE_LOCK_DIR = previous
    if (previousBroker === undefined) delete process.env.WT_SUITE_LOCK_BROKER
    else process.env.WT_SUITE_LOCK_BROKER = previousBroker
    rmSync(root, { recursive: true, force: true })
  }
  return { rep, steps, elapsedMs: now(), stalls, detail }
}

describe.skipIf(process.platform === 'win32')('broker half-open diagnostic', () => {
  it('records bounded per-step evidence across fresh brokers', async () => {
    const runs: Awaited<ReturnType<typeof repetition>>[] = []
    for (let rep = 1; rep <= REPETITIONS; rep++) runs.push(await repetition(rep))
    const slowest = [...runs].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 3)
    const result = {
      platform: process.platform, node: process.version, n: REPETITIONS,
      completed: runs.filter((run) => !run.stalls.length).length,
      stalls: runs.flatMap((run) => run.stalls.map((stall) => ({ rep: run.rep, ...stall }))),
      stepStats: Object.fromEntries((Object.keys(BOUNDS) as Step[]).map((step) => [step, stats(runs.flatMap((run) => run.steps[step] ? [run.steps[step].elapsedMs] : []))])),
      // A stalled repetition already has its full state in stalls; do not duplicate it in the log.
      slowest: slowest.map(({ rep, steps, elapsedMs, detail, stalls }) => ({
        rep, steps, elapsedMs, ...(stalls.length ? {} : { state: detail }),
      })),
    }
    const output = JSON.stringify(result)
    mkdirSync('ci-diagnostics', { recursive: true })
    writeFileSync('ci-diagnostics/broker-darwin-diag.json', `${output}\n`)
    process.stdout.write(`BROKER-DARWIN-DIAG ${output}\n`)
    expect(output.length).toBeGreaterThan(0)
  }, 650_000)
})
