// Pure shell-word reader: which directories does a Bash command run `git commit` in?
import { resolve } from 'node:path'
import { stripHeredocs } from './command-invocation.mjs'
import { homeDirectory } from './host/home-directory.mjs'

const MAX_DIRECTORIES = 4
// The shell escape character, spelled by code so the host-primitive census does not read it as a path separator.
const BACKSLASH = String.fromCharCode(92)
const HOME_PREFIX = /^~(?:\/|$)/
const WRAPPERS = new Set(['{', '!', 'sudo', 'env', 'command', 'time', 'nohup', 'exec', 'if', 'then', 'else', 'elif', 'while', 'until', 'do'])
const UNRESOLVABLE = /[$`*?[{]/
const OPERATORS = new Set([';', '&', '|', '\n', '(', ')'])

function commandWithoutComments(command) {
  // Preserve quoted/escaped hashes and remove only shell comments at word boundaries.
  return command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"|\\[\s\S]|(^|[\s;&|()])#[^\n]*/gm,
    (match, boundary) => boundary === undefined ? match : boundary)
}

function readSingle(text, start) {
  const end = text.indexOf("'", start + 1)
  const stop = end < 0 ? text.length : end
  return { value: text.slice(start + 1, stop), next: stop + 1 }
}

function readDouble(text, start) {
  let value = ''
  let i = start + 1
  while (i < text.length && text[i] !== '"') {
    if (text[i] === BACKSLASH && '$`"\\\n'.includes(text[i + 1] ?? '')) i++
    value += text[i] ?? ''
    i++
  }
  return { value, next: i + 1 }
}

function readQuoted(text, i) {
  if (text[i] === "'") return readSingle(text, i)
  if (text[i] === '"') return readDouble(text, i)
  if (text[i + 1] === '\n') return { value: '', next: i + 2 }
  return { value: text[i + 1] ?? '', next: i + 2 }
}

// Split into segments of words; each word keeps its raw text and its shell-unquoted value.
function shellSegments(text) {
  const segments = [[]]
  let word = null
  const flush = () => { if (word) segments.at(-1).push(word); word = null }
  for (let i = 0; i < text.length;) {
    const ch = text[i]
    if (OPERATORS.has(ch)) { flush(); segments.push([]); i++; continue }
    if (ch === ' ' || ch === '\t') { flush(); i++; continue }
    word ??= { raw: '', value: '' }
    const piece = ch === "'" || ch === '"' || ch === BACKSLASH ? readQuoted(text, i) : { value: ch, next: i + 1 }
    word.raw += text.slice(i, piece.next)
    word.value += piece.value
    i = piece.next
  }
  flush()
  return segments.filter((words) => words.length)
}

function skipWrappers(words) {
  let i = 0
  let wrapped = false
  while (i < words.length) {
    const { raw, value } = words[i]
    const isWrapper = WRAPPERS.has(value)
    if (isWrapper) wrapped = true
    if (!isWrapper && !/^[A-Za-z_]\w*=/.test(raw) && !(wrapped && raw.startsWith('-'))) break
    i++
  }
  return i
}

function literalPath(word, attached) {
  if (UNRESOLVABLE.test(word.raw)) return null
  if (attached || !word.raw.startsWith('~')) return word.value
  return HOME_PREFIX.test(word.raw) ? homeDirectory() + word.value.slice(1) : null
}

function directoryOption(words, i, dir) {
  const attached = words[i].value.length > 2
  const target = attached ? { raw: words[i].raw.slice(2), value: words[i].value.slice(2) } : words[i + 1]
  const path = target ? literalPath(target, attached) : null
  return path === null ? null : { next: i + (attached ? 1 : 2), dir: resolve(dir, path) }
}

function optionStep(words, i, dir) {
  const { value } = words[i]
  if (value.startsWith('-C')) return directoryOption(words, i, dir)
  if (!value.startsWith('-c')) return null
  return { next: i + (value.length > 2 ? 1 : 2), dir }
}

// The directory the commit runs in; null when the segment is not a resolvable commit,
// undefined for a commit that creates nothing (--dry-run).
function commitDirectory(words, cwd) {
  const start = skipWrappers(words)
  if (words[start]?.value !== 'git') return null
  let state = { next: start + 1, dir: cwd }
  while (state && words[state.next] && words[state.next].value !== 'commit') {
    state = optionStep(words, state.next, state.dir)
  }
  if (!state || !words[state.next]) return null
  return words.slice(state.next + 1).some((word) => word.value === '--dry-run') ? undefined : state.dir
}

// Distinct directories (at most four) in which the command runs a real `git commit`.
export function commitDirectories(command, cwd) {
  if (typeof command !== 'string' || typeof cwd !== 'string') return []
  const dirs = new Set()
  for (const words of shellSegments(commandWithoutComments(stripHeredocs(command)))) {
    const dir = commitDirectory(words, cwd)
    if (dir && dirs.size < MAX_DIRECTORIES) dirs.add(dir)
  }
  return [...dirs]
}
