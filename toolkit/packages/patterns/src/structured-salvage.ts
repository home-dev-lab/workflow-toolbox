// structured-salvage.ts — deterministic salvage for schema-enforced agent calls.
//
// THE PROBLEM (card #1820561035728258107, lived on pr-review 2026-07-16): the
// harness's StructuredOutput retry loop is INTRA-CONVERSATION and harness-owned —
// on repeated validation failures it re-prompts the same agent up to its own
// attempt ceiling, the validator feedback never forces compliance, and after
// exhaustion the script sees a bare `null` (the sandbox agent() contract has no
// error channel). A workflow whose classify/act stage draws a long, dense target
// can lose the whole item — five identical failures, zero diagnostics.
//
// THE FIX (the surface the toolkit actually owns): when a schema-bearing call
// returns null, run ONE deterministic salvage pass —
//   1. respawn the agent WITHOUT the harness schema, with the original prompt
//      plus explicit, schema-derived constraints (field, type, exact bounds);
//   2. parse the raw answer (fences/prose tolerated), validate it against the
//      same schema with a small subset validator whose violations are SPECIFIC
//      (field path + bound + received value/length);
//   3. deterministically repair what is repairable — truncate over-maxLength
//      strings, slice over-maxItems arrays, drop unexpected properties — and
//      re-validate. Repairs are surfaced as warnings, never silent.
// Missing required properties, wrong types, and enum violations are NEVER
// fabricated — an unrepairable answer still degrades to null, but now with
// actionable diagnostics in the pattern's warnings instead of silence.
//
// Cost/safety posture: the native path is byte-identical (same prompt, same
// schema → resume-cache safe); salvage only spawns on a call that is ALREADY
// dead today, so any salvage success is a strict improvement. Repair never
// invents content, so control schemas (enums, pass/fail verdicts) stay strict.
//
// Sandbox contract: pure, deterministic, zero imports beyond runtime types —
// safe to bundle into committed workflow artifacts.

import type { WorkflowRuntime, JsonSchema, AgentOptions } from '@workflow-toolbox/runtime'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One specific schema violation: `path` is the offending field ("$.summary",
 *  "$.riskAreas[3]"), `message` names the constraint, its bound, and what was
 *  actually received — the diagnostics the harness loop never surfaces. */
export interface SchemaViolation {
  path: string
  message: string
}

/** Outcome of a schema-bearing agent call routed through the salvage wrapper. */
export interface StructuredCallOutcome<T> {
  /** The validated (possibly repaired) result, or null when both the native
   *  call and the salvage pass failed. */
  value: T | null
  /** Specific diagnostics: salvage notes, repairs applied, and — on final
   *  failure — the exact violations (field + bound + received). Empty on a
   *  clean native success. */
  warnings: string[]
  /** Agent spawns consumed: 1 for the native call, +1 when salvage fired. */
  spawns: number
  /** True when `value` came from the salvage pass rather than the native call. */
  salvaged: boolean
}

// The JsonSchema type is an open record; these are the subset keywords the
// validator/repairer understand. Unknown keywords are deliberately ignored
// (permissive subset — never claim a violation the schema didn't state).
interface SchemaNode {
  type?: string
  properties?: Record<string, SchemaNode>
  required?: readonly string[]
  additionalProperties?: boolean
  items?: SchemaNode
  enum?: readonly unknown[]
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
}

// ---------------------------------------------------------------------------
// describeSchemaConstraints() — schema → explicit prose constraints
// ---------------------------------------------------------------------------

function describeNode(node: SchemaNode): string {
  const parts: string[] = []
  if (node.enum !== undefined) {
    parts.push(`one of: ${node.enum.map((v) => JSON.stringify(v)).join(' | ')}`)
  } else if (node.type !== undefined) {
    parts.push(node.type)
  }
  if (node.minLength !== undefined && node.maxLength !== undefined) {
    parts.push(`${node.minLength}-${node.maxLength} chars`)
  } else if (node.maxLength !== undefined) {
    parts.push(`at most ${node.maxLength} chars`)
  } else if (node.minLength !== undefined) {
    parts.push(`at least ${node.minLength} chars`)
  }
  if (node.maxItems !== undefined) parts.push(`at most ${node.maxItems} items`)
  if (node.minItems !== undefined) parts.push(`at least ${node.minItems} items`)
  if (node.type === 'array' && node.items !== undefined) {
    parts.push(`each item: ${describeNode(node.items)}`)
  }
  return parts.join(', ')
}

/** Derive an explicit, per-field prose statement of a schema's constraints
 *  (names, requiredness, types, exact bounds). Exported for workflow authors
 *  who want the same statement in their PRIMARY prompts (prevention); the
 *  salvage pass embeds it automatically. Returns '' for schemas with nothing
 *  to describe. */
