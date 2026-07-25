// transcript-usage.test.ts — unit tests for the PURE per-agent transcript usage parser.
//
// parseTranscriptUsage(jsonl) sums one agent transcript's billed token usage. The hard
// part (proven against a real transcript: 9 assistant lines / 5 distinct message.id, the
// same id streamed with output_tokens growing 4→134) is DEDUP BY message.id — keep the
// final (max-output) snapshot per id, then sum across DISTINCT ids. Naive line-summing
// double-counts. Input/cache values are stable within an id, so max-output co-selects the
// right input/cache. Tolerant by contract: malformed/non-assistant/usage-less lines are
// skipped, an empty transcript yields zeros, and it never throws.

import { describe, it, expect } from 'vitest'
import {
  parseTranscriptUsage,
  parseTranscriptActivity,
  parseTranscriptCompaction,
  buildCompactionReport,
  mergeCompactionReports,
  emptyCompactionReport,
  emptyUsage,
  emptyActivity,
  addUsage,
  type TranscriptCompaction,
} from '../src/transcript-usage.js'

/** Build one assistant transcript line with a usage block. */
function line(
  id: string | null,
  u: { i?: number; o?: number; cr?: number; cc?: number; nested?: boolean },
): string {
  const usage: Record<string, unknown> = {
    input_tokens: u.i ?? 0,
    output_tokens: u.o ?? 0,
    cache_read_input_tokens: u.cr ?? 0,
    cache_creation_input_tokens: u.cc ?? 0,
  }
  // The real SDK usage block carries BOTH the scalar AND a nested object — assert we read
  // the scalar, never the object.
  if (u.nested) usage['cache_creation'] = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 999 }
  const message: Record<string, unknown> = { usage }
  if (id !== null) message['id'] = id
  return JSON.stringify({ type: 'assistant', message })
}

describe('parseTranscriptUsage — dedup by message.id', () => {
  it('keeps the final (max-output) snapshot per id, summing across distinct ids', () => {
    const jsonl = [
      line('m1', { i: 100, o: 4, cr: 10, cc: 5 }), // streaming snapshot (not final)
      line('m1', { i: 100, o: 134, cr: 10, cc: 5 }), // final snapshot of the SAME message
      line('m2', { i: 200, o: 50, cr: 20, cc: 8 }),
    ].join('\n')
    expect(parseTranscriptUsage(jsonl)).toEqual({
      inputTokens: 300, // 100 + 200 (m1 counted once, not 100+100)
      outputTokens: 184, // 134 + 50 (the 4 snapshot dropped)
      cacheReadTokens: 30,
      cacheCreationTokens: 13,
    })
  })

  it('treats id-less lines as distinct (older SDK) — never collapses them together', () => {
    const jsonl = [line(null, { i: 5, o: 5 }), line(null, { i: 5, o: 5 })].join('\n')
    expect(parseTranscriptUsage(jsonl)).toMatchObject({ inputTokens: 10, outputTokens: 10 })
  })
})

describe('parseTranscriptUsage — schema details', () => {
  it('reads the scalar cache_creation_input_tokens, IGNORING the nested cache_creation object', () => {
    const r = parseTranscriptUsage(line('m1', { cc: 7, nested: true }))
    expect(r.cacheCreationTokens).toBe(7) // the scalar, not 999 from the nested object
  })
})

describe('parseTranscriptUsage — tolerance (never throws)', () => {
  it('skips malformed, non-assistant, and usage-less lines; sums only valid usage', () => {
    const jsonl = [
      '{ not json',
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { id: 'no-usage' } }),
      '',
      line('real', { i: 12, o: 3, cr: 4, cc: 1 }),
    ].join('\n')
    expect(parseTranscriptUsage(jsonl)).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 4,
      cacheCreationTokens: 1,
    })
  })

  it('returns zeros for an empty / whitespace-only transcript', () => {
    expect(parseTranscriptUsage('')).toEqual(emptyUsage())
    expect(parseTranscriptUsage('\n  \n')).toEqual(emptyUsage())
  })

  it('coerces non-numeric usage fields to 0 rather than throwing', () => {
    const bad = JSON.stringify({ type: 'assistant', message: { id: 'x', usage: { input_tokens: 'lots' } } })
    expect(parseTranscriptUsage(bad)).toEqual(emptyUsage())
  })
})

