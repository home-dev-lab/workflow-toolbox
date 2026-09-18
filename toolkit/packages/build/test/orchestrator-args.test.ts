import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { parseOrchestratorArgs } from '../../../../plugin/bin/lib/orchestrator-runner-core.mjs'

const required = ['--worktrees-dir', '/tmp/worktrees', '--report', '/tmp/report']

describe('parseOrchestratorArgs', () => {
  it.each(['--help', '-h'])('returns help for %s', (flag) => {
    expect(parseOrchestratorArgs([flag])).toEqual({ help: true })
  })

  it('rejects an unknown argument', () => {
    expect(parseOrchestratorArgs(['--unknown'])).toEqual({ error: 'unknown argument: --unknown' })
  })

  it('requires both output paths', () => {
    expect(parseOrchestratorArgs(['--cards', '1'])).toEqual({ error: '--worktrees-dir and --report are required' })
  })

  it.each([
    ['--concurrency', '0'],
    ['--concurrency', '-1'],
    ['--concurrency', '1.5'],
    ['--pilot-timeout', '0'],
  ])('rejects non-positive or non-integer %s values', (flag, value) => {
    expect(parseOrchestratorArgs(['--cards', '1', ...required, flag, value])).toEqual({ error: 'numeric options must be positive' })
  })

  it.each(['--max-cards', '--max-minutes'])('rejects a zero %s value independently', (flag) => {
    expect(parseOrchestratorArgs(['--cards', '1', ...required, flag, '0'])).toEqual({ error: 'numeric options must be positive' })
  })

  it('requires either cards or a mission list', () => {
    expect(parseOrchestratorArgs(required)).toEqual({ error: 'provide exactly one of --cards or --mission-list' })
  })

  it('accumulates repeated mission labels', () => {
    expect(parseOrchestratorArgs(['--mission-list', 'Next', '--mission-label', 'P1', '--mission-label', 'backend', ...required])).toMatchObject({ missionLabels: ['P1', 'backend'] })
  })

  it('parses a comma-separated hard list and filters empty entries', () => {
    expect(parseOrchestratorArgs(['--cards', '1', '--hard', '1,,3,', ...required])).toMatchObject({ hard: ['1', '3'] })
  })

  it('documents that a value-taking flag at the end leaves its option undefined', () => {
    expect(parseOrchestratorArgs(['--cards', '1', ...required, '--base'])).toMatchObject({ base: undefined })
  })

  it('documents that an empty cards value parses as an empty explicit-card list', () => {
    expect(parseOrchestratorArgs(['--cards', '', ...required])).toMatchObject({ cards: [] })
  })
})
