import fs from 'node:fs'
import path from 'node:path'

export const TOKEN_SOURCE = 'secret:[a-z-]+#[a-f0-9]{6}'
const MAX_FILE_BYTES = 1024 * 1024
const ATRIUM = new Set([
  'mcp__plugin_atrium_atrium__speak', 'mcp__atrium__speak',
  'mcp__plugin_atrium_atrium__amend_held_message', 'mcp__plugin_atrium_atrium__edit_message',
])
const FILE_FIELDS = { Write: 'content', Edit: 'new_string', NotebookEdit: 'new_source' }
const SHELL_WORD = /(?:'[^']*'|"(?:\\.|[^"\\])*"|\$\((?:'[^']*'|"(?:\\.|[^"\\])*"|[^()])*\)|\\[^\n]|[^\s;&|<>()"'\\])+|&&|\|\||<<-?|[;&|<>()\n]/g
const BOUNDARY = /^(?:&&|\|\||[;&|()\n])$/
const PREFIXES = new Set(['env', 'command', 'exec', 'nice', 'time', 'sudo'])
const PREFIX_VALUES = {
  env: ['-u', '--unset', '-C', '--chdir'], exec: ['-a'], nice: ['-n', '--adjustment'],
  time: ['-f', '--format', '-o', '--output'],
  sudo: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-R', '--chroot', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-U', '--other-user'],
}
const COMMIT_VALUE_OPTIONS = ['--author', '--date', '--cleanup', '--pathspec-from-file', '-C', '--reuse-message', '-c', '--reedit-message', '-t', '--template']

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

