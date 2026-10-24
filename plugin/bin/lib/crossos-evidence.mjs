import { parse } from './vendor/yaml.mjs'

export const JOBS_PER_PAGE = 100

// GitHub's default matrix job name includes every matrix value, in declaration order
// (including the Windows timeout value). Unsupported expressions fail closed.
export function workflowJobNames(source) {
  const { jobs } = parse(source)
  if (!jobs || !Object.keys(jobs).length) throw new Error('Workflow has no jobs')
  const names = Object.entries(jobs).flatMap(([id, job]) => {
    if (job.name) throw new Error(`Unsupported explicit job name: ${id}`)
    if (!job.strategy) return [id]
    const matrix = job.strategy.matrix
    if (!matrix || Object.keys(matrix).join() !== 'include' || !matrix.include?.length) {
      throw new Error(`Unsupported matrix: ${id}; expected static include entries`)
    }
    return matrix.include.map((entry) => {
      const values = Object.values(entry)
      if (!values.length || values.some((value) => !['string', 'number', 'boolean'].includes(typeof value) || String(value).includes('${{'))) {
        throw new Error(`Unsupported matrix values: ${id}`)
      }
      return `${id} (${values.join(', ')})`
    })
  })
  if (new Set(names).size !== names.length) throw new Error('Workflow has ambiguous duplicate job names')
  return names
}

export function completeJobs(pages) {
  if (!Array.isArray(pages) || !pages.length) throw new Error('Incomplete jobs listing: no pages')
  const total = pages[0].total_count
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Incomplete jobs listing: invalid total_count')
  if (pages.some((page) => page.total_count !== total || !Array.isArray(page.jobs))) {
    throw new Error('Incomplete jobs listing: inconsistent pages')
  }
  const jobs = pages.flatMap((page) => page.jobs)
  if (jobs.some((job) => !Number.isSafeInteger(job?.id) || job.id <= 0)) throw new Error('Incomplete jobs listing: invalid job ID')
  if (jobs.length !== total || new Set(jobs.map((job) => job.id)).size !== total) {
    throw new Error(`Incomplete jobs listing: expected ${total} unique jobs, received ${jobs.length}`)
  }
  return jobs.map((job) => ({ ...job, databaseId: job.id, completedAt: job.completed_at }))
}

// Explicit REST pages work on older gh versions too. Use the raw API count to
// bound requests, then independently verify all counts and identities together.
export function readJobPages(readPage) {
  const pages = [readPage(1)]
  const total = pages[0]?.total_count
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Incomplete jobs listing: invalid total_count')
  for (let page = 2; (page - 1) * JOBS_PER_PAGE < total; page++) pages.push(readPage(page))
  return completeJobs(pages)
}