// Build a full assistant line (top-level timestamp + optional content blocks), for the
// activity parser's tool_use/turn/span tests — distinct from `line()` above (which only needs
// a usage block, no content/timestamp).
function assistantLine(
  id: string,
  ts: string,
  u: { o?: number },
  content: Array<Record<string, unknown>> = [],
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { id, usage: { input_tokens: 1, output_tokens: u.o ?? 1 }, content },
  })
}

function otherLine(type: string, ts: string): string {
  return JSON.stringify({ type, timestamp: ts })
}

describe('parseTranscriptActivity — turns / tool calls / span', () => {
  it('counts DISTINCT turns by message.id, not raw lines (mirrors parseTranscriptUsage dedup)', () => {
    const jsonl = [
      assistantLine('m1', '2026-07-25T10:00:00.000Z', { o: 4 }), // streaming snapshot
      assistantLine('m1', '2026-07-25T10:00:01.000Z', { o: 40 }), // final snapshot, same turn
      assistantLine('m2', '2026-07-25T10:00:02.000Z', { o: 5 }),
    ].join('\n')
    expect(parseTranscriptActivity(jsonl).turns).toBe(2) // NOT 3 raw lines
  })

  it('counts tool_use blocks only on the FINAL (deduped) snapshot of a message', () => {
    const jsonl = [
      // Partial snapshot carries no tool_use yet (still streaming); final one does.
      assistantLine('m1', '2026-07-25T10:00:00.000Z', { o: 1 }, []),
      assistantLine('m1', '2026-07-25T10:00:01.000Z', { o: 50 }, [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', name: 'Bash', id: 't1' },
        { type: 'tool_use', name: 'Read', id: 't2' },
      ]),
      assistantLine('m2', '2026-07-25T10:00:02.000Z', { o: 3 }, [{ type: 'tool_use', name: 'Grep', id: 't3' }]),
    ].join('\n')
    const activity = parseTranscriptActivity(jsonl)
    expect(activity.turns).toBe(2)
    expect(activity.toolCalls).toBe(3) // 2 (final m1) + 1 (m2) — the dropped m1 partial contributes 0
  })

  it('spans first/last TIMESTAMP across ALL line types, not just assistant lines', () => {
    const jsonl = [
      otherLine('user', '2026-07-25T09:00:00.000Z'),
      assistantLine('m1', '2026-07-25T09:05:00.000Z', { o: 10 }),
      otherLine('tool_result', '2026-07-25T09:06:00.000Z'),
      assistantLine('m2', '2026-07-25T09:10:00.000Z', { o: 10 }),
    ].join('\n')
    const activity = parseTranscriptActivity(jsonl)
    expect(activity.firstTimestamp).toBe('2026-07-25T09:00:00.000Z') // the user line, not m1
    expect(activity.lastTimestamp).toBe('2026-07-25T09:10:00.000Z')
  })

  it('returns emptyActivity() for an empty / whitespace-only transcript', () => {
    expect(parseTranscriptActivity('')).toEqual(emptyActivity())
    expect(parseTranscriptActivity('\n  \n')).toEqual(emptyActivity())
  })

  it('tolerates malformed / usage-less lines without throwing, still counting the valid ones', () => {
    const jsonl = [
      '{ not json',
      JSON.stringify({ type: 'assistant', message: { id: 'no-usage' } }), // no usage → not admitted
      otherLine('system', '2026-07-25T11:00:00.000Z'),
      assistantLine('real', '2026-07-25T11:00:01.000Z', { o: 5 }, [{ type: 'tool_use', name: 'X', id: 't1' }]),
    ].join('\n')
    const activity = parseTranscriptActivity(jsonl)
    expect(activity.turns).toBe(1)
    expect(activity.toolCalls).toBe(1)
    expect(activity.firstTimestamp).toBe('2026-07-25T11:00:00.000Z')
    expect(activity.lastTimestamp).toBe('2026-07-25T11:00:01.000Z')
  })

  it('treats id-less assistant messages as distinct turns (never collapsed), mirroring parseTranscriptUsage', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', timestamp: '2026-07-25T12:00:00.000Z', message: { usage: { input_tokens: 1, output_tokens: 1 }, content: [] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-07-25T12:00:01.000Z', message: { usage: { input_tokens: 1, output_tokens: 1 }, content: [] } }),
    ].join('\n')
    expect(parseTranscriptActivity(jsonl).turns).toBe(2)
  })
})

