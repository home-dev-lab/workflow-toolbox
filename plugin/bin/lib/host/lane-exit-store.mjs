import { lstatSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'

function directoryEntries(directory, report) {
  try { return readdirSync(directory, { withFileTypes: true }) } catch (error) {
    report(directory, error)
    return []
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

function recentStat(file, cutoff, report) {
  try {
    const info = statSync(file)
    return info.mtimeMs >= cutoff ? info : null
  } catch (error) { report(file, error); return null }
}

function* recordsInDirectory(dir, cutoff, report) {
  for (const entry of directoryEntries(dir, report)) {
    if (!entry.isFile() || !/^\d+-\d+\.json$/.test(entry.name)) continue
    const file = path.join(dir, entry.name)
    const info = recentStat(file, cutoff, report)
    if (!info) continue
    let parsed
    try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
      if (!(error instanceof SyntaxError)) report(file, error)
      continue
    }
    yield { record: parsed, modifiedAt: info.mtimeMs }
  }
}

function supervisionDirectories(hostDir, report) {
  return directoryEntries(hostDir, report)
    .filter((entry) => entry.isDirectory() && /^supervision(?:-[A-Za-z0-9._-]+)?$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => path.join(hostDir, entry.name))
}

function* records(root, cutoff, report) {
  for (const entry of directoryEntries(root, report)) {
    if (!entry.isDirectory() || !/^[0-9a-f]{32}$/.test(entry.name)) continue
    const hostDir = path.join(root, entry.name)
    for (const dir of supervisionDirectories(hostDir, report)) {
      if (!recentStat(dir, cutoff, report)) continue
      yield* recordsInDirectory(dir, cutoff, report)
    }
  }
}

function pruneArchives(ownFile, cutoff, report) {
  const directory = path.dirname(ownFile)
  for (const entry of directoryEntries(directory, report)) {
    if (!entry.isFile() || !/^[A-Za-z0-9_-]+\.json$/.test(entry.name)) continue
    const file = path.join(directory, entry.name)
    if (file === ownFile) continue
    try {
      const info = lstatSync(file)
      if (info.isFile() && info.mtimeMs < cutoff) unlinkSync(file)
    } catch (error) { report(file, error) }
  }
}

function reportPresent(file) {
  try { return statSync(file).isFile() } catch { return false }
}

export const exitNoticeStore = { load, records, reportPresent, pruneArchives }
