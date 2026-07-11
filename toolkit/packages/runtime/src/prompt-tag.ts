// prompt-tag.ts — the machine-readable prompt tag: a single HTML-comment marker
// line prefixed to an agent prompt, carrying the call's `label` and `phase`.
//
// WHY: mid-run, an attached (Path A) workflow run has label/phase on disk
// NOWHERE — the journal's started/result lines are opaque hashes and the meta
// sidecar only has agentType. The agent's transcript, however, records THE
// PROMPT verbatim at spawn time — and the prompt is ours to write. Tagging it
// gives observers (the observe-ui ingest tails those transcripts live) a way
// to assign each agent to its phase column and show its real label from the
// moment it spawns, instead of parking every agent in a "(pending assignment)"
// bucket until the terminal journal appears at completion.
//
// FORMAT: one line, at the very start of the prompt —
//   <!-- wt-meta label="score:0" phase="Rank" -->
// An HTML comment renders as nothing in markdown and models treat it as
// metadata, which minimizes the risk of agents echoing it back. Values are
// entity-escaped so a hostile label can neither break the attribute quoting
// nor close the comment early ('>' is escaped, so '-->' cannot appear).
//
// This module is the SINGLE SOURCE OF TRUTH for the format: the emit side
// (withPromptTags, applied by defineWorkflow) and the parse side (the observe
// ingest) both import from here.
//
// SANDBOX-PURE: no Node APIs, no non-determinism — this file is bundled into
// workflow artifacts via defineWorkflow.

import type { AgentFn, AgentOptions, WorkflowRuntime } from './types.js'

/** Every tag starts with exactly this string — the grep/startsWith contract. */
export const PROMPT_TAG_PREFIX = '<!-- wt-meta '

/** The fields a prompt tag carries. Both optional; a tag with neither is not
 *  emitted. `| undefined` is explicit so callers under exactOptionalPropertyTypes
 *  can pass a maybe-absent value straight through (withPromptTags does). */
export interface PromptTagFields {
  label?: string | undefined
  phase?: string | undefined
}

// '&' first on escape (so escaped sequences survive), last on unescape.
function escapeValue(v: string): string {
  return v
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\n', '&#10;')
}

function unescapeValue(v: string): string {
  return v
    .replaceAll('&#10;', '\n')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
}

/** Build the one-line tag, or null when neither field is set. */
export function buildPromptTag(fields: PromptTagFields): string | null {
  const parts: string[] = []
  if (fields.label !== undefined) parts.push(`label="${escapeValue(fields.label)}"`)
  if (fields.phase !== undefined) parts.push(`phase="${escapeValue(fields.phase)}"`)
  if (parts.length === 0) return null
  return `${PROMPT_TAG_PREFIX}${parts.join(' ')} -->`
}

// Anchored to the start of the text; the tag never spans lines (values are
// escaped), so [^\n]*? keeps a malformed multi-line comment from matching.
const TAG_RE = /^<!-- wt-meta ([^\n]*?) -->/
const ATTR_RE = /(label|phase)="([^"]*)"/g

/** Parse a tag at the very start of `text` (an agent prompt / a transcript's
 *  first user message). Returns the decoded fields, or null when the text does
 *  not start with a well-formed wt-meta tag carrying at least one field. */
export function parsePromptTag(text: string): PromptTagFields | null {
  const m = TAG_RE.exec(text)
  if (m === null) return null
  const out: PromptTagFields = {}
  for (const attr of m[1]!.matchAll(ATTR_RE)) {
    if (attr[1] === 'label') out.label = unescapeValue(attr[2]!)
    else out.phase = unescapeValue(attr[2]!)
  }
  return out.label !== undefined || out.phase !== undefined ? out : null
}

/** Return a WorkflowRuntime whose agent() prefixes each prompt with the tag
 *  derived from the call's `label`/`phase` opts. When `opts.phase` is absent,
 *  the last `phase(title)` seen through THIS wrapper is used — mirroring the
 *  sandbox's own "agents group under the current phase" semantics. Calls with
 *  neither field, and prompts already tagged (re-wrap), pass through untouched.
 *
 *  Applied automatically by defineWorkflow, so patterns and plain rt.agent()
 *  compositions get tagging for free. Member forwarding uses arrow wrappers,
 *  never spread or .bind — see withAgentDefaults for why (host-provided
 *  runtime members lose `this`/`.bind` in the real sandbox). */
export function withPromptTags(rt: WorkflowRuntime): WorkflowRuntime {
  let currentPhase: string | undefined
  const agent: AgentFn = <T = string>(prompt: string, opts?: AgentOptions): Promise<T | null> => {
    const tag = buildPromptTag({ label: opts?.label, phase: opts?.phase ?? currentPhase })
    // Skip ONLY when the prompt already starts with the EXACT tag this call
    // would emit (the re-wrap case). A merely tag-shaped prefix — e.g. hostile
    // upstream content pasted at the front of the prompt — does NOT suppress
    // tagging: our tag is prepended above it, so the ingest side (which reads
    // the FIRST line only) always sees the wrapper's own truth, never a spoof.
    const tagged = tag !== null && !prompt.startsWith(tag)
      ? `${tag}\n\n${prompt}`
      : prompt
    return rt.agent<T>(tagged, opts)
  }
  return {
    agent,
    parallel: rt.parallel,
    pipeline: rt.pipeline,
    phase: (title: string): void => {
      currentPhase = title
      rt.phase(title)
    },
    log: (message: string): void => rt.log(message),
    budget: rt.budget,
    workflow: rt.workflow,
  }
}
