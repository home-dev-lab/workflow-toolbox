import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createHostAdapter } from '../../../../plugin/bin/lib/host/adapter.mjs'

const EVIDENCE_ROOT = resolve(import.meta.dirname, '../../../../probes/host-platform/evidence')
const platforms = ['linux', 'darwin', 'win32'] as const
const labels = { linux: 'ubuntu-latest', darwin: 'macos-latest', win32: 'windows-latest' } as const
const seedWrongFake = process.env.WT_SEED_WRONG_HOST_FAKE === '1'
const useRealHost = process.env.WT_HOST_CONTRACT_REAL === '1'
const activePlatforms = useRealHost ? platforms.filter((platform) => platform === process.platform) : platforms

function evidenceHost(platform: typeof platforms[number]) {
  return createHostAdapter({
    platform,
    evidenceRoot: EVIDENCE_ROOT,
    mutate: (evidence: { processTable: { processTable: { raw: string } } }) => {
      if (seedWrongFake && platform !== 'win32') evidence.processTable.processTable.raw = evidence.processTable.processTable.raw.replace(/^(\s*1)\s+0/m, '$1 999')
      return evidence
    },
  })
}

const contractHost = (platform: typeof platforms[number]) => useRealHost ? createHostAdapter({ platform }) : evidenceHost(platform)

describe('host adapter evidence contract', () => {
  const assertions = useRealHost ? 4 : 12
  const contract = (name: string, appliesTo: readonly string[], run: (platform: typeof platforms[number]) => void) => {
    it(`${name} [${appliesTo.join(',')}]`, () => {
      for (const platform of activePlatforms) {
        if (!appliesTo.includes(platform)) continue
        run(platform)
      }
    })
  }

  contract('reports evidence provenance for every question', platforms, (platform) => {
    const host = contractHost(platform)
    if (useRealHost) expect(host.platform).toBe(platform)
    else expect(host.evidence()).toMatchObject({ platform, runnerLabel: labels[platform], runId: '35501457364' })
  })

  contract('answers pid to parent-pid from the captured process table', platforms, (platform) => {
    const result = contractHost(platform).readProcessRelationships()
    if (platform === 'win32') {
      expect(result).toEqual({ status: 'unavailable', processes: [], reason: 'process table command exited 1' })
    } else {
      expect(result.status).toBe('known')
      expect(result.processes.length).toBeGreaterThan(1)
      expect(result.processes.every((row: { pid: number, parentPid: number }) => Number.isSafeInteger(row.pid) && Number.isSafeInteger(row.parentPid))).toBe(true)
      expect(result.processes.find((row: { pid: number }) => row.pid === 1)?.parentPid).toBe(0)
    }
  })

  contract('resolves the captured symlinked directory to its canonical target', platforms, (platform) => {
    const host = contractHost(platform)
    if (!useRealHost) {
      const sample = host.evidence().path.symlinkedDirectory
      expect(host.resolveCanonicalPath(sample.input)).toEqual({ status: 'resolved', path: sample.targetRealpath })
      return
    }
    const root = mkdtempSync(join(tmpdir(), 'wt-host-contract-'))
    const target = join(root, 'target'); const link = join(root, 'link')
    try {
      mkdirSync(target)
      symlinkSync(target, link, platform === 'win32' ? 'junction' : 'dir')
      expect(host.resolveCanonicalPath(link)).toEqual({ status: 'resolved', path: realpathSync.native(target) })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  contract('ends the captured process family using the native host concept', platforms, (platform) => {
    const host = contractHost(platform)
    if (!useRealHost) {
      const sample = host.evidence().termination
      expect(host.endProcessFamily(sample.childPid)).toEqual({ status: 'ended', kind: platform === 'win32' ? 'process_tree' : 'posix_process_group' })
      return
    }
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { detached: true, stdio: 'ignore' })
    if (!child.pid) throw new Error('host contract fixture did not start')
    try {
      expect(host.endProcessFamily(child.pid)).toEqual({ status: 'ended', kind: platform === 'win32' ? 'process_tree' : 'posix_process_group' })
    } finally { try { process.kill(child.pid, 'SIGKILL') } catch {} }
  })

  it('prints the declared applicability and skip count', () => {
    const skips = useRealHost ? 8 : 0
    expect(assertions + skips).toBe(12)
    const skippedPlatforms = useRealHost ? platforms.filter((platform) => platform !== process.platform).join(',') : 'none'
    process.stdout.write(`host adapter contract: assertions=${assertions} named_skips=${skips} skipped_platforms=${skippedPlatforms}\n`)
  })
})
