// spawn-brief-intent.mjs — precision predicates for the spawn-capability guard. Each one answers
// "does this brief or this type already provide a route for the deliverable?". Only the Bash one
// (a capability of the type) changes a decision; the two wording predicates feed the shadow field. String matching only: no path separator, platform
// or line-ending assumption beyond what each expression states.

const FINAL = '(?:final (?:message|response|answer)|last message)'
// A mention of the final message routes the deliverable only when the final message CARRIES it: a verb
// that puts the report there, and no "one line / REPORT WRITTEN / the path" status right after it
// (that is the normal file-report contract, where the report sits in the file).
const CARRIER = '(?:(?:put|return|make|give|include|deliver|write|send|provide|place|output)\\b[^.\\n]{0,60}' +
  `\\b(?:in|as|to|into)\\s+(?:your\\s+)?${FINAL}(?![^.\\n]{0,40}(?:one line|a single line|REPORT WRITTEN|the path))` +
  `|make\\s+your\\s+${FINAL}\\s+the\\s+(?:full |complete |whole )?(?:report|review|critique|deliverable))`
// An inability counts only when it is about writing: a type unable to modify code or finish still owes the file.
const INABILITY = '(?:cannot|can\'t|can not|have no|lack|may lack|do not have|don\'t have)(?:\\s+(?:a|the|any))?\\s+(?:write|files?)'

const FINAL_IS = '(?:final|last) (?:message|response|answer) (?:is|must be|will be)'
const DELIVERABLE = '(?:the |your )?(?:full |complete |whole )?(?:report|review|critique|deliverable|verdict list)'

// Semantic shapes of "the final message carries the deliverable", not an alternation fitted to cases.
const FINAL_MESSAGE_ROUTES = [
  // (a) a stated or conditional inability, then the route
  new RegExp(`\\b(?:(?:if|when)\\s+)?you\\s+${INABILITY}\\b[^.\\n]{0,80}\\b${CARRIER}`, 'i'),
  // (b) a stated inability, then the route
  new RegExp(`\\b(?:no Write tool|cannot write|can't write|not possible for you)\\b[^.\\n]{0,120}\\b${CARRIER}`, 'i'),
  // (c) "if you can write ...; otherwise ... final message"
  new RegExp(`\\bif you can write\\b[^.\\n]{0,60}\\b(?:otherwise|else|instead|so)\\b[^.\\n]{0,80}\\b${CARRIER}`, 'i'),
  // (d) the final message IS the deliverable
  new RegExp(`\\b${FINAL_IS} ${DELIVERABLE}\\b(?!\\s*(?:path|file))`, 'i'),
  // (e) the write target IS the final message
  /\bto your (?:final|last) (?:message|response)\b/i,
]

/** Indexes of the route shapes the brief matches; non-empty when it already routes the deliverable to
 *  the agent's final message. */
export function finalMessageRoutes(prompt) {
  const text = prompt.normalize('NFC')
  return FINAL_MESSAGE_ROUTES.flatMap((expression, index) => (expression.test(text) ? [index] : []))
}

// The one-call pin, in every phrasing the shipped definitions use ("exactly one Bash call",
// "exactly ONE Bash tool call", "ONE Bash call").
const SINGLE_BASH = /\b(?:exactly|only)\s+(?:one|a single)\s+Bash(?:\s+tool)?\s+(?:call|command|invocation)\b|\bONE Bash call\b/i

/** A bare `Bash` entry lets the type write through the shell unless its definition pins Bash to one
 *  command or lists Bash in disallowedTools. */
export function canWriteThroughBash(tools, body, denied) {
  if (!tools.includes('Bash')) return false
  if (denied?.some((tool) => tool === 'Bash' || tool === '*')) return false
  return !SINGLE_BASH.test(body ?? '')
}

const PATH_PATTERNS = new Set(['write-to-path', 'save-to-path', 'fr-ecris-dans', 'fr-depose'])
const WITH_EXTENSION = /^.+\.[A-Za-z0-9]{1,8}$/

/** True when the candidate's destination path has a last segment without a `name.ext`. */
export function hasNoFileExtension(candidate) {
  if (!PATH_PATTERNS.has(candidate.pattern)) return false
  const destination = candidate.phrase.split(/\s/).at(-1)
  if (!/^[/~][\w./-]*$/.test(destination)) return false
  let end = destination.length
  while (end > 0 && (destination[end - 1] === '.' || destination[end - 1] === ',')) end -= 1
  return !WITH_EXTENSION.test(destination.slice(0, end).split(/[/\\]/).at(-1))
}
