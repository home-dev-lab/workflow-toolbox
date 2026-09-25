#!/usr/bin/env node
// PreToolUse on Bash: warn when a scalar built as a space-separated string is later used
// unquoted where zsh does not split it. This is a lexer approximation, not a zsh parser.
// It sees same-command assignments only and cannot inspect options enabled in a user's .zshrc.

import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { emitGuardNotice, recordGuardEvent } from './lib/guard-journal.mjs'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'
import { readStdinJson } from './lib/host/read-stdin-json.mjs'

const GUARD = 'wt-zsh-word-split-guard-hook.mjs'
const CLASS = 'zsh-unquoted-scalar-split'
const NAME_RE = /^[A-Za-z_]\w*$/
const ASSIGN_RE = /^([A-Za-z_]\w*)(\[[^\]]*\])?(\+?=)/
const SKIP_PREFIX = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', 'time', 'noglob', 'nocorrect', 'done', 'fi', 'esac', 'coproc'])
const DECL = new Set(['local', 'typeset', 'declare', 'export', 'readonly', 'integer', 'float'])
const SILENT_CMDS = new Set(['echo', 'print', 'printf', '[', '[[', 'test', 'eval', ':', 'exit', 'return', 'unset', 'read', 'case', 'source', '.', 'let'])
const LOOP_CMDS = new Set(['for', 'select', 'foreach'])
const RANK = { none: 0, cmdsub: 1, list: 2 }
const BACKSLASH = String.fromCharCode(92)

function consumeBalanced(src, i, open, close) {
  let depth = 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === BACKSLASH) { i += 2; continue }
    if (ch === "'") { const j = src.indexOf("'", i + 1); i = j < 0 ? src.length : j + 1; continue }
    if (ch === '"') { i = skipDouble(src, i + 1); continue }
    if (ch === '`') { i = skipBacktick(src, i + 1); continue }
    if (ch === open) depth++
    else if (ch === close) { depth--; if (depth === 0) return i }
    i++
  }
  return src.length
}

function skipDouble(src, i) {
  while (i < src.length) {
    const ch = src[i]
    if (ch === BACKSLASH) { i += 2; continue }
    if (ch === '"') return i + 1
    if (ch === '$' && src[i + 1] === '(') { i = consumeBalanced(src, i + 2, '(', ')') + 1; continue }
    if (ch === '$' && src[i + 1] === '{') { i = consumeBalanced(src, i + 2, '{', '}') + 1; continue }
    if (ch === '`') { i = skipBacktick(src, i + 1); continue }
    i++
  }
  return src.length
}

function skipBacktick(src, i) {
  while (i < src.length) {
    if (src[i] === BACKSLASH) { i += 2; continue }
    if (src[i] === '`') return i + 1
    i++
  }
  return src.length
}

function innerSubs(text) {
  const out = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '(' && text[i + 2] !== '(') {
      const end = consumeBalanced(text, i + 2, '(', ')')
      out.push(text.slice(i + 2, end))
      i = end + 1
    } else {
      i++
    }
  }
  return out
}

