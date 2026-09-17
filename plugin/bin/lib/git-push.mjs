import path from 'node:path'
import { spawnSync } from 'node:child_process'

function splitCommandSegments(command) {
  const segments = []
  let current = ''
  let quote = null
  let escaped = false
  const text = String(command || '')
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]
    if (escaped) { current += ch; escaped = false; continue }
    if (ch === '\\') { current += ch; escaped = true; continue }
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { current += ch; quote = ch; continue }
    const width = ch === '&' && text[index + 1] === '&'
      ? 2
      : ch === '|' && text[index + 1] === '|' ? 2 : 1
    if (ch === '\n' || ch === ';' || ch === '|') {
      if (current.trim()) segments.push(current.trim())
      current = ''
      index += width - 1
      continue
    }
    if (width === 2) {
      if (current.trim()) segments.push(current.trim())
      current = ''
      index += 1
      continue
    }
    current += ch
  }
  if (current.trim()) segments.push(current.trim())
  return segments
}

function tokenize(segment) {
  const tokens = []
  let current = ''
  let quote = null
  let escaped = false
  for (const ch of String(segment || '')) {
    if (escaped) { current += ch; escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = '' }
      continue
    }
    current += ch
  }
  if (escaped || quote) return null
  if (current) tokens.push(current)
  return tokens
}

export function gitString(repo, args) {
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is the repository interface this guard inspects.
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 5_000 })
    if (result.error || result.status !== 0) return null
    return String(result.stdout || '').trim() || null
  } catch {
    return null
  }
}

function currentBranch(repo) {
  return gitString(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
}

function pushTrackingRef(repo) {
  return gitString(repo, ['rev-parse', '--symbolic-full-name', '@{push}']) || gitString(repo, ['rev-parse', '--symbolic-full-name', '@{upstream}'])
}

function normalizeSource(source) {
  return String(source || '').replace(/^\+/, '').trim() || null
}

function branchFromDestination(destination) {
  const clean = String(destination || '').trim()
  if (!clean) return null
  if (clean.startsWith('refs/heads/')) return clean.slice('refs/heads/'.length) || null
  if (clean.startsWith('refs/')) return null
  return clean
}

function defaultDestination(source, branch) {
  if (source === 'HEAD') return branch
  if (source.startsWith('refs/heads/')) return source.slice('refs/heads/'.length) || null
  if (source.startsWith('refs/')) return null
  return source
}

function parsePushSegment(segment, cwd) {
  const tokens = tokenize(segment)
  if (!tokens || tokens[0] !== 'git') return null
  let repo = cwd
  let index = 1
  while (index < tokens.length && tokens[index] !== 'push') {
    if (tokens[index] === '-C' && tokens[index + 1]) {
      repo = path.resolve(cwd || process.cwd(), tokens[index + 1])
      index += 2
    } else index += 1
  }
  if (tokens[index] !== 'push') return null

  const positionals = []
  let afterDashDash = false
  let optionRemote = null
  let deletion = false
  let aggregateForm = null
  const needsValue = new Set(['--receive-pack', '--exec', '--upload-pack', '--push-option', '-o', '--recurse-submodules'])
  for (let i = index + 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!afterDashDash && token === '--') { afterDashDash = true; continue }
    if (!afterDashDash && token === '--repo') { optionRemote = tokens[i + 1] || null; i += 1; continue }
    if (!afterDashDash && token.startsWith('--repo=')) { optionRemote = token.slice('--repo='.length) || null; continue }
    if (!afterDashDash && token === '--delete') { deletion = true; continue }
    if (!afterDashDash && (token === '--all' || token === '--mirror')) { aggregateForm = token; continue }
    if (!afterDashDash && token.startsWith('-')) {
      if (needsValue.has(token)) i += 1
      continue
    }
    positionals.push(token)
  }
  return {
    repo,
    remote: optionRemote || positionals[0] || null,
    refspecs: optionRemote ? positionals : positionals.slice(1),
    deletion,
    aggregateForm,
  }
}

export function derivePushTargets(input) {
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return []
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()
  const targets = []
  const segments = splitCommandSegments(input?.tool_input?.command)
  for (const segment of segments) {
    const parsed = parsePushSegment(segment, cwd)
    if (!parsed) continue
    const common = { ...parsed, command: segment, standalone: segments.length === 1 }
    const branch = currentBranch(parsed.repo)
    const tracking = pushTrackingRef(parsed.repo)
    if (parsed.aggregateForm) {
      targets.push({ ...common, source: null, destination: null, unsafeForm: parsed.aggregateForm })
      continue
    }
    if (parsed.refspecs.length === 0) {
      const explicitPrefix = parsed.remote ? `refs/remotes/${parsed.remote}/` : null
      const explicitDestination = explicitPrefix && tracking?.startsWith(explicitPrefix) ? tracking.slice(explicitPrefix.length) : null
      const inferred = parsed.remote ? null : tracking?.match(/^refs\/remotes\/([^/]+)\/(.+)$/)
      if (explicitDestination) {
        targets.push({ ...common, source: 'HEAD', destination: explicitDestination })
      } else if (inferred) {
        targets.push({ ...common, remote: inferred[1], source: 'HEAD', destination: inferred[2] })
      } else {
        targets.push({ ...common, source: null, destination: null })
      }
      continue
    }
    for (const refspec of parsed.refspecs) {
      if (refspec === ':') {
        targets.push({ ...common, source: null, destination: null, unsafeForm: "matching refspec ':'" })
        continue
      }
      const [rawSource, rawDestination] = refspec.split(':', 2)
      const source = normalizeSource(rawSource)
      const destination = branchFromDestination(rawDestination || defaultDestination(source, branch))
      if (refspec.includes('*')) {
        targets.push({ ...common, source, destination, unsafeForm: `wildcard refspec '${refspec}'` })
        continue
      }
      if (parsed.deletion || !source) {
        targets.push({ ...common, source: null, destination: branchFromDestination(parsed.deletion ? rawSource : rawDestination), deletion: true })
        continue
      }
      targets.push({
        ...common,
        source,
        destination,
      })
    }
  }
  return targets
}

export function derivePushChecks(input) {
  const seen = new Set()
  return derivePushTargets(input).flatMap((target) => {
    if (!target.remote || !target.source || !target.destination) return []
    const check = { repo: target.repo, range: `refs/remotes/${target.remote}/${target.destination}..${target.source}` }
    const key = `${check.repo}\u0000${check.range}`
    if (seen.has(key)) return []
    seen.add(key)
    return [check]
  })
}
