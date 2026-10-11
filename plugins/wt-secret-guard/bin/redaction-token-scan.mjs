import fs from 'node:fs'
import path from 'node:path'

export const TOKEN_SOURCE = 'secret:[a-z-]+#[a-f0-9]{6}'
const MAX_FILE_BYTES = 1024 * 1024
const ATRIUM = new Set([
  'mcp__plugin_atrium_atrium__speak', 'mcp__atrium__speak',
  'mcp__plugin_atrium_atrium__amend_held_message', 'mcp__plugin_atrium_atrium__edit_message',
])
const FILE_FIELDS = { Write: 'content', Edit: 'new_string', NotebookEdit: 'new_source' }
const EDIT_OPTIONS = new Set(['--edit', '-e', '-c', '--reedit-message', '-t', '--template'])
const COMMAND_SEPARATORS = new Set([';', '&', '|', '\n'])
const COMMAND_PREFIXES = new Set(['env', 'command', 'exec', 'nohup', 'time', 'nice', 'node'])
const DIRECTORY_WORDS = new Set(['(', 'cd', 'pushd', 'popd'])

export function countTokens(text) {
  return typeof text === 'string' ? [...text.matchAll(new RegExp(TOKEN_SOURCE, 'g'))].length : 0
}

function addText(findings, surface, field, text) {
  const count = countTokens(text)
  if (count) findings.push({ surface, field, count })
}

function strings(value) {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  return Object.values(value).flatMap(strings)
}

function normalise(p) {
  return p.replaceAll('\\', '/')
}

function resolved(cwd, p) {
  // Use Windows semantics for drive/UNC paths even when replaying on POSIX.
  const base = normalise(cwd || process.cwd())
  const target = normalise(p)
  const windows = /^(?:[A-Za-z]:\/|\/\/)/
  const api = windows.test(base) || windows.test(target) ? path.win32 : path.posix
  return normalise(api.resolve(base, target))
}

function isExempt(input) {
  const tool = input.tool_name
  if (!(tool in FILE_FIELDS) && tool !== 'MultiEdit') return false
  const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path'
  const p = input.tool_input?.[key]
  if (typeof p !== 'string') return false
  const target = resolved(input.cwd, p)
  const location = /\/(?:plugins\/wt-secret-guard|wt-secret-guard\/\d+\.\d+\.\d+)\//.exec(target)
  if (!location) return false
  const below = target.slice(location.index + location[0].length)
  return /(?:^|\/)(?:test|tests|fixtures|docs)\//.test(below)
    || /(?:^|\/)[^/]+\.(?:test|selftest)\.[^/]+$/.test(below)
    || /(?:^|\/)(?:README|CHANGELOG)\.md$/.test(below)
}

function unquote(word = '') {
  return word.replaceAll("'", '').replaceAll('"', '')
}

function absolute(p) {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p)
}

