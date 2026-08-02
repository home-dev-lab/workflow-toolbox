import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/bin/wt-check-observer-pairing.mjs')

type Verdict = {
  exitCode: number
  stdout: string
  json: { status?: string; reason?: string; observerFile?: string; checked?: number }
}

function withTempSubagentsDir(run: (dir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'wt-observer-pairing-'))
  const dir = join(root, 'subagents')
  mkdirSync(dir)
  try {
    run(dir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeMeta(dir: string, filename: string, payload: unknown, atSeconds: number): string {
  const filePath = join(dir, filename)
  writeFileSync(filePath, JSON.stringify(payload))
  const at = new Date(atSeconds * 1000)
  utimesSync(filePath, at, at)
  return filePath
}

function runCheck(subagentsDir: string, name: string, windowSec?: number): Verdict {
  const args = [SCRIPT, '--subagents-dir', subagentsDir, '--name', name]
  if (windowSec !== undefined) args.push('--window-sec', String(windowSec))
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8' })
    return { exitCode: 0, stdout, json: JSON.parse(stdout) as Verdict['json'] }
  } catch (error) {
    const failed = error as Error & { status?: number; stdout?: string | Buffer }
    const stdout = typeof failed.stdout === 'string' ? failed.stdout : String(failed.stdout ?? '')
    return {
      exitCode: failed.status ?? 2,
      stdout,
      json: JSON.parse(stdout) as Verdict['json'],
    }
  }
}

describe('wt-check-observer-pairing.mjs', () => {
  it('passes for in_process_teammate with no siblings at all', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'in_process_teammate' }, 1_000)

      const result = runCheck(dir, 'pilot-orchestrator')

      expect(result.exitCode).toBe(0)
      expect(result.json.status).toBe('pass')
    })
  })

  it('passes for async when an isObserver sibling lands 5s later', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'async' }, 1_000)
      writeMeta(dir, 'observer.meta.json', { name: 'pilot-orchestrator-watchdog', isObserver: true }, 1_005)

      const result = runCheck(dir, 'pilot-orchestrator')

      expect(result.exitCode).toBe(0)
      expect(result.json.status).toBe('pass')
      expect(result.json.observerFile).toContain('observer.meta.json')
    })
  })

  it('flags async when no isObserver sibling exists at all', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'async' }, 1_000)
      writeMeta(dir, 'other.meta.json', { name: 'pilot-helper', taskKind: 'async' }, 1_010)

      const result = runCheck(dir, 'pilot-orchestrator')

      expect(result.exitCode).toBe(1)
      expect(result.json.status).toBe('flag')
    })
  })

  it('flags async when an isObserver sibling exists outside the window', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'async' }, 1_000)
      writeMeta(dir, 'observer.meta.json', { name: 'pilot-orchestrator-watchdog', isObserver: true }, 1_200)

      const result = runCheck(dir, 'pilot-orchestrator', 30)

      expect(result.exitCode).toBe(1)
      expect(result.json.status).toBe('flag')
    })
  })

  it('passes on the green observer-pairing fixture', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'async' }, 1_000)
      writeMeta(dir, 'observer.meta.json', { name: 'pilot-orchestrator-watchdog', isObserver: true }, 1_005)

      const result = runCheck(dir, 'pilot-orchestrator')

      expect(result.exitCode).toBe(0)
      expect(result.json.status).toBe('pass')
    })
  })

  it('red-proof: deleting the observer sibling flips the same fixture to flag', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'async' }, 1_000)
      const observer = writeMeta(dir, 'observer.meta.json', { name: 'pilot-orchestrator-watchdog', isObserver: true }, 1_005)
      unlinkSync(observer)

      const result = runCheck(dir, 'pilot-orchestrator')

      expect(result.exitCode).toBe(1)
      expect(result.json.status).toBe('flag')
    })
  })

  it('returns unknown for an unrecognized taskKind', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'named-but-weird' }, 1_000)

      const result = runCheck(dir, 'pilot-orchestrator')

      expect(result.exitCode).toBe(2)
      expect(result.json.status).toBe('unknown')
    })
  })

  it('returns unknown when the observed name is not found', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'other.meta.json', { name: 'someone-else', taskKind: 'async' }, 1_000)

      const result = runCheck(dir, 'pilot-orchestrator')

      expect(result.exitCode).toBe(2)
      expect(result.json.status).toBe('unknown')
    })
  })
})