function shellValue(word) {
  return word.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/g,
    (_, single, double, escaped) => single ?? (double?.replace(/\\(["\\$`])/g, '$1')) ?? escaped)
}

function literalPath(word) {
  if (!word || /[$`*?{}~]/.test(word)) throw Error('dynamic path')
  return shellValue(word)
}

function appendWords(groups, words) {
  let group = []
  for (const word of words) {
    if (BOUNDARY.test(word)) { if (group.length) groups.push(group); group = [] }
    else group.push(word)
  }
  return group
}

function commandGroups(command) {
  const groups = []
  const lines = command.split('\n')
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    while (line.endsWith('\\') && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i]
    const words = line.match(SHELL_WORD) || []
    const current = []
    const last = appendWords(current, words)
    if (last.length) current.push(last)
    for (const group of current) {
      const entry = { words: group, heredocs: [] }
      for (let j = 0; j < group.length; j++) {
        if (!/^<<-?$/.test(group[j])) continue
        const doc = readHeredoc(lines, i + 1, group[j], group[++j])
        entry.heredocs.push(doc)
        i = doc.end
      }
      groups.push(entry)
    }
  }
  return groups
}

function readHeredoc(lines, start, marker, word = '') {
  const delimiter = shellValue(word)
  const quoted = /['"\\]/.test(word)
  const body = []
  let end = start
  for (; end < lines.length; end++) {
    const line = marker === '<<-' ? lines[end].replace(/^\t+/, '') : lines[end]
    if (line === delimiter) break
    body.push(line)
  }
  return { body: body.join('\n'), quoted, complete: end < lines.length, end }
}

function commandIndex(words) {
  let i = 0
  while (i < words.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) { i++; continue }
    const name = shellValue(words[i]).split('/').pop()
    if (!PREFIXES.has(name)) return i
    i++
    while (i < words.length && shellValue(words[i]).startsWith('-')) {
      const option = shellValue(words[i++])
      if (option === '--') break
      if ((PREFIX_VALUES[name] || []).includes(option)) i++
    }
  }
  return i
}

function gitDirectory(cwd, word) {
  try {
    const dir = literalPath(word)
    if (cwd === null && !/^(?:\/|[A-Za-z]:[\\/])/.test(dir)) return null
    return resolved(cwd, dir)
  } catch { return null }
}

function gitCommit(words, cwd) {
  const first = commandIndex(words)
  if (!/(?:^|\/)git$/.test(shellValue(words[first] || ''))) return null
  let base = cwd
  for (let i = first + 1; i < words.length; i++) {
    const word = shellValue(words[i])
    if (word === 'commit') return { words: words.slice(i + 1), cwd: base }
    if (word === '-C') { base = gitDirectory(base, words[++i]); continue }
    if (/^-C.+/.test(word)) { base = gitDirectory(base, quotedWord(word.slice(2))); continue }
    if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(word)) { i++; continue }
    if (!word.startsWith('-')) return null
  }
  return null
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

function readMessage(findings, surface, cwd, word, readFile) {
  try {
    const p = gitDirectory(cwd, word)
    if (p === null) throw Error('unknown working directory')
    const stat = fs.statSync(p)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw Error('unsafe file')
    const text = readFile(p)
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_FILE_BYTES) throw Error('unreadable file')
    addText(findings, surface, 'file-now', text)
  } catch { findings.push({ surface, field: 'unscannable', count: 0 }) }
}

function fileArgument(words, index) {
  const value = shellValue(words[index])
  if (value === '-F' || value === '--file') return { word: words[index + 1], advance: 1 }
  if (value.startsWith('--file=')) return { word: quotedWord(value.slice(7)), advance: 0 }
  if (/^-F.+/.test(value)) return { word: quotedWord(value.slice(2)), advance: 0 }
  return null
}

function quotedWord(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function stdinMessage(findings, commit, readFile) {
  const index = commit.words.indexOf('<')
  if (index >= 0) return readMessage(findings, 'git-commit', commit.shellCwd, commit.words[index + 1], readFile)
  const doc = commit.heredocs.at(-1)
  if (doc?.complete && (doc.quoted || !/[$`]/.test(doc.body))) {
    return addText(findings, 'git-commit', 'command', doc.body)
  }
  findings.push({ surface: 'git-commit', field: 'unscannable', count: 0 })
}

function messageArgument(words, i) {
  const value = shellValue(words[i])
  if (value === '-m' || value === '--message') return { word: words[i + 1], advance: 1 }
  if (value.startsWith('--message=')) return { word: words[i].replace(/^(['"]?)--message=/, '$1'), advance: 0 }
  if (/^-m.+/.test(value)) return { word: words[i].replace(/^(['"]?)-m/, '$1'), advance: 0 }
  return null
}

function addMessageText(findings, word) {
  const dynamic = typeof word !== 'string' || /[$`]/.test(word.replace(/'[^']*'|\\./g, ''))
  if (dynamic) findings.push({ surface: 'git-commit', field: 'unscannable', count: 0 })
  else addText(findings, 'git-commit', 'command', shellValue(word))
}

function textSourceStep(findings, value) {
  if (/^(?:-t|--template)(?:=|$)|^-t.+/.test(value)) {
    findings.push({ surface: 'git-commit', field: 'unscannable', count: 0 })
    return { source: true, advance: Number(value === '-t' || value === '--template') }
  }
  if (/^(?:-C|--reuse-message)(?:=|$)|^-C.+/.test(value)) {
    return { reused: true, advance: Number(['-C', '--reuse-message'].includes(value)) }
  }
  return { advance: Number(COMMIT_VALUE_OPTIONS.includes(value)) }
}

function sourceStep(findings, commit, i, readFile) {
  const value = shellValue(commit.words[i])
  const message = messageArgument(commit.words, i)
  if (message) {
    addMessageText(findings, message.word)
    return { source: true, advance: message.advance }
  }
  const file = fileArgument(commit.words, i)
  if (!file) return textSourceStep(findings, value)
  if (shellValue(file.word || '') === '-') stdinMessage(findings, commit, readFile)
  else readMessage(findings, 'git-commit', commit.cwd, file.word, readFile)
  return { source: true, advance: file.advance }
}

function messageSources(findings, commit, readFile) {
  const values = controlArguments(commit.words)
  if (values.includes('--dry-run')) return
  if (values.some(v => /^(?:-e|--edit|-c|--reedit-message)(?:=|$)|^-c.+/.test(v))) {
    findings.push({ surface: 'git-commit', field: 'unscannable', count: 0 })
    return
  }
  let source = false
  let reused = false
  for (let i = 0; i < commit.words.length; i++) {
    if (shellValue(commit.words[i]) === '--') break
    const step = sourceStep(findings, commit, i, readFile)
    if (step.source) source = true
    if (step.reused) reused = true
    i += step.advance
  }
  const noEdit = noEditCommit(commit)
  if (!source && !reused && !noEdit) findings.push({ surface: 'git-commit', field: 'unscannable', count: 0 })
}

function noEditCommit(commit) {
  return commit.words.includes('--amend') && commit.words.includes('--no-edit')
}

function controlArguments(words) {
  const values = []
  for (let i = 0; i < words.length; i++) {
    const source = messageArgument(words, i) || fileArgument(words, i)
    if (source) { i += source.advance; continue }
    const value = shellValue(words[i])
    if (value === '--') break
    values.push(value)
    if (COMMIT_VALUE_OPTIONS.includes(value)) i++
  }
  return values
}

function scanGit(findings, group, cwd, readFile) {
  try {
    const commit = gitCommit(group.words, cwd)
    if (commit) messageSources(findings, { ...commit, shellCwd: cwd, heredocs: group.heredocs }, readFile)
  } catch { findings.push({ surface: 'git-commit', field: 'unscannable', count: 0 }) }
}

function scanExtraBash(findings, words, cwd, options) {
  const first = commandIndex(words)
  const offset = /(?:^|\/)node$/.test(shellValue(words[first] || '')) ? 1 : 0
  const command = words.slice(first + offset).join(' ')
  const name = shellValue(words[first + offset] || '').split('/').pop()
  const matches = (options.bashTextCommands || []).some(pattern => {
    pattern.lastIndex = 0
    return pattern.exec(`${name} ${words.slice(first + offset + 1).join(' ')}`)?.index === 0
  })
  if (!matches) return
  addText(findings, 'board', 'command', words.slice(first + offset + 1).join(' '))
  const cat = /\$\(\s*cat\s+((?:'[^']*'|"[^"$`]*"|[^\s()])+?)\s*\)/g
  for (const match of command.matchAll(cat)) readMessage(findings, 'board', cwd, match[1], options.readFile)
}

function scanBash(findings, command, cwd, options) {
  let shellCwd = cwd || process.cwd()
  for (const group of commandGroups(command)) {
    const { words } = group
    if (shellValue(words[0] || '') === 'cd') {
      shellCwd = gitDirectory(shellCwd, words[1])
      continue
    }
    scanGit(findings, group, shellCwd, options.readFile)
    scanExtraBash(findings, words, shellCwd, options)
  }
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
  const name = /^(?:Write|Edit|MultiEdit|NotebookEdit|Bash|mcp__[A-Za-z0-9_]{1,120})$/.test(tool) ? tool : 'MCP persisted write'
  return `Redaction-token guard (warn-only): ${name} write went through carrying ${result.total} redaction tokens (${fields}). `
    + 'REPAIR it now: edit the file, amend the commit message, or edit the card/message. Replace each token with the plain word you meant; '
    + 'use a neutral paraphrase or removal when the meaning is unknown; never guess a hidden value. '
    + "Check a file with grep -nE 'secret:[a-z-]+#[a-f0-9]{6}' <file>. This hook never blocks."
}
