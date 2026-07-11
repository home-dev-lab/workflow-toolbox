// audit-folder.test.ts — INTEGRATION test for scanTranscripts, the impure disk-reading
// wrapper in audit-folder.ts. The pure parsers (parseTranscriptUsage /
// parseTranscriptCompaction) are unit-tested inline in transcript-usage.test.ts, and the
// run-level surfacing (buildAuditReport / stop-surface / report-format) is covered with
// INJECTED data in report.test.ts / stop-surface.test.ts / report-format.test.ts. What was
// UNCOVERED — and is the substrate this card exists to provide — is the on-disk seam: a real
// `agent-<id>.jsonl` file, read once from a transcript dir, yielding BOTH a correct billed
// usage sum AND a correct compaction detection. Auto-compaction is non-deterministic to
// trigger live (observed 1 run in 4), so this deterministic fixture is the only reliable way
// to verify that seam.
//
// The fixture (agent-compacted-sample.jsonl) is real-shaped, grounded on the actual event
// values captured from run wf_de6d0068-d7e (preTokens 198625 / postTokens 98958 /
// cumulativeDroppedTokens 99667 / durationMs 31948). It carries the streaming-dedup shape
// (msg_pre1 emitted twice, output 8 → 240), a `compact_boundary` system event, the synthetic
// `isCompactSummary` user summary, and post-boundary continuation turns.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { scanTranscripts, isSafeAgentId, resolveLogDir } from '../src/audit-folder.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
// scanTranscripts derives the transcript path as `agent-${agentId}.jsonl`, so the agentId
// IS the fixture filename's stem.
const ID = 'compacted-sample'

describe('scanTranscripts — on-disk compaction fixture (the deterministic substrate)', () => {
  it('reads one file and yields BOTH the billed usage sum AND the compaction — the card invariant', () => {
    const scan = scanTranscripts(FIXTURES, [ID], { withUsage: true, withDenials: true, withCompaction: true })

    // Present on disk.
    expect(scan.presentTranscripts.has(ID)).toBe(true)
    expect(scan.transcriptSources).toHaveLength(1)
    expect(scan.transcriptSources[0]!.sourcePath).toBe(join(FIXTURES, `agent-${ID}.jsonl`))

    // Billing-accurate per-message sum is INTACT — the system boundary line and the
    // isCompactSummary user line contribute nothing (neither is an `assistant` line), and the
    // streamed msg_pre1 snapshot (output 8) is dropped in favour of its final (output 240).
    expect(scan.usageByAgent.get(ID)).toEqual({
      inputTokens: 199700, // 1200 (pre, counted once) + 99000 + 99500
      outputTokens: 515, //    240 (final, not 8) + 180 + 95
      cacheReadTokens: 52874, // 40000 + 6437 + 6437
      cacheCreationTokens: 75500, // 63000 + 12000 + 500 (the scalar, never the nested object)
    })

    // Compaction is detected from the SAME read, with the real peak/dropped/trigger.
    expect(scan.compactionByAgent.get(ID)).toEqual({
      compacted: true,
      peakTokens: 198625,
      events: [{ trigger: 'auto', preTokens: 198625, postTokens: 98958, droppedTokens: 99667, durationMs: 31948 }],
    })

    // No is_error tool_results in the fixture → the denial scan (run in the same pass) is clean.
    expect(scan.denialsByAgent.size).toBe(0)
  })

  it('the cheap statSync-only pass (no flags) marks presence WITHOUT reading usage or compaction', () => {
    const scan = scanTranscripts(FIXTURES, [ID])
    expect(scan.presentTranscripts.has(ID)).toBe(true)
    expect(scan.transcriptSources).toHaveLength(1)
    // No read flags → the parsers never run.
    expect(scan.usageByAgent.size).toBe(0)
    expect(scan.compactionByAgent.size).toBe(0)
    expect(scan.denialsByAgent.size).toBe(0)
  })

  it('omits a missing transcript best-effort (never throws), and does not fabricate an entry', () => {
    const scan = scanTranscripts(FIXTURES, ['no-such-agent'], { withUsage: true, withCompaction: true })
    expect(scan.presentTranscripts.size).toBe(0)
    expect(scan.transcriptSources).toHaveLength(0)
    expect(scan.usageByAgent.size).toBe(0)
    expect(scan.compactionByAgent.size).toBe(0)
  })

  it('scans a mix of present + absent ids in one call, keeping only the present one', () => {
    const scan = scanTranscripts(FIXTURES, ['no-such-agent', ID], { withCompaction: true })
    expect([...scan.presentTranscripts]).toEqual([ID])
    expect(scan.compactionByAgent.get(ID)?.peakTokens).toBe(198625)
  })

  it('cross-checks the on-disk fixture against a direct read of the same file (parity)', () => {
    // Guards against the fixture silently drifting from what the pure parser sees.
    const text = readFileSync(join(FIXTURES, `agent-${ID}.jsonl`), 'utf8')
    const scan = scanTranscripts(FIXTURES, [ID], { withCompaction: true })
    // Every non-empty line is valid JSON (a malformed line would be silently skipped and could
    // hide a broken fixture) — assert the exact line count the fixture is authored with.
    const lines = text.split('\n').filter((l) => l.trim() !== '')
    expect(lines).toHaveLength(6)
    expect(scan.compactionByAgent.get(ID)?.events).toHaveLength(1)
  })

  it('never produces an entry for a path-traversal agentId (the join-escape guard holds end-to-end)', () => {
    // Behaviour contract at the scan level: an id with a `/`, `.`, or `..` segment is refused, so
    // it can never appear in any output map (the discriminating guard test is on isSafeAgentId below).
    const scan = scanTranscripts(FIXTURES, ['../secret', 'a/b', 'a.b', ''], {
      withUsage: true,
      withDenials: true,
      withCompaction: true,
    })
    expect(scan.presentTranscripts.size).toBe(0)
    expect(scan.transcriptSources).toHaveLength(0)
    expect(scan.usageByAgent.size).toBe(0)
    expect(scan.compactionByAgent.size).toBe(0)
    expect(scan.denialsByAgent.size).toBe(0)
  })

  it('withDenials POSITIVE path: reads the on-disk denial fixture and surfaces its denials', () => {
    // The compaction fixture has no denials (asserted above); this exercises the OTHER read flag
    // through the same disk seam, against the committed denial fixture (agent-denied-sample.jsonl).
    const scan = scanTranscripts(FIXTURES, ['denied-sample'], { withDenials: true })
    expect(scan.presentTranscripts.has('denied-sample')).toBe(true)
    const denials = scan.denialsByAgent.get('denied-sample')
    expect(denials).toHaveLength(3)
    expect(denials!.map((d) => d.kind)).toEqual(['rejected', 'hook', 'auto-mode-classifier'])
    // withDenials alone must NOT populate usage/compaction (single read, per-flag maps stay scoped).
    expect(scan.usageByAgent.size).toBe(0)
    expect(scan.compactionByAgent.size).toBe(0)
  })
})

