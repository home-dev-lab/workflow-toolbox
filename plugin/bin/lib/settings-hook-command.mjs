// Recognise literal `node <absolute .mjs>` runs in a settings hook command without
// executing it. This is a single-pass scanner, not a shell evaluator:
// - a word holding an expansion is opaque: it can be neither the executable nor the script;
// - command, process and backtick substitutions are scanned as nested command lists, since
//   their commands run whenever the command around them runs;
// - redirections are skipped together with their target;
// - an OR branch is conditional and gives no evidence, nor does anything after it in the list;
// - syntax it cannot read (a here-document, an unterminated quote or expansion, an unbalanced
//   group, a dangling redirection) gives no evidence for the whole command.
import { basename, isAbsolute } from 'node:path'

class Unreadable extends Error {}
const unreadable = () => { throw new Unreadable() }
const MAX_NESTING = 32
const BLANK = /(?:[ \t\r]|\\\n)+/y
const REDIRECT = /\d*(?:&>>?|>>|>&|<&|>\||<>|<<<|<<-?|>|<)/y
const SUBSTITUTION_OPENERS = ['$(', '<(', '>(']

function matchAt(pattern, scan) {
  pattern.lastIndex = scan.pos
  return pattern.exec(scan.text)?.[0] ?? null
}

// push(...items) passes every item as an argument and overflows the stack on wide input.
function append(target, items) {
  for (const item of items) target.push(item)
}

const opensSubstitution = (scan) => SUBSTITUTION_OPENERS.some((opener) => scan.text.startsWith(opener, scan.pos))

// Reads one nested command list after its opener; the scan stops past the matching `)`.
function substitution(scan, word) {
  if (scan.depth >= MAX_NESTING) unreadable()
  scan.pos += 2
  scan.depth++
  append(word.scripts, commandScripts(commandList(scan, true)))
  scan.depth--
}

