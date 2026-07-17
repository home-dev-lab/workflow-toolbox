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
// workflow-toolbox scaffold observer — through main(), the path npm consumers
// run (review lock, run wf_9f3dc111-f31: this branch previously had zero
// coverage at the published-CLI level; the pure emitter tests live in the
// scaffold package and never exercised this wiring).
// ---------------------------------------------------------------------------

const OBSERVER_SPEC = {
  name: 'sub-test-observer',
  description: 'Subcommand test observer.',
  watch: { roles: ['implementer'] },
  brain: { mandate: 'Watch the transcript delta and hint when external docs would help.' },
  emits: ['observer.hint'],
  actions: ['summary', 'wt-comm'],
}

function writeObserverSpec(dir: string): string {
  const p = path.join(dir, 'observer-spec.json')
  fs.writeFileSync(p, JSON.stringify(OBSERVER_SPEC), 'utf8')
  return p
}

describe('cli main() — workflow-toolbox scaffold observer', () => {
  it('writes <name>.observer.json into --out-dir, stamped and shaped', async () => {
    const dir = makeTmpDir()
    await main(['scaffold', 'observer', writeObserverSpec(dir), '--out-dir', dir])
    const out = path.join(dir, 'sub-test-observer.observer.json')
    expect(fs.existsSync(out)).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, unknown>
    expect(parsed['schemaVersion']).toBe(1)
    expect(parsed['name']).toBe('sub-test-observer')
  })

  it('refuses to overwrite without --force, allows with it', async () => {
    const dir = makeTmpDir()
    const spec = writeObserverSpec(dir)
    await main(['scaffold', 'observer', spec, '--out-dir', dir])
    await expect(main(['scaffold', 'observer', spec, '--out-dir', dir])).rejects.toThrow(/--force/)
    await main(['scaffold', 'observer', spec, '--out-dir', dir, '--force'])
  })

  it('--stdout prints the artifact instead of writing a file', async () => {
    const dir = makeTmpDir()
    const spec = writeObserverSpec(dir)
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    await main(['scaffold', 'observer', spec, '--stdout'])
    expect(writes.join('')).toContain('"schemaVersion": 1')
    expect(fs.existsSync(path.join(dir, 'sub-test-observer.observer.json'))).toBe(false)
  })

  it('an invalid spec fails loud with the shared validator message', async () => {
    const dir = makeTmpDir()
    const bad = path.join(dir, 'bad-observer.json')
    fs.writeFileSync(bad, JSON.stringify({ ...OBSERVER_SPEC, actions: ['summary'] }), 'utf8')
    await expect(main(['scaffold', 'observer', bad])).rejects.toThrow(/actions lacks 'wt-comm'/)
  })
})

// ---------------------------------------------------------------------------
// workflow-toolbox scaffold agent — through main(), the path npm consumers run.
// The pure scaffoldAgent emitter is tested in the scaffold package; this locks
// the published-CLI wiring of the `agent` branch (sibling of the observer
// coverage above), card #1821306514896323997.
// ---------------------------------------------------------------------------

const AGENT_SPEC = {
  name: 'sub-test-agent',
  description: 'Subcommand test agent.',
  prompt: 'You review code and report findings.',
}

function writeAgentSpec(dir: string): string {
  const p = path.join(dir, 'agent-spec.json')
  fs.writeFileSync(p, JSON.stringify(AGENT_SPEC), 'utf8')
  return p
}