function literalPath(word) {
  if (typeof word !== 'string' || /[\\$`*?{}~\[\]]/.test(word)) throw Error('dynamic path')
  return unquote(word)
}

// Detection reads plain words, including words inside quoted text or comments.
// It deliberately does not decide whether the shell would execute this Git.
function commitPosition(command) {
  const words = command.matchAll(/[^\s;&|()<>]+/g)
  let git = -1
  let commit = -1
  for (const word of words) {
    const value = unquote(word[0])
    if (git < 0 && (value === 'git' || value.endsWith('/git'))) git = word.index
    if (git >= 0 && commit < 0 && value === 'commit') commit = word.index
  }
  return commit < 0 ? null : { git, commit }
}

function commitDryRun(words, position) {
  for (const word of words) {
    if (word.start <= position.commit) continue
    if (COMMAND_SEPARATORS.has(word.raw)) return false
    if (word.raw === '--dry-run') return true
  }
  return false
}

// A bounded, forward-only word reader keeps quoted literal file names together.
// No substitutions, prefixes, command groups or directory state are interpreted.
function literalWords(command) {
  const words = []
  let start = -1
  let quote = ''
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (!quote && /[\s;&|()<>]/.test(char)) {
      if (start >= 0) words.push({ raw: command.slice(start, i), start, end: i })
      start = -1
      if (!/[^\S\n]/.test(char)) words.push({ raw: char, start: i, end: i + 1 })
      continue
    }
    if (start < 0) start = i
    if (char === '\\' && quote !== "'") { i++; continue }
    quote = nextQuote(quote, char)
  }
  if (start >= 0) words.push({ raw: command.slice(start), start, end: command.length })
  return words
}

function nextQuote(quote, char) {
  if (char === quote) return ''
  if (!quote && (char === '"' || char === "'")) return char
  return quote
}

function gitDirectory(cwd, word) {
  try {
    const dir = literalPath(word)
    if (cwd === null && !absolute(dir)) return null
    return resolved(cwd, dir)
  } catch { return null }
}

export function readBoundedFile(p) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0))
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw Error('unsafe file')
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0)
    if (length > MAX_FILE_BYTES) throw Error('oversized file')
    return buffer.subarray(0, length).toString('utf8')
  } finally { fs.closeSync(fd) }
}

function readMessage(findings, surface, cwd, word, readFile, uncertain = false) {
  try {
    const p = messagePath(cwd, word, uncertain)
    const stat = fs.statSync(p)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw Error('unsafe file')
    const text = readFile(p)
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_FILE_BYTES) throw Error('unreadable file')
    addText(findings, surface, 'file-now', text)
  } catch { findings.push({ surface, field: 'unscannable', count: 0 }) }
}

function messagePath(cwd, word, uncertain) {
  const literal = literalPath(word)
  if (!literal || (uncertain && !absolute(literal))) throw Error('unknown working directory')
  const p = gitDirectory(cwd, word)
  if (p === null) throw Error('unknown working directory')
  return p
}

function argument(words, index, short, long) {
  const value = unquote(words[index].raw)
  if (value === short || value === long) return { word: words[index + 1]?.raw, advance: 1 }
  if (value.startsWith(long + '=')) return { word: value.slice(long.length + 1), advance: 0 }
  if (value.startsWith(short) && value.length > short.length) return { word: value.slice(short.length), advance: 0 }
  return null
}

function commitDirectory(words, position, cwd) {
  let base = cwd
  for (let i = 0; i < words.length; i++) {
    if (words[i].start <= position.git || words[i].start >= position.commit) continue
    const directory = argument(words, i, '-C', '-C')
    if (!directory) continue
    base = gitDirectory(base, directory.word)
    i += directory.advance
  }
  return base
}

function heredoc(command) {
  const marker = command.indexOf('<<')
  if (marker < 0) return null
  const dash = command[marker + 2] === '-'
  const start = marker + (dash ? 3 : 2)
  const newline = command.indexOf('\n', start)
  if (newline < 0) return { complete: false }
  const word = command.slice(start, newline).trim().split(/\s+/)[0]
  const delimiter = unquote(word).replaceAll('\\', '')
  const lines = command.slice(newline + 1).split('\n')
  const body = []
  for (const raw of lines) {
    const line = dash ? raw.replace(/^\t+/, '') : raw
    if (line === delimiter) return { complete: true, quoted: /['"\\]/.test(word), body: body.join('\n') }
    body.push(line)
  }
  return { complete: false }
}

function stdinMessage(findings, context) {
  const { redirect, doc, cwd, readFile, uncertain } = context
  if (redirect !== undefined) {
    readMessage(findings, 'git-commit', cwd, redirect, readFile, uncertain)
    return false
  }
  return !doc?.complete || (!doc.quoted && /[$`]/.test(doc.body))
}

function editorOption(value) {
  return EDIT_OPTIONS.has(value.split('=')[0])
    || ['-c', '-t'].some(flag => value.startsWith(flag) && value.length > 2)
}

function sourceStep(findings, context, i) {
  const { words } = context
  const message = argument(words, i, '-m', '--message')
  if (message) return { source: true, unknown: !message.word || /[$`]/.test(message.word), advance: message.advance }
  const file = argument(words, i, '-F', '--file')
  if (!file) return { advance: 0 }
  let unknown = false
  if (unquote(file.word) === '-') unknown = stdinMessage(findings, context)
  else readMessage(findings, 'git-commit', context.base, file.word, context.readFile, context.uncertain)
  return { source: true, unknown, advance: file.advance }
}

function messageSources(findings, context) {
  let source = false
  let unknown = dynamicHeredoc(context.doc)
  const values = context.words.map(word => unquote(word.raw))
  for (let i = 0; i < context.words.length; i++) {
    const value = values[i]
    const step = sourceStep(findings, context, i)
    source ||= Boolean(step.source)
    unknown ||= Boolean(step.unknown) || editorOption(value)
    if (reusedSource(value)) source = true
    i += step.advance
  }
  source ||= values.includes('--amend') && values.includes('--no-edit')
  if (unknown || !source) findings.push({ surface: 'git-commit', field: 'unscannable', count: 0 })
}

function dynamicHeredoc(doc) {
  return Boolean(doc?.complete && !doc.quoted && /[$`]/.test(doc.body))
}

function reusedSource(value) {
  return value === '-C' || value.startsWith('-C') || value.startsWith('--reuse-message')
}

function scanGit(findings, command, cwd, words, readFile) {
  const position = commitPosition(command)
  if (!position || commitDryRun(words, position)) return
  addText(findings, 'git-commit', 'command', command)
  const context = {
    words: words.filter(word => word.start > position.commit),
    base: commitDirectory(words, position, cwd), cwd, readFile,
    uncertain: words.some(word => word.start < position.commit && DIRECTORY_WORDS.has(word.raw)), doc: heredoc(command),
    redirect: redirectWord(words),
  }
  messageSources(findings, context)
}

