// Tests for the off-repo `workflow-toolbox` subcommands: scaffold / debug / report and
// `build --typecheck`. debug/report are exercised through the literal
// journal-path mode (no ~/.claude dependency); scaffold through a spec fixture.
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../src/cli.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, 'fixtures')

const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sub-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

const SPEC = {
  meta: { name: 'sub-test-flow', description: 'Subcommand test workflow.' },
  steps: [{ pattern: 'fanOutAndSynthesize', phase: 'Work' }],
}

function writeSpec(dir: string): string {
  const p = path.join(dir, 'spec.json')
  fs.writeFileSync(p, JSON.stringify(SPEC), 'utf8')
  return p
}

/** A minimal journal parseJournal accepts (runId is the only hard requirement). */
const JOURNAL = JSON.stringify({
  runId: 'wf_subtest',
  status: 'completed',
  workflowProgress: [],
})

function writeJournalTree(dir: string): string {
  const wfDir = path.join(dir, 'proj', 'sess-9', 'workflows')
  fs.mkdirSync(wfDir, { recursive: true })
  const p = path.join(wfDir, 'wf_subtest.json')
  fs.writeFileSync(p, JOURNAL, 'utf8')
  return p
}

// ---------------------------------------------------------------------------
// workflow-toolbox scaffold
// ---------------------------------------------------------------------------

describe('cli main() — workflow-toolbox scaffold', () => {
  it('writes <name>.workflow.ts from a spec into --out-dir', async () => {
    const dir = makeTmpDir()
    const spec = writeSpec(dir)
    await main(['scaffold', spec, '--out-dir', dir])
    const out = path.join(dir, 'sub-test-flow.workflow.ts')
    expect(fs.existsSync(out)).toBe(true)
    const src = fs.readFileSync(out, 'utf8')
    expect(src).toContain('defineWorkflow')
    expect(src).toContain('fanOutAndSynthesize')
  })

  it('emits a minimal tsconfig.json when none exists (and not with --no-tsconfig)', async () => {
    const a = makeTmpDir()
    await main(['scaffold', writeSpec(a), '--out-dir', a])
    expect(fs.existsSync(path.join(a, 'tsconfig.json'))).toBe(true)
    const cfg = JSON.parse(fs.readFileSync(path.join(a, 'tsconfig.json'), 'utf8'))
    expect(cfg.compilerOptions.moduleResolution).toBe('bundler')

    const b = makeTmpDir()
    await main(['scaffold', writeSpec(b), '--out-dir', b, '--no-tsconfig'])
    expect(fs.existsSync(path.join(b, 'tsconfig.json'))).toBe(false)
  })

  it('never overwrites an existing tsconfig.json', async () => {
    const dir = makeTmpDir()
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{"custom":true}', 'utf8')
    await main(['scaffold', writeSpec(dir), '--out-dir', dir])
    expect(fs.readFileSync(path.join(dir, 'tsconfig.json'), 'utf8')).toBe('{"custom":true}')
  })

  it('refuses to overwrite an existing skeleton without --force', async () => {
    const dir = makeTmpDir()
    const spec = writeSpec(dir)
    await main(['scaffold', spec, '--out-dir', dir])
    await expect(main(['scaffold', spec, '--out-dir', dir])).rejects.toThrow(/--force/)
    await main(['scaffold', spec, '--out-dir', dir, '--force'])
  })

  it('--stdout prints the source instead of writing files', async () => {
    const dir = makeTmpDir()
    const spec = writeSpec(dir)
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    await main(['scaffold', spec, '--stdout'])
    expect(writes.join('')).toContain('defineWorkflow')
    expect(fs.existsSync(path.join(dir, 'sub-test-flow.workflow.ts'))).toBe(false)
  })

  it('throws an actionable error on a malformed spec', async () => {
    const dir = makeTmpDir()
    const bad = path.join(dir, 'bad.json')
    fs.writeFileSync(bad, JSON.stringify({ meta: { name: 'x' } }), 'utf8')
    await expect(main(['scaffold', bad])).rejects.toThrow(/description|steps/)
  })
})

// ---------------------------------------------------------------------------
// workflow-toolbox debug / workflow-toolbox report — literal journal-path mode
// ---------------------------------------------------------------------------

describe('cli main() — workflow-toolbox debug / workflow-toolbox report', () => {
  it('debug accepts a literal journal path and emits JSON with --json', async () => {
    const dir = makeTmpDir()
    const journal = writeJournalTree(dir)
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    await main(['debug', journal, '--json'])
    const parsed = JSON.parse(writes.join('')) as { journalPath: string }
    expect(parsed.journalPath).toBe(journal)
  })

  it('report renders the markdown report for a literal journal path', async () => {
    const dir = makeTmpDir()
    const journal = writeJournalTree(dir)
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    await main(['report', journal])
    expect(writes.join('')).toContain('# Workflow Audit Report')
  })

  it('debug throws (with the scanned dir in the message) when nothing resolves', async () => {
    await expect(main(['debug', 'wf_does-not-exist-anywhere'])).rejects.toThrow(/no journal found/)
  })
})

// ---------------------------------------------------------------------------
// workflow-toolbox build --typecheck
// ---------------------------------------------------------------------------

describe('cli main() — workflow-toolbox build --typecheck', () => {
  it('fails the build on a type error in the entry', async () => {
    const outDir = makeTmpDir()
    const entry = path.join(FIXTURES, 'type-error.workflow.ts')
    await expect(
      main(['build', entry, '--out-dir', outDir, '--typecheck']),
    ).rejects.toThrow(/typecheck/)
    expect(fs.readdirSync(outDir)).toHaveLength(0)
  })

  it('builds the clean fixture with --typecheck enabled', async () => {
    const outDir = makeTmpDir()
    await main(['build', path.join(FIXTURES, 'hello.workflow.ts'), '--out-dir', outDir, '--typecheck'])
    expect(fs.existsSync(path.join(outDir, 'wt-fixture-hello.js'))).toBe(true)
  })
})