describe('emptyActivity', () => {
  it('is all-zero / null', () => {
    expect(emptyActivity()).toEqual({ turns: 0, toolCalls: 0, firstTimestamp: null, lastTimestamp: null })
  })
})

describe('emptyUsage / addUsage', () => {
  it('emptyUsage is all-zero', () => {
    expect(emptyUsage()).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })
  })

  it('addUsage sums field-wise without mutating its inputs', () => {
    const a = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 }
    const b = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 }
    expect(addUsage(a, b)).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheCreationTokens: 44 })
    expect(a).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 }) // unmutated
  })
})

// parseTranscriptCompaction(jsonl) surfaces auto-compaction of a fleet agent — the
// `type:'system', subtype:'compact_boundary'` event the run journal's post-compaction
// totalTokens erases. `compactMetadata` fields are read defensively (SDK guarantees only
// { trigger, preTokens }; the runtime also emits postTokens / cumulativeDroppedTokens /
// durationMs). The shapes below are lifted from a real transcript (run wf_de6d0068-d7e).

/** Build a real-shaped compact_boundary system line with the given metadata. */
function compactLine(meta: Record<string, unknown>): string {
  return JSON.stringify({ type: 'system', subtype: 'compact_boundary', isSidechain: true, compactMetadata: meta })
}

describe('parseTranscriptCompaction — detection', () => {
  it('extracts every compactMetadata field from a real-shaped boundary + the peak', () => {
    const jsonl = [
      line('m1', { i: 10, o: 4, cc: 63000 }), // pre-compaction turn
      compactLine({ trigger: 'auto', preTokens: 198625, postTokens: 98958, cumulativeDroppedTokens: 99667, durationMs: 31948 }),
      line('m2', { i: 10, o: 3, cr: 6437 }), // post-compaction turn
    ].join('\n')
    expect(parseTranscriptCompaction(jsonl)).toEqual({
      compacted: true,
      peakTokens: 198625,
      events: [{ trigger: 'auto', preTokens: 198625, postTokens: 98958, droppedTokens: 99667, durationMs: 31948 }],
    })
  })

  it('is defensive: an SDK-minimal { trigger, preTokens } boundary yields nulls for the rest', () => {
    const r = parseTranscriptCompaction(compactLine({ trigger: 'auto', preTokens: 170000 }))
    expect(r.compacted).toBe(true)
    expect(r.peakTokens).toBe(170000)
    expect(r.events[0]).toEqual({ trigger: 'auto', preTokens: 170000, postTokens: null, droppedTokens: null, durationMs: null })
  })

  it('records multiple boundaries and reports the MAX preTokens as the peak', () => {
    const jsonl = [
      compactLine({ trigger: 'auto', preTokens: 198000 }),
      compactLine({ trigger: 'auto', preTokens: 205000 }),
    ].join('\n')
    const r = parseTranscriptCompaction(jsonl)
    expect(r.events).toHaveLength(2)
    expect(r.peakTokens).toBe(205000)
  })
})

