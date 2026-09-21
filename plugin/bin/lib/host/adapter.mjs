import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import * as darwin from './darwin.mjs'
import * as linux from './linux.mjs'
import * as posix from './posix.mjs'
import * as win32 from './win32.mjs'

const implementations = { aix: posix, darwin, freebsd: posix, linux, sunos: posix, win32 }
const evidenceLabels = { linux: 'ubuntu-latest', darwin: 'macos-latest', win32: 'windows-latest' }

export function createHostAdapter({ platform = process.platform, invoke, evidenceRoot, mutate = (value) => value } = {}) {
  const implementation = implementations[platform]
  if (!implementation) throw new Error(`host adapter unavailable on ${platform}`)
  const captured = evidenceRoot ? readEvidence(platform, evidenceRoot, mutate) : null
  const invocation = captured ? evidenceInvocation(implementation, captured) : invoke ?? realInvocation()
  const adapter = {
    platform,
    readProcessRelationships: () => implementation.readProcessRelationships(invocation),
    readProcessSnapshot: () => implementation.readProcessSnapshot(invocation),
    resolveCanonicalPath: (input) => implementation.resolveCanonicalPath(invocation, input),
    endProcessFamily: (pid) => implementation.endProcessFamily(invocation, pid),
  }
  if (!captured) return adapter
  return { ...adapter, evidence: () => evidenceSummary(platform, captured) }
}

function realInvocation() {
  return {
    run(command, args, options = {}) {
      try {
        const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options })
        return { status: result.status ?? 'unavailable', stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error ?? null }
      } catch (error) {
        return { status: 'unavailable', stdout: '', stderr: '', error }
      }
    },
    realpath(input) {
      try { return { status: 'resolved', path: realpathSync.native(input) } } catch (error) { return { status: 'unavailable', path: null, reason: error?.code ?? String(error) } }
    },
    killGroup(pid) {
      try { process.kill(-Number(pid), 'SIGTERM'); return { status: 'ended', kind: 'posix_process_group' } } catch (error) { return { status: 'unavailable', kind: 'posix_process_group', reason: error?.code ?? String(error) } }
    },
    killTree(pid) {
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
      return result.status === 0 ? { status: 'ended', kind: 'process_tree' } : { status: 'unavailable', kind: 'process_tree', reason: `taskkill exited ${String(result.status)}` }
    },
  }
}

export const hostAdapter = createHostAdapter()

function readEvidence(platform, evidenceRoot, mutate) {
  const directory = join(evidenceRoot, evidenceLabels[platform])
  return mutate({
    processTable: JSON.parse(readFileSync(join(directory, 'process-table.json'), 'utf8')),
    termination: JSON.parse(readFileSync(join(directory, 'process-group-terminate.json'), 'utf8')),
    path: JSON.parse(readFileSync(join(directory, 'path-resolve.json'), 'utf8')),
  })
}

const evidenceSummary = (platform, captured) => ({
  platform,
  runnerLabel: captured.processTable.provenance.runnerImage.label,
  runId: captured.processTable.provenance.runId,
  path: captured.path,
  termination: { childPid: captured.termination.pids.childPid, ...captured.termination.operation },
})

const operationKey = ({ command, args }) => JSON.stringify([command, args])

function evidenceInvocation(implementation, captured) {
  const operations = new Map([
    [operationKey(implementation.processRelationshipOperation), captured.processTable.processTable],
    [operationKey(implementation.processSnapshotOperation), captured.processTable.processSnapshot],
  ].filter(([, result]) => result))
  return {
    run(command, args) {
      const key = operationKey({ command, args })
      const result = operations.get(key)
      if (!result) throw new Error(`captured host evidence has no invocation for ${command} ${args.join(' ')}`)
      return { status: result.exitCode, stdout: result.raw, stderr: result.exitCode === 0 ? '' : result.raw }
    },
    realpath(input) {
      const samples = [captured.path.tempDirectory.machineEvidence, captured.path.symlinkedDirectory, captured.path.windowsUnc?.machineEvidence].filter(Boolean)
      const sample = samples.find((item) => item.input === input)
      return sample?.realpath ? { status: 'resolved', path: sample.realpath } : { status: 'unavailable', path: null, reason: 'path absent from captured evidence' }
    },
    killGroup(pid) {
      return pid === captured.termination.pids.childPid && captured.termination.termination.exitCode === 0
        ? { status: 'ended', kind: 'posix_process_group' }
        : { status: 'unavailable', kind: 'posix_process_group', reason: 'termination absent from captured evidence' }
    },
    killTree(pid) {
      return pid === captured.termination.pids.childPid && captured.termination.termination.exitCode === 0
        ? { status: 'ended', kind: 'process_tree' }
        : { status: 'unavailable', kind: 'process_tree', reason: 'termination absent from captured evidence' }
    },
  }
}
