import type { AgentOptions, JsonSchema, WorkflowRuntime } from '@workflow-toolbox/runtime'
import {
  describeSchemaConstraints,
  extractJsonObject,
  repairToSchema,
  validateAgainstSchema,
} from './structured-salvage.js'
import type { StructuredCallOutcome } from './structured-salvage.js'

type EnvelopeFailure = 'no-manifest' | 'no-answer' | 'schema' | 'lane-error'

const wrappedRuntimes = new WeakMap<WorkflowRuntime, WorkflowRuntime>()
const wrappersByRuntime = new WeakMap<WorkflowRuntime, WorkflowRuntime>()

/** True for either a plugin-scoped or bare opencode-envelope agent type. */
export function isOpenCodeEnvelopeType(agentType: string | undefined): boolean {
  return agentType?.split(':').pop() === 'opencode-envelope'
}

function envelopePrompt(prompt: string, schema: JsonSchema | undefined): string {
  const taskMarker = '--- BEGIN OPENCODE ENVELOPE TASK ---'
  if (prompt.includes(taskMarker)) return prompt
  const lines = prompt.split('\n')
  const directives = lines.filter((line) => /^OPENCODE_[A-Z0-9_]+:/.test(line))
  const task = lines.filter((line) => !/^OPENCODE_[A-Z0-9_]+:/.test(line)).join('\n').trim()
  const constraints = schema === undefined ? '' : describeSchemaConstraints(schema)
  const eachMode = directives.some((line) => /^OPENCODE_EACH_(JSON|LINES):/.test(line))
  return [
    ...directives,
    ...(directives.length > 0 ? [''] : []),
    taskMarker,
    task,
    ...(schema === undefined ? [] : ['Reply with ONLY a JSON object satisfying this schema.', ...(constraints === '' ? [] : [constraints])]),
    '--- END OPENCODE ENVELOPE TASK ---',
    '',
    '--- BEGIN OPENCODE ENVELOPE INSTRUCTIONS ---',
    eachMode
      ? 'The directives above name a task SOURCE (EACH mode): run the envelope script once on it — the script generates the tasks itself; do not write a tasks file, do not open the source — and report EVERY stdout line verbatim.'
      : 'Write ONE task with the TASK block above as its prompt, run the envelope script, and report EVERY stdout line verbatim.',
    'Never answer the task yourself. Never open the manifest or the answer file.',
    'Pass no --model flag unless an OPENCODE_MODEL line is present.',
    '--- END OPENCODE ENVELOPE INSTRUCTIONS ---',
  ].join('\n')
}

function envelopeFailure<T>(where: string, warning: string, failure: EnvelopeFailure): StructuredCallOutcome<T> {
  return { value: null, warnings: [`${where}: ${warning}`], spawns: 1, salvageAttempted: false, salvaged: false, envelopeAnswer: true, envelopeFailure: failure }
}

