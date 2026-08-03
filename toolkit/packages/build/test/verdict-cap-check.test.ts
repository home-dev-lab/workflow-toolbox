// verdict-cap-check.test.ts — behavior gates for the hand-written CLI
// plugin/bin/wt-verdict-cap-check.mjs. Like plugin-hooks.test.ts, each case
// drives the REAL script as a child process against a crafted report fixture
// and asserts stdout/exit code — the "closest to real" option.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/bin/wt-verdict-cap-check.mjs')

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function mkRoot(tag: string): string {
  const r = mkdtempSync(join(tmpdir(), `wt-verdict-cap-${tag}-`))
  roots.push(r)
  return r
}

interface Run {
  stdout: string
  code: number | null
  json: Record<string, unknown> | null
}
function runCheck(reportPath: string): Run {
  const res = spawnSync(process.execPath, [SCRIPT, reportPath], { encoding: 'utf8' })
  const stdout = (res.stdout ?? '').trim()
  let json: Record<string, unknown> | null = null
  try {
    const parsed: unknown = stdout ? JSON.parse(stdout) : null
    if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>
  } catch {
    json = null
  }
  return { stdout, code: res.status, json }
}
function writeReport(root: string, name: string, content: string): string {
  const p = join(root, name)
  writeFileSync(p, content, 'utf8')
  return p
}

describe('wt-verdict-cap-check.mjs', () => {
  it('all sources REACHABLE, verdict yes -> exit 0, ok:true', () => {
    const root = mkRoot('all-reachable')
    const p = writeReport(
      root,
      'report.md',
      `## Sources probed\n- Knowledge-base index: REACHABLE\n- Task tracker: REACHABLE\n\n(A) Resumable? yes\n`,
    )
    const r = runCheck(p)
    expect(r.code).toBe(0)
    expect(r.json?.ok).toBe(true)
  })

  it('one source UNREACHABLE, verdict yes with DEGRADED -> exit 0, ok:true, capped:true', () => {
    const root = mkRoot('capped')
    const p = writeReport(
      root,
      'report.md',
      `## Sources probed\n- Harness TaskList/TaskGet: UNREACHABLE — ToolSearch returned no matching tool\n- Knowledge-base index: REACHABLE\n\n(A) Resumable? yes — DEGRADED: TaskList/TaskGet unreachable\n`,
    )
    const r = runCheck(p)
    expect(r.code).toBe(0)
    expect(r.json?.ok).toBe(true)
    expect(r.json?.capped).toBe(true)
  })

  it('one source UNREACHABLE, verdict yes with NO DEGRADED -> exit 1, ok:false, violation:true, names the source', () => {
    const root = mkRoot('uncapped')
    const p = writeReport(
      root,
      'report.md',
      `## Sources probed\n- Harness TaskList/TaskGet: UNREACHABLE — ToolSearch returned no matching tool\n\n(A) Resumable? yes\n`,
    )
    const r = runCheck(p)
    expect(r.code).toBe(1)
    expect(r.json?.ok).toBe(false)
    expect(r.json?.violation).toBe(true)
    expect(r.json?.unreachableSources).toContain('Harness TaskList/TaskGet')
  })

  it('one source UNREACHABLE, verdict no -> exit 0, ok:true (no DEGRADED needed)', () => {
    const root = mkRoot('verdict-no')
    const p = writeReport(
      root,
      'report.md',
      `## Sources probed\n- Harness TaskList/TaskGet: UNREACHABLE — ToolSearch returned no matching tool\n\n(A) Resumable? no\n`,
    )
    const r = runCheck(p)
    expect(r.code).toBe(0)
    expect(r.json?.ok).toBe(true)
  })

  it('two sources, one REACHABLE one UNREACHABLE, verdict yes uncapped -> exit 1 (mix still caught)', () => {
    const root = mkRoot('mix')
    const p = writeReport(
      root,
      'report.md',
      `## Sources probed\n- Knowledge-base index: REACHABLE\n- Task tracker: UNREACHABLE — MCP not configured\n\n(A) Resumable? yes\n`,
    )
    const r = runCheck(p)
    expect(r.code).toBe(1)
    expect(r.json?.ok).toBe(false)
    expect(r.json?.violation).toBe(true)
  })

  it('missing "## Sources probed" heading entirely -> exit 2, malformed:true', () => {
    const root = mkRoot('no-heading')
    const p = writeReport(root, 'report.md', `(A) Resumable? yes\n`)
    const r = runCheck(p)
    expect(r.code).toBe(2)
    expect(r.json?.malformed).toBe(true)
  })

  it('"## Sources probed" present but missing "(A) Resumable?" line -> exit 2, malformed:true', () => {
    const root = mkRoot('no-verdict')
    const p = writeReport(root, 'report.md', `## Sources probed\n- Knowledge-base index: REACHABLE\n`)
    const r = runCheck(p)
    expect(r.code).toBe(2)
    expect(r.json?.malformed).toBe(true)
  })

  it('mixed/lower-case REACHABLE/UNREACHABLE tokens still parse and still enforce the cap -> exit 1', () => {
    const root = mkRoot('mixed-case')
    const p = writeReport(
      root,
      'report.md',
      `## Sources probed\n- A: Reachable\n- B: Unreachable — timeout\n(A) Resumable? yes\n`,
    )
    const r = runCheck(p)
    expect(r.code).toBe(1)
    expect(r.json?.ok).toBe(false)
    expect(r.json?.violation).toBe(true)
    expect(r.json?.unreachableSources).toContain('B')
  })

  it('a garbage/unparseable line inside the Sources-probed block -> exit 2, malformed (fail closed, not silently dropped)', () => {
    const root = mkRoot('garbage-line')
    const p = writeReport(
      root,
      'report.md',
      `## Sources probed\n- A: REACHABLE\nthis is a stray line\n- B: UNREACHABLE — timeout\n\n(A) Resumable? yes\n`,
    )
    const r = runCheck(p)
    expect(r.code).toBe(2)
    expect(r.json?.ok).toBe(false)
    expect(r.json?.malformed).toBe(true)
  })

  // Reproduces the exact measured failure from card 1833620759134602301 — the
  // pre-fix shape: the harness TaskList/TaskGet tools declared unreachable via
  // an empty ToolSearch, alongside other reachable sources, and an uncapped
  // "clean" verdict shipped anyway.
  it('reproduces the exact measured pre-fix shape from card 1833620759134602301 -> exit 1', () => {
    const root = mkRoot('measured-case')
    const p = writeReport(
      root,
      'report.md',
      [
        '## Sources probed',
        '- Harness TaskList/TaskGet: UNREACHABLE — ToolSearch returned no matching tool',
        '- Knowledge-base index: REACHABLE',
        '- CLAUDE.md and .claude/rules: REACHABLE',
        '- Task-tracker card descriptions: REACHABLE',
        '- Git ground-truth (log/branch/worktree list): REACHABLE',
        '',
        '(A) Resumable? yes',
        '',
      ].join('\n'),
    )
    const r = runCheck(p)
    expect(r.code).toBe(1)
    expect(r.json?.ok).toBe(false)
    expect(r.json?.violation).toBe(true)
    expect(r.json?.unreachableSources).toContain('Harness TaskList/TaskGet')
  })
})
