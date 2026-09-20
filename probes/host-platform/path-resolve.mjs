import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { basename, join, parse } from 'node:path'

import { outputPath, provenance, runToFile, writeEvidence } from './probe-lib.mjs'

const destination = outputPath('path-resolve')
const scratch = `${destination}.native`
const root = mkdtempSync(join(tmpdir(), 'wt-host-path-probe-'))
const target = join(root, 'target')
const link = join(root, 'directory-link')
mkdirSync(target)

const measure = (input) => {
  try {
    return { status: 'measured', input, realpath: realpathSync.native(input) }
  } catch (error) {
    return { status: 'measurement_failed', input, error: String(error.message) }
  }
}

let symlink
try {
  symlinkSync(target, link, platform() === 'win32' ? 'junction' : 'dir')
  symlink = { creation: 'measured', ...measure(link), targetRealpath: realpathSync.native(target) }
} catch (error) {
  symlink = { creation: 'measurement_failed', input: link, error: String(error.message) }
}

let shortForm
let unc
if (platform() === 'win32') {
  const shortResult = runToFile('cmd.exe', ['/d', '/s', '/c', `for %I in ("${root}") do @echo %~sI`], `${scratch}.short`)
  const shortPath = shortResult.raw.trim()
  shortForm = {
    status: shortResult.exitCode === 0 && shortPath !== '' ? 'measured' : 'measurement_failed',
    commandResult: shortResult,
    resolvedShortPath: shortPath === '' ? null : measure(shortPath),
    note: 'A short path identical to the long path means 8.3 naming is disabled or no component has a short alias.',
  }
  const parsed = parse(root)
  const drive = parsed.root.slice(0, 1)
  const uncInput = `\\\\localhost\\${drive}$\\${root.slice(parsed.root.length).split('\\').join('\\')}`
  unc = {
    status: 'attempted',
    inputConstruction: { kind: 'string_arithmetic', description: 'Mapped the local drive root to its localhost administrative-share spelling.' },
    machineEvidence: measure(uncInput),
  }
} else {
  shortForm = { status: 'not_applicable', reason: '8.3 short paths are a Windows filesystem question; no path.win32 simulation was used.' }
  unc = { status: 'not_applicable', reason: 'UNC paths are a Windows host question; no string-only path.win32 result is presented as evidence.' }
}

const command = `node ${basename(import.meta.filename)} ${destination}`
const evidence = {
  provenance: provenance('path-resolve', command, `${scratch}.provenance`),
  tempDirectory: { reportedRoot: tmpdir(), createdPath: root, machineEvidence: measure(root) },
  symlinkedDirectory: symlink,
  windows83ShortForm: shortForm,
  windowsUnc: unc,
  classification: 'Only cases labelled machineEvidence or measured called the host filesystem. Labelled string_arithmetic values are inputs, not probe conclusions.',
}
rmSync(root, { recursive: true, force: true })
writeEvidence(destination, evidence)
