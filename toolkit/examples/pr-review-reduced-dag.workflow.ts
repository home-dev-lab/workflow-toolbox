import { defineWorkflow } from '@workflow-toolbox/build/define'
import type { WorkflowRuntime, JsonSchema, ModelAlias, EffortAlias } from '@workflow-toolbox/runtime'
import { collectTrail, dagExecute, makeRecord, reducedLenses } from '@workflow-toolbox/patterns'
import type { DagNode, TrailRecord } from '@workflow-toolbox/patterns'
import type { FromSchema } from 'json-schema-to-ts'

const CHEAP_MODEL: ModelAlias = 'haiku'
const CHEAP_EFFORT: EffortAlias = 'low'

const CATEGORY_LENSES = {
  bugfix: ['root-cause', 'regression-risk', 'test-coverage', 'maintainability'],
  feature: ['correctness', 'security', 'api-design', 'maintainability'],
  refactor: ['behavioral-equivalence', 'test-coverage', 'readability', 'maintainability'],
  config: ['correctness', 'security', 'blast-radius', 'maintainability'],
  docs: ['accuracy', 'completeness', 'clarity'],
} as const satisfies Record<string, readonly string[]>

type ReviewCategory = keyof typeof CATEGORY_LENSES

interface PrReviewReducedDagInput {
  target: string
  category: ReviewCategory
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1 },
          file: { type: 'string', minLength: 1 },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          detail: { type: 'string', minLength: 1 },
        },
        required: ['title', 'file', 'severity', 'detail'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const satisfies JsonSchema

type FindingsOutput = FromSchema<typeof FINDINGS_SCHEMA>

type ReducedFinding = FindingsOutput['findings'][number] & {
  findingId: string
  lens: string
}

const VERIFIER_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          findingId: { type: 'string', minLength: 1 },
          verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unverifiable'] },
          citation: {
            type: 'string',
            minLength: 3,
            pattern: '^.+:[0-9]+(?:-[0-9]+)?$',
          },
          rationale: { type: 'string', minLength: 1 },
        },
        required: ['findingId', 'verdict', 'citation', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
} as const satisfies JsonSchema

type VerifierOutput = FromSchema<typeof VERIFIER_SCHEMA>

type FinalVerdict = 'approve' | 'request-changes'

interface PrReviewReducedDagOutput {
  category: ReviewCategory
  target: string
  lenses: readonly string[]
  /**
   * The lenses that actually returned findings. A lens whose agent dies contributes nothing,
   * and `lenses` alone would still advertise it — so a reader comparing this shape against the
   * full one must be able to see that a wave ran short. Equal to `lenses` on a complete run.
   */
  lensesConcluded: readonly string[]
  waves: number
  verdict: FinalVerdict
  summary: string
  findings: Array<ReducedFinding & { verifierVerdict: VerifierOutput['verdicts'][number]['verdict']; citation: string; rationale: string }>
  envelope: { trail: TrailRecord[] }
}

interface ReviewNode extends DagNode {
  kind: 'review'
  lens: string
}

interface VerifyNode extends DagNode {
  kind: 'verify'
}

type ReducedNode = ReviewNode | VerifyNode

function parseInput(raw: unknown): PrReviewReducedDagInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'pr-review-reduced-dag: input must be an object with { target, category } because the reduced shape folds classification into deterministic script logic',
    )
  }

  const obj = raw as Record<string, unknown>
  if (typeof obj['target'] !== 'string' || obj['target'].trim().length === 0) {
    throw new Error('pr-review-reduced-dag: "target" must be a non-empty string')
  }
  if (typeof obj['category'] !== 'string' || !(obj['category'] in CATEGORY_LENSES)) {
    throw new Error(
      'pr-review-reduced-dag: "category" must be one of bugfix, feature, refactor, config, docs because the reduced shape spends no agent on classification',
    )
  }

  return {
    target: obj['target'],
    category: obj['category'] as ReviewCategory,
  }
}

function targetBlock(target: string): string {
  return '```\n' + target + '\n```'
}

function reviewPrompt(input: PrReviewReducedDagInput, lens: string): string {
  return (
    `## Role\n` +
    `You are a specialized code reviewer for the \"${lens}\" lens.\n\n` +
    `## Change\n` +
    `Category: ${input.category}\n\n` +
    `**Target:**\n${targetBlock(input.target)}\n\n` +
    `## Instructions\n` +
    `- Read the actual change from first principles.\n` +
    `- Focus ONLY on the \"${lens}\" lens.\n` +
    `- Do not trust any prior summary; produce only findings you can support from the source.\n\n` +
    `## Output\n` +
    `Return { \"findings\": [{ \"title\": \"...\", \"file\": \"path\", \"severity\": \"high|medium|low\", \"detail\": \"...\" }] }`
  )
}