function backtick(scan, word) {
  let end = scan.pos + 1
  while (end < scan.text.length && scan.text[end] !== '`') end += scan.text[end] === '\\' ? 2 : 1
  if (end >= scan.text.length || scan.depth >= MAX_NESTING) unreadable()
  const inner = { text: scan.text.slice(scan.pos + 1, end).replace(/\\([\\`$])/g, '$1'), pos: 0, depth: scan.depth + 1 }
  append(word.scripts, commandScripts(commandList(inner, false)))
  scan.pos = end + 1
}

// `${...}` may nest, quote a closing brace or hold a substitution; one forward pass finds its end.
// Commands inside it run only when the default is used, so they give no evidence.
function parameterExpansion(scan) {
  let depth = 0
  while (scan.pos < scan.text.length) {
    if (scan.text.startsWith('${', scan.pos)) {
      depth++
      scan.pos += 2
    } else if (scan.text[scan.pos] === '}') {
      scan.pos++
      if (--depth === 0) return
    } else skipParameterPart(scan)
  }
  unreadable()
}

function skipParameterPart(scan) {
  const ch = scan.text[scan.pos]
  if (ch === '\\') scan.pos += 2
  else if (ch === "'" || ch === '"') scan.pos = closingQuote(scan.text, scan.pos) + 1
  else if (ch === '`' || opensSubstitution(scan)) expansion(scan, { scripts: [], opaque: true })
  else scan.pos++
}

function closingQuote(text, open) {
  let pos = open + 1
  while (pos < text.length && text[pos] !== text[open]) pos += text[pos] === '\\' && text[open] === '"' ? 2 : 1
  return pos < text.length ? pos : unreadable()
}

function expansion(scan, word) {
  word.opaque = true
  if (opensSubstitution(scan)) return substitution(scan, word)
  if (scan.text[scan.pos] === '`') return backtick(scan, word)
  if (scan.text.startsWith('${', scan.pos)) return parameterExpansion(scan)
  scan.pos++
}

function escaped(scan, word) {
  const next = scan.text[scan.pos + 1]
  if (next !== '\n' && next !== undefined) word.value += next
  scan.pos += next === undefined ? 1 : 2
}

function singleQuoted(scan, word) {
  const end = scan.text.indexOf("'", scan.pos + 1)
  if (end < 0) unreadable()
  word.value += scan.text.slice(scan.pos + 1, end)
  scan.pos = end + 1
}

function doubleQuotedPart(scan, word) {
  const ch = scan.text[scan.pos]
  const next = scan.text[scan.pos + 1]
  if (ch === '\\' && '\\"$`\n'.includes(next)) {
    if (next !== '\n') word.value += next
    scan.pos += 2
  } else if (ch === '$' || ch === '`') expansion(scan, word)
  else { word.value += ch; scan.pos++ }
}

function doubleQuoted(scan, word) {
  scan.pos++
  while (scan.pos < scan.text.length && scan.text[scan.pos] !== '"') doubleQuotedPart(scan, word)
  if (scan.pos >= scan.text.length) unreadable()
  scan.pos++
}

function wordPart(scan, word) {
  const ch = scan.text[scan.pos]
  if (ch === '\\') return escaped(scan, word)
  if (ch === "'") return singleQuoted(scan, word)
  if (ch === '"') return doubleQuoted(scan, word)
  if (ch === '$' || ch === '`' || opensSubstitution(scan)) return expansion(scan, word)
  word.value += ch
  scan.pos++
}

function endsWord(scan) {
  const ch = scan.text[scan.pos]
  if (ch === '<' || ch === '>') return !opensSubstitution(scan)
  return /[ \t\r\n;&|()]/.test(ch)
}

function wordToken(scan) {
  const word = { kind: 'word', value: '', opaque: false, scripts: [] }
  const start = scan.pos
  while (scan.pos < scan.text.length && !endsWord(scan)) wordPart(scan, word)
  // Every token must consume input; a character no rule reads would otherwise loop forever.
  if (scan.pos === start) unreadable()
  word.assignment = /^[A-Za-z_]\w*=/.test(scan.text.slice(start, scan.pos))
  return word
}

function operatorAt(scan) {
  const ch = scan.text[scan.pos]
  return ['&&', '||'].find((operator) => scan.text.startsWith(operator, scan.pos)) ?? (';&|()\n'.includes(ch) ? ch : null)
}

function nextToken(scan) {
  const blank = matchAt(BLANK, scan)
  if (blank) { scan.pos += blank.length; return null }
  if (scan.text[scan.pos] === '#') {
    const end = scan.text.indexOf('\n', scan.pos)
    scan.pos = end < 0 ? scan.text.length : end
    return null
  }
  if (opensSubstitution(scan)) return wordToken(scan)
  const redirect = matchAt(REDIRECT, scan)
  if (redirect) {
    if (/^\d*<<-?$/.test(redirect)) unreadable()
    scan.pos += redirect.length
    return { kind: 'redirect' }
  }
  const operator = operatorAt(scan)
  if (!operator) return wordToken(scan)
  scan.pos += operator.length
  return { kind: 'operator', value: operator }
}

// A nested list ends at its unmatched `)`; the top-level list must balance its groups.
function commandList(scan, nested) {
  const tokens = []
  let depth = 0
  while (scan.pos < scan.text.length) {
    const token = nextToken(scan)
    if (!token) continue
    const group = token.kind === 'operator' ? token.value : null
    if (group === ')' && depth === 0) return nested ? tokens : unreadable()
    if (group === '(') depth++
    if (group === ')') depth--
    tokens.push(token)
  }
  return finishedList(nested, depth, tokens)
}

function finishedList(nested, depth, tokens) {
  return nested || depth ? unreadable() : tokens
}

// `env` reads its own NAME=value arguments after quote removal; the shell reads only unquoted ones.
const isEnvAssignment = (word) => !word.opaque && /^[A-Za-z_]\w*=/.test(word.value)
const isCommand = (word, name) => word && !word.opaque && !word.value.endsWith('/') && basename(word.value) === name

function nodeScript(words) {
  let index = 0
  const wrapper = isCommand(words[0], 'env')
  if (wrapper) index++
  index = afterAssignments(words, wrapper, index)
  const executable = words[index]
  const script = words[index + 1]
  if (!isCommand(executable, 'node') && !isCommand(executable, 'node.exe')) return null
  return literalNodeScript(script)
}

function afterAssignments(words, wrapper, index) {
  while (words[index]?.assignment || (wrapper && words[index] && isEnvAssignment(words[index]))) index++
  return index
}

function literalNodeScript(script) {
  return script && !script.opaque && isAbsolute(script.value) && script.value.endsWith('.mjs') ? script.value : null
}

function nextCondition(operator, conditional, groups) {
  if (operator === '(') { groups.push(conditional); return conditional }
  if (operator === ')') return groups.pop() ?? false
  if (operator === '||') return true
  if ([';', '\n', '&'].includes(operator)) return groups.at(-1) ?? false
  return conditional
}

const emptyCommand = () => ({ words: [], targets: [], redirected: false })

function simpleCommandScripts({ words, targets }) {
  const script = nodeScript(words)
  return [...(script ? [script] : []), ...[...words, ...targets].flatMap((word) => word.scripts)]
}

function endCommand(state, operator) {
  const { command } = state
  if (command.redirected) unreadable()
  const empty = !command.words.length && !command.targets.length
  // A newline right after `||`, `&&` or `|` continues the same list.
  if (operator === '\n' && empty && ['||', '&&', '|'].includes(state.lastOperator)) return
  if (!state.conditional) append(state.scripts, simpleCommandScripts(command))
  state.command = emptyCommand()
  state.lastOperator = operator
  state.conditional = nextCondition(operator, state.conditional, state.groups)
}

function commandScripts(tokens) {
  const state = { scripts: [], groups: [], conditional: false, command: emptyCommand(), lastOperator: null }
  for (const token of [...tokens, { kind: 'operator', value: '\n' }]) {
    const { command } = state
    if (token.kind === 'operator') endCommand(state, token.value)
    else if (command.redirected && token.kind === 'redirect') unreadable()
    else if (token.kind === 'redirect') command.redirected = true
    else {
      (command.redirected ? command.targets : command.words).push(token)
      command.redirected = false
    }
  }
  return state.scripts
}

export function settingsHookScripts(command) {
  try {
    return commandScripts(commandList({ text: command, pos: 0, depth: 0 }, false))
  } catch (error) {
    if (error instanceof Unreadable) return []
    throw error
  }
}
