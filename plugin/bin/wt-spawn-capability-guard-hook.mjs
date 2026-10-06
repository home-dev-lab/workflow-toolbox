#!/usr/bin/env node
// wt-spawn-capability-guard-hook.mjs — a PreToolUse guard on the Agent tool: refuse a spawn whose
// BRIEF asks the agent to write a file when its agent TYPE has no Write tool.
//
// WHY IT EXISTS. An agent type declares its tools in frontmatter (`tools: Read, Grep, Glob`).
// Brief such a type with "write your report to <path>" and three things happen, in this order:
// it does the work; it cannot write; and it ends its turn saying REPORT WRITTEN. Every signal
// says success. The file is not there. The work survives only inside the agent's transcript,
// and recovering it costs another agent and another pass.
//
// The failure is SILENT and EXPENSIVE, and it is not a knowledge problem: it has been recorded
// in a rule and in a memory note, and it still recurred — twice, ~120k tokens each. A written
// instruction does not fire at the moment of the gesture. A hook does.
//
// WHAT IT CHECKS. Resolve the spawned type's definition, read its `tools:` allowlist, and deny
// only when BOTH hold:
//   1. the type declares an allowlist that does NOT include Write, and
//   2. the prompt asks for a file to be produced at a path.
// A type with no `tools:` line inherits everything — allowed, nothing to say.
//
// WHY DENY RATHER THAN WARN. The two costs are wildly asymmetric. A false deny costs one
// re-brief, immediately, with the reason printed. A false allow costs the whole delegated arc
// and looks like success while doing it. So this guard is biased toward refusing, and it says
// exactly how to fix the brief.
// Clean prohibitions and noun uses of "output" get an advisory instead: the classifier is
// deliberately conservative, and every suppression stays visible and journaled.
//
// WHY IT DOES NOT GUARD OTHER TOOLS. Bash, Edit and the rest have the same failure shape, but a
// brief mentions commands and files constantly for reasons other than "you must run/write this",
// so pattern-matching them would deny legitimate spawns. Write is the one measured repeatedly,
// and the file-report contract makes its intent unambiguous. One concern per guard.
//
// Any internal error → fail open with one stderr trace. A guard that breaks spawns because of its
// own bug is worse than the gap it closes.

import fs from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { guardMode, recordGuardEvent } from './lib/guard-journal.mjs'
import { resolveAgentTypeTools } from './lib/agent-type-tools.mjs'

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** Does the brief ask the agent to PRODUCE a file? Deliberately narrow: an imperative write verb
 *  bound to a path or to the report contract. Mentioning a path is not enough — briefs name paths
 *  to READ all the time, and denying those would make the guard the nuisance it exists to prevent. */
const FR_ECRIRE_ENDINGS = 're|ras?|rez|rons|ront|rai[st]?|rait|riez|rions|vez|vons|vent|ve|ves|vi[eo]ns|[st]'
const WRITE_INTENT = [
  ['write-to-path', /\bwrite\b[^.\n]{0,60}\b(?:to|into|at)\b[^.\n]{0,20}[/~][\w./-]+/i],
  ['write-report-to', /\bwrite\b[^.\n]{0,40}\b(?:report|findings|results?|output|proposal|file)\b[^.\n]{0,40}\bto\b/i],
  ['report-written', /\bREPORT WRITTEN\b/],
  ['save-to-path', /\b(?:save|persist|emit|output)\b[^.\n]{0,40}\bto\b[^.\n]{0,20}[/~][\w./-]+/i],
  // French — briefs on this machine are frequently written in French.
  // ⚠ No `\b` before an accented letter: JS word boundaries are built on ASCII \w, so `\bé`
  // does not mean what it looks like. And accents get dropped in practice, so match both forms.
  // A pattern that can never fire is worse than no pattern: it looks like coverage.
  // The verb covers the imperative, infinitive, future and subjunctive (écris, écrire, écriras, écrives,
  // écrivez) and must end there, so "écrivains" is not the verb. The preposition must start a word, or
  // "méta (…" or "data in" would read as the preposition "a".
  ['fr-ecris-dans', new RegExp(
    `(?:^|[^\\p{L}])[ée]cri(?:${FR_ECRIRE_ENDINGS})(?!\\p{L})[^.\\n]{0,60}[^\\p{L}](?:dans|vers|à|a)\\s[^.\\n]{0,20}[/~][\\w./-]+`, 'iu')],
  ['fr-depose', /(?:^|[^\p{L}])(?:enregistre|sauvegarde|d[ée]pose|r[ée]dige)[^.\n]{0,60}[/~][\w./-]+/iu],
]

