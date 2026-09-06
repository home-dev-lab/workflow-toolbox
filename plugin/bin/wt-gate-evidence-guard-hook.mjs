#!/usr/bin/env node
// Refuse commits touching declared paths until every declared gate has evidence for this exact tree.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { invokes } from './lib/command-invocation.mjs'
import { emitGuardNotice, recordGuardEvent } from './lib/guard-journal.mjs'
import { readGuardJournal } from './lib/guard-journal-read.mjs'
import { readGateDeclaration, readGateRecord, recordIsFresh, repoRoot, stagedPaths, touchesDeclaredPath, treeSignature } from './lib/gate-evidence.mjs'

const GUARD = 'wt-gate-evidence-guard-hook.mjs'
const GIT_COMMIT = /^git\s+(?:-C\s+\S+\s+)?commit\b/

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function commitCwd(command, fallback) {
  const match = command.match(/(?:^|[;&|\n]\s*)git\s+(?:-C\s+(\S+)\s+)?commit\b/)
  return match?.[1] ? path.resolve(fallback, match[1].replace(/^['"]|['"]$/g, '')) : fallback
}

function skippedReason(command, cwd) {
  const inline = command.match(/(?:-m|--message)(?:\s+|=)(['"])([\s\S]*?)\1/)
  if (inline) return trailer(inline[2])
  const file = command.match(/(?:-F|--file)(?:\s+|=)([^\s;]+)/)
  if (file && file[1] !== '-') {
    try { return trailer(fs.readFileSync(path.resolve(cwd, file[1].replace(/^['"]|['"]$/g, '')), 'utf8')) } catch { return null }
  }
  const heredoc = command.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)\n\s*\2(?:\n|$)/)
  return heredoc ? trailer(heredoc[3]) : null
}

function trailer(message) {
  const match = message.match(/^gates:\s*skipped\s+—\s*(.+?)\s*$/mi)
  return match?.[1] || null
}

function probationFiring() {
  const journal = readGuardJournal({ weeks: 1 })
  const row = journal.ok ? journal.rows.find((entry) => entry.guard === GUARD) : null
  return (row?.total || 0) + 1
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash' || input.agent_id) return
  const command = input.tool_input?.command
  if (!invokes(command, GIT_COMMIT)) return
  const cwd = commitCwd(command, input.cwd || process.cwd())
  const root = repoRoot(cwd)
  const declaration = readGateDeclaration(root)
  if (!declaration) return
  const paths = stagedPaths(root)
  if (!paths.length || !touchesDeclaredPath(paths, declaration.paths)) return
  const gitDir = git(root, ['rev-parse', '--git-dir'])
  if (fs.existsSync(path.resolve(root, gitDir, 'MERGE_HEAD'))) return

  const reason = skippedReason(command, cwd)
  if (reason) {
    recordGuardEvent({ guard: GUARD, decision: 'silent', class: 'gate-evidence-skipped', reason, cwd: root, session: input.session_id, agent: input.agent_id })
    return
  }

  const signature = treeSignature(root)
  const problems = declaration.gates.flatMap((gate) => {
    const record = readGateRecord(root, gate.name)
    if (!record) return [{ gate, status: 'MISSING' }]
    if (record.exit !== 0) return [{ gate, status: `RED (exit ${record.exit})` }]
    if (!recordIsFresh(root, record, signature, paths)) return [{ gate, status: 'STALE (signature differs or staged file changed after gate)' }]
    return []
  })
  if (!problems.length) {
    recordGuardEvent({ guard: GUARD, decision: 'silent', class: 'gate-evidence-fresh', cwd: root, session: input.session_id, agent: input.agent_id })
    return
  }

  const firing = probationFiring()
  const cls = problems.some((p) => p.status.startsWith('MISSING')) ? 'gate-evidence-missing' : problems.some((p) => p.status.startsWith('RED')) ? 'gate-evidence-red' : 'gate-evidence-stale'
  const commands = problems.map(({ gate }) => `  (${gate.cwd}) node "${'${CLAUDE_PLUGIN_ROOT}'}/bin/wt-run-gate.mjs" --record ${gate.name} -- ${gate.command}`).join('\n')
  const message = `Gate evidence is required before this commit:\n${problems.map(({ gate, status }) => `- ${gate.name}: ${status}`).join('\n')}\nRun:\n${commands}`
  const deny = firing >= 20
  recordGuardEvent({ guard: GUARD, decision: deny ? 'blocked' : 'warned', class: cls, reason: problems.map((p) => `${p.gate.name}:${p.status}`).join(', '), cwd: root, session: input.session_id, agent: input.agent_id })
  if (deny) {
    emitGuardNotice({ payload: input, stdoutJson: { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: message } } })
  } else {
    emitGuardNotice({ payload: input, stdoutJson: { hookSpecificOutput: { additionalContext: `${message}\nProbation: ${20 - firing} firing(s) remain before refusal.` } } })
  }
}

runFailOpenHook(GUARD, main)
