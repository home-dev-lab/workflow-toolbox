// Recognise literal shell command words without executing settings commands. This is
// deliberately not a shell evaluator: a word holding an expansion is opaque (it can be
// neither the executable nor the script), redirections are skipped with their target,
// and syntax the tokenizer cannot read (a here-document, a dangling redirection, an
// unbalanced group) produces no evidence. An OR branch is
// conditional, not proof of hook execution.
import { basename, isAbsolute } from 'node:path'

const TOKEN = new RegExp([
  String.raw`(?:[ \t\r]|\\\n)+`,
  String.raw`#[^\n]*`,
  String.raw`&&|\|\|`,
  String.raw`(?<heredoc>\d*<<-?(?!<))`,
  String.raw`(?<redirect>\d*(?:&>>?|>>|>&|<&|>\||<>|<<<|>|<))`,
  String.raw`[;&|()\n]`,
  String.raw`(?:\\[^\n]|'[^']*'|"(?:\\[^\n]|[^"\\])*"|` + '`[^`]*`' + String.raw`|\$\{[^}]*\}|\$|[^\s\\'";&|()<>` + '`' + String.raw`$])+`,
].join('|'), 'y')

// Quoted and escaped text is literal; what remains unquoted decides whether a word expands.
function unquoted(raw) {
  return raw.replace(/\\[^\n]|'[^']*'|"((?:\\[^\n]|[^"\\])*)"/g, (_match, inner) => inner?.replace(/\\[\\"$`]/g, '') ?? '')
}

function literalWord(raw) {
  return raw.replace(/\\([^\n])|'([^']*)'|"((?:\\.|[^"\\])*)"/g, (_match, escaped, single, double) => {
    if (escaped !== undefined) return escaped
    if (single !== undefined) return single
    return double.replace(/\\([\\"$`])/g, '$1')
  })
}

function wordToken(raw) {
  const bare = unquoted(raw)
  return { kind: 'word', value: literalWord(raw), opaque: /[$`]/.test(bare), assignment: /^[A-Za-z_]\w*=/.test(raw) }
}

function classify(match) {
  const raw = match[0]
  if (/^(?:[ \t\r]|\\\n|#)/.test(raw)) return null
  if (match.groups.heredoc !== undefined) return { kind: 'unsupported' }
  if (match.groups.redirect !== undefined) return { kind: 'redirect' }
  if (/^(?:&&|\|\||[;&|()\n])$/.test(raw)) return { kind: 'operator', value: raw }
  return wordToken(raw)
}

function shellTokens(command) {
  const tokens = []
  TOKEN.lastIndex = 0
  while (TOKEN.lastIndex < command.length) {
    const match = TOKEN.exec(command)
    if (!match) return []
    const token = classify(match)
    if (token?.kind === 'unsupported') return []
    if (token) tokens.push(token)
  }
  return tokens
}

// `env` reads its own NAME=value arguments after quote removal; the shell reads only unquoted ones.
const isEnvAssignment = (word) => !word.opaque && /^[A-Za-z_]\w*=/.test(word.value)

function nodeScript(words) {
  let index = 0
  const wrapper = words[0] && !words[0].opaque && !words[0].value.endsWith('/') && basename(words[0].value) === 'env'
  if (wrapper) index++
  while (words[index]?.assignment || (wrapper && words[index] && isEnvAssignment(words[index]))) index++
  const executable = words[index]
  const script = words[index + 1]
  if (!executable || executable.opaque || executable.value.endsWith('/')) return null
  if (!['node', 'node.exe'].includes(basename(executable.value))) return null
  return script && !script.opaque && isAbsolute(script.value) && script.value.endsWith('.mjs') ? script.value : null
}

function nextCondition(operator, conditional, groups) {
  if (operator === '(') { groups.push(conditional); return conditional }
  if (operator === ')') return groups.pop() ?? false
  if (operator === '||') return true
  if ([';', '\n', '&'].includes(operator)) return groups.at(-1) ?? false
  return conditional
}

function balanced(tokens) {
  let depth = 0
  for (const { kind, value } of tokens) {
    if (kind !== 'operator') continue
    if (value === '(') depth++
    if (value === ')') depth--
    if (depth < 0) return false
  }
  return depth === 0
}

export function settingsHookScripts(command) {
  const tokens = shellTokens(command)
  if (!balanced(tokens)) return []
  const scripts = []
  const groups = []
  let words = [], conditional = false, redirected = false
  for (const token of [...tokens, { kind: 'operator', value: '\n' }]) {
    if (token.kind === 'redirect') { redirected = true; continue }
    if (token.kind === 'word') {
      if (!redirected) words.push(token)
      redirected = false
      continue
    }
    if (redirected) return []
    const script = !conditional && nodeScript(words)
    if (script) scripts.push(script)
    words = []
    redirected = false
    conditional = nextCondition(token.value, conditional, groups)
  }
  return scripts
}