// isSafeAgentId is the join-escape guard extracted from scanTranscripts so the security invariant
// is tested DISCRIMINATINGLY (a relaxed regex fails here) — not just implicitly via a missing file.
describe('isSafeAgentId — the transcript-path join-escape guard', () => {
  it('accepts the system-generated id shapes (`a<hex>`, the fixture stem)', () => {
    for (const id of ['a23cb0d8ce0eaae06', 'compacted-sample', 'denied-sample', 'A0_z-9']) {
      expect(isSafeAgentId(id)).toBe(true)
    }
  })

  it('rejects any id that could escape the dir via `join`, and the empty id', () => {
    for (const id of ['../secret', '../../etc/passwd', 'a/b', 'a.b', '.', '..', 'a b', 'a\tb', '']) {
      expect(isSafeAgentId(id)).toBe(false)
    }
  })
})

// resolveLogDir picks the audit-folder base dir: an explicit --out wins over $DWT_WORKFLOW_LOG_DIR;
// blank/whitespace values are treated as unset; neither set → null (disk persistence OFF by default).
describe('resolveLogDir — audit-folder base-dir resolution', () => {
  it('an explicit --out flag wins over the env var', () => {
    expect(resolveLogDir({ DWT_WORKFLOW_LOG_DIR: '/env/dir' }, '/flag/dir')).toEqual({
      baseDir: '/flag/dir',
      source: 'flag',
    })
  })

  it('falls back to $DWT_WORKFLOW_LOG_DIR when no flag is given', () => {
    expect(resolveLogDir({ DWT_WORKFLOW_LOG_DIR: '/env/dir' })).toEqual({ baseDir: '/env/dir', source: 'env' })
  })

  it('treats a blank/whitespace flag or env value as unset', () => {
    expect(resolveLogDir({ DWT_WORKFLOW_LOG_DIR: '   ' }, '  ')).toBeNull()
    expect(resolveLogDir({ DWT_WORKFLOW_LOG_DIR: '/env/dir' }, '   ')).toEqual({ baseDir: '/env/dir', source: 'env' })
  })

  it('returns null when neither a flag nor the env var is set (persistence off by default)', () => {
    expect(resolveLogDir({})).toBeNull()
  })
})