function readDollar(src, i, meta) {
  const next = src[i + 1]
  if (next === '(' && src[i + 2] === '(') return consumeBalanced(src, i + 2, '(', ')') + 1
  if (next === '(') {
    const end = consumeBalanced(src, i + 2, '(', ')')
    meta.subs.push(src.slice(i + 2, end))
    meta.hasCmdSub = true
    return end + 1
  }
  if (next === '{') {
    const end = consumeBalanced(src, i + 2, '{', '}')
    const inner = src.slice(i + 2, end)
    const match = inner.match(/^[=#^~+]*([A-Za-z_]\w*)/)
    if (match) meta.refs.add(match[1])
    for (const sub of innerSubs(inner)) { meta.subs.push(sub); meta.hasCmdSub = true }
    return end + 1
  }
  if (next === "'") {
    let j = i + 2
    while (j < src.length && src[j] !== "'") j += src[j] === BACKSLASH ? 2 : 1
    const body = src.slice(i + 2, j)
    if (/\s/.test(body.replace(/\\[nt]/g, ' '))) meta.hasWS = true
    meta.literal += body
    return j + 1
  }
  const match = src.slice(i + 1).match(/^=?([A-Za-z_]\w*)/)
  if (match) { meta.refs.add(match[1]); return i + 1 + match[0].length }
  return /[?$#@*\-!0-9]/.test(next ?? '') ? i + 2 : i + 1
}

function newMeta() {
  return { refs: new Set(), subs: [], hasWS: false, hasCmdSub: false, quoted: false, literal: '', isArray: false, assign: null }
}

function readWord(src, startAt) {
  const start = startAt
  let i = startAt
  const meta = newMeta()
  const assignment = src.slice(i).match(ASSIGN_RE)
  if (assignment) {
    meta.assign = { name: assignment[1], op: assignment[3], element: Boolean(assignment[2]) }
    i += assignment[0].length
    if (src[i] === '(') {
      meta.isArray = true
      i = consumeBalanced(src, i + 1, '(', ')') + 1
    }
  }
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch) || ';&|<>'.includes(ch) || ch === ')') break
    if (ch === '(') { i = consumeBalanced(src, i + 1, '(', ')') + 1; continue }
    if (ch === BACKSLASH) {
      if (src[i + 1] === '\n') { i += 2; continue }
      if (/\s/.test(src[i + 1] ?? '')) meta.hasWS = true
      meta.literal += src[i + 1] ?? ''
      i += 2
      continue
    }
    if (ch === "'") {
      meta.quoted = true
      const j = src.indexOf("'", i + 1)
      const end = j < 0 ? src.length : j
      const body = src.slice(i + 1, end)
      if (/\s/.test(body)) meta.hasWS = true
      meta.literal += body
      i = end + 1
      continue
    }
    if (ch === '"') {
      meta.quoted = true
      i++
      while (i < src.length && src[i] !== '"') {
        const inner = src[i]
        if (inner === BACKSLASH) { meta.literal += src[i + 1] ?? ''; i += 2; continue }
        if (inner === '$') { i = readDollar(src, i, meta); continue }
        if (inner === '`') {
          const end = skipBacktick(src, i + 1)
          meta.subs.push(src.slice(i + 1, end - 1)); meta.hasCmdSub = true
          i = end
          continue
        }
        if (/\s/.test(inner)) meta.hasWS = true
        meta.literal += inner
        i++
      }
      i++
      continue
    }
    if (ch === '$') { i = readDollar(src, i, meta); continue }
    if (ch === '`') {
      const end = skipBacktick(src, i + 1)
      meta.subs.push(src.slice(i + 1, end - 1)); meta.hasCmdSub = true
      i = end
      continue
    }
    meta.literal += ch
    i++
  }
  const raw = src.slice(start, i)
  const exact = raw.match(/^\$([A-Za-z_]\w*)$/) || raw.match(/^\$\{([A-Za-z_]\w*)\}$/)
  return [{ type: 'word', raw, meta, exactRef: exact ? exact[1] : null }, i]
}

const OPS = [';;', ';&', ';|', '&&', '||', '|&', '&!', '&|', ';', '|', '&', '(', ')']
const REDIRS = ['&>>', '&>', '<<<', '<<-', '<<', '>>', '>|', '>!', '>&', '<&', '<>', '>', '<']

