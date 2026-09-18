#!/usr/bin/env node
// Push-scope answers WHICH commits go out; this guard independently answers whether the release commit was gated.
import fs from 'node:fs'
import path from 'node:path'
import { consumeMainGuardAllowOnce, mainGuardStateDir } from './lib/main-guard-allow-once.mjs'
import { derivePushTargets, gitString } from './lib/git-push.mjs'
import { readGateDeclaration, repoRoot, requiredGateProblems } from './lib/gate-evidence.mjs'
import { emitGuardNotice, recordGuardEvent } from './lib/guard-journal.mjs'
import { resolveWorkflowToolboxOption } from './lib/plugin-options.mjs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'

const GUARD = 'wt-release-push-evidence-guard-hook.mjs'

function remoteDefaultBranch(repo, remote) {
  if (!remote) return null
  const ref = gitString(repo, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`])
  return ref?.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : null
}

function releaseBranch(repo, remote) {
  const discovered = remoteDefaultBranch(repo, remote)
  if (discovered) return { name: discovered, source: `locally cached refs/remotes/${remote}/HEAD` }
  const configured = resolveWorkflowToolboxOption('release_branch').value
  if (configured?.trim()) return { name: configured.trim(), source: 'workflow-toolbox release_branch option' }
  return null
}

function resolutionText(resolved, remote) {
  const refresh = resolved.source.startsWith('locally cached ')
    ? ` Refresh it with: git remote set-head ${remote} --auto.`
    : ''
  return `Release branch '${resolved.name}' was resolved from ${resolved.source}.${refresh}`
}

function refuse(input, target, classification, reason) {
  recordGuardEvent({ guard: GUARD, decision: 'blocked', class: classification, reason, cwd: target.repo, session: input.session_id, agent: input.agent_id })
  emitGuardNotice({ payload: input, stdoutJson: { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: reason } } })
}

function warnUnresolved(input, target) {
  const marker = path.join(mainGuardStateDir(), 'release-push-branch-unresolved.warned')
  if (fs.existsSync(marker)) return
  fs.mkdirSync(path.dirname(marker), { recursive: true })
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`)
  const message = `[workflow-toolbox release gate] Could not resolve the release branch for remote '${target.remote || 'unknown'}' and destination '${target.destination || 'unknown'}'; allowing this push. Configure release_branch (WT_RELEASE_BRANCH) if the remote default branch is unavailable.`
  recordGuardEvent({ guard: GUARD, decision: 'warned', class: 'release-branch-unresolved', reason: message, cwd: target.repo, session: input.session_id, agent: input.agent_id })
  emitGuardNotice({ payload: input, stdoutJson: { hookSpecificOutput: { additionalContext: message } } })
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  const targets = derivePushTargets(input)
  if (!targets.length) return
  const command = input.tool_input?.command

  for (const target of targets) {
    if (!target.remote) {
      warnUnresolved(input, target)
      continue
    }
    const resolved = releaseBranch(target.repo, target.remote)
    if (target.unsafeForm) {
      if (!resolved) {
        warnUnresolved(input, target)
        continue
      }
      refuse(input, target, 'release-push-unsafe-form', `[workflow-toolbox release gate] Refused ${target.unsafeForm} because it can update release branch '${resolved.name}' without naming the exact pushed object. ${resolutionText(resolved, target.remote)}`)
      return
    }
    if (!target.destination) {
      warnUnresolved(input, target)
      continue
    }
    const fallbackRelease = target.destination === 'main' || target.destination === 'master'
    if (resolved ? target.destination !== resolved.name : !fallbackRelease) {
      if (!resolved && !fallbackRelease) warnUnresolved(input, target)
      continue
    }
    const releaseResolution = resolved || { name: target.destination, source: 'literal main/master fallback' }
    const resolution = resolutionText(releaseResolution, target.remote)
    if (!target.standalone) {
      refuse(input, target, 'release-push-compound-command', `[workflow-toolbox release gate] Refused: a release push must be the whole Bash command, not share it with another shell segment. ${resolution}`)
      return
    }
    if (target.deletion) {
      refuse(input, target, 'release-push-deletion', `[workflow-toolbox release gate] Refused deletion of release branch '${target.destination}'. ${resolution} The main guard independently refuses remote deletion; the two guards compose.`)
      return
    }
    if (!target.source) {
      warnUnresolved(input, target)
      continue
    }

    const root = repoRoot(target.repo)
    const declaration = readGateDeclaration(root)
    if (!declaration) {
      const message = `[workflow-toolbox release gate] Allowed ${target.remote}/${target.destination}: no .wt-gates.json declaration. ${resolution}`
      emitGuardNotice({ payload: input, stdoutJson: { hookSpecificOutput: { additionalContext: message } } })
      continue
    }
    const pushedCommit = gitString(target.repo, ['rev-parse', `${target.source}^{commit}`])
    if (!pushedCommit) {
      warnUnresolved(input, target)
      continue
    }
    const problems = requiredGateProblems(root, declaration, { pushedCommit })
    if (!problems.length) {
      const message = `[workflow-toolbox release gate] Allowed ${target.remote}/${target.destination} at ${pushedCommit}: gate evidence is fresh. ${resolution}`
      recordGuardEvent({ guard: GUARD, decision: 'silent', class: 'release-gate-evidence-fresh', reason: resolution, cwd: root, session: input.session_id, agent: input.agent_id })
      emitGuardNotice({ payload: input, stdoutJson: { hookSpecificOutput: { additionalContext: message } } })
      continue
    }

    const overrideReason = consumeMainGuardAllowOnce(command, input.tool_use_id)
    if (overrideReason) {
      const message = `[workflow-toolbox release gate] Allowed ${target.remote}/${target.destination} by consuming one-time override: ${overrideReason}. ${resolution}`
      recordGuardEvent({ guard: GUARD, decision: 'silent', class: 'release-gate-evidence-override', reason: overrideReason, cwd: root, session: input.session_id, agent: input.agent_id })
      emitGuardNotice({ payload: input, stdoutJson: { hookSpecificOutput: { additionalContext: message } } })
      return
    }

    const refresh = problems.map(({ gate }) => `  (${gate.cwd}) node "${'${CLAUDE_PLUGIN_ROOT}'}/bin/wt-run-gate.mjs" --record ${gate.name} -- ${gate.command}`).join('\n')
    const problemLines = problems.map(({ gate, status }) => `- ${gate.name}: ${status}`).join('\n')
    const legacyRefresh = problems.some(({ status }) => status.includes('predates version 2'))
      ? `\nSome records predate version 2 — refresh:\n${refresh}`
      : ''
    const overrideFile = path.join(mainGuardStateDir(), 'allow-once.json')
    const overrideExample = JSON.stringify({ command, reason: '<why>' })
    const reason = `Gate evidence is required before pushing ${target.remote}/${target.destination} at ${pushedCommit}. ${resolution}\n${problemLines}${legacyRefresh}\nRun:\n${refresh}\nThe release path does not accept a gates: skipped trailer. If a gate cannot run, write ${overrideExample} to ${overrideFile} and retry; the exact-command override requires a non-empty reason and is consumed once.`
    recordGuardEvent({ guard: GUARD, decision: 'blocked', class: 'release-gate-evidence-stale', reason: problems.map(({ gate, status }) => `${gate.name}:${status}`).join(', '), cwd: root, session: input.session_id, agent: input.agent_id })
    emitGuardNotice({ payload: input, stdoutJson: { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: reason } } })
    return
  }
}

runFailOpenHook(GUARD, main)
