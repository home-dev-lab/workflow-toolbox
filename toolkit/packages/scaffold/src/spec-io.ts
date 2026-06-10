// spec-io.ts — IMPURE spec loading (filesystem) shared by the in-repo scaffold
// CLI and the published `workflow-toolbox scaffold` subcommand, so their read/parse/validate
// error messages cannot drift. Held out of `pnpm test` coverage requirements
// like the other impure CLI-support modules; the pure validation it delegates
// to (assertSpecShape) is tested via scaffold.ts.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { assertSpecShape } from './scaffold.js'
import type { ScaffoldSpec } from './scaffold.js'

/** Read + parse + shape-narrow a spec file. Throws an actionable Error. */
export function loadSpec(specPath: string): ScaffoldSpec {
  let raw: string
  try {
    raw = fs.readFileSync(path.resolve(specPath), 'utf8')
  } catch {
    throw new Error(`workflow-toolbox scaffold: cannot read spec file ${JSON.stringify(specPath)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `workflow-toolbox scaffold: ${JSON.stringify(specPath)} is not valid JSON — ${(err as Error).message}`,
    )
  }
  assertSpecShape(parsed)
  return parsed
}