function redirectWord(words) {
  for (let i = 0; i < words.length; i++) {
    if (words[i].raw !== '<' || words[i + 1]?.raw === '<') continue
    if (words[i - 1]?.raw === '<') continue
    return words[i + 1]?.raw
  }
  return undefined
}

// Propagate the prefix walk's result once per word, keeping long prefix runs linear.
function commandPositions(words) {
  let position = true
  return words.map(word => {
    const current = position
    const value = unquote(word.raw)
    if (COMMAND_SEPARATORS.has(value) || value === '(') position = true
    else if (!commandPrefix(value)) position = false
    return current
  })
}

function commandPrefix(word) {
  return COMMAND_PREFIXES.has(word) || word.endsWith('/node') || assignmentWord(word)
}

function assignmentWord(word) {
  const equal = word.indexOf('=')
  if (equal < 1) return false
  const name = word.slice(0, equal)
  return /^[A-Za-z_]$/.test(name[0]) && !/[^A-Za-z0-9_]/.test(name)
}

function extraMatch(words, i, options, positions) {
  if (!positions[i]) return false
  const name = unquote(words[i].raw).split('/').pop()
  const operation = unquote(words[i + 1]?.raw)
  return (options.bashTextCommands || []).some(pattern => {
    pattern.lastIndex = 0
    return pattern.exec(`${name} ${operation}`)?.index === 0
  })
}

function readCatFiles(findings, command, cwd, readFile) {
  let offset = 0
  while (offset < command.length) {
    const start = command.indexOf('$(', offset)
    if (start < 0) return
    const end = command.indexOf(')', start + 2)
    if (end < 0) return
    const body = command.slice(start + 2, end).trim()
    if (body.startsWith('cat ')) readMessage(findings, 'board', cwd, body.slice(4).trim(), readFile)
    offset = end + 1
  }
}

function scanExtraBash(findings, command, words, cwd, options) {
  const positions = commandPositions(words)
  for (let i = 0; i < words.length; i++) {
    if (!extraMatch(words, i, options, positions)) continue
    const start = words[i + 1]?.end || words[i].end
    let end = i + 2
    while (end < words.length && ![';', '&', '|', '\n'].includes(words[end].raw)) end++
    const text = command.slice(start, words[end]?.start ?? command.length)
    addText(findings, 'board', 'command', text)
    readCatFiles(findings, text, cwd, options.readFile)
    i = end
  }
}

function scanBash(findings, command, cwd, options) {
  const words = literalWords(command)
  scanGit(findings, command, cwd, words, options.readFile)
  scanExtraBash(findings, command, words, cwd, options)
}

function scanFileFields(findings, tool, data) {
  if (tool in FILE_FIELDS) addText(findings, 'files', FILE_FIELDS[tool], data[FILE_FIELDS[tool]])
  if (tool === 'MultiEdit' && Array.isArray(data.edits)) {
    for (const edit of data.edits) addText(findings, 'files', 'new_string', edit?.new_string)
  }
}

function scanMcpFields(findings, tool, data, options) {
  if (ATRIUM.has(tool)) addText(findings, 'atrium', 'strings', strings(data).join('\n'))
  if ((options.mcpTextTools || []).includes(tool)) addText(findings, 'board', 'strings', strings(data).join('\n'))
}

function scanFields(findings, input, options) {
  const tool = input.tool_name
  const data = input.tool_input || {}
  if (tool === 'NotebookEdit' && data.edit_mode === 'delete') return
  scanFileFields(findings, tool, data)
  scanMcpFields(findings, tool, data, options)
  if (tool === 'Bash' && typeof data.command === 'string') {
    scanBash(findings, data.command, input.cwd, options)
  }
}

export function scanHookInput(input = {}, options = {}) {
  const findings = []
  const settings = { ...options, readFile: options.readFile || readBoundedFile }
  scanFields(findings, input, settings)
  return { exempt: isExempt(input), findings, total: findings.reduce((sum, f) => sum + f.count, 0) }
}

export function warningContext(tool, result) {
  const fields = result.findings.map(f => `${f.field}=${f.count}`).join(', ')
  // Only known names are displayed; caller-controlled keys and text never enter the warning.
  const name = /^(?:Write|Edit|MultiEdit|NotebookEdit|Bash|mcp__\w{1,120})$/.test(tool) ? tool : 'MCP persisted write'
  return `Redaction-token guard (warn-only): ${name} write went through carrying ${result.total} redaction tokens (${fields}). `
    + 'REPAIR it now: edit the file, amend the commit message, or edit the card/message. Replace each token with the plain word you meant; '
    + 'use a neutral paraphrase or removal when the meaning is unknown; never guess a hidden value. '
    + "Check a file with grep -nE 'secret:[a-z-]+#[a-f0-9]{6}' <file>. This hook never blocks."
}