function lex(src) {
  const tokens = []
  const pendingHeredocs = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\n') {
      tokens.push({ type: 'op', v: '\n' })
      i++
      while (pendingHeredocs.length) {
        const { tag, strip } = pendingHeredocs.shift()
        while (i < src.length) {
          let newline = src.indexOf('\n', i)
          if (newline < 0) newline = src.length
          let line = src.slice(i, newline)
          if (strip) line = line.replace(/^\t+/, '')
          i = newline + 1
          if (line === tag) break
        }
      }
      continue
    }
    if (/\s/.test(ch)) { i++; continue }
    if (ch === BACKSLASH && src[i + 1] === '\n') { i += 2; continue }
    if (ch === '#') {
      const newline = src.indexOf('\n', i)
      i = newline < 0 ? src.length : newline
      continue
    }
    if (ch === '(' && src[i + 1] === '(') {
      i = consumeBalanced(src, i + 1, '(', ')') + 1
      tokens.push({ type: 'op', v: ';' })
      continue
    }
    if ((ch === '<' || ch === '>') && src[i + 1] === '(') {
      const end = consumeBalanced(src, i + 2, '(', ')')
      const meta = newMeta()
      meta.subs.push(src.slice(i + 2, end))
      tokens.push({ type: 'word', raw: src.slice(i, end + 1), meta, exactRef: null })
      i = end + 1
      continue
    }
    const fd = src.slice(i).match(/^\d+(?=[<>])/)
    const at = fd ? i + fd[0].length : i
    const redirection = REDIRS.find((candidate) => src.startsWith(candidate, at))
    if (redirection && (fd || '<>&'.includes(ch))) {
      i = at + redirection.length
      while (src[i] === ' ' || src[i] === '\t') i++
      if (redirection === '<<' || redirection === '<<-') {
        const tag = src.slice(i).match(/^(['"]?)([^\s'";&|<>()]+)\1/)
        if (tag) { pendingHeredocs.push({ tag: tag[2], strip: redirection === '<<-' }); i += tag[0].length }
        continue
      }
      if (i < src.length && !/[\s;&|()]/.test(src[i])) {
        const [token, next] = readWord(src, i)
        token.type = 'redir-target'
        tokens.push(token)
        i = next
      }
      continue
    }
    const operator = OPS.find((candidate) => src.startsWith(candidate, i))
    if (operator) { tokens.push({ type: 'op', v: operator }); i += operator.length; continue }
    const [token, next] = readWord(src, i)
    tokens.push(token)
    i = next === i ? i + 1 : next
  }
  return tokens
}

function looksLikeOnePath(literal) {
  const pieces = literal.trim().split(/\s+/)
  return /^(~|\/|\.\.?\/)/.test(pieces[0]) && pieces.slice(1).every((piece) => !/^[-/~$]/.test(piece))
}

// These two narrow shapes are measured false positives: each command substitution returns one
// value by construction, so a loop over that scalar does not rely on word splitting.
function isKnownSingleValueSub(command) {
  const value = command.trim()
  if (/^git\s+rev-parse\s+(?:--verify\s+)?[^\s;&|]+$/.test(value)) return true
  return /^ps\s+-o\s+ppid=\s+-p\s+\$\$\s*\|\s*tr\s+-d\s+(['"]) \1$/.test(value)
}

function staticWord(word) {
  if (!word || word.meta.assign || word.meta.refs.size > 0 || word.meta.subs.length > 0) return null
  return word.meta.literal
}

function commandEnablesWordSplit(words) {
  let index = 0
  while (SKIP_PREFIX.has(staticWord(words[index]))) index++
  const command = staticWord(words[index])?.toLowerCase()
  const args = words.slice(index + 1).map(staticWord)
  if (args.includes(null)) return false
  const normalized = args.map((word) => word.toLowerCase().replaceAll('_', ''))
  if (command === 'setopt' && normalized.includes('shwordsplit')) return true
  if (command === 'set') {
    return normalized.some((word, at) => word === '-o' && normalized[at + 1] === 'shwordsplit')
  }
  return command === 'emulate' && normalized.some((word) => ['sh', 'ksh', 'bash'].includes(word))
}

function enablesWordSplit(command) {
  let words = []
  for (const token of lex(command)) {
    if (token.type === 'word') words.push(token)
    else {
      if (commandEnablesWordSplit(words)) return true
      words = []
    }
  }
  return commandEnablesWordSplit(words)
}

function classify(meta, vars) {
  if (meta.hasWS) {
    const pureLiteral = meta.refs.size === 0 && meta.subs.length === 0
    if (pureLiteral && looksLikeOnePath(meta.literal)) return 'none'
    return 'list'
  }
  for (const reference of meta.refs) if (vars.get(reference)?.kind === 'list') return 'list'
  if (meta.hasCmdSub && !meta.subs.every(isKnownSingleValueSub)) return 'cmdsub'
  return 'none'
}

function recordAssign(state, word, forceArray) {
  const { name, element } = word.meta.assign
  const kind = classify(word.meta, state.vars)
  if (word.meta.assign.op === '+=') {
    const value = state.vars.get(name) ?? { kind: 'none', array: false }
    if (forceArray || element || word.meta.isArray) value.array = true
    if (RANK[kind] > RANK[value.kind]) value.kind = kind
    state.vars.set(name, value)
    return
  }
  state.vars.set(name, { kind, array: forceArray || element || word.meta.isArray })
}

function markArray(state, name) {
  const value = state.vars.get(name) ?? { kind: 'none', array: false }
  value.array = true
  state.vars.set(name, value)
}

function flag(state, word, context, command, allowed) {
  const name = word.exactRef
  if (!name) return
  const value = state.vars.get(name)
  if (!value || value.array || !allowed.includes(value.kind)) return
  const use = context === 'for' ? `${command} ... in ${word.raw}` : `${command} ${word.raw}`
  state.findings.push({ name, kind: value.kind, context, use })
}

function cloneVars(vars) {
  return new Map([...vars].map(([name, value]) => [name, { ...value }]))
}

function analyzeSubstitution(state, src) {
  analyzeInto({ ...state, vars: cloneVars(state.vars) }, src)
}

function processCommand(state, words) {
  for (const word of words) for (const sub of word.meta.subs) analyzeSubstitution(state, sub)
  let index = 0
  while (index < words.length) {
    const word = words[index]
    if (word.meta.assign) { recordAssign(state, word, false); index++; continue }
    if (SKIP_PREFIX.has(word.raw)) { index++; continue }
    break
  }
  if (index >= words.length) return
  const command = words[index].raw
  const args = words.slice(index + 1)
  if (LOOP_CMDS.has(command)) {
    if (args[1]?.raw === 'in') for (const arg of args.slice(2)) flag(state, arg, 'for', command, ['list', 'cmdsub'])
    return
  }
  if (DECL.has(command)) {
    let arrayFlag = false
    for (const arg of args) {
      if (/^[-+][A-Za-z]*[aA]/.test(arg.raw)) { arrayFlag = true; continue }
      if (arg.meta.assign) recordAssign(state, arg, arrayFlag)
      else if (arrayFlag && NAME_RE.test(arg.raw)) markArray(state, arg.raw)
    }
    return
  }
  if (command === 'set') {
    for (const arg of args) flag(state, arg, 'set', 'set --', ['list', 'cmdsub'])
    return
  }
  if (SILENT_CMDS.has(command)) return
  for (const word of words.slice(index)) flag(state, word, 'args', command.startsWith('$') ? '' : command, ['list'])
}

function analyzeInto(state, src) {
  if (state.depth > 8) return
  state.depth++
  let words = []
  const parentScopes = []
  for (const token of lex(src)) {
    if (token.type === 'word') words.push(token)
    else if (token.type === 'redir-target') { for (const sub of token.meta.subs) analyzeSubstitution(state, sub) }
    else {
      processCommand(state, words)
      words = []
      if (token.v === '(') { parentScopes.push(state.vars); state.vars = cloneVars(state.vars) }
      else if (token.v === ')' && parentScopes.length > 0) state.vars = parentScopes.pop()
    }
  }
  processCommand(state, words)
  if (parentScopes.length > 0) state.vars = parentScopes[0]
  state.depth--
}

export function analyze(command) {
  if (typeof command !== 'string' || !command.includes('$') || enablesWordSplit(command)) return []
  const state = { vars: new Map(), findings: [], depth: 0 }
  try { analyzeInto(state, command) } catch { return [] }
  return state.findings
}

function warningText(findings) {
  const byName = new Map()
  for (const finding of findings) {
    const entry = byName.get(finding.name) ?? { kind: finding.kind, uses: [] }
    if (!entry.uses.includes(finding.use)) entry.uses.push(finding.use)
    byName.set(finding.name, entry)
  }
  const parts = [...byName].map(([name, entry]) => {
    const source = entry.kind === 'list' ? 'built as a space-separated string' : 'assigned from a command substitution'
    const uses = entry.uses.slice(0, 3).map((use) => `\`${use.trim()}\``).join(', ')
    return `\`${name}\` (${source}, then used as ${uses})`
  })
  const first = [...byName.keys()][0]
  return (
    `[workflow-toolbox zsh word-split guard] zsh does not word-split an unquoted scalar: ${parts.join('; ')} ` +
    'will reach the command as one word; a command can receive one malformed argument and a loop can run once. ' +
    `Use \`\${=${first}}\` for an explicit split, or an array: \`${first}=()\`, \`${first}+=(value)\`, then \`"\${${first}[@]}"\`. ` +
    'This hook recognizes `setopt shwordsplit` in the same command but cannot inspect options enabled in your .zshrc.'
  )
}

function isZshShell() {
  return /(^|\/)zsh$/.test(process.env.SHELL ?? '')
}

function main() {
  const input = readStdinJson()
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash' || !isZshShell()) return
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : ''
  if (!command) return
  const findings = analyze(command)
  if (findings.length === 0) return
  const names = [...new Set(findings.map((finding) => finding.name))]
  recordGuardEvent({
    guard: GUARD,
    decision: 'warned',
    class: CLASS,
    session: input.session_id,
    agent: input.agent_id,
    cwd: input.cwd,
    evidence: { vars: names.join(',') },
  })
  emitGuardNotice({
    payload: input,
    stdoutJson: { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warningText(findings) } },
  })
}

// Real-path comparison keeps symlink and Windows short-name invocation working while imports stay inert.
if (isInvokedDirectly(import.meta.url)) runFailOpenHook(GUARD, main)