function interleaveFindings(findingsByLens: Readonly<Record<string, readonly ReducedFinding[]>>): ReducedFinding[] {
  const lenses = Object.keys(findingsByLens)
  const interleaved: ReducedFinding[] = []
  let index = 0
  while (true) {
    let added = false
    for (const lens of lenses) {
      const finding = findingsByLens[lens]?.[index]
      if (finding !== undefined) {
        interleaved.push(finding)
        added = true
      }
    }
    if (!added) return interleaved
    index++
  }
}

function verifierPrompt(input: PrReviewReducedDagInput, findings: readonly ReducedFinding[]): string {
  return (
    `## Role\n` +
    `You are the shared verifier for a reduced PR review.\n\n` +
    `## Change\n` +
    `Category: ${input.category}\n\n` +
    `**Target:**\n${targetBlock(input.target)}\n\n` +
    `## Required constraints\n` +
    `1. Return one verdict per finding, each anchored in a FRESH re-read of the source and cited as file:line. A verdict with no fresh citation counts as no verdict.\n` +
    `2. Do NOT reference any other finding in a verdict. No \"same as the previous one\", no \"same pattern as #2\", and no cross-finding comparisons.\n` +
    `3. The findings below are intentionally INTERLEAVED across lenses. Judge each finding independently in the order given, never as a grouped lens block.\n\n` +
    `## Findings to verify\n` +
    '```json\n' + JSON.stringify(findings, null, 2) + '\n```\n\n' +
    `## Output\n` +
    `Return { \"verdicts\": [{ \"findingId\": \"...\", \"verdict\": \"confirmed|refuted|unverifiable\", \"citation\": \"path:line\", \"rationale\": \"...\" }] }`
  )
}

function summarize(
  verdict: FinalVerdict,
  findings: PrReviewReducedDagOutput['findings'],
  lenses: readonly string[],
  lensesConcluded: readonly string[],
): string {
  const missing = lenses.filter((lens) => !lensesConcluded.includes(lens))
  // Stated FIRST and unconditionally, because an incomplete wave changes what every number
  // below it means — a count read without it is a count of the lenses that happened to survive.
  const shortfall =
    missing.length === 0 ? '' : `INCOMPLETE — ${missing.length} of ${lenses.length} lenses did not conclude (${missing.join(', ')}). `
  if (findings.length === 0) {
    return `${shortfall}No findings were returned by the reduced review lenses.`
  }
  const counts = {
    confirmed: findings.filter((finding) => finding.verifierVerdict === 'confirmed').length,
    refuted: findings.filter((finding) => finding.verifierVerdict === 'refuted').length,
    unverifiable: findings.filter((finding) => finding.verifierVerdict === 'unverifiable').length,
  }
  return `${shortfall}${verdict}: ${counts.confirmed} confirmed, ${counts.refuted} refuted, ${counts.unverifiable} unverifiable findings.`
}

