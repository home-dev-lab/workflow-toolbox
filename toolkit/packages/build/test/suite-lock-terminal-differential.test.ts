import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

const source = (name: string) => readFileSync(new URL(`../../../../plugin/bin/lib/host/${name}.mjs`, import.meta.url), 'utf8')
function declaration(text: string, name: string) {
  const start = text.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`missing differential subject ${name}`)
  return text.slice(start, text.indexOf('\n}', start) + 2)
}

function ticketObservation(text: string, scenario: number) {
  const trace: unknown[] = []
  let lists = 0, markers = 0, records = 0
  const record = { get field() { trace.push(['get:field']); if (scenario === 5) throw new Error('getter'); return 1 } }
  const seams = {
    list() { trace.push(['list', ++lists, this === seams]); return { markers: [1, 2], records: [], parked: scenario === 1 ? [8] : [] } },
    prepare(number: number) { trace.push(['prepare', number, this === seams]); if (scenario === 4) throw new Error('prepare') },
  }
  const deps = { path: path.posix, TICKET_MARKERS_KEPT: scenario === 2 ? 1 : 256,
    listTickets: seams.list, ticketBase: (dir: string, n: number) => `${dir}/${n}`, recordFile: (dir: string, n: number) => `${dir}/${n}.json`,
    mkdirSync: (...args: unknown[]) => { trace.push(['mkdir', ...args]) },
    existsSync: (file: string) => { trace.push(['exists', file]); return false },
    rmSync: (...args: unknown[]) => { trace.push(['remove', ...args]) },
    createExclusive(file: string, content: string) {
      trace.push(['create', file, content])
      if (file.endsWith('.ticket')) return scenario !== 3 || ++markers > 2
      return scenario !== 6 || ++records > 1
    },
  }
  return observeFunction(text, 'takeTicket', deps, ['/queue', record, seams], trace)
}

function observeFunction(text: string, name: string, deps: object, args: unknown[], trace: unknown[]) {
  let value: unknown, error: unknown
  try { value = runInNewContext(`${text}\n${name}`, deps)(...args) } catch (caught) {
    const failure = caught as Error & { code?: string }
    error = { name: failure.name, message: failure.message, code: failure.code }
  }
  // VM objects have a distinct prototype; compare their values, not their realm.
  return JSON.parse(JSON.stringify({ value, error, trace }))
}

it('preserves ticket allocation returns errors effects property reads and callback receivers in 7 cases', () => {
  const text = source('suite-lock-queue')
  const current = declaration(text, 'takeTicket') + '\n' + declaration(text, 'ticketContent')
  const reference = declaration(text, 'takeTicket')
    .replace('    if (createExclusive(recordFile', '    seams.prepare?.(number)\n    if (createExclusive(recordFile')
    .replace('ticketContent(record, number, seams)', '`${JSON.stringify(record)}\\n`')
  const candidate = process.env.WT_SUITE_DIFFERENTIAL_MUTATE ? current.replace('return number', 'return number + 1') : current
  for (let scenario = 0; scenario < 7; scenario++) {
    expect(ticketObservation(candidate, scenario), `ticket differential case ${scenario}`).toEqual(ticketObservation(reference, scenario))
  }
})

function reaperObservation(text: string, scenario: number) {
  const trace: unknown[] = []
  const dead = { pid: 999, leaseId: 'lease', journal: { root: '/journal', leaseId: 'lease' } }
  const record = { ...dead, ...([4, 7].includes(scenario) ? { pid: 1 } : {}), ...(scenario === 5 ? { leaseId: 'replacement' } : {}) }
  const deps = { path: path.posix, process: { pid: 123 }, randomUUID: () => 'unique',
    provenDead: (holder: { pid: number }) => holder.pid === 999,
    removeTicket: (...args: unknown[]) => { trace.push(['remove-ticket', ...args]) },
    renameSync(...args: unknown[]) {
      trace.push(['rename', ...args])
      if (scenario === 2 || scenario === 3) throw Object.assign(new Error('rename'), { code: scenario === 2 ? 'ENOENT' : 'EPERM' })
    },
    readFileSync: (...args: unknown[]) => { trace.push(['read', ...args]); return JSON.stringify(record) },
    readHolderIn: (...args: unknown[]) => { trace.push(['holder', ...args]); return scenario === 6 ? { leaseId: 'lease' } : null },
    writeFileSync(...args: unknown[]) { trace.push(['restore', ...args]); if (scenario === 7) throw Object.assign(new Error('occupied'), { code: 'EEXIST' }) },
    rmSync: (...args: unknown[]) => { trace.push(['remove-claim', ...args]) },
    suiteJournalEvent: (...args: unknown[]) => { trace.push(['journal', ...args]) },
    claimSuiteSection: (root: string, critical: () => unknown) => { trace.push(['claim-section', root]); return critical() },
  }
  const options = { beforeTicketClaim() { trace.push(['before-claim', this === options]) } }
  return observeFunction(text, 'reapSuiteTicket', deps, ['/queue', { number: 1, holder: scenario === 1 ? { ...dead, pid: 1 } : dead }, options], trace)
}

it('preserves reaper returns errors effects and outgoing call order in 8 cases', () => {
  const text = source('suite-lock-recovery')
  const body = declaration(text, 'reapSuiteTicket')
  const journal = text.match(/^const recoveryJournal = .+$/m)?.[0]
  if (!journal) throw new Error('missing differential subject recoveryJournal')
  const common = declaration(text, 'restoreClaim') + '\n' + journal
  const current = body + '\n' + common + '\n' + declaration(text, 'renameClaim')
  const referenceBody = body.replace('    if (!renameClaim(file, claim)) return', `    try { renameSync(file, claim) } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }`)
  expect(referenceBody, 'reference must inline the rename claim').not.toBe(body)
  const reference = referenceBody + '\n' + common
  const candidate = process.env.WT_SUITE_DIFFERENTIAL_MUTATE ? current.replace("cause: 'client-gone'", "cause: 'wrong-cause'") : current
  for (let scenario = 0; scenario < 8; scenario++) {
    const observed = reaperObservation(candidate, scenario)
    const baseline = reaperObservation(reference, scenario)
    expect(observed.error?.name ?? '', `candidate reaper case ${scenario} must execute its real body`).not.toMatch(/^(ReferenceError|TypeError)$/)
    expect(baseline.error?.name ?? '', `reference reaper case ${scenario} must execute its real body`).not.toMatch(/^(ReferenceError|TypeError)$/)
    expect(observed, `reaper differential case ${scenario}`).toEqual(baseline)
  }
})
