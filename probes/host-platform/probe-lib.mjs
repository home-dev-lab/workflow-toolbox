import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, platform, release, version } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export const outputPath = (name) => resolve(process.argv[2] ?? `evidence/${platform()}/${name}.json`)

export const runToFile = (command, args, file, options = {}) => {
  mkdirSync(dirname(file), { recursive: true })
  const descriptor = openSync(file, 'w')
  let result
  try {
    result = spawnSync(command, args, {
      ...options,
      encoding: undefined,
      stdio: ['ignore', descriptor, descriptor],
      timeout: options.timeout ?? 30_000,
      windowsHide: true,
    })
  } finally {
    closeSync(descriptor)
  }
  const raw = readFileSync(file, 'utf8')
  rmSync(file, { force: true })
  return {
    command: [command, ...args].join(' '),
    exitCode: result.status,
    signal: result.signal,
    error: result.error === undefined ? null : String(result.error.message),
    raw,
  }
}

const unavailableTool = (reason) => ({ status: 'not_used', reason })

const toolVersions = (scratch) => {
  const procps = platform() === 'linux'
    ? runToFile('ps', ['--version'], `${scratch}.procps`)
    : unavailableTool('procps is not the process-table provider on this OS')
  const powershell = platform() === 'win32'
    ? runToFile('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], `${scratch}.powershell`)
    : unavailableTool('PowerShell is not used by these probes on this OS')
  return {
    node: process.version,
    procps,
    powershell,
  }
}

export const provenance = (probe, command, scratch) => ({
  schemaVersion: 1,
  probe,
  capturedAt: new Date().toISOString(),
  command,
  runId: process.env.GITHUB_RUN_ID ?? 'local',
  commitSha: process.env.GITHUB_SHA ?? 'local-uncommitted',
  runnerImage: {
    label: process.env.WT_RUNNER_IMAGE ?? 'local',
    os: process.env.ImageOS ?? 'unknown',
    version: process.env.ImageVersion ?? 'unknown',
  },
  osRelease: {
    platform: platform(),
    release: release(),
    version: version(),
    arch: arch(),
  },
  tools: toolVersions(scratch),
})

export const writeEvidence = (file, evidence) => {
  mkdirSync(dirname(file), { recursive: true })
  const bytes = `${JSON.stringify(evidence, null, 2)}\n`
  writeFileSync(file, bytes, { encoding: 'utf8' })
  const readBack = readFileSync(file)
  if (readBack.length === 0) throw new Error(`probe wrote no evidence: ${file}`)
  if (readBack[0] === 0xef && readBack[1] === 0xbb && readBack[2] === 0xbf) {
    throw new Error(`probe wrote a UTF-8 BOM: ${file}`)
  }
  if (readBack.toString('utf8') !== bytes) throw new Error(`probe read-back differs: ${file}`)
  process.stdout.write(`${file}\n`)
}

export const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
