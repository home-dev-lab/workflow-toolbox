// dag-artifact.ts — versioned, serializable DAG descriptors.

import type { DagNode } from './dag-execute.js'

/** One serializable DAG node descriptor, with an optional human label. */
export interface DagArtifactNode extends DagNode {
  readonly label?: string
}

/** Persisted DAG artifact format.
 *
 *  Pure data only: the caller supplies timestamps and performs any actual file
 *  IO. This module only serializes and validates the data shape. */
export interface DagArtifact {
  readonly schemaVersion: 1
  readonly name: string
  readonly createdAt: string
  readonly nodes: ReadonlyArray<DagArtifactNode>
}

/** Input accepted by `serializeDagArtifact()`. */
export interface SerializeDagArtifactInput {
  readonly name: string
  readonly createdAt: string
  readonly nodes: readonly DagArtifactNode[]
}

/** Build the persisted v1 DAG artifact shape from typed inputs.
 *
 *  The returned object is immediately suitable for `JSON.stringify()`. */
export function serializeDagArtifact(input: SerializeDagArtifactInput): DagArtifact {
  const { name, createdAt, nodes } = input
  validateTopLevelString(name, 'name')
  validateTopLevelString(createdAt, 'createdAt')
  if (!Array.isArray(nodes)) {
    throw new Error('serializeDagArtifact: nodes must be an array of DAG nodes')
  }

  const serialized: DagArtifactNode[] = []
  for (let i = 0; i < nodes.length; i++) {
    serialized.push(serializeNode(nodes[i] as DagArtifactNode, i))
  }
  validateGraphShape(serialized)

  return { schemaVersion: 1, name, createdAt, nodes: serialized }
}

/** Parse and validate an unknown value as a persisted v1 DAG artifact.
 *
 *  Throws a descriptive error that names the exact malformed field so a fresh
 *  session can safely re-read the artifact instead of accepting silent drift. */
export function parseDagArtifact(raw: unknown): DagArtifact {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('parseDagArtifact: artifact must be an object')
  }

  const artifact = raw as Record<string, unknown>

  if (artifact.schemaVersion !== 1) {
    throw new Error(
      `parseDagArtifact: schemaVersion must be 1, got ${JSON.stringify(artifact.schemaVersion)}`,
    )
  }

  const name = artifact.name
  validateTopLevelString(name, 'name', 'parseDagArtifact')
  const createdAt = artifact.createdAt
  validateTopLevelString(createdAt, 'createdAt', 'parseDagArtifact')

  if (!Array.isArray(artifact.nodes)) {
    throw new Error('parseDagArtifact: nodes is missing or not an array')
  }

  // Indexed loop (not .map()) — .map() SKIPS holes in a sparse `nodes` array,
  // which would silently preserve a hole (and its downstream `undefined`)
  // instead of failing validation.
  const nodes: DagArtifactNode[] = []
  for (let i = 0; i < artifact.nodes.length; i++) {
    nodes.push(parseNode(artifact.nodes[i], i))
  }

  validateGraphShape(nodes)

  return { schemaVersion: 1, name, createdAt, nodes }
}

/** Graph-level validation beyond per-node shape: duplicate ids and dangling
 *  `dependsOn` references. Without this, a structurally well-formed but
 *  graph-invalid artifact would parse successfully and only fail later, in
 *  `dagExecute` — defeating the "safely re-readable" contract this module
 *  exists to provide. Cycle detection is deliberately NOT duplicated here:
 *  `dagExecute` already detects cycles at execution time with a full node-id
 *  listing, and a persisted artifact is not required to be immediately
 *  executable (e.g. a work-in-progress shape saved mid-edit). */
function validateGraphShape(nodes: readonly DagArtifactNode[]): void {
  const seen = new Set<string>()
  for (const node of nodes) {
    if (seen.has(node.id)) {
      throw new Error(`parseDagArtifact: duplicate node id ${JSON.stringify(node.id)}`)
    }
    seen.add(node.id)
  }
  for (const node of nodes) {
    for (const dependencyId of node.dependsOn) {
      if (!seen.has(dependencyId)) {
        throw new Error(
          `parseDagArtifact: node ${JSON.stringify(node.id)} depends on unknown id ${JSON.stringify(dependencyId)}`,
        )
      }
    }
  }
}

function serializeNode(node: DagArtifactNode, index: number): DagArtifactNode {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`serializeDagArtifact: nodes[${index}] must be an object`)
  }
  const candidate: Record<string, unknown> = {
    id: node.id,
    dependsOn: node.dependsOn,
    ...(node.label !== undefined ? { label: node.label } : {}),
  }
  validateNode(candidate, `serializeDagArtifact: nodes[${index}]`)
  return {
    id: node.id,
    dependsOn: [...node.dependsOn],
    ...(node.label !== undefined ? { label: node.label } : {}),
  }
}

function parseNode(node: unknown, index: number): DagArtifactNode {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`parseDagArtifact: nodes[${index}] must be an object`)
  }
  const candidate = node as Record<string, unknown>
  validateNode(candidate, `parseDagArtifact: nodes[${index}]`)
  const id = candidate.id
  validateTopLevelString(id, `parseDagArtifact: nodes[${index}].id`)
  const dependsOn = candidate.dependsOn
  if (!Array.isArray(dependsOn)) {
    throw new Error(`parseDagArtifact: nodes[${index}].dependsOn must be an array of strings`)
  }
  const label = candidate.label
  if (label !== undefined && typeof label !== 'string') {
    throw new Error(`parseDagArtifact: nodes[${index}].label must be a string when present`)
  }
  return {
    id,
    dependsOn: [...dependsOn],
    ...(label !== undefined ? { label } : {}),
  }
}

function validateNode(node: Record<string, unknown>, prefix: string): void {
  validateTopLevelString(node.id, `${prefix}.id`)

  if (!Array.isArray(node.dependsOn)) {
    throw new Error(`${prefix}.dependsOn must be an array of strings`)
  }
  // Indexed access (not .every()/.map()) deliberately — .every()/.map() SKIP
  // holes in a sparse array (`new Array(1)`), which would silently let a hole
  // (read back as `undefined`) survive validation and corrupt the parsed
  // shape. An indexed loop visits every index, hole or not.
  for (let i = 0; i < node.dependsOn.length; i++) {
    if (typeof node.dependsOn[i] !== 'string') {
      throw new Error(`${prefix}.dependsOn must contain only strings (index ${i} is not a string)`)
    }
  }

  if (node.label !== undefined && typeof node.label !== 'string') {
    throw new Error(`${prefix}.label must be a string when present`)
  }
}

function validateTopLevelString(
  value: unknown,
  field: string,
  caller = 'serializeDagArtifact',
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${caller}: ${field} must be a non-empty string`)
  }
}
