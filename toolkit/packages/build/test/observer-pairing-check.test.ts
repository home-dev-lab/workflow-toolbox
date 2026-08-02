import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/bin/wt-check-observer-pairing.mjs')

type Verdict = {
  exitCode: number
  stdout: string
  json: {
    status?: string
    reason?: string
    matchedBy?: 'id' | 'name'
    observerFile?: string
    checked?: number
    malformed?: unknown[]
    candidates?: string[]
    triedAgentId?: string | null
    triedName?: string | null
  }
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

function writeAgentFixture(dir: string, rawId: string, payload: unknown, atSeconds: number): string {
  const metaPath = writeMeta(dir, `agent-${rawId}.meta.json`, payload, atSeconds)
  const jsonlPath = join(dir, `agent-${rawId}.jsonl`)
  writeFileSync(jsonlPath, '')
  const at = new Date(atSeconds * 1000)
  utimesSync(jsonlPath, at, at)
  return metaPath
}

function runCheck(
  subagentsDir: string,
  options: { agentId?: string; name?: string; windowSec?: number },
): Verdict {
  const args = [SCRIPT, '--subagents-dir', subagentsDir]
  if (options.agentId) args.push('--agent-id', options.agentId)
  if (options.name) args.push('--name', options.name)
  if (options.windowSec !== undefined) args.push('--window-sec', String(options.windowSec))
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
  it('returns a usage error when neither --agent-id nor --name is given', () => {
    withTempSubagentsDir((dir) => {
      try {
        execFileSync(process.execPath, [SCRIPT, '--subagents-dir', dir], { encoding: 'utf8' })
        expect.unreachable()
      } catch (error) {
        const failed = error as Error & { status?: number; stdout?: string | Buffer }
        const stdout = typeof failed.stdout === 'string' ? failed.stdout : String(failed.stdout ?? '')
        const json = JSON.parse(stdout) as Verdict['json']

        expect(failed.status).toBe(2)
        expect(json.status).toBe('unknown')
        expect(json.reason).toContain('(--agent-id <rawId> | --name <observedAgentName>)')
      }
    })
  })

  it('passes for in_process_teammate with no siblings at all', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'in_process_teammate' }, 1_000)

      const result = runCheck(dir, { name: 'pilot-orchestrator' })

      expect(result.exitCode).toBe(0)
      expect(result.json.status).toBe('pass')
      expect(result.json.matchedBy).toBe('name')
    })
  })

  it('passes for an anonymous agent resolved by --agent-id when an isObserver sibling lands in-window', () => {
    withTempSubagentsDir((dir) => {
      writeAgentFixture(dir, 'anon-pass', { agentType: 'general-purpose', description: 'anonymous spawn', spawnDepth: 1 }, 1_000)
      writeMeta(dir, 'observer.meta.json', { name: 'pilot-orchestrator-watchdog', isObserver: true }, 1_005)

      const result = runCheck(dir, { agentId: 'anon-pass' })

      expect(result.exitCode).toBe(0)
      expect(result.json.status).toBe('pass')
      expect(result.json.matchedBy).toBe('id')
      expect(result.json.observerFile).toContain('observer.meta.json')
    })
  })

  it('flags the same anonymous --agent-id shape when no isObserver sibling exists', () => {
    withTempSubagentsDir((dir) => {
      writeAgentFixture(dir, 'anon-flag', { agentType: 'general-purpose', description: 'anonymous spawn', spawnDepth: 1 }, 1_000)
      writeMeta(dir, 'other.meta.json', { name: 'pilot-helper' }, 1_010)

      const result = runCheck(dir, { agentId: 'anon-flag' })

      expect(result.exitCode).toBe(1)
      expect(result.json.status).toBe('flag')
      expect(result.json.matchedBy).toBe('id')
    })
  })

  it('passes for a named agent resolved by --name when an isObserver sibling lands 5s later', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'async' }, 1_000)
      writeMeta(dir, 'observer.meta.json', { name: 'pilot-orchestrator-watchdog', isObserver: true }, 1_005)

      const result = runCheck(dir, { name: 'pilot-orchestrator' })

      expect(result.exitCode).toBe(0)
      expect(result.json.status).toBe('pass')
      expect(result.json.matchedBy).toBe('name')
      expect(result.json.observerFile).toContain('observer.meta.json')
    })
  })

  it('flags a named agent resolved by --name when no isObserver sibling exists', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'async' }, 1_000)
      writeMeta(dir, 'other.meta.json', { name: 'pilot-helper', taskKind: 'async' }, 1_010)

      const result = runCheck(dir, { name: 'pilot-orchestrator' })

      expect(result.exitCode).toBe(1)
      expect(result.json.status).toBe('flag')
      expect(result.json.matchedBy).toBe('name')
    })
  })

  it('raw id takes priority over name when both resolve different agents', () => {
    withTempSubagentsDir((dir) => {
      writeAgentFixture(dir, 'id-wins', { agentType: 'general-purpose', description: 'anonymous spawn', spawnDepth: 1 }, 1_000)
      writeAgentFixture(dir, 'name-would-pass', { name: 'named-target' }, 1_100)
      writeMeta(dir, 'observer.meta.json', { name: 'pilot-orchestrator-watchdog', isObserver: true }, 1_105)

      const result = runCheck(dir, { agentId: 'id-wins', name: 'named-target' })

      expect(result.exitCode).toBe(1)
      expect(result.json.status).toBe('flag')
      expect(result.json.matchedBy).toBe('id')
    })
  })

  it('falls back to --name when --agent-id does not resolve to a readable file', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'async' }, 1_000)
      writeMeta(dir, 'observer.meta.json', { name: 'pilot-orchestrator-watchdog', isObserver: true }, 1_005)

      const result = runCheck(dir, { agentId: 'missing-id', name: 'pilot-orchestrator' })

      expect(result.exitCode).toBe(0)
      expect(result.json.status).toBe('pass')
      expect(result.json.matchedBy).toBe('name')
    })
  })

  it('flags a taskKind-absent agent instead of treating it as unrecognized', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator' }, 1_000)
      writeMeta(dir, 'other.meta.json', { name: 'pilot-helper' }, 1_010)

      const result = runCheck(dir, { name: 'pilot-orchestrator' })

      expect(result.exitCode).toBe(1)
      expect(result.json.status).toBe('flag')
      expect(result.json.matchedBy).toBe('name')
    })
  })

  it('passes on the green observer-pairing fixture', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'async' }, 1_000)
      writeMeta(dir, 'observer.meta.json', { name: 'pilot-orchestrator-watchdog', isObserver: true }, 1_005)

      const result = runCheck(dir, { name: 'pilot-orchestrator' })

      expect(result.exitCode).toBe(0)
      expect(result.json.status).toBe('pass')
      expect(result.json.matchedBy).toBe('name')
    })
  })

  it('red-proof: deleting the observer sibling flips the same fixture to flag', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'async' }, 1_000)
      const observer = writeMeta(dir, 'observer.meta.json', { name: 'pilot-orchestrator-watchdog', isObserver: true }, 1_005)
      unlinkSync(observer)

      const result = runCheck(dir, { name: 'pilot-orchestrator' })

      expect(result.exitCode).toBe(1)
      expect(result.json.status).toBe('flag')
      expect(result.json.matchedBy).toBe('name')
    })
  })

  it('returns unknown for an unrecognized taskKind', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'named-but-weird' }, 1_000)

      const result = runCheck(dir, { name: 'pilot-orchestrator' })

      expect(result.exitCode).toBe(2)
      expect(result.json.status).toBe('unknown')
      expect(result.json.matchedBy).toBe('name')
    })
  })

  it('returns unknown when the observed name is not found', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'other.meta.json', { name: 'someone-else', taskKind: 'async' }, 1_000)

      const result = runCheck(dir, { name: 'pilot-orchestrator' })

      expect(result.exitCode).toBe(2)
      expect(result.json.status).toBe('unknown')
      expect(result.json.triedAgentId).toBeNull()
      expect(result.json.triedName).toBe('pilot-orchestrator')
    })
  })

  // Mutation-coverage: an isObserver sibling that predates the observed agent must NOT
  // count as pairing — timing correlation only makes sense forward in time (the observer
  // attaches AFTER the observed spawns). Without this test, relaxing the script's
  // `delta >= 0` guard to a bare `delta <= windowMs` would keep every other test green.
  it('flags async when the only isObserver sibling predates the observed agent (negative delta)', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observer.meta.json', { name: 'pilot-orchestrator-watchdog', isObserver: true }, 990)
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'async' }, 1_000)

      const result = runCheck(dir, { name: 'pilot-orchestrator', windowSec: 30 })

      expect(result.exitCode).toBe(1)
      expect(result.json.status).toBe('flag')
      expect(result.json.matchedBy).toBe('name')
    })
  })

  // No field in the harness's own meta.json ties an observer to a specific observed agent —
  // pairing is inferred by mtime correlation only (see measure-in-metadata-not-content.md).
  // Two isObserver siblings landing in the same window (e.g. an unrelated concurrent async
  // agent's own watchdog) makes that inference ambiguous — a false "pass" here would be
  // worse than an honest "can't tell", so this must resolve to unknown, not pass.
  it('returns unknown (ambiguous) when more than one isObserver sibling lands in the window', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'async' }, 1_000)
      writeMeta(dir, 'observer-a.meta.json', { name: 'pilot-orchestrator-watchdog', isObserver: true }, 1_003)
      writeMeta(dir, 'observer-b.meta.json', { name: 'some-other-watchdog', isObserver: true }, 1_006)

      const result = runCheck(dir, { name: 'pilot-orchestrator', windowSec: 30 })

      expect(result.exitCode).toBe(2)
      expect(result.json.status).toBe('unknown')
      expect(result.json.matchedBy).toBe('name')
    })
  })

  it('does not let a malformed sibling silently masquerade as a missing observer without saying so', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'async' }, 1_000)
      const corruptPath = join(dir, 'observer.meta.json')
      writeFileSync(corruptPath, '{not valid json')
      utimesSync(corruptPath, new Date(1_005 * 1000), new Date(1_005 * 1000))

      const result = runCheck(dir, { name: 'pilot-orchestrator', windowSec: 30 })

      expect(result.exitCode).toBe(1)
      expect(result.json.status).toBe('flag')
      expect(result.json.matchedBy).toBe('name')
      expect(result.json.malformed).toBeDefined()
      expect(JSON.stringify(result.json.malformed)).toContain('observer.meta.json')
    })
  })

  it('does not follow a symlinked meta.json as a valid observer sibling', () => {
    withTempSubagentsDir((dir) => {
      writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'async' }, 1_000)
      const realPath = writeMeta(dir, 'real-observer.meta.json', { name: 'watchdog', isObserver: true }, 1_005)
      const linkPath = join(dir, 'linked-observer.meta.json')
      symlinkSync(realPath, linkPath)
      unlinkSync(realPath)

      const result = runCheck(dir, { name: 'pilot-orchestrator', windowSec: 30 })

      expect(result.exitCode).toBe(1)
      expect(result.json.status).toBe('flag')
      expect(result.json.matchedBy).toBe('name')
    })
  })
})
