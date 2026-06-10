import { describe, it, expect } from 'vitest'
import { parseDebugArgs, parseReportArgs } from '../src/cli-args.js'

// Claude Code project slugs are derived from an absolute cwd with
// non-alphanumerics mapped to "-", so EVERY real slug starts with a dash —
// the parsers must accept it as a --project value, not read it as a flag.
const SLUG = '-home-doublefx-projects-dynamic-workflow-toolbox'

describe('parseDebugArgs', () => {
  it('accepts a leading-dash slug in space form', () => {
    const r = parseDebugArgs(['wf_abc', '--project', SLUG])
    expect(r.error).toBeUndefined()
    expect(r.project).toBe(SLUG)
    expect(r.runId).toBe('wf_abc')
  })

  it('accepts the equals form', () => {
    const r = parseDebugArgs([`--project=${SLUG}`, 'wf_abc'])
    expect(r.error).toBeUndefined()
    expect(r.project).toBe(SLUG)
    expect(r.runId).toBe('wf_abc')
  })

  it('still rejects a KNOWN flag as the --project value', () => {
    const r = parseDebugArgs(['--project', '--json'])
    expect(r.error).toMatch(/--project requires a value/)
  })

  it('rejects a missing trailing value', () => {
    const r = parseDebugArgs(['wf_abc', '--project'])
    expect(r.error).toMatch(/--project requires a value/)
  })

  it('rejects an empty equals form (--project=)', () => {
    const r = parseDebugArgs(['wf_abc', '--project='])
    expect(r.error).toMatch(/--project requires a value/)
  })

  it('treats a journal PATH positional as the runId argument (passed through)', () => {
    const p = '/home/u/.claude/projects/-slug/sess/workflows/wf_abc.json'
    const r = parseDebugArgs([p])
    expect(r.error).toBeUndefined()
    expect(r.runId).toBe(p)
  })

  it('parses --json and bare runId as before', () => {
    const r = parseDebugArgs(['latest', '--json'])
    expect(r.json).toBe(true)
    expect(r.runId).toBe('latest')
    expect(r.project).toBeUndefined()
  })
})

describe('parseReportArgs', () => {
  it('accepts a leading-dash slug in space form and keeps --out/--quiet', () => {
    const r = parseReportArgs(['wf_abc', '--project', SLUG, '--out', '/tmp/x', '--quiet'])
    expect(r.error).toBeUndefined()
    expect(r.project).toBe(SLUG)
    expect(r.out).toBe('/tmp/x')
    expect(r.quiet).toBe(true)
  })

  it('accepts the equals form for --project and --out', () => {
    const r = parseReportArgs([`--project=${SLUG}`, '--out=/tmp/x'])
    expect(r.error).toBeUndefined()
    expect(r.project).toBe(SLUG)
    expect(r.out).toBe('/tmp/x')
  })

  it('still rejects a KNOWN flag as the --out value', () => {
    const r = parseReportArgs(['--out', '--quiet'])
    expect(r.error).toMatch(/--out requires a value/)
  })

  it('rejects empty equals forms (--project= / --out=)', () => {
    expect(parseReportArgs(['--project=']).error).toMatch(/--project requires a value/)
    expect(parseReportArgs(['--out=']).error).toMatch(/--out requires a value/)
  })
})
