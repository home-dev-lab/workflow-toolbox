import { join } from 'node:path'
import { signatureCommand } from './signature-exception-io.mjs'
import { signatureCheckResult } from '../signature-check-result.mjs'
import { authorizationDestination, exceptionHelp, exceptionStatement } from '../signature-exception.mjs'
import { remoteSignaturePolicy } from '../remote-signature-policy.mjs'

function git(repo, args) {
  const result = signatureCommand('git', ['-C', repo, ...args])
  if (result.error || result.status !== 0) throw Error('git target lookup failed')
  return result.stdout.trim()
}

function requireActiveInstall(check, bin) {
  const active = signatureCommand(process.execPath, [join(bin, 'wt-push-guard-install.mjs'), '--check', '--repo', check.repo])
  if (active.error || active.status !== 0) throw Error(`no exception exists for this push: active pinned pre-push guard unavailable (${active.stderr || active.error?.message || active.status}); install with node plugin/bin/wt-push-guard-install.mjs --install --repo ${JSON.stringify(check.repo)} --guard-remote ${JSON.stringify(check.remote)}`)
}

// Only words the push parser reads exactly as the shell will: no expansion, substitution, globbing or escapes.
const LITERAL_SEGMENT = /^[\w \t./:@=+,^~%'"-]+$/

function requireDelegable(check) {
  if (check.prefixed || check.noVerify || check.gitConfigOverride) throw Error('delegation-disabled: run git itself without wrappers, --no-verify, -c or --config-env')
  if (check.standalone !== true) throw Error('delegation-disabled: run the push as a command of its own, with nothing before or after it')
  if (typeof check.command !== 'string' || !LITERAL_SEGMENT.test(check.command)) throw Error('delegation-disabled: the push uses shell syntax this guard cannot read exactly (expansion, substitution, globbing or escapes)')
}

function preview(check, bin, newSha) {
  requireDelegable(check)
  requireActiveInstall(check, bin)
  const result = signatureCommand(process.execPath, [join(bin, 'wt-signature-exception.mjs'), 'preview', '--repo', check.repo, '--remote', check.remote, '--ref', `refs/heads/${check.destination}`, '--new', newSha])
  if (result.error) throw Error(`preview failed: ${result.error.message}`)
  const parsed = JSON.parse(result.stdout)
  if (result.status !== 0 || !parsed.opened) throw Error(parsed.failure?.cause ?? 'preview failed')
  return `Owner authorization ${parsed.opened.requestId} verified; the pinned pre-push guard will spend it for this attempt.`
}

/** Called only AFTER exit 1. Nothing here may escape to the hook's fail-open outer catch. */
export function confirmedPushDecision(check, result, bin) {
  let statement = null
  let policy = 'Remote signature requirement is unknown: target lookup failed.'
  let text = 'Signature checker returned an invalid offender document.'
  try {
    const report = signatureCheckResult(result)
    text = report.text
    const url = git(check.repo, ['remote', 'get-url', '--push', check.remote])
    policy = remoteSignaturePolicy({ url, branch: check.destination, statuses: report.offenders.map((o) => o.status) }).sentence
    const newSha = git(check.repo, ['rev-parse', '--verify', '--end-of-options', `${check.source}^{commit}`])
    statement = exceptionStatement({ destination: authorizationDestination(url, check.repo), ref: `refs/heads/${check.destination}`, newSha })
    return { allowed: true, message: preview(check, bin, newSha) }
  } catch (error) {
    const failure = { cause: error.message }
    return { allowed: false, message: `${text}\n${policy}\n${exceptionHelp(statement, failure, check.repo)}` }
  }
}