describe('parseTranscriptCompaction — tolerance (never throws)', () => {
  it('a transcript with no boundary is not compacted', () => {
    const jsonl = [line('m1', { i: 100, o: 10 }), JSON.stringify({ type: 'user', message: { content: 'hi' } })].join('\n')
    expect(parseTranscriptCompaction(jsonl)).toEqual({ compacted: false, events: [], peakTokens: null })
  })

  it('skips malformed lines, non-system events, and other system subtypes', () => {
    const jsonl = [
      '{ not json',
      JSON.stringify({ type: 'assistant', subtype: 'compact_boundary' }), // wrong type — not a system event
      JSON.stringify({ type: 'system', subtype: 'attribution-snapshot' }), // other subtype
      compactLine({ trigger: 'auto', preTokens: 190000 }),
    ].join('\n')
    const r = parseTranscriptCompaction(jsonl)
    expect(r.events).toHaveLength(1)
    expect(r.peakTokens).toBe(190000)
  })

  it('an empty transcript, or a boundary with no metadata, never throws', () => {
    expect(parseTranscriptCompaction('')).toEqual({ compacted: false, events: [], peakTokens: null })
    const noMeta = parseTranscriptCompaction(JSON.stringify({ type: 'system', subtype: 'compact_boundary' }))
    expect(noMeta.compacted).toBe(true)
    expect(noMeta.peakTokens).toBe(null)
    expect(noMeta.events[0]).toEqual({ trigger: null, preTokens: null, postTokens: null, droppedTokens: null, durationMs: null })
  })
})

// buildCompactionReport(perAgent) rolls per-agent TranscriptCompaction into a RUN-level ADVISORY
// report (mirrors buildToolDenialReport): agentsCompacted, the worst peak (max preTokens across
// agents), total dropped (sum of each agent's cumulative drop), and per-agent rows sorted
// worst-pressure-first. emptyCompactionReport is the explicit not-compacted default.

describe('buildCompactionReport — run-level advisory rollup', () => {
  const comp = (peak: number, dropped: number | null, trigger: string | null = 'auto'): TranscriptCompaction => ({
    compacted: true,
    peakTokens: peak,
    events: [{ trigger, preTokens: peak, postTokens: peak - (dropped ?? 0), droppedTokens: dropped, durationMs: 31948 }],
  })

  it('aggregates peak (max) + dropped (sum) across agents and carries the label, worst-first', () => {
    const r = buildCompactionReport([
      { agentId: 'a1', label: 'read:big', compaction: comp(198625, 99667) },
      { agentId: 'a2', label: 'read:huge', compaction: comp(205000, 50000) },
    ])
    expect(r.compacted).toBe(true)
    expect(r.agentsCompacted).toBe(2)
    expect(r.peakTokens).toBe(205000) // max across agents
    expect(r.droppedTokens).toBe(149667) // 99667 + 50000
    expect(r.agents).toHaveLength(2)
    // worst-pressure-first: a2 (peak 205000) precedes a1 (peak 198625)
    expect(r.agents[0]).toMatchObject({ agentId: 'a2', label: 'read:huge', peakTokens: 205000, droppedTokens: 50000, trigger: 'auto', boundaries: 1 })
  })

  it('derives per-agent dropped as the MAX (cumulativeDroppedTokens is cumulative) across boundaries', () => {
    const twoBoundary: TranscriptCompaction = {
      compacted: true,
      peakTokens: 205000,
      events: [
        { trigger: 'auto', preTokens: 198000, postTokens: null, droppedTokens: 99000, durationMs: null },
        { trigger: 'auto', preTokens: 205000, postTokens: null, droppedTokens: 150000, durationMs: null }, // cumulative total
      ],
    }
    const r = buildCompactionReport([{ agentId: 'a1', compaction: twoBoundary }])
    expect(r.agents[0]!.droppedTokens).toBe(150000) // the cumulative max, NOT 99000+150000
    expect(r.agents[0]!.boundaries).toBe(2)
  })

  it('reports the trigger of the PEAK boundary, so the Trigger column matches the Peak beside it', () => {
    const mixed: TranscriptCompaction = {
      compacted: true,
      peakTokens: 205000,
      events: [
        { trigger: 'manual', preTokens: 150000, postTokens: null, droppedTokens: 40000, durationMs: null },
        { trigger: 'auto', preTokens: 205000, postTokens: null, droppedTokens: 90000, durationMs: null }, // the peak
      ],
    }
    const r = buildCompactionReport([{ agentId: 'a1', compaction: mixed }])
    expect(r.agents[0]!.peakTokens).toBe(205000)
    expect(r.agents[0]!.trigger).toBe('auto') // the PEAK boundary's trigger, not the first ('manual')
  })

  it('skips non-compacted entries defensively → empty report', () => {
    const r = buildCompactionReport([{ agentId: 'a1', compaction: { compacted: false, events: [], peakTokens: null } }])
    expect(r).toEqual(emptyCompactionReport())
  })

  it('is null-safe: an SDK-minimal boundary with no dropped yields null run-level dropped', () => {
    const r = buildCompactionReport([{ agentId: 'a1', compaction: comp(170000, null) }])
    expect(r.peakTokens).toBe(170000)
    expect(r.droppedTokens).toBe(null)
  })

  it('emptyCompactionReport is an explicit not-compacted zero', () => {
    expect(emptyCompactionReport()).toEqual({ agentsCompacted: 0, peakTokens: null, droppedTokens: null, agents: [], compacted: false })
  })
})

