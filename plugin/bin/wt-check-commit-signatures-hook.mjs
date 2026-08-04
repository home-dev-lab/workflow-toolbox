#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

function splitSegments(command) {
  return String(command || '')
    .split(/\n|;|&&|\|\||\|/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function tokenize(segment) {
  const tokens = []
  let current = ''
  let quote = null
  let escaped = false

  for (const ch of String(segment || '')) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }

  if (escaped || quote) return null
  if (current) tokens.push(current)
  return tokens
}

function runGit(repo, args) {
  try {
    return spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      timeout: 5_000,
    })
  } catch {
    return null
  }
}

function gitString(repo, args) {
  const res = runGit(repo, args)
  if (!res || res.error || res.status !== 0) return null
  const out = String(res.stdout || '').trim()
  return out || null
}

function currentBranch(repo) {
  return gitString(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
}

function pushTrackingRef(repo) {
  return (
    gitString(repo, ['rev-parse', '--symbolic-full-name', '@{push}']) ||
    gitString(repo, ['rev-parse', '--symbolic-full-name', '@{upstream}'])
  )
}

function normalizeRefSpecSource(src) {
  const clean = String(src || '').replace(/^\+/, '').trim()
  return clean || null
}

function branchFromDestination(dst) {
  const clean = String(dst || '').trim()
  if (!clean) return null
  if (clean.startsWith('refs/heads/')) return clean.slice('refs/heads/'.length) || null
  if (clean.startsWith('refs/')) return null
  return clean
}

function defaultDestinationBranch(source, branch) {
  if (source === 'HEAD') return branch
  if (source.startsWith('refs/heads/')) return source.slice('refs/heads/'.length) || null
  if (source.startsWith('refs/')) return null
  return source
}

function parsePushSegment(segment, cwd) {
  const tokens = tokenize(segment)
  if (!tokens || tokens[0] !== 'git') return null

  let repo = cwd
  let i = 1
  while (i < tokens.length && tokens[i] !== 'push') {
    if (tokens[i] === '-C' && i + 1 < tokens.length) {
      repo = path.resolve(cwd || process.cwd(), tokens[i + 1])
      i += 2
      continue
    }
    i += 1
  }
  if (tokens[i] !== 'push') return null

  const positionals = []
  let explicitRemote = null
  let afterDashDash = false
  const needsValue = new Set([
    '--repo',
    '--receive-pack',
    '--exec',
    '--upload-pack',
    '--push-option',
    '-o',
    '--force-if-includes',
    '--signed',
    '--recurse-submodules',
    '-u',
    '--set-upstream',
  ])

  for (let j = i + 1; j < tokens.length; j++) {
    const token = tokens[j]
    if (!afterDashDash && token === '--') {
      afterDashDash = true
      continue
    }
    if (!afterDashDash && token.startsWith('-')) {
      if (needsValue.has(token)) j += 1
      continue
    }
    positionals.push(token)
  }

  if (positionals.length >= 1) explicitRemote = positionals[0]
  return {
    repo,
    remote: explicitRemote,
    refspecs: positionals.length >= 2 ? positionals.slice(1) : [],
  }
}

function derivePushChecks(input) {
  if (input.hook_event_name !== 'PreToolUse') return []
  if (input.tool_name !== 'Bash') return []

  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()
  const checks = []

  for (const segment of splitSegments(input?.tool_input?.command)) {
    const parsed = parsePushSegment(segment, cwd)
    if (!parsed) continue

    const branch = currentBranch(parsed.repo)
    const pushRef = pushTrackingRef(parsed.repo)

    if (parsed.refspecs.length === 0) {
      const base = pushRef
      if (base && (!parsed.remote || base.startsWith(`refs/remotes/${parsed.remote}/`))) {
        checks.push({ repo: parsed.repo, range: `${base}..HEAD` })
      }
      continue
    }

    for (const refspec of parsed.refspecs) {
      if (!parsed.remote) continue
      const [rawSource, rawDestination] = refspec.split(':', 2)
      const source = normalizeRefSpecSource(rawSource)
      if (!source) continue // deletion / malformed refspec: no outgoing commits to inspect here
      const destination = rawDestination || defaultDestinationBranch(source, branch)
      const destBranch = branchFromDestination(destination)
      if (!destBranch) continue
      checks.push({ repo: parsed.repo, range: `refs/remotes/${parsed.remote}/${destBranch}..${source}` })
    }
  }

  const seen = new Set()
  return checks.filter(({ repo, range }) => {
    const key = `${repo}\u0000${range}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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

const invokedPath = process.argv[1]
const isEntry = invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href
if (isEntry) {
  try {
    run()
  } catch {
    // A hook that can break a session is not worth its output.
  }
}
