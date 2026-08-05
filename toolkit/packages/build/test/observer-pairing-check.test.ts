import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
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
    attachedBy?: 'observerTaskId' | 'observerTaskId-conflict' | 'mtime-fallback' | 'not-required'
    captured?: string
    captureError?: string
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
  options: { agentId?: string; name?: string; windowSec?: number; captureDir?: string },
): Verdict {
  const args = [SCRIPT, '--subagents-dir', subagentsDir]
  if (options.agentId) args.push('--agent-id', options.agentId)
  if (options.name) args.push('--name', options.name)
  if (options.windowSec !== undefined) args.push('--window-sec', String(options.windowSec))
  if (options.captureDir) args.push('--capture-dir', options.captureDir)
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

      // Explicit narrow window: this test is about id-vs-name precedence, not window
      // width — pin it so it stays independent of the fallback default.
      const result = runCheck(dir, { agentId: 'id-wins', name: 'named-target', windowSec: 30 })

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

  // Real shapes grounded in production .meta.json files (2026-08-03, atlassian-cli wave
  // cc4e1f93): { observerTaskId: "ac7f39a67a5aefa87", ... } paired with a sibling
  // agent-ac7f39a67a5aefa87.meta.json carrying { isObserver: true }. Before this fix the
  // checker never read this field at all (`grep -c observerTaskId` on the script was 0),
  // so a real, correctly attached observer landing outside the mtime window was flagged
  // as missing.
  describe('observerTaskId — direct ownership link (checked before mtime correlation)', () => {
    it('confirms pairing via observerTaskId even when the isObserver sibling lands FAR outside the mtime window', () => {
      withTempSubagentsDir((dir) => {
        // 211s was the real gap that triggered this card; use a larger one (500s) to prove
        // the fix does not depend on widening the window either — the field alone decides.
        writeAgentFixture(dir, 'aaac5ffb5420322e5', { agentType: 'pilot', observerTaskId: 'ac7f39a67a5aefa87' }, 1_000)
        writeAgentFixture(dir, 'ac7f39a67a5aefa87', { agentType: 'pilot-watchdog', isObserver: true }, 1_000 + 500)

        const result = runCheck(dir, { agentId: 'aaac5ffb5420322e5', windowSec: 30 })

        expect(result.exitCode).toBe(0)
        expect(result.json.status).toBe('pass')
        expect(result.json.matchedBy).toBe('id')
        expect(result.json.attachedBy).toBe('observerTaskId')
        expect(result.json.observerFile).toContain('agent-ac7f39a67a5aefa87.meta.json')
      })
    })

    it('confirms pairing via observerTaskId even when the sibling mtime predates the observed agent (negative delta)', () => {
      withTempSubagentsDir((dir) => {
        writeAgentFixture(dir, 'obs-1', { agentType: 'pilot-watchdog', isObserver: true }, 990)
        writeAgentFixture(dir, 'agent-1', { agentType: 'pilot', observerTaskId: 'obs-1' }, 1_000)

        const result = runCheck(dir, { agentId: 'agent-1' })

        expect(result.exitCode).toBe(0)
        expect(result.json.status).toBe('pass')
        expect(result.json.attachedBy).toBe('observerTaskId')
      })
    })

    it('returns unknown when observerTaskId is present but does not resolve to any file, even if an unrelated in-window observer exists', () => {
      withTempSubagentsDir((dir) => {
        writeAgentFixture(dir, 'agent-dangling', { agentType: 'pilot', observerTaskId: 'no-such-agent', taskKind: 'async' }, 1_000)
        writeMeta(dir, 'observer.meta.json', { name: 'watchdog', isObserver: true }, 1_005)

        const result = runCheck(dir, { agentId: 'agent-dangling' })

        expect(result.exitCode).toBe(2)
        expect(result.json.status).toBe('unknown')
        expect(result.json.attachedBy).toBe('observerTaskId-conflict')
        expect(result.json.reason).toContain('no-such-agent')
      })
    })

    it('returns unknown when observerTaskId resolves but the sibling is not isObserver:true', () => {
      withTempSubagentsDir((dir) => {
        writeAgentFixture(dir, 'agent-badref', { agentType: 'pilot', observerTaskId: 'not-an-observer', taskKind: 'async' }, 1_000)
        writeAgentFixture(dir, 'not-an-observer', { agentType: 'general-purpose' }, 1_000)
        writeMeta(dir, 'observer.meta.json', { name: 'watchdog', isObserver: true }, 1_005)

        const result = runCheck(dir, { agentId: 'agent-badref' })

        expect(result.exitCode).toBe(2)
        expect(result.json.status).toBe('unknown')
        expect(result.json.attachedBy).toBe('observerTaskId-conflict')
        expect(result.json.reason).toContain('not isObserver:true')
      })
    })

    it('still flags a genuinely unpaired agent — no observerTaskId, no mtime match (the check must still be able to fail)', () => {
      withTempSubagentsDir((dir) => {
        writeAgentFixture(dir, 'truly-alone', { agentType: 'general-purpose', description: 'genuinely unobserved spawn', spawnDepth: 1 }, 1_000)
        writeMeta(dir, 'unrelated.meta.json', { name: 'someone-else', taskKind: 'async' }, 1_100)

        const result = runCheck(dir, { agentId: 'truly-alone' })

        expect(result.exitCode).toBe(1)
        expect(result.json.status).toBe('flag')
        expect(result.json.attachedBy).toBe('mtime-fallback')
      })
    })

    it('still returns unknown when observerTaskId is present but unresolved AND no mtime candidate exists either', () => {
      withTempSubagentsDir((dir) => {
        writeAgentFixture(dir, 'agent-both-fail', { agentType: 'pilot', observerTaskId: 'ghost', taskKind: 'async' }, 1_000)

        const result = runCheck(dir, { agentId: 'agent-both-fail' })

        expect(result.exitCode).toBe(2)
        expect(result.json.status).toBe('unknown')
        expect(result.json.attachedBy).toBe('observerTaskId-conflict')
      })
    })

    it('normal mtime-fallback pass still names its signal as mtime-fallback, not observerTaskId', () => {
      withTempSubagentsDir((dir) => {
        writeMeta(dir, 'observed.meta.json', { name: 'pilot-orchestrator', taskKind: 'async' }, 1_000)
        writeMeta(dir, 'observer.meta.json', { name: 'pilot-orchestrator-watchdog', isObserver: true }, 1_005)

        const result = runCheck(dir, { name: 'pilot-orchestrator' })

        expect(result.exitCode).toBe(0)
        expect(result.json.status).toBe('pass')
        expect(result.json.attachedBy).toBe('mtime-fallback')
      })
    })

    describe('--capture-dir: preserving the one shape that evidences a real loss', () => {
      // A DECLARED-but-unresolved pairing is the only artefact that could ever credit the
      // pairing guard's speaking half. 182 real pairs have been measured, all resolving;
      // the losing direction exists only as prose. A hand-written fixture cannot close
      // that — it would be authored from the same understanding as the code. So the
      // mechanism is to KEEP the artefact the first time reality produces one, rather
      // than to wait and hope someone is looking.

      it('archives both meta files and its own verdict when the pointed-at sibling is not an observer', () => {
        withTempSubagentsDir((dir) => {
          const captureDir = join(dir, '..', 'evidence')
          writeAgentFixture(dir, 'obs1', { agentId: 'obs1', observerTaskId: 'sib1' }, 1000)
          writeAgentFixture(dir, 'sib1', { agentId: 'sib1', isObserver: false }, 1000)

          const result = runCheck(dir, { agentId: 'obs1', captureDir })

          expect(result.json.attachedBy).toBe('observerTaskId-conflict')
          expect(result.json.captured, 'the conflicting pair must be archived').toBeTruthy()
          const files = readdirSync(result.json.captured as string).sort()
          expect(files).toEqual([
            'conflict.json',
            'observed-agent-obs1.meta.json',
            'pointed-at-agent-sib1.meta.json',
          ])
          // The inputs alone do not say what was concluded from them, and a later reader
          // has no way to recover it — so the verdict is archived beside the evidence.
          const conflict = JSON.parse(
            readFileSync(join(result.json.captured as string, 'conflict.json'), 'utf8'),
          )
          expect(conflict.observerTaskId).toBe('sib1')
          expect(conflict.pointedAtExists).toBe(true)
        })
      })

      it('archives the observed file alone when the pointed-at sibling does not exist', () => {
        withTempSubagentsDir((dir) => {
          const captureDir = join(dir, '..', 'evidence')
          writeAgentFixture(dir, 'obs2', { agentId: 'obs2', observerTaskId: 'ghost' }, 1000)

          const result = runCheck(dir, { agentId: 'obs2', captureDir })

          expect(result.json.attachedBy).toBe('observerTaskId-conflict')
          const files = readdirSync(result.json.captured as string).sort()
          expect(files).toEqual(['conflict.json', 'observed-agent-obs2.meta.json'])
        })
      })

      it('writes NOTHING on a healthy pairing, even when a capture dir is supplied', () => {
        // The capture must be scoped to the losing direction. A capture dir that fills up
        // with healthy pairs is a directory nobody reads, which is how the one real
        // artefact would get lost in the noise.
        withTempSubagentsDir((dir) => {
          const captureDir = join(dir, '..', 'evidence')
          writeAgentFixture(dir, 'good1', { agentId: 'good1', observerTaskId: 'good2' }, 1000)
          writeAgentFixture(dir, 'good2', { agentId: 'good2', isObserver: true }, 1000)

          const result = runCheck(dir, { agentId: 'good1', captureDir })

          expect(result.json.status).toBe('pass')
          expect(result.json.captured).toBeUndefined()
          expect(existsSync(captureDir), 'no capture dir should be created').toBe(false)
        })
      })

      it('leaves the verdict byte-identical when no capture dir is given', () => {
        withTempSubagentsDir((dir) => {
          writeAgentFixture(dir, 'obs3', { agentId: 'obs3', observerTaskId: 'ghost' }, 1000)

          const result = runCheck(dir, { agentId: 'obs3' })

          expect(result.json.attachedBy).toBe('observerTaskId-conflict')
          expect(result.json.captured).toBeUndefined()
          expect(result.json.captureError).toBeUndefined()
        })
      })

      it('keeps the FINDING when the capture itself fails, and names the failure', () => {
        // This is the case that decides whether the capture is safe to add at all. Losing
        // the finding because the evidence could not be written would be strictly worse
        // than losing the evidence alone — and a silent capture failure would leave a
        // reader believing an artefact exists somewhere.
        withTempSubagentsDir((dir) => {
          const readOnly = join(dir, '..', 'readonly')
          mkdirSync(readOnly)
          chmodSync(readOnly, 0o500)
          try {
            writeAgentFixture(dir, 'obs4', { agentId: 'obs4', observerTaskId: 'ghost' }, 1000)

            const result = runCheck(dir, { agentId: 'obs4', captureDir: join(readOnly, 'nested') })

            expect(result.exitCode).toBe(2)
            expect(result.json.attachedBy).toBe('observerTaskId-conflict')
            expect(result.json.captured).toBeUndefined()
            expect(result.json.captureError).toContain('could not archive')
          } finally {
            chmodSync(readOnly, 0o700)
          }
        })
      })
    })
  })
})