export function describeSchemaConstraints(schema: JsonSchema): string {
  const root = schema as SchemaNode
  if (root.type !== 'object' || root.properties === undefined) {
    const line = describeNode(root)
    return line === '' ? '' : `The answer must be: ${line}.`
  }
  const required = new Set(root.required ?? [])
  const lines = Object.entries(root.properties).map(([name, node]) => {
    const desc = describeNode(node)
    return `- "${name}" (${required.has(name) ? 'REQUIRED' : 'optional'})${desc === '' ? '' : `: ${desc}`}`
  })
  const extras =
    root.additionalProperties === false ? '\nNo other properties are allowed.' : ''
  return `The JSON object must have exactly these properties:\n${lines.join('\n')}${extras}`
}

// ---------------------------------------------------------------------------
// extractJsonObject() — tolerant JSON extraction from a raw text answer
// ---------------------------------------------------------------------------

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through — caller tries the next extraction strategy
  }
  return undefined
}

/** Extract a JSON object from a raw text answer: direct parse, then fenced
 *  ```json block, then the outermost { … } span. Undefined when no strategy
 *  yields an object (arrays and scalars are NOT accepted — every schema this
 *  wrapper serves is an object schema). */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  const direct = tryParseObject(trimmed)
  if (direct !== undefined) return direct
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  if (fence?.[1] !== undefined) {
    const fenced = tryParseObject(fence[1].trim())
    if (fenced !== undefined) return fenced
  }
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last > first) {
    return tryParseObject(trimmed.slice(first, last + 1))
  }
  return undefined
}

// ---------------------------------------------------------------------------
// validateAgainstSchema() — subset validator with SPECIFIC violations
// ---------------------------------------------------------------------------

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function validateNode(value: unknown, node: SchemaNode, path: string, out: SchemaViolation[]): void {
  if (node.enum !== undefined) {
    if (!node.enum.some((v) => v === value)) {
      out.push({
        path,
        message: `${JSON.stringify(value)} is not one of ${node.enum.map((v) => JSON.stringify(v)).join(' | ')}`,
      })
    }
    return // enum fully constrains the value; type/bound checks are redundant
  }
  const t = node.type
  if (t === undefined) return
  const actual = typeOf(value)
  if (t === 'integer' ? !(actual === 'number' && Number.isInteger(value)) : actual !== t) {
    out.push({ path, message: `expected ${t}, got ${actual}` })
    return // deeper checks are meaningless on the wrong type
  }
  if (t === 'string') {
    const s = value as string
    if (node.maxLength !== undefined && s.length > node.maxLength) {
      out.push({ path, message: `${s.length} chars exceeds maxLength ${node.maxLength}` })
    }
    if (node.minLength !== undefined && s.length < node.minLength) {
      out.push({ path, message: `${s.length} chars under minLength ${node.minLength}` })
    }
    return
  }
  if (t === 'array') {
    const arr = value as unknown[]
    if (node.maxItems !== undefined && arr.length > node.maxItems) {
      out.push({ path, message: `${arr.length} items exceeds maxItems ${node.maxItems}` })
    }
    if (node.minItems !== undefined && arr.length < node.minItems) {
      out.push({ path, message: `${arr.length} items under minItems ${node.minItems}` })
    }
    if (node.items !== undefined) {
      arr.forEach((item, i) => validateNode(item, node.items as SchemaNode, `${path}[${i}]`, out))
    }
    return
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>
    for (const req of node.required ?? []) {
      if (!(req in obj)) out.push({ path: `${path}.${req}`, message: 'required property missing' })
    }
    const props = node.properties ?? {}
    for (const [key, child] of Object.entries(props)) {
      if (key in obj) validateNode(obj[key], child, `${path}.${key}`, out)
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) {
          out.push({ path: `${path}.${key}`, message: 'unexpected property (additionalProperties: false)' })
        }
      }
    }
  }
}

/** Validate `value` against the schema subset (type / required /
 *  additionalProperties:false / enum / length / item bounds, recursively).
 *  Every violation names the field path, the constraint's exact bound, and
 *  what was received. Unknown schema keywords are ignored (permissive). */
export function validateAgainstSchema(value: unknown, schema: JsonSchema): SchemaViolation[] {
  const out: SchemaViolation[] = []
  validateNode(value, schema as SchemaNode, '$', out)
  return out
}

// ---------------------------------------------------------------------------
// repairToSchema() — deterministic repair of the REPAIRABLE violation classes
// ---------------------------------------------------------------------------

function repairNode(value: unknown, node: SchemaNode, path: string, repairs: string[]): unknown {
  if (node.type === 'string' && typeof value === 'string') {
    if (node.maxLength !== undefined && value.length > node.maxLength) {
      repairs.push(`${path}: truncated from ${value.length} to maxLength ${node.maxLength} chars`)
      return value.slice(0, node.maxLength)
    }
    return value
  }
  if (node.type === 'array' && Array.isArray(value)) {
    let arr = value
    if (node.maxItems !== undefined && arr.length > node.maxItems) {
      repairs.push(`${path}: sliced from ${arr.length} to maxItems ${node.maxItems} items`)
      arr = arr.slice(0, node.maxItems)
    }
    return node.items !== undefined
      ? arr.map((item, i) => repairNode(item, node.items as SchemaNode, `${path}[${i}]`, repairs))
      : arr
  }
  if (node.type === 'object' && typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>
    const props = node.properties ?? {}
    const result: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(obj)) {
      if (key in props) {
        result[key] = repairNode(v, props[key] as SchemaNode, `${path}.${key}`, repairs)
      } else if (node.additionalProperties === false) {
        repairs.push(`${path}.${key}: dropped unexpected property`)
      } else {
        result[key] = v
      }
    }
    return result
  }
  return value
}

