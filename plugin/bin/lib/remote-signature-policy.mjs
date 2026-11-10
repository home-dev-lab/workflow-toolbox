import { signaturePolicyCommand } from './host/signature-exception-io.mjs'

function githubRepoOf(url) {
  if (typeof url !== 'string') return null
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url)
  return match ? { owner: match[1], repo: match[2] } : null
}

function rulesetRequirement(run, endpoint) {
  const result = run('gh', ['api', '--hostname', 'github.com', '--paginate', '--slurp', endpoint])
  if (result.error || result.signal || result.status !== 0) throw Error(`rulesets unreadable: ${result.stderr || result.error?.message || 'gh failed'}`)
  const pages = JSON.parse(result.stdout)
  if (!Array.isArray(pages) || !pages.length || !pages.every((page) => Array.isArray(page) && page.every((rule) => rule && typeof rule.type === 'string'))) throw Error('ruleset page shape error')
  return pages.some((page) => page.some((rule) => rule.type === 'required_signatures'))
}

function unprotected404(result, body) {
  return result.status === 1 && /\bHTTP 404\b/.test(result.stderr) && body?.message === 'Branch not protected'
}

function classicRequirement(run, endpoint) {
  const result = run('gh', ['api', '--hostname', 'github.com', endpoint])
  if (result.error || result.signal) throw Error('classic protection command failed')
  const body = JSON.parse(result.stdout)
  if (result.status !== 0) {
    if (unprotected404(result, body)) return false
    throw Error('classic protection unreadable (including an ambiguous 404)')
  }
  if (typeof body?.enabled !== 'boolean') throw Error('classic protection shape error')
  return body.enabled
}

function readPolicy({ url, branch, run }) {
  const repo = githubRepoOf(url)
  if (!repo || typeof branch !== 'string' || !branch) throw Error('not a measurable GitHub branch destination')
  const name = `${repo.owner}/${repo.repo}`
  const encoded = encodeURIComponent(branch)
  if (rulesetRequirement(run, `repos/${name}/rules/branches/${encoded}`)) return { state: 'requirement-present', source: 'rulesets', name }
  if (classicRequirement(run, `repos/${name}/branches/${encoded}/protection/required_signatures`)) return { state: 'requirement-present', source: 'classic protection', name }
  return { state: 'no-requirement-found', name }
}

/** A partial/failing page set never becomes evidence of absence. */
export function remoteSignaturePolicy({ url, branch, run = signaturePolicyCommand, statuses = [] }) {
  let result
  try { result = readPolicy({ url, branch, run }) }
  catch (error) { result = { state: 'unknown', reason: error.message } }
  const sentences = {
    'requirement-present': `Remote signature requirement: a signature requirement applies on ${result.name} ${branch} (${result.source}); GitHub refuses commits it cannot verify, and bypass rights were not checked.`,
    'no-requirement-found': `Remote signature requirement: no requirement found on ${result.name} ${branch} (complete rulesets and classic protection read).`,
    unknown: `Remote signature requirement is unknown: ${result.reason}.`,
  }
  const note = statuses.includes('E') ? ' GitHub may verify those signatures even though this machine cannot (local status E).' : ''
  return { ...result, sentence: sentences[result.state] + note }
}
