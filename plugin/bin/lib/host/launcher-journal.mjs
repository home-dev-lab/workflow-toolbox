import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { refuseEventSymlink } from './launcher-event-io.mjs'
import { eventOperation, eventReason, removeEventFile } from './launcher-maildir.mjs'

export const JOURNAL_LIMIT = 65_536
export const JOURNAL_FRAME_MAX = 1_099
const PAYLOAD_MAX = 1_024
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function journalFrame(record) {
  const bytes = Buffer.from(JSON.stringify(record))
  if (bytes.length > PAYLOAD_MAX) throw new Error('launcher-journal-record-too-large')
  return Buffer.concat([Buffer.from(`${bytes.length.toString(16).padStart(8, '0')}:${digest(bytes)}:`), bytes, Buffer.from('\n')])
}

function decodeFrame(bytes) {
  const header = bytes.subarray(0, 74).toString('utf8'), payload = bytes.subarray(74, -1)
  if (!/^[0-9a-f]{8}:[0-9a-f]{64}:$/.test(header)) throw new Error('launcher-journal-invalid-frame')
  if (payload.length > PAYLOAD_MAX || parseInt(header.slice(0, 8), 16) !== payload.length) throw new Error('launcher-journal-invalid-length')
  if (digest(payload) !== header.slice(9, 73)) throw new Error('launcher-journal-checksum-mismatch')
  return JSON.parse(payload.toString('utf8'))
}

function validateRecord(record) {
  if (record?.v !== 1 || !['claim', 'printed', 'done'].includes(record.type)) throw new Error('launcher-journal-invalid-record')
  if (typeof record.name !== 'string' || !/^\d+-\d+-[A-Za-z0-9-]+\.json$/.test(record.name)) throw new Error('launcher-journal-invalid-name')
  if (typeof record.token !== 'string' || !/^[0-9a-f-]{36}$/.test(record.token) || !Number.isFinite(record.at)) throw new Error('launcher-journal-invalid-transaction')
}

function applyRecord(transactions, record) {
  validateRecord(record)
  const current = transactions.at(-1)
  if (record.type === 'claim') {
    if (current && !current.done) throw new Error('launcher-journal-overlapping-claims')
    transactions.push({ name: record.name, token: record.token, records: [record], printed: false, done: false })
    return
  }
  if (!current || current.name !== record.name || current.token !== record.token) throw new Error('launcher-journal-transaction-mismatch')
  if (current.done || (record.type === 'done') !== current.printed) throw new Error('launcher-journal-invalid-transition')
  current[record.type] = true
  current.records.push(record)
}

function parseJournal(bytes) {
  const transactions = []; let offset = 0
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset)
    if (end === -1) return { transactions, offset, torn: true }
    let record
    try { record = decodeFrame(bytes.subarray(offset, end + 1)) }
    catch (error) { if (end === bytes.length - 1) return { transactions, offset, torn: true }; throw error }
    applyRecord(transactions, record)
    offset = end + 1
  }
  return { transactions, offset, torn: false }
}

export function syncJournalDirectory(directory, options) {
  if ((options.platform ?? process.platform) === 'win32') return
  const fd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export function openLauncherJournal(paths, options) {
  const file = path.join(paths.box, 'delivery.journal'); refuseEventSymlink(file)
  const fd = openSync(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1) throw new Error('launcher-journal-not-private-file')
    if (info.size > JOURNAL_LIMIT + 3 * JOURNAL_FRAME_MAX) throw new Error('launcher-journal-size-limit')
    const parsed = parseJournal(readFileSync(fd))
    if (parsed.torn) {
      ftruncateSync(fd, parsed.offset); fsyncSync(fd)
      eventReason(options, 'launcher-journal-torn-tail-retained')
      closeSync(fd); return null
    }
    fsyncSync(fd)
    syncJournalDirectory(paths.box, options)
    return { file, fd, bytes: parsed.offset, transactions: parsed.transactions }
  } catch (error) { closeSync(fd); throw error }
}

function writeFrame(fd, bytes, write = writeSync) {
  let offset = 0
  while (offset < bytes.length) {
    const count = write(fd, bytes, offset, bytes.length - offset)
    if (count <= 0) throw new Error('launcher-journal-write-no-progress')
    offset += count
  }
}

function sharingFailure(error, options) {
  return (options.platform ?? process.platform) === 'win32' && ['EPERM', 'EBUSY', 'EACCES'].includes(error.code)
}

function exhaustedAppend(error, options) {
  if (!sharingFailure(error, options)) return error
  return Object.assign(new Error(`windows-sharing-retry-exhausted append: ${error.code}`), { code: `windows-sharing-retry-exhausted ${error.code}` })
}

export function appendJournalRecord(journal, record, options) {
  validateRecord(record)
  const frame = journalFrame(record)
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      writeFrame(journal.fd, frame, options.journalWrite); fsyncSync(journal.fd)
      applyRecord(journal.transactions, record); journal.bytes += frame.length
      return
    } catch (error) {
      eventReason(options, 'launcher-journal-append-failed', error)
      ftruncateSync(journal.fd, journal.bytes); fsyncSync(journal.fd)
      if (attempt + 1 >= (sharingFailure(error, options) ? 4 : 3)) throw exhaustedAppend(error, options)
    }
  }
}

export function compactLauncherJournal(journal, options) {
  if (journal.bytes < JOURNAL_LIMIT) return
  const retained = journal.transactions.filter((item) => !item.projected)
  const bytes = Buffer.concat(retained.flatMap((item) => item.records.map(journalFrame)))
  const next = path.join(path.dirname(journal.file), `delivery.${randomUUID()}.next`)
  const fd = openSync(next, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    try { writeFrame(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    // No descriptor for the replaced journal remains open on Windows.
    closeSync(journal.fd); journal.fd = undefined
    eventOperation('rename', next, journal.file, options)
    syncJournalDirectory(path.dirname(journal.file), options)
    journal.fd = openSync(journal.file, constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0))
    journal.bytes = bytes.length; journal.transactions = retained
  } finally { removeEventFile(next, options) }
}

export function closeLauncherJournal(journal) {
  if (journal?.fd !== undefined) { closeSync(journal.fd); journal.fd = undefined }
}
