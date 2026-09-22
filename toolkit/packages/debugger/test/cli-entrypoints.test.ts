import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const JOURNAL = join(HERE, 'fixtures', 'real-completed.json')
const COST_FIXTURES = join(HERE, 'fixtures')
const originalArgv = [...process.argv]
const made: string[] = []

afterEach(() => {
  process.argv = [...originalArgv]
  vi.restoreAllMocks()
  vi.resetModules()
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

function captureIo(): { stdout: ReturnType<typeof vi.spyOn>; stderr: ReturnType<typeof vi.spyOn> } {
  return {
    stdout: vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    stderr: vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
  }
}

function expectExit(code: number): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation((value) => {
    expect(value).toBe(code)
    return undefined as never
  })
}

function journalFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wt-cli-journal-'))
  made.push(root)
  const path = join(root, 'wf_characterized.json')
  copyFileSync(JOURNAL, path)
  return path
}

async function runDebug(args: string[]): Promise<void> {
  vi.resetModules()
  process.argv = [process.execPath, 'wt-debug', ...args]
  await import('../src/cli.js')
}

async function runReport(args: string[]): Promise<void> {
  vi.resetModules()
  process.argv = [process.execPath, 'wt-report', ...args]
  await import('../src/report-cli.js')
}

async function runCardCost(args: string[]): Promise<void> {
  vi.resetModules()
  process.argv = [process.execPath, 'wt-card-cost', ...args]
  await import('../src/card-cost-cli.js')
}

describe('debugger command entry points', () => {
  it('wt-debug reads a literal journal path and emits the JSON diagnosis', async () => {
    const io = captureIo()
    const exit = expectExit(0)
    process.argv = [process.execPath, 'wt-debug', journalFixture(), '--json']

    await import('../src/cli.js')

    expect(exit).toHaveBeenCalledOnce()
    expect(io.stderr.mock.calls.join('')).toContain('[project dir:')
    expect(io.stdout.mock.calls.join('')).toContain('"journalPath"')
  })

  it('wt-report renders stdout and writes an explicitly requested audit folder', async () => {
    const out = mkdtempSync(join(tmpdir(), 'wt-report-entry-'))
    made.push(out)
    const io = captureIo()
    const exit = expectExit(0)
    process.argv = [process.execPath, 'wt-report', journalFixture(), '--out', out]

    await import('../src/report-cli.js')

    expect(exit).toHaveBeenCalledOnce()
    expect(io.stdout.mock.calls.join('')).toContain('# Workflow Audit Report')
    expect(io.stderr.mock.calls.join('')).toContain('[report] wrote audit folder')
  })

  it('wt-card-cost characterizes help, validation, selected-agent JSON, and hop JSON', async () => {
    const io = captureIo()
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    process.argv = [process.execPath, 'wt-card-cost', '--help']
    await import('../src/card-cost-cli.js')
    expect(io.stdout.mock.calls.join('')).toContain('wt-card-cost')

    vi.resetModules()
    process.argv = [process.execPath, 'wt-card-cost', '--subagents-dir', COST_FIXTURES, '--name', 'pilot-x', '--name', 'missing']
    await import('../src/card-cost-cli.js')
    expect(io.stdout.mock.calls.join('')).toContain('"unmatchedNames"')
    expect(io.stderr.mock.calls.join('')).toContain('WARNING')

    vi.resetModules()
    process.argv = [process.execPath, 'wt-card-cost', '--hops']
    await import('../src/card-cost-cli.js')
    expect(io.stderr.mock.calls.join('')).toContain('--hops requires --session')

    vi.resetModules()
    process.argv = [process.execPath, 'wt-card-cost', '--hops', '--session', join(COST_FIXTURES, 'missing-session.jsonl'), '--json']
    await import('../src/card-cost-cli.js')
    expect(io.stdout.mock.calls.join('')).toContain('"maxDepth"')
    expect(exit).toHaveBeenCalledTimes(4)
  })

  it('wt-debug characterizes help, argument errors, lookup misses, invalid journals, and text output', async () => {
    const io = captureIo()
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const invalidRoot = mkdtempSync(join(tmpdir(), 'wt-debug-invalid-'))
    made.push(invalidRoot)
    const invalid = join(invalidRoot, 'wf_invalid.json')
    writeFileSync(invalid, 'not-json')

    await runDebug(['--help'])
    await runDebug(['-h'])
    await runDebug(['--unknown'])
    await runDebug([join(invalidRoot, 'wf_missing.json')])
    await runDebug([invalid])
    await runDebug([journalFixture()])
    await runDebug([journalFixture(), '--project', '-characterized', '--json'])

    expect(exit.mock.calls.map(([code]) => code)).toEqual([0, 0, 2, 1, 1, 0, 0])
    expect(io.stdout.mock.calls.join('')).toContain('[completed-ok]')
    expect(io.stderr.mock.calls.join('')).toContain('not a readable workflow journal')
  })

  it('wt-report characterizes help, argument errors, misses, invalid journals, and quiet destinations', async () => {
    const io = captureIo()
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const invalidRoot = mkdtempSync(join(tmpdir(), 'wt-report-invalid-'))
    made.push(invalidRoot)
    const invalid = join(invalidRoot, 'wf_invalid.json')
    writeFileSync(invalid, '[]')
    const savedLogDir = process.env['DWT_WORKFLOW_LOG_DIR']
    delete process.env['DWT_WORKFLOW_LOG_DIR']

    await runReport(['--help'])
    await runReport(['-h'])
    await runReport(['--unknown'])
    await runReport([join(invalidRoot, 'wf_missing.json')])
    await runReport([invalid])
    await runReport([journalFixture(), '--quiet'])
    await runReport([journalFixture(), '--quiet', '--out', invalidRoot])
    await runReport([journalFixture(), '--project', '-characterized'])
    const blockedOut = join(invalidRoot, 'not-a-directory')
    writeFileSync(blockedOut, 'file')
    await runReport([journalFixture(), '--quiet', '--out', blockedOut])
    if (savedLogDir === undefined) delete process.env['DWT_WORKFLOW_LOG_DIR']
    else process.env['DWT_WORKFLOW_LOG_DIR'] = savedLogDir

    expect(exit.mock.calls.map(([code]) => code)).toEqual([0, 0, 2, 1, 1, 1, 0, 0, 1])
    expect(io.stderr.mock.calls.join('')).toContain('nothing emitted')
  })

  it('wt-card-cost characterizes every missing-value parse branch and required selector checks', async () => {
    captureIo()
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const cases = [
      ['--session'],
      ['--subagents-dir'],
      ['--card-id'],
      ['--name'],
      ['--agent-id'],
      [],
      ['--subagents-dir', COST_FIXTURES],
      ['--subagents-dir=' + COST_FIXTURES, '--card-id=C', '--agent-id=cost-b'],
      ['--subagents-dir=' + COST_FIXTURES, '--name=pilot-x'],
    ]
    for (const args of cases) await runCardCost(args)
    expect(exit.mock.calls.map(([code]) => code)).toEqual([2, 2, 2, 2, 2, 2, 2, 0, 0])
  })
})