describe('cli main() — workflow-toolbox scaffold agent', () => {
  it('writes <name>.md into --out-dir, with the agent frontmatter', async () => {
    const dir = makeTmpDir()
    await main(['scaffold', 'agent', writeAgentSpec(dir), '--out-dir', dir])
    const out = path.join(dir, 'sub-test-agent.md')
    expect(fs.existsSync(out)).toBe(true)
    const md = fs.readFileSync(out, 'utf8')
    expect(md).toContain('\nname: sub-test-agent\n')
    expect(md).toContain('\ndescription: Subcommand test agent.\n')
  })

  it('refuses to overwrite without --force, allows with it', async () => {
    const dir = makeTmpDir()
    const spec = writeAgentSpec(dir)
    await main(['scaffold', 'agent', spec, '--out-dir', dir])
    await expect(main(['scaffold', 'agent', spec, '--out-dir', dir])).rejects.toThrow(/--force/)
    await main(['scaffold', 'agent', spec, '--out-dir', dir, '--force'])
  })

  it('--stdout prints the source instead of writing a file', async () => {
    const dir = makeTmpDir()
    const spec = writeAgentSpec(dir)
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    await main(['scaffold', 'agent', spec, '--stdout'])
    expect(writes.join('')).toContain('\nname: sub-test-agent\n')
    expect(fs.existsSync(path.join(dir, 'sub-test-agent.md'))).toBe(false)
  })

  it('an invalid spec (missing prompt) fails loud with the shared validator message', async () => {
    const dir = makeTmpDir()
    const bad = path.join(dir, 'bad-agent.json')
    fs.writeFileSync(bad, JSON.stringify({ name: 'x', description: 'y' }), 'utf8')
    await expect(main(['scaffold', 'agent', bad])).rejects.toThrow(/prompt must be a string/)
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

// ---------------------------------------------------------------------------
// workflow-toolbox pipeline (I5 authoring increment)
// ---------------------------------------------------------------------------

describe('cli main() — workflow-toolbox pipeline', () => {
  it('derives the output filename from the entry (.pipeline.ts stripped) into --out-dir', async () => {
    const outDir = makeTmpDir()
    await main(['pipeline', path.join(FIXTURES, 'hello.pipeline.ts'), '--out-dir', outDir])
    const outFile = path.join(outDir, 'hello.json')
    expect(fs.existsSync(outFile)).toBe(true)
    const spec = JSON.parse(fs.readFileSync(outFile, 'utf8')) as { goal: string; stages: unknown[] }
    expect(spec.goal).toBe('minimal fixture pipeline')
    expect(spec.stages).toHaveLength(2)
  })

  it('--out overrides the derived filename (without requiring .json)', async () => {
    const outDir = makeTmpDir()
    await main(['pipeline', path.join(FIXTURES, 'hello.pipeline.ts'), '--out-dir', outDir, '--out', 'custom-name'])
    expect(fs.existsSync(path.join(outDir, 'custom-name.json'))).toBe(true)
    expect(fs.existsSync(path.join(outDir, 'hello.json'))).toBe(false)
  })

  it('the written file ends with a trailing newline', async () => {
    const outDir = makeTmpDir()
    await main(['pipeline', path.join(FIXTURES, 'hello.pipeline.ts'), '--out-dir', outDir])
    const raw = fs.readFileSync(path.join(outDir, 'hello.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('rejects a spec that fails the parsePipelineSpec round-trip, writing nothing', async () => {
    const outDir = makeTmpDir()
    await expect(
      main(['pipeline', path.join(FIXTURES, 'bad-roundtrip.pipeline.ts'), '--out-dir', outDir]),
    ).rejects.toThrow(/round-trip/)
    expect(fs.readdirSync(outDir)).toHaveLength(0)
  })

  it('fails the build on a type error in the entry with --typecheck', async () => {
    const outDir = makeTmpDir()
    await expect(
      main(['pipeline', path.join(FIXTURES, 'type-error.pipeline.ts'), '--out-dir', outDir, '--typecheck']),
    ).rejects.toThrow(/typecheck/)
    expect(fs.readdirSync(outDir)).toHaveLength(0)
  })

  describe('name injection (card #1813065099577918566 — pipelines become first-class citizens with a type)', () => {
    it("injects the entry-filename-derived name when the authored spec doesn't declare one", async () => {
      const outDir = makeTmpDir()
      await main(['pipeline', path.join(FIXTURES, 'hello.pipeline.ts'), '--out-dir', outDir])
      const spec = JSON.parse(fs.readFileSync(path.join(outDir, 'hello.json'), 'utf8')) as { name?: string }
      expect(spec.name).toBe('hello')
    })

    it("preserves the author's own declared name, never overwriting it with the filename-derived one", async () => {
      const outDir = makeTmpDir()
      await main(['pipeline', path.join(FIXTURES, 'hello-named.pipeline.ts'), '--out-dir', outDir])
      const spec = JSON.parse(fs.readFileSync(path.join(outDir, 'hello-named.json'), 'utf8')) as { name?: string }
      expect(spec.name).toBe('custom-pattern-name')
    })

    it('the injected name follows the ENTRY filename, not --out (which only overrides the output FILENAME)', async () => {
      const outDir = makeTmpDir()
      await main(['pipeline', path.join(FIXTURES, 'hello.pipeline.ts'), '--out-dir', outDir, '--out', 'custom-name'])
      const spec = JSON.parse(fs.readFileSync(path.join(outDir, 'custom-name.json'), 'utf8')) as { name?: string }
      expect(spec.name).toBe('hello')
    })

    it("regression: name injection preserves the AUTHOR's own key order within a stage — must never reorder via the round-tripped result.spec (parseStageSpecV2 reconstructs a fixed {name,workflow,[input],[gateAfter],[artifact]} order, which once silently reordered every artifact)", async () => {
      const outDir = makeTmpDir()
      await main(['pipeline', path.join(FIXTURES, 'hello-key-order.pipeline.ts'), '--out-dir', outDir])
      const raw = fs.readFileSync(path.join(outDir, 'hello-key-order.json'), 'utf8')
      const planStage = (JSON.parse(raw) as { stages: Record<string, unknown>[] }).stages[0]!
      // Object.keys preserves the STRING text's own key order (JSON.parse inserts keys in
      // source order) — this is the exact author order the fixture declares: name, workflow,
      // gateAfter, artifact, input. The buggy path put `input` third (right after `workflow`).
      expect(Object.keys(planStage)).toEqual(['name', 'workflow', 'gateAfter', 'artifact', 'input'])
      expect(raw).toContain('"name": "hello-key-order"') // the injection itself still landed
    })
  })
})
