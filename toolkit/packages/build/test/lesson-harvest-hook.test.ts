import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const HOOK = resolve(HERE, '../../../../plugin/bin/wt-lesson-harvest-hook.mjs')

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'wt-lesson-harvest-'))
  roots.push(root)
  const project = join(root, 'project')
  const reports = join(project, '.claude', 'reports', 'wave-x')
  mkdirSync(reports, { recursive: true })
  return { root, project, reports, statePath: join(root, 'state.json') }
}

function report(dir: string, name: string, body: string) {
  writeFileSync(join(dir, name), body)
  return join(dir, name)
}

const WITH_LESSONS = '# Report\n\n## Lessons for the memory\n\n- A first reusable lesson.\n- A second one.\n'
const NO_LESSONS = '# Report\n\n## Lessons for the memory\n\nNone.\n'
const NOT_A_REPORT = '# Just a document\n\nNothing to harvest here.\n'

function run(s: ReturnType<typeof scaffold>) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: s.project }),
    encoding: 'utf8',
    env: { ...process.env, WT_LESSON_HARVEST_STATE: s.statePath },
    timeout: 20_000,
  })
  const stdout = res.stdout.trim()
  return {
    status: res.status,
    stdout,
    context: stdout ? (JSON.parse(stdout).hookSpecificOutput?.additionalContext as string) : '',
  }
}

describe('wt-lesson-harvest-hook surfaces what a rule and a skill both failed to trigger', () => {
  it('names a report that carries lessons, with its count', () => {
    const s = scaffold()
    const file = report(s.reports, 'card-1-report.md', WITH_LESSONS)

    const result = run(s)

    expect(result.status).toBe(0)
    expect(result.context).toContain('2 lesson(s)')
    expect(result.context).toContain(file)
  })

  it('stays SILENT on a report whose section says None, and on markdown that is not a report', () => {
    const s = scaffold()
    report(s.reports, 'card-2-report.md', NO_LESSONS)
    report(s.reports, 'random-note.md', NOT_A_REPORT)

    const result = run(s)

    // A hook that spoke about every markdown file it walked would be switched off within a day,
    // taking its real case with it. Silence here is the feature, not an omission.
    expect(result.stdout).toBe('')
    expect(result.status).toBe(0)
  })

  it('speaks ONCE per report — a second turn with nothing changed is silent', () => {
    const s = scaffold()
    report(s.reports, 'card-1-report.md', WITH_LESSONS)

    const first = run(s)
    const second = run(s)

    expect(first.context).toContain('2 lesson(s)')
    expect(second.stdout).toBe('')
  })

  it('speaks AGAIN when the report changes, because a rewritten report is new material', () => {
    const s = scaffold()
    const file = report(s.reports, 'card-1-report.md', WITH_LESSONS)
    run(s)

    writeFileSync(file, `${WITH_LESSONS}- A third one.\n`)
    const after = run(s)

    expect(after.context).toContain('3 lesson(s)')
  })

  it('records a lesson-free report too, so it is not re-examined at every single turn end', () => {
    const s = scaffold()
    const file = report(s.reports, 'card-2-report.md', NO_LESSONS)

    run(s)

    const state = JSON.parse(readFileSync(s.statePath, 'utf8')) as Record<string, number>
    expect(Object.keys(state)).toContain(file)
  })

  it('NEVER writes to a knowledge base — its only output is a state file it owns', () => {
    const s = scaffold()
    const memory = join(s.project, '.claude', 'memory')
    mkdirSync(memory, { recursive: true })
    report(s.reports, 'card-1-report.md', WITH_LESSONS)

    run(s)

    // The harvest is detection and extraction; deciding what becomes a durable note stays with
    // the single session that integrates the card. A hook that persisted would look helpful and
    // would be crossing the one boundary the harvester was designed around.
    expect(existsSync(join(memory, 'MEMORY.md'))).toBe(false)
    expect(JSON.parse(readFileSync(s.statePath, 'utf8'))).toBeTypeOf('object')
  })

  it('can be switched off entirely, because a guard nobody can disable gets worked around', () => {
    const s = scaffold()
    report(s.reports, 'card-1-report.md', WITH_LESSONS)

    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd: s.project }),
      encoding: 'utf8',
      env: { ...process.env, WT_LESSON_HARVEST_STATE: s.statePath, WT_LESSON_HARVEST_OFF: '1' },
      timeout: 20_000,
    })

    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toBe('')
  })
})
