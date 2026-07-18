// spec-io.ts — IMPURE spec loading (filesystem) shared by the in-repo scaffold
// CLI and the published `workflow-toolbox scaffold` subcommand, so their read/parse/validate
// error messages cannot drift. Held out of `pnpm test` coverage requirements
// like the other impure CLI-support modules; the pure validation it delegates
// to (assertSpecShape) is tested via scaffold.ts.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { assertAgentSpecShape, assertCapabilitiesScaffoldSpec, assertObserverScaffoldSpec, assertSpecShape } from './scaffold.js'
import type { AgentScaffoldSpec, CapabilitiesScaffoldSpec, ObserverScaffoldSpec, ScaffoldSpec } from './scaffold.js'

/** Read + parse a spec file to raw JSON. Throws an actionable Error. Shared by
 *  the workflow + agent loaders so their read/parse error messages cannot drift. */
function readSpecJson(specPath: string): unknown {
  let raw: string
  try {
    raw = fs.readFileSync(path.resolve(specPath), 'utf8')
  } catch {
    throw new Error(`workflow-toolbox scaffold: cannot read spec file ${JSON.stringify(specPath)}`)
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `workflow-toolbox scaffold: ${JSON.stringify(specPath)} is not valid JSON — ${(err as Error).message}`,
    )
  }
}

/** Read + parse + shape-narrow a WORKFLOW spec file. Throws an actionable Error. */
export function loadSpec(specPath: string): ScaffoldSpec {
  const parsed = readSpecJson(specPath)
  assertSpecShape(parsed)
  return parsed
}

/** Read + parse + shape-narrow an AGENT spec file. Throws an actionable Error. */
export function loadAgentSpec(specPath: string): AgentScaffoldSpec {
  const parsed = readSpecJson(specPath)
  assertAgentSpecShape(parsed)
  return parsed
}

/** Read + parse + shape-narrow an OBSERVER spec file. Throws an actionable Error.
 *  The field-level rules are enforced later by scaffoldObserver via the shared
 *  validateObserverDefinition — this only guarantees an object was parsed. */
export function loadObserverSpec(specPath: string): ObserverScaffoldSpec {
  const parsed = readSpecJson(specPath)
  assertObserverScaffoldSpec(parsed)
  return parsed
}

/** Read + parse + shape-narrow a CAPABILITY-SIDECAR spec file. Throws an actionable
 *  Error. The field-level rules are enforced later by scaffoldCapabilities via the
 *  shared lintSidecarMachineAgnostic — this only guarantees an object with a `name`. */
export function loadCapabilitiesSpec(specPath: string): CapabilitiesScaffoldSpec {
  const parsed = readSpecJson(specPath)
  assertCapabilitiesScaffoldSpec(parsed)
  return parsed
}