const NEGATION_CUES = new Set(['not', 'never', 'dont', 'cannot'])
const REVERSALS = new Set(['why', 'if', 'unless', 'whether', 'pourquoi', 'si', 'ne', "n'"])
const CONTINUATIONS = new Set([
  'but', 'only', 'just', 'until', 'unless', 'instead', 'rather', 'except', 'then', 'first', 'yet',
  'mais', 'seulement', 'que', 'sauf', 'avant', 'jusqu', 'puis', 'plutôt', 'plutot',
])
const OUTPUT_INTRODUCERS = new Set([
  'and', 'then', 'please', 'also', 'so', 'finally', 'must', 'should', 'shall', 'will', 'can', 'to', 'now', 'just',
  'do', 'does', 'did', 'would', 'could', 'might', 'may',
])
const SUPPRESSION_CLASSES = { negated: 'negated-write', noun: 'noun-output' }

function normaliseContext(text) {
  return text.replace(/[*_]/g, '').replace(/’/g, "'").toLowerCase()
}

function contextWords(text) {
  return text.match(/[\p{L}]+(?:'[\p{L}]*)?/gu) ?? []
}

function isNegationCue(word) {
  return NEGATION_CUES.has(word) || word.endsWith("n't")
}

function hasReversal(text) {
  return contextWords(normaliseContext(text)).some((word) =>
    isNegationCue(word) || REVERSALS.has(word) || word.startsWith("n'"))
}

// Context read around one candidate is bounded, so a long unbroken clause stays linear. A reversal or
// continuation further away than this is missed, which costs an advisory, never a silent spawn.
const CONTEXT_WINDOW = 240

function clauseContext(prompt, start, headEnd, boundaries, cursor) {
  // Each pattern visits candidates in order, so its cursors only move forwards.
  while (boundaries.clause[cursor.clause] < start) cursor.clause++
  while (boundaries.sentence[cursor.sentence] < headEnd) cursor.sentence++
  const left = Math.max(boundaries.clause[cursor.clause - 1] + 1, start - CONTEXT_WINDOW)
  // A continuation ("instead", "rather") after a colon or semicolon still qualifies the same
  // instruction, so the forward window runs to the end of the SENTENCE, not of the clause.
  const right = Math.min(boundaries.sentence[cursor.sentence], headEnd + CONTEXT_WINDOW)
  return { before: prompt.slice(left, start), after: prompt.slice(headEnd, right) }
}

function boundaryIndexes(prompt, expression) {
  return [-1, ...Array.from(prompt.matchAll(expression), (match) => match.index), prompt.length]
}

function adjacentNegation(before, after, french) {
  if (french) {
    const frame = before.match(/(?:^|[^\p{L}\p{N}'’])(?:n['’][*_]*|ne[*_]*[ \t]+[*_]*)$/iu)
    if (!frame || !/^[ \t]+(?:pas|jamais|plus|rien)\b/.test(normaliseContext(after))) return null
    return before.slice(0, frame.index)
  }
  const prefix = before.replace(/[*_]+$/, '')
  if (!/[ \t]$/.test(prefix)) return null
  const cue = prefix.split(/[ \t]+/).at(-2)
  if (!cue || !isNegationCue(normaliseContext(cue))) return null
  return prefix.slice(0, prefix.lastIndexOf(cue))
}

// A French infinitive carries its negation BEFORE the verb ("ne pas écrire", "sans écrire",
// "il est interdit d'écrire"), which the post-verb frame above cannot see. The prohibition must
// govern the verb directly: it ends right before the infinitive. A double negative ("n'oublie pas
// d'écrire") never ends that way, and a negation or reversal earlier in the same comma segment
// ("tu ne peux pas ne pas", "pourquoi ne pas") cancels it. Paths are blanked before any word test,
// so "/tmp/avant" is not the word "avant".
const FR_INFINITIVE = /^(?:[ée]crire|enregistrer|sauvegarder|d[ée]poser|r[ée]diger)$/iu
const FR_MODAL = '(?:dois|doit|devez|devras|devrez|devrais|devrait|devait|doivent|peux|peut|pouvez|pouvait|pourrait|pourras|pourra|peuvent|faut|faudra|faudrait|vas|va|allez)'
const FR_INFINITIVE_FRAME = new RegExp(
  `(?:^|[^\\p{L}])(?:(?:ne\\s+|n')(?:${FR_MODAL}\\s+)?(?:surtout\\s+)?(?:pas|jamais|plus)(?:\\s+surtout)?` +
    `|sans(?:\\s+(?:rien|jamais))?|(?:pas\\s+besoin|inutile|interdit|d[ée]fense|[ée]vite[rz]?)\\s+d(?:e\\s+|'))\\s*$`,
  'u',
)
const FR_EARLIER_CANCEL = /(?:^|[^\p{L}])(?:(?:ne|pas|jamais|sans|non|pourquoi|si)(?!\p{L})|n')/u
const FR_RESTRICTION = /(?:^|[^\p{L}])(?:(?:mais|seulement|uniquement|que|sauf|plut[ôo]t|avant|jusqu|sinon)(?!\p{L})|qu')/u
const FR_CORRECTION_START = /^\s*(?:mais|plut[ôo]t|uniquement|seulement|sauf|sinon)(?!\p{L})/u

function frenchWords(text) {
  return normaliseContext(text).replace(/[/~][\w./-]+/g, ' ')
}

function isFrenchInfinitiveProhibition(candidate, context) {
  if (candidate.phrase.includes(',')) return false
  const before = frenchWords(context.before)
  const frame = before.match(FR_INFINITIVE_FRAME)
  if (!frame || FR_EARLIER_CANCEL.test(before.slice(0, frame.index).split(',').at(-1))) return false
  const [here, next = ''] = frenchWords(context.after).split(',')
  return !FR_RESTRICTION.test(here) && !FR_CORRECTION_START.test(next)
}

function isCleanProhibition(candidate, context) {
  if (candidate.pattern === 'report-written') return false
  // The destination must stay in the prohibited clause, not in a correction after it.
  if (/[;:!?]|\.(?=\s)/.test(candidate.phrase)) return false
  if (FR_INFINITIVE.test(candidate.head)) return isFrenchInfinitiveProhibition(candidate, context)
  const { before, after } = context
  const earlier = adjacentNegation(before, after, candidate.pattern.startsWith('fr-'))
  if (earlier === null || hasReversal(earlier)) return false
  return !contextWords(normaliseContext(after)).some((word) => CONTINUATIONS.has(word.split("'")[0]))
}

function isNounOutput(candidate, context) {
  if (candidate.head.toLowerCase() !== 'output') return false
  const before = normaliseContext(context.before)
  if (/^\s*$/.test(before) || /[.!?;:,\n][ \t]*$/.test(before)) return false
  if (/(?:^|\n)[ \t]*(?:[-+•]|\d+[.)])[ \t]*$/.test(before)) return false
  const token = before.trimEnd().split(/\s+/).at(-1)
  return !isNegationCue(token) && !OUTPUT_INTRODUCERS.has(token)
}

function preferCandidate(current, candidate) {
  if (!current || candidate.start < current.start) return candidate
  if (candidate.start === current.start && candidate.phrase.length > current.phrase.length) return candidate
  return current // equal position and length: keep pattern order
}

function writeCandidate(match, pattern) {
  const leading = pattern.startsWith('fr-') ? match[0].match(/^[^\p{L}]/u)?.[0] : ''
  const delimiter = leading?.length ?? 0
  const phrase = match[0].slice(delimiter)
  const start = match.index + delimiter
  const head = phrase.match(/^\p{L}+/u)[0]
  return { pattern, phrase, start, head, headEnd: start + head.length }
}

function candidateSuppression(prompt, candidate, boundaries, cursor) {
  const context = clauseContext(prompt, candidate.start, candidate.headEnd, boundaries, cursor)
  if (isCleanProhibition(candidate, context)) return 'negated'
  if (isNounOutput(candidate, context)) return 'noun'
  return null
}

function findWriteIntent(rawPrompt) {
  // A decomposed accent (e + U+0301) must read as the same verb as the composed one.
  const prompt = rawPrompt.normalize('NFC')
  let surviving = null
  let suppressed = null
  // Enumerate once; a filename's internal dot is not a clause boundary.
  const boundaries = {
    clause: boundaryIndexes(prompt, /[!?;:\n]|\.(?=\s|$)/g),
    sentence: boundaryIndexes(prompt, /[!?\n]|\.(?=\s|$)/g),
  }
  for (const [pattern, expression] of WRITE_INTENT) {
    const scanner = new RegExp(expression.source, `${expression.flags}g`)
    const cursor = { clause: 0, sentence: 0 }
    let match
    while ((match = scanner.exec(prompt)) !== null) {
      const candidate = writeCandidate(match, pattern)
      const suppression = candidateSuppression(prompt, candidate, boundaries, cursor)
      if (suppression) {
        suppressed = preferCandidate(suppressed, { ...candidate, suppression })
        // A greedy span can contain another instruction: consume only this candidate's head.
        scanner.lastIndex = candidate.headEnd
      } else {
        surviving = preferCandidate(surviving, candidate)
      }
    }
  }
  return surviving ?? suppressed
}

function emitWriteDecision(input, type, tools, intent) {
  const { pattern, phrase, suppression } = intent
  const reason = `agent type "${type}" has no Write tool; matched: "${phrase}"`
  recordGuardEvent({
    guard: 'wt-spawn-capability-guard-hook.mjs',
    decision: suppression ? 'warned' : 'blocked',
    session: input.session_id,
    agent: input.agent_id,
    class: suppression ? SUPPRESSION_CLASSES[suppression] : 'no-write-tool',
    evidence: { pattern, phrase },
    reason,
  })
  if (suppression && guardMode() === 'observe') return
  const output = { hookEventName: 'PreToolUse' }
  if (suppression) {
    output.additionalContext = `[workflow-toolbox spawn-capability] ADVISORY: agent type "${type}" has no Write tool; ` +
      `"${phrase}" was read as not a write request (${suppression}). If a file is required, spawn a type with Write ` +
      `or require the report in the agent's final message.`
  } else {
    output.permissionDecision = 'deny'
    output.permissionDecisionReason =
      `[workflow-toolbox spawn-capability] Refused: agent type "${type}" declares ` +
      `tools: ${tools.join(', ')} — it has NO Write tool, and this brief asks it to write a ` +
      `file. Matched: "${phrase}". It would do the work, fail to write, and still end its turn reporting success; ` +
      `the output would survive only in its transcript. Fix the brief, not the agent: ` +
      `either spawn a type that has Write, or require the report to BE the agent's final ` +
      `message (and say "your last output IS the deliverable — do not summarise after it", ` +
      `because only the last message is routed back).`
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: output }))
}

function main() {
  const input = readInput()
  if (input.tool_name !== 'Agent') return

  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}
  const type = typeof ti.subagent_type === 'string' ? ti.subagent_type.trim() : ''
  const prompt = typeof ti.prompt === 'string' ? ti.prompt : ''
  if (!type || !prompt) return

  const resolved = resolveAgentTypeTools(type, typeof input.cwd === 'string' ? input.cwd : '')
  if (resolved.unresolved) {
    recordGuardEvent({ guard: 'wt-spawn-capability-guard-hook.mjs', decision: 'warned', class: 'unresolved', reason: resolved.unresolved, session: input.session_id, agent: input.agent_id })
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `[workflow-toolbox spawn-capability] Definition unresolved for ${type}: ${resolved.unresolved}` } }))
    return
  }
  if (!resolved.resolved) return
  const { tools } = resolved
  if (!tools) return // inherits everything

  const hasWrite = tools.some((t) => t === 'Write' || t === '*')
  if (hasWrite) return
  const intent = findWriteIntent(prompt)
  if (intent) emitWriteDecision(input, type, tools, intent)
}

runFailOpenHook('wt-spawn-capability-guard-hook.mjs', main)