async function run(rt: WorkflowRuntime, input: PrReviewReducedDagInput): Promise<PrReviewReducedDagOutput> {
  rt.phase('Classify')
  const lenses = [...reducedLenses(CATEGORY_LENSES[input.category] as readonly string[])]
  const classificationTrail = { trail: [makeRecord('prReviewReducedDag:classify', true, { decision: input.category })] }

  const reviewFindingsByLens = new Map<string, ReducedFinding[]>()
  let verifierOutput: VerifierOutput | null = null

  const reviewNodes: ReviewNode[] = lenses.map((lens) => ({
    id: `review:${lens}`,
    dependsOn: [],
    kind: 'review',
    lens,
  }))
  const verifyNode: VerifyNode = {
    id: 'verify:shared',
    dependsOn: reviewNodes.map((node) => node.id),
    kind: 'verify',
  }

  const dag = await dagExecute<ReducedNode, FindingsOutput | VerifierOutput>(rt, {
    nodes: [...reviewNodes, verifyNode],
    stageKey: 'reduced',
    run: async (node, dagRt) => {
      if (node.kind === 'review') {
        dagRt.phase('Review')
        const output = await dagRt.agent<FindingsOutput>(reviewPrompt(input, node.lens), {
          schema: FINDINGS_SCHEMA,
          label: `pr-review-reduced-dag:review:${node.lens}`,
          phase: 'Review',
          model: CHEAP_MODEL,
          effort: CHEAP_EFFORT,
        })
        // A dead lens ABSORBS its own failure instead of propagating null, and the reason is
        // structural rather than defensive. `dagExecute` skips a node whose dependency did not
        // succeed, and the shared verifier depends on ALL the review lenses — so propagating
        // null here would skip the whole verification stage and the run would yield nothing at
        // all. That is the price of fanning three lenses into ONE verifier: the shared node is
        // a single point of failure the per-finding shape does not have. Returning an empty
        // result keeps the two surviving lenses verifiable; `lensesConcluded` (below) is what
        // records that the wave ran short, and the verdict is fail-closed on it.
        if (output === null) return { findings: [] }
        reviewFindingsByLens.set(
          node.lens,
          output.findings.map((finding, index) => ({
            ...finding,
            lens: node.lens,
            findingId: `${node.lens}:${index + 1}`,
          })),
        )
        return output
      }

      dagRt.phase('Verify')
      const interleavedFindings = interleaveFindings(Object.fromEntries(reviewFindingsByLens))
      const output = await dagRt.agent<VerifierOutput>(verifierPrompt(input, interleavedFindings), {
        schema: VERIFIER_SCHEMA,
        label: 'pr-review-reduced-dag:verify',
        phase: 'Verify',
        model: CHEAP_MODEL,
        effort: CHEAP_EFFORT,
      })
      verifierOutput = output
      return output
    },
  })

  if (verifierOutput === null) {
    throw new Error('pr-review-reduced-dag: the shared verifier did not return a result')
  }
  const sharedVerifier = verifierOutput as VerifierOutput

  rt.phase('Synthesize')
  const allFindings = interleaveFindings(Object.fromEntries(reviewFindingsByLens))
  const verdictById = new Map<string, VerifierOutput['verdicts'][number]>(
    sharedVerifier.verdicts.map((verdict) => [verdict.findingId, verdict]),
  )
  const findings = allFindings.map((finding) => {
    const verifierVerdict = verdictById.get(finding.findingId)
    if (verifierVerdict === undefined) {
      throw new Error(`pr-review-reduced-dag: verifier omitted verdict for ${finding.findingId}`)
    }
    return {
      ...finding,
      verifierVerdict: verifierVerdict.verdict,
      citation: verifierVerdict.citation,
      rationale: verifierVerdict.rationale,
    }
  })

  // FAIL-CLOSED on an incomplete wave. A lens whose agent returned null produced no findings,
  // which is indistinguishable from a lens that ran and found nothing — so an "approve" here
  // would cover only the lenses that concluded while the output still advertises all of them.
  // That is the failure this reduced shape is most exposed to: it buys its saving by having
  // fewer lenses, so losing one silently costs proportionally more than in the full shape.
  const lensesConcluded = lenses.filter((lens) => reviewFindingsByLens.has(lens))
  const waveIncomplete = lensesConcluded.length < lenses.length
  const verdict: FinalVerdict =
    waveIncomplete || findings.some((finding) => finding.verifierVerdict !== 'refuted')
      ? 'request-changes'
      : 'approve'
  const synthesisTrail = { trail: [makeRecord('prReviewReducedDag:synthesize', true, { decision: verdict })] }

  return {
    category: input.category,
    target: input.target,
    lenses,
    lensesConcluded,
    waves: dag.value.waves,
    verdict,
    summary: summarize(verdict, findings, lenses, lensesConcluded),
    findings,
    envelope: { trail: collectTrail(classificationTrail, dag, synthesisTrail) },
  }
}

export default defineWorkflow({
  meta: {
    name: 'pr-review-reduced-dag',
    description:
      'Reduced PR review as a DAG: deterministic classification from input, three independent review lenses, one shared verifier, deterministic synthesis.',
    whenToUse:
      'Use when you want the reduced PR-review budgeted shape as a runnable DAG. Pass both target and category: this reduced form spends no agent on classification and no agent on synthesis.',
    phases: [
      { title: 'Classify', detail: 'Deterministic category selection from workflow input' },
      { title: 'Review', detail: 'Three reduced lenses run in one DAG wave', model: 'haiku' },
      { title: 'Verify', detail: 'One shared verifier depends on all three review lenses', model: 'haiku' },
      { title: 'Synthesize', detail: 'Deterministic verdict and summary in script logic' },
    ],
  },
  parseInput,
  run,
})
