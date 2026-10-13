import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { supervisionPaths, supervisionSlots } from '../lane-supervisor-core.mjs'

function directoryEntries(directory) {
  try { return readdirSync(directory, { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function validEntry(entry) {
  return entry && typeof entry.runId === 'string' && Number.isFinite(entry.at)
}

function validArchive(value) {
  return value?.version === 1 && Array.isArray(value.entries) && value.entries.every(validEntry)
    && (value.through == null || validEntry(value.through))
}

function load(file, report) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (!validArchive(value)) throw new Error('invalid completion notice archive')
    return { entries: new Map(value.entries.map((entry) => [entry.runId, entry])), through: value.through ?? null, baseline: false }
  } catch (error) {
    if (error?.code !== 'ENOENT') report(error)
    return { entries: new Map(), through: null, baseline: true }
  }
}

function* recordsInDirectory(dir) {
  for (const entry of directoryEntries(dir)) {
    if (!entry.isFile() || !/^\d+-\d+\.json$/.test(entry.name)) continue
    const file = path.join(dir, entry.name)
    let parsed
    try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
      if (error instanceof SyntaxError || error?.code === 'ENOENT') continue
      throw error
    }
    yield { record: parsed, modifiedAt: statSync(file).mtimeMs }
  }
}

function* records(root, cutoff) {
  for (const entry of directoryEntries(root)) {
    if (!entry.isDirectory() || !/^[0-9a-f]{32}$/.test(entry.name)) continue
    const hostDir = path.join(root, entry.name)
    for (const slot of supervisionSlots(null, { hostDir })) {
      const { dir } = supervisionPaths(null, null, slot, { hostDir })
      if (statSync(dir).mtimeMs < cutoff) continue
      yield* recordsInDirectory(dir)
    }
  }
}

function reportPresent(file) {
  try { return statSync(file).isFile() } catch { return false }
}

export const exitNoticeStore = { load, records, reportPresent }
