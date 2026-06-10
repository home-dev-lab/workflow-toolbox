// edge.test.ts — unit tests for the pure pieces of the negative-case canary.
// The judgeRejection tests run against BOTH synthetic ToolResults (to pin the
// verdict logic) and REAL SDK rejection messages captured live from the runtime
// (test/fixtures/edge-*.json), parsed through the same readToolResult the live
// runner uses. No agent runs here — these are part of `pnpm test`. The only edits
// to the captured JSON: the ephemeral temp-dir path and session/uuid were
// neutralized (the rejection text — the thing under test — is verbatim).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readToolResult, type ToolResult } from '../src/lib.js'
import { canonicalizeReason, edgeCases, judgeRejection, metaOrderScript, oversizeScript, SIZE_CAP } from '../src/edge.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

const tr = (over: Partial<ToolResult> = {}): ToolResult => ({
  toolUseId: 'toolu_x',
  isError: true,
  text: 'exceeds 524288 bytes',
  ...over,
})

describe('script generators', () => {
  it('oversizeScript exceeds the 512 KB cap and starts with the meta literal', () => {
    const s = oversizeScript()
    expect(s.length).toBeGreaterThan(SIZE_CAP)
    expect(s.trimStart().startsWith('export const meta')).toBe(true)
  })

  it('metaOrderScript places a statement before the meta literal', () => {
    const s = metaOrderScript()
    expect(s.indexOf('const before')).toBeLessThan(s.indexOf('export const meta'))
  })

  it('declares exactly the two negative cases', () => {
    const cases = edgeCases()
    expect(cases.map((c) => c.filename)).toEqual(['wt-edge-oversize.js', 'wt-edge-metaorder.js'])
  })
})

describe('canonicalizeReason', () => {
  it('strips the volatile temp path so two runs of the same rejection match', () => {
    const a = canonicalizeReason('Workflow script file /tmp/wt-canary-AAA111/wt-edge-oversize.js exceeds 524288 bytes')
    const b = canonicalizeReason('Workflow script file /tmp/wt-canary-ZZZ999/wt-edge-oversize.js exceeds 524288 bytes')
    expect(a).toBe(b)
    expect(a).toContain('<path>')
    expect(a).toContain('524288') // semantic number kept on purpose
  })

  it('strips run ids and task ids', () => {
    expect(canonicalizeReason('launched wf_89363eba-692 task w71kc0tlj done')).toBe('launched <runid> task <taskid> done')
  })

  it('strips real-shaped task ids (which always contain a digit)', () => {
    for (const id of ['w9tc3di7t', 'wbnnvwo9q', 'wq6oz0qpq', 'wnb0p872p']) {
      expect(canonicalizeReason(`task ${id} ok`)).toBe('task <taskid> ok')
    }
  })

  it('does NOT mask all-alpha words that start with w (no false canonicalization)', () => {
    const msg = 'workflows wrongness windows are not task ids'
    expect(canonicalizeReason(msg)).toBe(msg)
  })

  it('leaves a clean meta-order message stable', () => {
    const msg = 'Invalid workflow script: meta must be the FIRST statement in the script'
    expect(canonicalizeReason(msg)).toBe(msg)
  })
})

describe('judgeRejection (verdict logic)', () => {
  it('PASSES when rejected for the expected reason', () => {
    expect(judgeRejection('cap', tr({ text: 'exceeds 524288 bytes' }), /524288|exceeds/i).ok).toBe(true)
  })

  it('FAILS when the launch was accepted (the regression case)', () => {
    const accepted = tr({ isError: false, text: 'Workflow launched in background. Task ID: w123\nRun ID: wf_abc' })
    const r = judgeRejection('cap', accepted, /524288|exceeds/i)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/ACCEPTED/)
  })

  it('FAILS when rejected for a different reason than expected', () => {
    const r = judgeRejection('cap', tr({ text: 'some unrelated parse error' }), /524288|exceeds/i)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/did not match/)
  })

  it('strips the <tool_use_error> wrapper via launchVerdict', () => {
    const r = judgeRejection('meta', tr({ text: '<tool_use_error>meta must be the first statement</tool_use_error>' }), /meta|first/i)
    expect(r.ok).toBe(true)
    expect(r.detail).not.toContain('<tool_use_error>')
  })
})

describe('judgeRejection against REAL captured runtime rejections', () => {
  const cases = edgeCases()

  it('the oversized scriptPath is really rejected by the current runtime', () => {
    const result = readToolResult(fixture('edge-oversize-rejection.json'))
    expect(result).not.toBeNull()
    expect(judgeRejection(cases[0]!.name, result!, cases[0]!.reasonPattern).ok).toBe(true)
  })

  it('the statement-before-meta script is really rejected by the current runtime', () => {
    const result = readToolResult(fixture('edge-metaorder-rejection.json'))
    expect(result).not.toBeNull()
    expect(judgeRejection(cases[1]!.name, result!, cases[1]!.reasonPattern).ok).toBe(true)
  })
})
