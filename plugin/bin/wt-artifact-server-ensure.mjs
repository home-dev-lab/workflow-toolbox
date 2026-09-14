#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ARTIFACT_PORT_ATTEMPTS,
  ARTIFACT_SERVER_VERSION,
  artifactRegistrationsDir,
  atomicWriteJson,
  configuredArtifactPort,
  configuredDenyPatterns,
  configuredRoots,
  ensureSecureStateDir,
  probeArtifactServer,
} from './lib/artifact-server.mjs'
import { handleHelpFlag } from './lib/cli-help.mjs'
import { resolveWorkflowToolboxOption } from './lib/plugin-options.mjs'

const HELP = `wt-artifact-server-ensure - register this session with the shared artifact server

Usage:
  wt-artifact-server-ensure

The monitor starts or attaches by default. Set WT_ARTIFACT_SERVER=0 to disable it.
WT_ARTIFACT_SERVER_PORT overrides the per-user candidate port; WT_ARTIFACT_SERVER_ROOTS
is a path-delimited list of name=path or bare-path roots.

Options:
  --help, -h  print this text and exit 0
`

const session = `${process.pid}-${randomUUID()}`
const parentPid = process.ppid
let stopping = false
let upgradeNoticed = false
let registrationFile = null
let finish
const finished = new Promise((resolve) => { finish = resolve })

function spawnServer(port) {
  const script = fileURLToPath(new URL('./wt-artifact-server.mjs', import.meta.url))
  const child = spawn(process.execPath, [script, 'serve'], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, WT_ARTIFACT_SERVER_PORT: String(port) },
  })
  child.unref()
}

function compareVersions(left, right) {
  const a = String(left).split('.').map(Number)
  const b = String(right).split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

async function discoverOrStart(firstPort) {
  let firstFree = null
  for (let offset = 0; offset < ARTIFACT_PORT_ATTEMPTS && firstPort + offset <= 65535; offset += 1) {
    const port = firstPort + offset
    const probe = await probeArtifactServer(port)
    if (probe.kind === 'ours') return { port, health: probe.health }
    if (probe.kind === 'free' && firstFree === null) firstFree = port
  }
  if (firstFree === null) return null
  spawnServer(firstFree)
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    for (let offset = 0; offset < ARTIFACT_PORT_ATTEMPTS && firstPort + offset <= 65535; offset += 1) {
      const port = firstPort + offset
      const probe = await probeArtifactServer(port, 250)
      if (probe.kind === 'ours') return { port, health: probe.health }
    }
  }
  return null
}

function removeRegistration() {
  if (registrationFile) rmSync(registrationFile, { force: true })
}

function cleanExit() {
  if (stopping) return
  stopping = true
  removeRegistration()
  finish()
}

async function main() {
  if (!resolveWorkflowToolboxOption('artifact_server').value) return
  let firstPort
  let roots
  try {
    ensureSecureStateDir()
    firstPort = configuredArtifactPort()
    roots = configuredRoots()
    registrationFile = path.join(artifactRegistrationsDir(), `${session}.json`)
    atomicWriteJson(registrationFile, {
      pid: process.pid, roots, deny: configuredDenyPatterns(), startedAt: new Date().toISOString(),
    })
  } catch (error) {
    process.stderr.write(`wt-artifact-server: ${error.message}\n`)
    process.exitCode = 1
    return
  }
  try {
    const found = await discoverOrStart(firstPort)
    if (!found) {
      process.stdout.write(`ARTIFACT SERVER NOT STARTED: no available port in ${firstPort}-${Math.min(firstPort + ARTIFACT_PORT_ATTEMPTS - 1, 65535)}\n`)
      return
    }
    if (!upgradeNoticed && typeof found.health.version === 'string' && compareVersions(ARTIFACT_SERVER_VERSION, found.health.version) > 0) {
      process.stdout.write(`artifact server v${found.health.version} is older than plugin v${ARTIFACT_SERVER_VERSION}; run \`node wt-artifact-server.mjs restart\` when sessions can disconnect.\n`)
      upgradeNoticed = true
    }
    const keepAlive = setInterval(() => {
      if (process.ppid !== parentPid) cleanExit()
    }, 2_000)
    try { await finished } finally { clearInterval(keepAlive) }
  } finally {
    removeRegistration()
  }
}

const argv = process.argv.slice(2)
handleHelpFlag(argv, HELP)
if (argv.length > 0) {
  process.stderr.write('usage: wt-artifact-server-ensure\n')
  process.exitCode = 2
} else {
  process.once('SIGINT', cleanExit)
  process.once('SIGTERM', cleanExit)
  process.once('exit', removeRegistration)
  await main()
}
