import { join } from 'node:path'
import { signatureCommand } from './signature-exception-io.mjs'
import { signatureCheckResult } from '../signature-check-result.mjs'
import { authorizationDestination, exceptionHelp, exceptionStatement, findOwnerException } from '../signature-exception.mjs'
import { remoteSignaturePolicy } from '../remote-signature-policy.mjs'

function ranges(line, advertisedIds) {
  return /^0+$/.test(line.remote) ? [line.local, ...advertisedIds().map((sha) => `^${sha}`)] : [`${line.remote}..${line.local}`]
}

function judgeLine({ line, dir, config, url, advertisedIds }) {
  const args = ranges(line, advertisedIds).flatMap((range) => ['--range', range])
  const result = signatureCommand(process.execPath, [join(dir, 'bin/wt-check-commit-signatures.mjs'), '--json', ...args],
    { env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } })
  const report = signatureCheckResult(result)
  if (!report.offenders.length) return null
  let statement = null
  let verdict
  try {
    statement = exceptionStatement({ destination: authorizationDestination(url, process.cwd()), ref: line.remoteRef, newSha: line.local })
    verdict = findOwnerException({ statement, config, consume: true })
  } catch (error) { verdict = { failure: { cause: error.message } } }
  if (verdict.opened) {
    console.log(`signature exception opened: owner signed room ${verdict.opened.room} question ${verdict.opened.questionId} request ${verdict.opened.requestId} (answer_id ${verdict.opened.answerId} is unverified transport metadata)`)
    return null
  }
  const policy = remoteSignaturePolicy({ url, branch: line.remoteRef.replace(/^refs\/heads\//, ''), statuses: report.offenders.map((o) => o.status) })
  return `${report.text}\n${policy.sentence}\n${exceptionHelp(statement, verdict.failure, process.cwd())}`
}

export function inspectPushSignatures(options) {
  try {
    for (const line of options.lines) {
      if (/^0+$/.test(line.local)) continue
      const failure = judgeLine({ ...options, line })
      if (failure) return { failure }
    }
    return { ok: true }
  } catch (error) { return { failure: `signature check failed: ${error.message}; no exception attempted` } }
}
