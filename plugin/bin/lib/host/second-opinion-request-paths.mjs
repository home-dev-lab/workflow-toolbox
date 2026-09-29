import path from 'node:path'
import { quoteRemedyWord } from '../remedy-quote.mjs'
import { laneSandboxReadRemedyAllowed } from './lane-sandbox.mjs'

// `~/x` becomes `<home>/x` by concatenation: path.join would fold a `..` that the kernel resolves
// through a symlink, and so check a different file than the one the reviewer would open.
function expandHome(value, home) {
  if (!value.startsWith('~/')) return value
  const base = home.endsWith('/') ? home.slice(0, -1) : home
  return `${base}${value.slice(1)}`
}
// A path starts at `/` or `~/` unless the character before it makes it part of a URL, a relative
// path or a word (`https://x`, `./x`, `a/b`).
const START = /(?:~\/|\/)/g
const NOT_A_START_AFTER = /[\w:/.~]/
// A candidate may end wherever the text could end a filename: end of line, or before any character
// that is not a word character, `-` or `/` (so `/outside/typo.md` never shrinks to `/outside`).
const INSIDE_A_NAME = /[\w/-]/

// Every spelling a request line could mean from one start, LONGEST first. The host keeps the first
// spelling that exists, so the longest real file wins over its punctuation-stripped prefixes, over a
// shorter existing prefix, and over whatever quoting surrounds it; no grammar of quotes or markup
// decides it.
// Linux limits: a name component is at most 255 bytes and a path at most 4096, so no spelling runs
// past the first over-long component; this bounds the work per start on a long line.
const NAME_MAX = 255
const PATH_MAX = 4096
function longestPossibleEnd(line, start) {
  let component = 0
  for (let end = start; end < line.length && end - start < PATH_MAX; end += 1) {
    component = line[end] === '/' ? 0 : component + 1
    if (component > NAME_MAX) return end
  }
  return Math.min(line.length, start + PATH_MAX)
}

function spellingsFrom(line, start, home) {
  const spellings = []
  const limit = longestPossibleEnd(line, start)
  for (let end = limit; end > start + 1; end -= 1) {
    if (end < line.length && INSIDE_A_NAME.test(line[end]) && end !== limit) continue
    const raw = line.slice(start, end)
    if (raw === '~/') continue
    for (const spelling of [raw, raw.replaceAll('\\ ', ' ')]) spellings.push(expandHome(spelling, home))
  }
  return [...new Set(spellings)].filter((value) => value !== '/')
}

export function requestNamedPaths(text, home) {
  const candidates = []
  for (const line of text.split(/\r?\n/)) {
    for (const match of line.matchAll(START)) {
      if (NOT_A_START_AFTER.test(line[match.index - 1] ?? '')) continue
      if (match[0] === '/' && line[match.index - 1] === '~') continue
      const spellings = spellingsFrom(line, match.index, home)
      if (spellings.length) candidates.push(spellings)
    }
  }
  return [...new Map(candidates.map((entry) => [entry.join('\0'), entry])).values()]
}

export function unreadEscape(value, home) {
  let paths
  try { paths = value?.startsWith('[') ? JSON.parse(value) : String(value ?? '').split(':') } catch { paths = [] }
  return Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.length > 0).map((p) => expandHome(p, home)) : []
}

export function requestPathRefusal(missing, repo, home, env) {
  const paths = missing.map((item) => typeof item === 'string' ? item : item.path)
  const reasons = missing.filter((item) => item.reason).map(({ path: named, reason }) => `${named}: ${reason}`)
  const dirs = [...new Set(paths.filter((named) => !named.includes(':')).map((named) => path.dirname(named)))]
    .filter((dir) => laneSandboxReadRemedyAllowed(dir, { ...env, HOME: home }))
  const read = dirs.length ? `; or re-run with WT_LANE_SANDBOX_READ=${quoteRemedyWord(dirs.join(':'), true)} (may make them readable; the check re-runs)` : ''
  const reasonNote = reasons.length ? ` (${reasons.join(', ')})` : ''
  return `REFUSED: the request names ${paths.join(', ')} outside the sandbox's readable set${reasonNote}. Copy them under --repo (${repo}) and change the request to name the copy${read}; or, if a path is only mentioned and not needed, WT_SECOND_OPINION_UNREAD=${quoteRemedyWord(JSON.stringify(paths))}.\n`
}
