import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
// @ts-expect-error JS plugin module
import { ciBranchFor, verdictFromEvidence } from '../../../../plugin/bin/lib/crossos-verdict.mjs'
// @ts-expect-error JS plugin module
import { completeJobs, readJobPages, workflowJobNames } from '../../../../plugin/bin/lib/crossos-evidence.mjs'

const workflow = readFileSync(resolve(import.meta.dirname, '../../../../.github/workflows/cross-os.yml'), 'utf8')
const config = parse(workflow) as { jobs: Record<string, { strategy?: { matrix: { include: Record<string, string | number>[] } } }> }
const expectedJobs = Object.entries(config.jobs).flatMap(([name, job]) => job.strategy
  ? job.strategy.matrix.include.map((entry) => `${name} (${Object.values(entry).join(', ')})`) : [name])
const sha = 'a'.repeat(40)
function positive() {
  return { event: 'workflow_dispatch', headBranch: ciBranchFor(sha), headSha: sha, status: 'completed', conclusion: 'success',
    expectedJobs, jobs: expectedJobs.map((name) => ({ name, conclusion: 'success' })) }
}

describe('cross-os verdict requires the complete dispatched roster', () => {
  it('matches the current GitHub default roster, including Windows timeout values', () => {
    expect(workflowJobNames(workflow)).toEqual([
      'matrix (ubuntu-latest, 1)', 'matrix (ubuntu-latest, 2)', 'matrix (ubuntu-latest, 3)', 'matrix (macos-latest)',
      'matrix (windows-latest, 1, 75)', 'matrix (windows-latest, 2, 75)', 'matrix (windows-latest, 3, 75)', 'ubuntu-coverage',
    ])
  })

  it('accepts every expected shard and the coverage job when successful', () => {
    expect(verdictFromEvidence(positive(), sha).verdict).toBe('green')
  })

  it.each(['matrix (ubuntu-latest, 2)', 'matrix (windows-latest, 3, 75)', 'ubuntu-coverage'])(
    'marks missing expected job %s incomplete', (missing) => {
      const run = positive()
      expect(expectedJobs).toContain(missing)
      run.jobs = run.jobs.filter(({ name }) => name !== missing)
      expect(verdictFromEvidence(run, sha), `missing expected job ${missing}`).toMatchObject({ verdict: 'red', incomplete: true })
    })

  it('does not let ubuntu-coverage stand for all absent Ubuntu test jobs', () => {
    const run = positive()
    run.jobs = run.jobs.filter(({ name }) => !name.startsWith('matrix (ubuntu'))
    expect(verdictFromEvidence(run, sha), 'all Ubuntu test jobs absent').toMatchObject({ verdict: 'red', incomplete: true })
  })

  it('requires a roster rather than accepting an OS-shaped list with no expectation', () => {
    expect(verdictFromEvidence({ ...positive(), expectedJobs: undefined }, sha)).toMatchObject({ verdict: 'red', incomplete: true })
  })
})

describe('GitHub jobs pagination completeness', () => {
  const jobs = expectedJobs.map((name, index) => ({ id: index + 1, name, conclusion: 'success' }))
  it('combines all pages and preserves API identity and completion fields', () => {
    const pages = [jobs.slice(0, 3), jobs.slice(3)].map((page) => ({ total_count: jobs.length, jobs: page }))
    expect(completeJobs(pages).map((job: { name: string }) => job.name)).toEqual(expectedJobs)
    expect(completeJobs([{ total_count: 1, jobs: [{ id: 17, completed_at: 'finished' }] }])[0]).toMatchObject({ databaseId: 17, completedAt: 'finished' })
  })

  it('rejects a successful first page that omits later jobs', () => {
    expect(() => completeJobs([{ total_count: jobs.length, jobs: jobs.slice(0, 3) }])).toThrow('Incomplete jobs listing: expected')
  })

  it('rejects repeated pages even if their combined length equals total_count', () => {
    const page = { total_count: 4, jobs: jobs.slice(0, 2) }
    expect(() => completeJobs([page, page])).toThrow('Incomplete jobs listing: expected 4 unique jobs')
  })

  it('rejects missing or malformed job identities instead of counting an unknown job', () => {
    expect(() => completeJobs([{ total_count: 1, jobs: [{ name: 'unknown' }] }])).toThrow('invalid job ID')
  })

  it.each([[], {}, [{ jobs }], [{ total_count: 1, jobs: [] }, { total_count: 2, jobs }]].map((pages) => [pages]))('rejects malformed or inconsistent page evidence %j', (pages) => {
    expect(() => completeJobs(pages)).toThrow('Incomplete jobs listing:')
  })
})

describe('workflow roster refuses ambiguous shapes', () => {
  it.each(['jobs: {}', 'jobs: { test: { name: custom } }', 'jobs: { test: { strategy: { matrix: { os: [ubuntu] } } } }',
    'jobs: { test: { strategy: { matrix: { include: [{os: "${{ inputs.os }}"}] } } } }',
    'jobs: { test: { strategy: { matrix: { include: [{os: ubuntu}, {os: ubuntu}] } } } }'])(
    'fails closed for unsupported roster %s', (source) => {
      expect(() => workflowJobNames(source)).toThrow()
    })
})

const manyJobs = Array.from({ length: 105 }, (_, index) => ({ id: index + 1, name: `job-${index + 1}`, conclusion: 'success' }))
const jobPages = [manyJobs.slice(0, 100), manyJobs.slice(100)].map((jobs) => ({ total_count: 105, jobs }))
describe('version-independent jobs page requests', () => {
  it('requests every 100-job page from the raw count and returns all job identities', () => {
    const requests: number[] = []
    const jobs = readJobPages((page: number) => { requests.push(page); return jobPages[page - 1] })
    expect(requests).toEqual([1, 2])
    expect(jobs).toHaveLength(105)
    expect(jobs.at(-1).databaseId).toBe(105)
  })
  it('rejects a partial first page instead of treating it as the complete run', () => {
    expect(() => readJobPages(() => ({ total_count: 8, jobs: manyJobs.slice(0, 3) }))).toThrow('Incomplete jobs listing: expected 8 unique jobs')
  })
  it('rejects an empty last page', () => {
    expect(() => readJobPages((page: number) => page === 1 ? jobPages[0] : { total_count: 105, jobs: [] })).toThrow('Incomplete jobs listing: expected 105 unique jobs')
  })
  it('rejects a changed total across page requests', () => {
    expect(() => readJobPages((page: number) => page === 1 ? jobPages[0] : { ...jobPages[1], total_count: 106 })).toThrow('inconsistent pages')
  })
  it('rejects repeated last-page identities even when the combined count is correct', () => {
    expect(() => readJobPages((page: number) => page === 1 ? jobPages[0] : { total_count: 105, jobs: manyJobs.slice(0, 5) })).toThrow('expected 105 unique jobs')
  })
})