/** Run the envelope protocol once, exposing failures for pattern warnings. */
export async function runEnvelopeContract<T>(
  rt: WorkflowRuntime,
  prompt: string,
  opts: AgentOptions,
): Promise<StructuredCallOutcome<T>> {
  const schema = opts.schema
  const where = opts.label ?? 'agent'
  const envelopeOpts: AgentOptions = { ...opts }
  delete envelopeOpts.schema
  const raw = await unwrapEnvelopeContract(rt).agent<unknown>(envelopePrompt(prompt, schema), envelopeOpts)
  if (typeof raw !== 'string' || !/^MANIFEST:\s*.+$/m.test(raw)) {
    return envelopeFailure(where, 'opencode envelope did not run the script — final text carries no MANIFEST line', 'no-manifest')
  }
  const errorLine = /^MANIFEST:[^\r\n]*? ERROR:\s*(.+)$/m.exec(raw)
  if (errorLine !== null) {
    try {
      const reason = JSON.parse(errorLine[1]!)
      if (typeof reason === 'string') return envelopeFailure(where, `opencode envelope lane failed — ${reason}`, 'lane-error')
    } catch {
      // The malformed suffix is a protocol/schema failure below.
    }
    return envelopeFailure(where, 'opencode envelope ERROR line is not a JSON string', 'schema')
  }
  const answerLine = /^MANIFEST:[^\r\n]*? ANSWER:\s*(.+)$/m.exec(raw) ?? /^ANSWER:\s*(.+)$/m.exec(raw)
  if (answerLine === null) {
    // No schema: the caller consumes the result line itself (a multi-task batch has no single
    // answer to append — its value IS the manifest line). With a schema, a missing suffix is
    // the transport failure the caller must see.
    if (schema === undefined) return { value: raw as T, warnings: [], spawns: 1, salvageAttempted: false, salvaged: false, envelopeAnswer: true }
    return envelopeFailure(where, 'opencode envelope script ran but the ANSWER line was not reported', 'no-answer')
  }
  let answer: unknown
  try {
    answer = JSON.parse(answerLine[1]!)
  } catch {
    return envelopeFailure(where, 'opencode envelope ANSWER line is not a JSON string', 'schema')
  }
  if (typeof answer !== 'string') return envelopeFailure(where, 'opencode envelope ANSWER line is not a JSON string', 'schema')
  if (schema === undefined) return { value: answer as T, warnings: [], spawns: 1, salvageAttempted: false, salvaged: false, envelopeAnswer: true }
  const candidate = extractJsonObject(answer)
  if (candidate === undefined) return envelopeFailure(where, 'opencode envelope ANSWER payload is not a JSON object', 'schema')
  const preViolations = validateAgainstSchema(candidate, schema)
  if (preViolations.length === 0) return { value: candidate as T, warnings: [], spawns: 1, salvageAttempted: false, salvaged: false, envelopeAnswer: true }
  const { value: repaired, repairs } = repairToSchema(candidate, schema)
  const postViolations = validateAgainstSchema(repaired, schema)
  if (postViolations.length === 0) {
    return { value: repaired as T, warnings: [`${where}: opencode envelope answer repaired — ${repairs.join('; ')}`], spawns: 1, salvageAttempted: false, salvaged: false, envelopeAnswer: true }
  }
  return envelopeFailure(where, 'opencode envelope ANSWER failed schema validation — ' +
    postViolations.map((v) => `${v.path}: ${v.message}`).join('; ') +
    (repairs.length > 0 ? ` (repairs attempted: ${repairs.join('; ')})` : ''), 'schema')
}

/** Wrap envelope calls while preserving every non-envelope call byte-for-byte. */
export function withEnvelopeContract(rt: WorkflowRuntime): WorkflowRuntime {
  if (wrappedRuntimes.has(rt)) return rt
  const existing = wrappersByRuntime.get(rt)
  if (existing !== undefined) return existing
  const wrapped: WorkflowRuntime = {
    agent: async <T = string>(prompt: string, opts: AgentOptions = {}): Promise<T | null> => {
      if (!isOpenCodeEnvelopeType(opts.agentType)) return rt.agent<T>(prompt, opts)
      return (await runEnvelopeContract<T>(rt, prompt, opts)).value
    },
    parallel: <T>(thunks: ReadonlyArray<() => Promise<T>>) => rt.parallel<T>(thunks),
    pipeline: (...args: Parameters<WorkflowRuntime['pipeline']>) => rt.pipeline(...args),
    phase: (title) => rt.phase(title),
    log: (message) => rt.log(message),
    budget: rt.budget,
    workflow: rt.workflow,
  }
  wrappedRuntimes.set(wrapped, rt)
  wrappersByRuntime.set(rt, wrapped)
  return wrapped
}

function unwrapEnvelopeContract(rt: WorkflowRuntime): WorkflowRuntime {
  return wrappedRuntimes.get(rt) ?? rt
}
