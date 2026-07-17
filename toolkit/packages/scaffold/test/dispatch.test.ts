// Tests for the shared per-mode scaffold dispatch (dispatch.ts) — the render +
// write-out plumbing both the published `workflow-toolbox scaffold` subcommand
// (@workflow-toolbox/build) and the dev-only `wt:scaffold` CLI consume, extracted
// so the mode->(load, render, outName) mapping cannot drift between them.
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { renderScaffold, writeScaffoldArtifact } from '../src/dispatch.js'

const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-dispatch-test-'))
  tmpDirs.push(dir)
  return dir
}

function writeJson(dir: string, name: string, spec: unknown): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, JSON.stringify(spec), 'utf8')
  return p
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

const WORKFLOW_SPEC = {
  meta: { name: 'disp-flow', description: 'Dispatch test workflow.' },
  steps: [{ pattern: 'fanOutAndSynthesize', phase: 'Work' }],
}
const AGENT_SPEC = {
  name: 'disp-agent',
  description: 'A dispatch test agent.',
  prompt: 'Do the dispatch thing.',
}
const OBSERVER_SPEC = {
  name: 'disp-observer',
  description: 'A dispatch test observer.',
  watch: { roles: ['implementer'] },
  brain: { mandate: 'Watch the transcript delta and hint when external docs would help.' },
  emits: ['observer.hint'],
  actions: ['summary', 'wt-comm'],
}

// ---------------------------------------------------------------------------
// renderScaffold — the mode->load+render+outName dispatch
// ---------------------------------------------------------------------------

describe('renderScaffold', () => {
  it('workflow: loads the spec, renders defineWorkflow source, derives <meta.name>.workflow.ts', () => {
    const dir = makeTmpDir()
    const r = renderScaffold('workflow', writeJson(dir, 'spec.json', WORKFLOW_SPEC))
    expect(r.mode).toBe('workflow')
    expect(r.outName).toBe('disp-flow.workflow.ts')
    expect(r.source).toContain('defineWorkflow')
    expect(r.source).toContain('fanOutAndSynthesize')
    expect(r.mode === 'workflow' && r.spec.meta.name).toBe('disp-flow')
  })

  it('agent: loads the spec, renders the agent .md, derives <name>.md', () => {
    const dir = makeTmpDir()
    const r = renderScaffold('agent', writeJson(dir, 'agent.json', AGENT_SPEC))
    expect(r.mode).toBe('agent')
    expect(r.outName).toBe('disp-agent.md')
    expect(r.source).toContain('\nname: disp-agent\n')
    expect(r.mode === 'agent' && r.spec.name).toBe('disp-agent')
  })

  it('observer: loads the spec, renders the .observer.json, derives <name>.observer.json', () => {
    const dir = makeTmpDir()
    const r = renderScaffold('observer', writeJson(dir, 'obs.json', OBSERVER_SPEC))
    expect(r.mode).toBe('observer')
    expect(r.outName).toBe('disp-observer.observer.json')
    expect(r.source).toContain('"schemaVersion": 1')
    expect(r.mode === 'observer' && r.spec.name).toBe('disp-observer')
  })

  it('propagates the loader error for a malformed workflow spec', () => {
    const dir = makeTmpDir()
    const bad = writeJson(dir, 'bad.json', { meta: { name: 'x' } })
    expect(() => renderScaffold('workflow', bad)).toThrow(/description|steps/)
  })

  it('propagates the emitter validation error for an invalid observer spec', () => {
    const dir = makeTmpDir()
    const bad = writeJson(dir, 'bad-obs.json', { ...OBSERVER_SPEC, actions: ['summary'] })
    expect(() => renderScaffold('observer', bad)).toThrow(/wt-comm/)
  })
})

// ---------------------------------------------------------------------------
// writeScaffoldArtifact — the generic --stdout / no-clobber / mkdir / write mechanics
// ---------------------------------------------------------------------------

describe('writeScaffoldArtifact', () => {
  it('stdout mode: writes the source to process.stdout and touches no file', () => {
    const dir = makeTmpDir()
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk)); return true
    })
    const r = writeScaffoldArtifact({ source: 'SRC', outName: 'x.md', outDir: dir, stdout: true, force: false })
    expect(r.kind).toBe('stdout')
    expect(writes.join('')).toBe('SRC')
    expect(fs.existsSync(path.join(dir, 'x.md'))).toBe(false)
  })

  it('written mode: writes the file and returns the joined outFile', () => {
    const dir = makeTmpDir()
    const r = writeScaffoldArtifact({ source: 'HELLO', outName: 'out.txt', outDir: dir, stdout: false, force: false })
    expect(r.kind).toBe('written')
    expect(r.kind === 'written' && r.outFile).toBe(path.join(dir, 'out.txt'))
    expect(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('HELLO')
  })

  it('refused mode: an existing file without --force is refused, leaving the original intact', () => {
    const dir = makeTmpDir()
    fs.writeFileSync(path.join(dir, 'out.txt'), 'ORIGINAL', 'utf8')
    const r = writeScaffoldArtifact({ source: 'NEW', outName: 'out.txt', outDir: dir, stdout: false, force: false })
    expect(r.kind).toBe('refused')
    expect(r.kind === 'refused' && r.outFile).toBe(path.join(dir, 'out.txt'))
    expect(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('ORIGINAL')
  })

  it('force overwrites an existing file', () => {
    const dir = makeTmpDir()
    fs.writeFileSync(path.join(dir, 'out.txt'), 'ORIGINAL', 'utf8')
    const r = writeScaffoldArtifact({ source: 'NEW', outName: 'out.txt', outDir: dir, stdout: false, force: true })
    expect(r.kind).toBe('written')
    expect(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('NEW')
  })

  it('creates the out-dir recursively when it does not exist', () => {
    const dir = makeTmpDir()
    const nested = path.join(dir, 'a', 'b', 'c')
    const r = writeScaffoldArtifact({ source: 'NEST', outName: 'deep.txt', outDir: nested, stdout: false, force: false })
    expect(r.kind).toBe('written')
    expect(fs.readFileSync(path.join(nested, 'deep.txt'), 'utf8')).toBe('NEST')
  })
})
