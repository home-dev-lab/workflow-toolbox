// dag-execute.ts — wave-based DAG executor for direct-spawn workflows.
//
// Mirrors the stable Kahn wave computation used in
// toolkit/examples/dev-implement.workflow.ts, generalized into a reusable
// package helper for any workflow author.

import type { WorkflowRuntime } from '@workflow-toolbox/runtime'
import { emitDigest, makeRecord, warn } from './envelope.js'
import type { PatternResult, PatternStats, TrailRecord } from './envelope.js'
import { claimStageInstance, stageBuilder } from './stage-instance.js'

const STAGE = 'dagExecute'

// STATS/TRAIL DEVIATION (like loopUntilDone's own documented deviation in
// loop-until-done.ts): `run()` is a CALLER callback, not an agent call this
// pattern makes directly — per envelope.ts's stated meaning, `agentsSpawned`
// is normally "agent calls spawned directly by THIS pattern (not caller
// callbacks)". dagExecute deliberately narrows that to "nodes whose run()
// actually executed" instead, because that is the unit this pattern controls
// and can count without inspecting the callback's own body (`run` may call
// rt.agent() zero, one, or many times — dagExecute has no visibility into
// that). One TrailRecord per NODE RUN, not per rt.agent() call.

/** One node in a directed acyclic graph. `dependsOn` names the ids that MUST
 *  complete successfully before this node may run. */
export interface DagNode {
  readonly id: string
  readonly dependsOn: readonly string[]
}

/** Options for one wave-based DAG execution.
 *
 *  `run()` is invoked ONLY for nodes whose dependencies all succeeded. Nodes in
 *  the same computed wave are dispatched concurrently via `rt.parallel()`, and
 *  the next wave does not start until the current one fully settles.
 *
 *  Failure convention: a node is treated as FAILED when `run()` returns `null`
 *  OR throws. This matches `parallel()`'s runtime contract: throwing thunks are
 *  converted to `null` results, so the pattern treats both forms uniformly. */
export interface DagExecuteOptions<TNode extends DagNode, TOut> {
  readonly nodes: readonly TNode[]
  readonly run: (node: TNode, rt: WorkflowRuntime) => Promise<TOut | null>
  readonly phase?: string
  readonly stageKey?: string
}

/** Outcome for one node in the input graph, preserved in the SAME order as the
 *  original `nodes` array. */
export interface DagNodeResult<TNode extends DagNode, TOut> {
  readonly node: TNode
  readonly status: 'succeeded' | 'failed' | 'skipped'
  readonly value: TOut | null
}

/** Final DAG outcome: per-node status plus how many execution waves were
 *  needed by the graph's topology. */
export interface DagExecuteResult<TNode extends DagNode, TOut> {
  readonly results: ReadonlyArray<DagNodeResult<TNode, TOut>>
  readonly waves: number
}

/**
 * Execute a DAG in Kahn-topological waves: nodes in the same wave are mutually
 * independent and run concurrently through `rt.parallel()`, while later waves
 * wait for earlier waves to settle.
 *
 * Config errors throw synchronously at entry: empty graph, duplicate ids,
 * unknown dependency references, and cycles. Runtime node failures never throw
 * out of the pattern: a `null`/throwing `run()` result marks that node failed,
 * increments `stats.dropped`, and causes its dependents to become `skipped`.
 */
