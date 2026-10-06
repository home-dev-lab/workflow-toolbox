import path from 'node:path'
import { parseGitCommands, parsePushCommand } from './git-push.mjs'
import * as io from './host/work-journal-io.mjs'
import { needsGitFallback, subjectOf } from './work-journal-recorders.mjs'

const COMMIT = /^(?:commit(?: \((?:initial|amend)\))?:|cherry-pick:|revert:)/
const MERGE = /^(?:commit \(merge\):|merge .+: (?:Fast-forward|Merge made)|pull\b)/
const splitLines = (value) => value ? value.split('\n') : []
const reflog = (repo, deadline) => splitLines(io.git(repo, ['reflog', 'show', '--format=%H%x09%gs', 'HEAD'], deadline))
const tags = (repo, deadline) => splitLines(io.git(repo, ['tag', '--list'], deadline))

export function captureGit(input, deadline) {
  const commands = parseGitCommands(input.tool_input?.command, input.cwd)
  if (commands.some((item) => item.unsupportedForm)) throw new Error('unsupported-git-target')
  const targets = commands.map((item) => item.repo)
  if (needsGitFallback(input, commands)) targets.push(input.projectRoot || input.cwd)
  const repos = [...new Set(targets)].map((repo) => {
    if (io.git(repo, ['rev-parse', '--git-dir'], deadline) === null) throw new Error('git-unreadable')
    const log = reflog(repo, deadline)
    const head = io.git(repo, ['rev-parse', '--verify', 'HEAD'], deadline)
    if (head && !log.length) throw new Error('reflog-unavailable')
    return { repo, reflog: log, head, tags: tags(repo, deadline), branch: io.git(repo, ['symbolic-ref', '--short', 'HEAD'], deadline) || '' }
  })
  const pushes = parsePushCommand(input.tool_input?.command, input.cwd, (repo, args) => io.git(repo, args, deadline)).map((target) => {
    const tracking = target.remote && target.destination && !target.unsafeForm ? `refs/remotes/${target.remote}/${target.destination}` : null
    return { ...target, tracking, before: tracking ? io.git(target.repo, ['rev-parse', '--verify', tracking], deadline) : null,
      sha: target.source ? io.git(target.repo, ['rev-parse', '--verify', target.source], deadline) : null }
  })
  // These calls cannot attribute tracking-ref movement to a real push. Keep the shared
  // parser unchanged; uncertainty belongs to the journal's evidence classification.
  const pushUncertain = /\b(?:fetch|pull)\b|\bremote\s+update\b/.test(input.tool_input?.command || '')
    || commands.some((item) => item.action === 'push' && item.args.some((arg) => arg === '--dry-run' || /^-[^-]*n/.test(arg)))
  return { repos, pushes, pushUncertain }
}
function ledgerDelta(before, after) {
  if (after.length < before.length) throw new Error('reflog-shrank')
  if (before.length && after.slice(after.length - before.length).join('\n') !== before.join('\n')) throw new Error('reflog-rewritten')
  return after.slice(0, after.length - before.length).reverse()
}
function commitIndex(ctx) {
  const indexed = new Set(splitLines(io.optionalRead(path.join(ctx.store, 'commits.idx'))))
  // Close the recent append/index crash gap here; locked SessionStart recovery rebuilds all history.
  for (const day of io.list(path.join(ctx.store, 'days')).filter((file) => file.endsWith('.ndjson')).slice(-2)) {
    for (const raw of splitLines(io.read(path.join(ctx.store, 'days', day)))) {
      try {
        const line = JSON.parse(raw)
        const sha = line.link.split('@').at(-1)
        if (line.kind === 'commit') indexed.add(sha)
        if (line.kind === 'merge') indexed.add(`merge:${sha}`)
      } catch { /* Recovery handles torn tails before appending. */ }
    }
  }
  return indexed
}
function appendGitEntry(ctx, before, entry, branch, indexed, acts, deadline) {
  const [sha, message] = entry.split('\t')
  const checkout = /^checkout: moving from .+ to (.+)$/.exec(message)
  if (checkout) branch = checkout[1]
  const kind = MERGE.test(message) ? 'merge' : COMMIT.test(message) ? 'commit' : null
  const key = kind === 'merge' ? `merge:${sha}` : sha
  if (!kind || indexed.has(key)) return branch
  const text = kind === 'merge' ? message : io.git(before.repo, ['show', '-s', '--format=%s', sha], deadline) || message
  acts.push({ kind, subject: subjectOf(ctx, text, branch), text, link: `${path.basename(before.repo)}@${sha}`, sha: kind === 'commit' ? sha : null })
  indexed.add(key)
  return branch
}
function appendRepoActs(ctx, before, indexed, acts, deadline) {
  const after = reflog(before.repo, deadline)
  if (!after.length && io.git(before.repo, ['rev-parse', '--verify', 'HEAD'], deadline) !== before.head) throw new Error('reflog-unavailable')
  const delta = ledgerDelta(before.reflog, after)
  if (delta.filter((entry) => COMMIT.test(entry.split('\t')[1]) || MERGE.test(entry.split('\t')[1])).length + acts.length > 200) throw new Error('too-many')
  let branch = before.branch
  for (const entry of delta) branch = appendGitEntry(ctx, before, entry, branch, indexed, acts, deadline)
}
export function gitActs(ctx, snapshot, deadline) {
  const acts = []
  const indexed = commitIndex(ctx)
  for (const before of snapshot.repos) appendRepoActs(ctx, before, indexed, acts, deadline)
  if (acts.length > 200) throw new Error('too-many')
  return acts
}
export function tagActs(ctx, snapshot, deadline) {
  const acts = []
  for (const before of snapshot.repos) {
    for (const tag of tags(before.repo, deadline).filter((item) => !before.tags.includes(item))) {
      const sha = io.git(before.repo, ['rev-parse', `refs/tags/${tag}`], deadline)
      acts.push({ kind: 'release', subject: subjectOf(ctx, tag, before.branch), text: `Created tag ${tag}`, link: `${path.basename(before.repo)}:refs/tags/${tag}@${sha}` })
    }
  }
  return acts
}
export function pushActs(ctx, snapshot, deadline) {
  if (!snapshot.pushes.length) return [{ outcome: 'unknown' }]
  return snapshot.pushes.map((target) => {
    if (snapshot.pushUncertain) return { outcome: 'unknown' }
    const after = target.tracking ? io.git(target.repo, ['rev-parse', '--verify', target.tracking], deadline) : null
    if (!target.sha || !after || after === target.before || after !== target.sha) return { outcome: 'unknown' }
    return { kind: 'push', subject: subjectOf(ctx, target.destination), text: `Pushed ${target.destination} to ${target.remote}`,
      link: `${path.basename(target.repo)}:${target.remote}/${target.destination}@${after}` }
  })
}
