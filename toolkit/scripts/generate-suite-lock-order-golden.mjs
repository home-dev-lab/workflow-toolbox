import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const upstreamCommit = '77635d4d2'
const source = process.argv[2] ? readFileSync(process.argv[2], 'utf8')
  : execFileSync('git', ['show', `${upstreamCommit}:plugin/bin/lib/suite-lock-order.mjs`], { encoding: 'utf8' })
const load = (text) => import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`)
const develop = await load(source)
const noAging = await load(source.replace('const LEVEL_AGING_STEP_MS = 30 * 60 * 1000', 'const LEVEL_AGING_STEP_MS = Infinity'))
const now = Date.parse('2026-01-01T12:00:00Z')
const record = { level: 2, levelOrderVersion: 3, project: 'alpha', size: 'L', startedAt: new Date(now).toISOString(), lightGrantsAtQueue: 0, lightGrantsGeneration: 'light' }
const grid = (...axes) => axes.reduce((rows, values) => rows.flatMap((row) => values.map((value) => [...row, value])), [[]])

function rolloverVector([level, version, age, grants, p0grants, kind]) {
  const first = { ...record, level, levelOrderVersion: version, startedAt: new Date(now - age).toISOString(), p0GrantsAtQueue: 0, p0GrantsGeneration: 'p0' }
  if (kind === 'light') first.light = true
  if (kind === 'release') first.priority = 'release'
  if (kind === 'counter-lost') first.lightGrantsGeneration = 'lost'
  const older = { level, levelOrderVersion: version, startedAt: first.startedAt }
  const tickets = [{ number: 1, record: kind === 'null' ? null : kind === 'old' ? older : first },
    { number: 2, record: { ...record, level: 0, p0GrantsAtQueue: 0, p0GrantsGeneration: 'p0' } }]
  const counter = { generation: 'light', grants }; const p0Counter = { generation: 'p0', grants: p0grants }
  const result = develop.orderSuiteLockTickets(tickets, counter, now, p0Counter)
  return { tickets, counter, p0Counter, expected: { order: result.order, levelOrder: result.levelOrder,
    ranked: result.tickets.map((ticket) => [ticket.number, ticket.key, ticket.effectiveLevel ?? null]) } }
}

function p0Vector([level, grants, generation, queued, lightGrants, lightGeneration]) {
  const entry = { ...record, level, levelOrderVersion: 2, startedAt: new Date(now - 10800000).toISOString(), p0GrantsAtQueue: queued, p0GrantsGeneration: generation }
  const counter = { generation: lightGeneration, grants: lightGrants }
  return { record: entry, counter, expected: noAging.orderSuiteLockTickets([{ number: 1, record: entry }], counter, now, { generation: 'p0', grants }).tickets[0].effectiveLevel }
}

const rollover = grid([undefined, 0, 1, 2], [undefined, 1, 2], [0, 1800000, 10800000], [0, 8], [0, 16], ['exclusive', 'light', 'release', 'old', 'null', 'counter-lost']).map(rolloverVector)
const p0 = grid([0, 1, 2], [0, 7, 8, 15, 16, 17], ['p0', 'lost', null], [undefined, -1, 0, 5, 20], [0, 7, 8], ['light', 'lost']).map(p0Vector)
writeFileSync(new URL('../packages/build/test/fixtures/suite-lock-order-golden.json', import.meta.url), JSON.stringify({
  provenance: 'Captured from the pre-v3 order module; p0 vectors disable only LEVEL_AGING_STEP_MS.',
  source: { generator: 'toolkit/scripts/generate-suite-lock-order-golden.mjs', upstreamCommit }, now, rollover, p0,
}) + '\n')