export async function dagExecute<TNode extends DagNode, TOut>(
  rt: WorkflowRuntime,
  options: DagExecuteOptions<TNode, TOut>,
): Promise<PatternResult<DagExecuteResult<TNode, TOut>>> {
  const { nodes, run, phase, stageKey } = options

  if (nodes.length === 0) {
    throw new Error('dagExecute: nodes must not be empty — provide at least one DAG node')
  }

  const idToIndex = new Map<string, number>()
  for (const [index, node] of nodes.entries()) {
    if (idToIndex.has(node.id)) {
      throw new Error(
        `dagExecute: duplicate node id ${JSON.stringify(node.id)} at index ${index} — each id must appear exactly once`,
      )
    }
    idToIndex.set(node.id, index)
  }

  for (const node of nodes) {
    for (const dependencyId of node.dependsOn) {
      if (!idToIndex.has(dependencyId)) {
        throw new Error(
          `dagExecute: node ${JSON.stringify(node.id)} depends on unknown id ${JSON.stringify(dependencyId)} — every dependsOn reference must name a node present in options.nodes`,
        )
      }
    }
  }

  const waves = computeWaveLevels(nodes)

  const { salt, warning: stageKeyWarning } = claimStageInstance(rt, STAGE, stageKey)
  const warnings: string[] = []
  if (stageKeyWarning !== undefined) warn(rt, warnings, stageKeyWarning)
  const stg = stageBuilder(STAGE, salt)

  const results: DagNodeResult<TNode, TOut>[] = nodes.map((node) => ({
    node,
    status: 'skipped',
    value: null,
  }))
  const statusById = new Map<string, DagNodeResult<TNode, TOut>['status']>()
  const trail: TrailRecord[] = []
  let agentsSpawned = 0

  for (const wave of waves) {
    const runnable = wave.filter((node) =>
      node.dependsOn.every((dependencyId) => statusById.get(dependencyId) === 'succeeded'),
    )

    for (const node of wave) {
      if (runnable.includes(node)) continue
      const index = idToIndex.get(node.id) as number
      results[index] = { node, status: 'skipped', value: null }
      statusById.set(node.id, 'skipped')
      warn(
        rt,
        warnings,
        `dagExecute: skipped node ${JSON.stringify(node.id)} because at least one dependency did not succeed`,
      )
    }

    const waveResults = await rt.parallel(runnable.map((node) => async () => run(node, rt)))

    for (const [indexInWave, node] of runnable.entries()) {
      const value = waveResults[indexInWave] ?? null
      const ok = value !== null
      const nodeIndex = idToIndex.get(node.id) as number
      results[nodeIndex] = {
        node,
        status: ok ? 'succeeded' : 'failed',
        value,
      }
      statusById.set(node.id, ok ? 'succeeded' : 'failed')
      trail.push(makeRecord(stg(`run:${nodeIndex}`), ok, { decision: node.id }))
      agentsSpawned++
      if (!ok) {
        warn(rt, warnings, `dagExecute: node ${JSON.stringify(node.id)} failed (returned null or threw)`)
      }
    }
  }

  const succeeded = results.filter((result) => result.status === 'succeeded').length
  const dropped = results.filter((result) => result.status !== 'succeeded').length
  const stats: PatternStats = {
    itemsIn: nodes.length,
    itemsOut: succeeded,
    agentsSpawned,
    dropped,
    truncated: 0,
  }

  emitDigest(rt, {
    stage: STAGE,
    ...(phase !== undefined ? { phase } : {}),
    output: `waves=${waves.length}`,
    counts: { in: nodes.length, out: succeeded, dropped },
  })

  return { value: { results, waves: waves.length }, stats, warnings, trail }
}

function computeWaveLevels<TNode extends DagNode>(nodes: readonly TNode[]): TNode[][] {
  const ordered = topologicalOrder(nodes)
  const levelById = new Map<string, number>()
  const waves: TNode[][] = []

  for (const node of ordered) {
    const level =
      node.dependsOn.length === 0
        ? 0
        : Math.max(...node.dependsOn.map((dependencyId) => levelById.get(dependencyId) as number)) + 1
    levelById.set(node.id, level)
    ;(waves[level] ??= []).push(node)
  }

  return waves
}

function topologicalOrder<TNode extends DagNode>(nodes: readonly TNode[]): TNode[] {
  const done = new Set<string>()
  const ordered: TNode[] = []
  const remaining = [...nodes]

  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((node) => node.dependsOn.every((dependencyId) => done.has(dependencyId)))
    if (readyIndex === -1) {
      const cycleIds = remaining.map((node) => JSON.stringify(node.id)).join(', ')
      throw new Error(
        `dagExecute: cycle detected involving node ids ${cycleIds} — DAG execution requires an acyclic dependsOn graph`,
      )
    }
    const node = remaining.splice(readyIndex, 1)[0] as TNode
    done.add(node.id)
    ordered.push(node)
  }

  return ordered
}
