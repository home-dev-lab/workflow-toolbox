// readonly-brief-scope.mjs: does a brief put the AGENT itself under a read-only boundary?
//
// "read-only" often labels a RESOURCE the brief names ("Knowledge base (read-only): <path>") while the agent
// itself writes. Warning on those labels makes the read-only guard noise. This module keeps the guard's
// trigger words and drops only the occurrences that qualify a resource, unless the brief also carries an
// agent-wide prohibition. String matching only: a CRLF brief reads the same as an LF one.

const TRIGGER = /\b(read-only|do not modify|investigate only)\b/gi
// A noun or a path-like token that a label can sit on (see endsInResource).
const RESOURCE_WORDS = new Set([
  'index', 'base', 'store', 'memory', 'input', 'inputs', 'source', 'sources', 'record', 'board', 'tree',
  'checkout', 'copy', 'copies', 'file', 'files', 'dir', 'directory', 'path',
])
const LABEL_BEFORE = /(?:\(\s*|,\s*|\s)$/
const LABEL_AFTER = /^\s*(?:\)|;|:|,\s*(?:open|main|lessons))/i
const TASK_NOUN = /\b(?:review|verification|pass|check|research|investigation|audit|triage|forensics|survey|analysis|probe|harvest|grounding|query)\s*$/i
const COPULA_BEFORE = /(?:^|[^a-z])(?!(?:you|task|job|role|work|mandate)\b)[a-z][\w-]*\s+(?:is|are)\s+(?:a\s+)?$/i
const COPULA_AGENT_AFTER = /^\s*(?:on everything|everywhere|except|too\b)/i
const FOR_YOU_AFTER = /^\s*(?:\)\s*)?for you\b/i
// An agent-wide prohibition, one small expression per phrasing (each keeps its own word boundaries).
const AGENT_PROHIBITIONS = [
  /\b(?:no writes|write nothing|change nothing|modify nothing|touch nothing|you cannot write)\b/i,
  /\bno (?:repo(?:sitory)?|file|git) (?:edits|writes|changes)\b/i,
  /\b(?:do not|must not|never) (?:edit|write|change|modify|apply|touch) (?:any|anything|the (?:worktree|repo|repository|code))\b/i,
  /\bnothing you run may write\b/i,
]
const QUOTED = /```[\s\S]*?```|["'][^"'\n]*["']/g

// Text up to its last character that is not '(' , ',' or whitespace.
function trimTail(text) {
  let end = text.length
  while (end > 0 && /[(,\s]/.test(text[end - 1])) end--
  return text.slice(0, end)
}

// The maximal run of characters at the end of the text that satisfy `test`.
function trailingRun(text, test) {
  let start = text.length
  while (start > 0 && test.test(text[start - 1])) start--
  return start
}

function endsInResourceWord(text) {
  return RESOURCE_WORDS.has(text.slice(trailingRun(text, /[a-z]/i)).toLowerCase())
}

// "~" or "/" followed by path characters and ending on a word character.
function endsInPath(text) {
  if (!/\w$/.test(text)) return false
  const start = trailingRun(text, /[\w./-]/)
  return /\//.test(text.slice(start)) || text[start - 1] === '~'
}

// A dot and one to five word characters at the very end (".md", ".json").
function endsInExtension(text) {
  const tail = text.slice(text.lastIndexOf('.') + 1)
  return text.includes('.') && tail.length >= 1 && tail.length <= 5 && trailingRun(tail, /\w/) === 0
}

// A resource noun, a path or a file extension, optionally inside one closing backtick and trailing spaces.
function endsInResource(text) {
  let end = text.length
  while (end > 0 && /\s/.test(text[end - 1])) end--
  if (text[end - 1] === '`') end--
  const head = text.slice(0, end)
  return endsInResourceWord(head) || endsInPath(head) || endsInExtension(head)
}

// A label that opens a parenthesis may run on inside it ("(read-only source of truth)", "(read-only, diff
// saved)"), but only when the thing it labels is a resource noun or a path: "Research question (read-only,
// cite sources)" labels the agent's own task.
const PAREN_OPEN = /\(\s*$/
const PAREN_CONTINUES = /^\s*(?:[,;]|[^()]{0,40}\))/
const WORKSPACE_NOUN = /(?:^|[^a-z])(?:plugin|worktree|repo(?:sitory)?|source|snapshot)\s*$/i

function isLabelPosition(before, after) {
  if (LABEL_AFTER.test(after) && LABEL_BEFORE.test(before)) return true
  if (!PAREN_OPEN.test(before) || !PAREN_CONTINUES.test(after)) return false
  const noun = trimTail(before)
  return endsInResource(noun) || WORKSPACE_NOUN.test(noun)
}

// The label sits on the text just before it: a task noun before a parenthesis names the agent's task,
// anything else must end in a resource noun or a path.
function labelsResource(before) {
  const noun = trimTail(before)
  if (/\w\s*\(\s*$/.test(before)) return !TASK_NOUN.test(noun)
  return endsInResource(noun)
}

function qualifiesResource(prompt, hit) {
  if (hit[0].toLowerCase() !== 'read-only') return false
  const lineStart = prompt.lastIndexOf('\n', hit.index) + 1
  const before = prompt.slice(Math.max(lineStart, hit.index - 80), hit.index)
  const after = prompt.slice(hit.index + hit[0].length, hit.index + hit[0].length + 40)
  if (FOR_YOU_AFTER.test(after)) return true
  if (COPULA_BEFORE.test(before) && !COPULA_AGENT_AFTER.test(after)) return true
  return isLabelPosition(before, after) && labelsResource(before)
}

/** True when the brief scopes the agent itself read-only (any trigger that is not a resource label, or an
 *  agent-wide prohibition); false when every trigger only labels a resource. */
export function briefScopesAgentReadOnly(rawPrompt) {
  const prompt = rawPrompt.replace(QUOTED, ' ')
  const hits = [...prompt.matchAll(TRIGGER)]
  if (!hits.length) return false
  if (hits.some((hit) => !qualifiesResource(prompt, hit))) return true
  return AGENT_PROHIBITIONS.some((expression) => expression.test(prompt))
}
