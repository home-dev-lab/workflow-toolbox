#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { derivePushChecks } from './lib/git-push.mjs'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'wt-check-commit-signatures.mjs')
const GIT_COMMIT = /\bgit(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+commit\b/

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function derivePushRanges(input) {
  return derivePushChecks(input).map(({ range }) => range)
}

function runSignatureCli(repo, extraArgs = []) {
  if (!fs.existsSync(CLI)) return null
  try {
    return spawnSync(process.execPath, [CLI, '--repo', repo, ...extraArgs], {
      encoding: 'utf8',
      timeout: 15_000,
    })
  } catch {
    return null
  }
}

function handlePostToolUse(input) {
  const command = input?.tool_input?.command
  if (typeof command !== 'string' || !GIT_COMMIT.test(command)) return

  const res = runSignatureCli(input.cwd || process.cwd())
  if (!res || res.error || res.status !== 1) return

  const stdout = String(res.stdout || '').trim()
  if (!stdout) return

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          'COMMIT SIGNATURE PROBLEM — the commit landed, but HEAD is missing an acceptable signature for this repository policy. Fix it before more history accumulates:\n' +
          stdout,
      },
    }),
  )
}

function handlePreToolUse(input) {
  const checks = derivePushChecks(input)
  if (checks.length === 0) return

  const findings = []
  for (const { repo, range } of checks) {
    const res = runSignatureCli(repo, ['--range', range])
    if (!res || res.error) continue
    if (res.status === 1) {
      const stdout = String(res.stdout || '').trim()
      if (stdout) findings.push(stdout)
    }
  }
  if (findings.length === 0) return

  // Block on CONFIRMED offenders only. The remote will reject the same push anyway, so this is
  // just an earlier, cheaper failure. Everything uncertain fails open: no derived range, git
  // trouble, malformed push shape, or CLI error all allow the push rather than teaching people to
  // route around a noisy guard.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'COMMIT SIGNATURE PROBLEM — this push would send commits that do not satisfy this repository\'s signature policy. The remote is expected to reject them; blocking here names the offending commit(s) before the network round-trip:\n' +
          findings.join('\n\n'),
      },
    }),
  )
}

export function run() {
  const input = readInput()
  if (input.tool_name && input.tool_name !== 'Bash') return
  if (input.hook_event_name === 'PostToolUse') {
    handlePostToolUse(input)
    return
  }
  if (input.hook_event_name === 'PreToolUse') handlePreToolUse(input)
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    run()
  } catch {
    // A hook that can break a session is not worth its output.
  }
}