/** Deterministically repair the repairable violation classes — truncate
 *  over-maxLength strings, slice over-maxItems arrays, drop unexpected
 *  properties under additionalProperties:false — and report each repair.
 *  NEVER fabricates: missing required properties, wrong types, enum and
 *  minimum-bound violations pass through untouched (they remain violations). */
export function repairToSchema(value: unknown, schema: JsonSchema): { value: unknown; repairs: string[] } {
  const repairs: string[] = []
  const repaired = repairNode(value, schema as SchemaNode, '$', repairs)
  return { value: repaired, repairs }
}

// ---------------------------------------------------------------------------
// agentWithSchemaSalvage() — the call wrapper patterns route schema calls through
// ---------------------------------------------------------------------------

function salvagePrompt(prompt: string, schema: JsonSchema): string {
  const constraints = describeSchemaConstraints(schema)
  return (
    `${prompt}\n\n` +
    `STRUCTURED-OUTPUT SALVAGE: a previous schema-enforced attempt at this exact task ` +
    `failed validation repeatedly. Answer with ONLY one JSON object — no prose, no code ` +
    `fences, no explanation before or after.` +
    (constraints === '' ? '' : `\n${constraints}`) +
    `\nNever satisfy a constraint with placeholder values ("test", "a"); shorten real ` +
    `content instead of faking it.`
  )
}

/**
 * Run an agent call, salvaging schema-validation exhaustion deterministically.
 *
 * - No `schema` in opts → plain `rt.agent()` passthrough (spawns 1, no salvage).
 * - Schema present, native call succeeds → the value, untouched (fast path;
 *   prompt and schema are byte-identical to a direct call — resume-cache safe).
 * - Native call returns null (harness retry loop exhausted) → ONE salvage
 *   respawn without the harness schema, constraints stated in prose; the raw
 *   answer is parsed, validated against the same schema, repaired where
 *   deterministically possible, and re-validated. Unrepairable → null, with
 *   the specific violations in `warnings`.
 *
 * Budget errors (`rt.agent` throws) propagate unchanged — same contract as a
 * direct call. Only the null-degrade path gains behavior.
 */
export async function agentWithSchemaSalvage<T>(
  rt: WorkflowRuntime,
  prompt: string,
  opts: AgentOptions,
): Promise<StructuredCallOutcome<T>> {
  const schema = opts.schema
  if (schema === undefined) {
    const plain = await rt.agent<T>(prompt, opts)
    return { value: plain, warnings: [], spawns: 1, salvaged: false }
  }

  const native = await rt.agent<T>(prompt, opts)
  if (native !== null) return { value: native, warnings: [], spawns: 1, salvaged: false }

  const where = opts.label ?? 'agent'
  const salvageOpts: AgentOptions = {
    ...opts,
    ...(opts.label !== undefined ? { label: `${opts.label}:salvage` } : {}),
  }
  delete salvageOpts.schema
  const raw = await rt.agent<unknown>(salvagePrompt(prompt, schema), salvageOpts)
  if (raw === null) {
    return {
      value: null,
      warnings: [`${where}: structured-output salvage respawn also returned null`],
      spawns: 2,
      salvaged: false,
    }
  }

  // A real (schema-less) harness call yields a string; a scripted test double
  // may hand the candidate object directly — accept both.
  const candidate = typeof raw === 'string' ? extractJsonObject(raw) : raw
  if (candidate === undefined) {
    const head = typeof raw === 'string' ? raw.trim().slice(0, 120) : String(raw)
    return {
      value: null,
      warnings: [`${where}: salvage output is not a JSON object (starts: ${JSON.stringify(head)})`],
      spawns: 2,
      salvaged: false,
    }
  }

  const preViolations = validateAgainstSchema(candidate, schema)
  if (preViolations.length === 0) {
    return {
      value: candidate as T,
      warnings: [`${where}: value salvaged after structured-output exhaustion (schema-less respawn)`],
      spawns: 2,
      salvaged: true,
    }
  }

  const { value: repaired, repairs } = repairToSchema(candidate, schema)
  const postViolations = validateAgainstSchema(repaired, schema)
  if (postViolations.length === 0) {
    return {
      value: repaired as T,
      warnings: [
        `${where}: value salvaged after structured-output exhaustion, with deterministic repairs — ${repairs.join('; ')}`,
      ],
      spawns: 2,
      salvaged: true,
    }
  }

  return {
    value: null,
    warnings: [
      `${where}: salvage failed schema validation — ` +
        postViolations.map((v) => `${v.path}: ${v.message}`).join('; ') +
        (repairs.length > 0 ? ` (repairs attempted: ${repairs.join('; ')})` : ''),
    ],
    spawns: 2,
    salvaged: false,
  }
}
