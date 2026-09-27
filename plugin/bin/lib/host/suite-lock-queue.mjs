import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// The file layer of the suite lock's FIFO queue (policy: ../suite-lock.mjs). Two files per ticket,
// both created with an exclusive `wx` open, which is atomic on every platform and needs no flock:
//   <n>.ticket  an allocation marker that outlives the wait, so a waiter that read the directory late
//               climbs past numbers already handed out instead of reusing a freed low one;
//   <n>.json    the waiter's holder-shaped record, whose mtime is its heartbeat.
const TICKET_DIGITS = 16
const TICKET_MARKERS_KEPT = 256
const TICKET_FILE = /^(\d{16})\.(ticket|json)$/

const ticketBase = (queueDir, number) => path.join(queueDir, String(number).padStart(TICKET_DIGITS, '0'))
const recordFile = (queueDir, number) => `${ticketBase(queueDir, number)}.json`

function listTickets(queueDir) {
  const markers = []
  const records = []
  for (const name of readdirSync(queueDir)) {
    const match = TICKET_FILE.exec(name)
    if (match) (match[2] === 'ticket' ? markers : records).push(Number(match[1]))
  }
  return { markers, records: records.sort((a, b) => a - b) }
}

function createExclusive(file, content) {
  try {
    writeFileSync(file, content, { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
}

/** Live ticket numbers, lowest (oldest) first. */
export function queuedTickets(queueDir) {
  return listTickets(queueDir).records
}

/** Allocates the next number past every marker still on disk and publishes the record under it. */
export function takeTicket(queueDir, record) {
  mkdirSync(queueDir, { recursive: true, mode: 0o700 })
  const { markers, records } = listTickets(queueDir)
  let number = Math.max(0, ...markers, ...records) + 1
  while (!createExclusive(`${ticketBase(queueDir, number)}.ticket`, '')) number += 1
  for (const old of markers) {
    if (old <= number - TICKET_MARKERS_KEPT) rmSync(`${ticketBase(queueDir, old)}.ticket`, { force: true })
  }
  createExclusive(recordFile(queueDir, number), `${JSON.stringify(record)}\n`)
  return number
}

/** Refreshes the record's mtime; a record someone removed is put back under the same number. */
export function heartbeatTicket(queueDir, number, record) {
  const file = recordFile(queueDir, number)
  const now = new Date()
  try { utimesSync(file, now, now) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    createExclusive(file, `${JSON.stringify(record)}\n`)
  }
}

/** The ticket in the holder's shape ({ held, holder, ageMs }, age = time since its heartbeat), or null once gone. */
export function readTicket(queueDir, number) {
  const file = recordFile(queueDir, number)
  let holder = null
  try { holder = JSON.parse(readFileSync(file, 'utf8')) } catch { /* being written, or gone */ }
  try { return { held: true, holder, ageMs: Date.now() - statSync(file).mtimeMs } } catch { return null }
}

export function removeTicket(queueDir, number) {
  rmSync(recordFile(queueDir, number), { force: true })
}