// mergeCompactionReports — multi-stage pipeline rollup of CompactionReports.
// Mirrors rollupPipelineDenials: concatenates all per-agent rows, recomputes peak (max)
// and dropped (sum), re-sorts worst-peak-first. Empty stages are skipped (no agents).

describe('mergeCompactionReports — pipeline-level advisory rollup', () => {
  it('merges two stage reports: peak = max, dropped = sum, sorted worst-first', () => {
    const stage1 = buildCompactionReport([
      { agentId: 'a1', label: 'plan:read', compaction: { compacted: true, peakTokens: 180000, events: [{ trigger: 'auto', preTokens: 180000, postTokens: 80000, droppedTokens: 80000, durationMs: null }] } },
    ])
    const stage2 = buildCompactionReport([
      { agentId: 'a2', label: 'impl:code', compaction: { compacted: true, peakTokens: 205000, events: [{ trigger: 'auto', preTokens: 205000, postTokens: 100000, droppedTokens: 50000, durationMs: null }] } },
    ])
    const merged = mergeCompactionReports([stage1, stage2])
    expect(merged.compacted).toBe(true)
    expect(merged.agentsCompacted).toBe(2)
    expect(merged.peakTokens).toBe(205000) // max across both stages
    expect(merged.droppedTokens).toBe(130000) // sum: 80000 + 50000
    expect(merged.agents[0]!.agentId).toBe('a2') // worst-peak first
    expect(merged.agents[1]!.agentId).toBe('a1')
  })

  it('empty array of reports yields the empty compaction report', () => {
    expect(mergeCompactionReports([])).toEqual(emptyCompactionReport())
  })

  it('merging two empty (not-compacted) reports yields the empty report', () => {
    expect(mergeCompactionReports([emptyCompactionReport(), emptyCompactionReport()])).toEqual(emptyCompactionReport())
  })

  it('merging a compacted + an empty report returns the compacted one unchanged', () => {
    const stage = buildCompactionReport([
      { agentId: 'a1', compaction: { compacted: true, peakTokens: 190000, events: [{ trigger: 'auto', preTokens: 190000, postTokens: 90000, droppedTokens: 75000, durationMs: null }] } },
    ])
    const merged = mergeCompactionReports([stage, emptyCompactionReport()])
    expect(merged.agentsCompacted).toBe(1)
    expect(merged.peakTokens).toBe(190000)
    expect(merged.droppedTokens).toBe(75000)
  })
})
