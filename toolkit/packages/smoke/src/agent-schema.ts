// agent-schema.ts — pure AgentDefinition / query-Options schema-drift detection for
// the upgrade canary. The agent `.md` frontmatter parser lives inside the Claude Code
// binary (not a type we can import); the SDK's exported `AgentDefinition` type is the
// closest GROUND-TRUTH proxy for it, and the query `Options` type is the source of the
// least-privilege levers `leastPrivilegeOptions` relies on. Both drift on SDK upgrades.
//
// The probe already derives `QueryOptions` from the live SDK types, so a RENAME/REMOVAL
// of a field we USE fails typecheck. What that does NOT catch — and this module does — is
// a NEW field (additions never break the build) that the scaffold emitter / composer
// guidance should learn to handle. We diff the live type against a COMMITTED baseline
// (not the per-clone canary marker, which is gitignored): the baseline is the reviewable
// record of "the schema we've accounted for", updated in the same commit that adopts a
// drift (card Y-D). Extraction is done with the real TypeScript compiler AST — never a
// regex — so a future field whose type is an inline object literal can't corrupt the set.

import * as ts from 'typescript'

/** Field names of the SDK `AgentDefinition` we have accounted for (SDK 0.3.205).
 *  Sorted to match `extractTypeFields` output. Update this — together with the scaffold
 *  emitter and composer guidance — when the canary flags drift (upgrade-canary skill,
 *  "Report and act"). */
export const AGENT_DEFINITION_BASELINE: readonly string[] = [
  'background',
  'criticalSystemReminder_EXPERIMENTAL',
  'description',
  'disallowedTools',
  'effort',
  'initialPrompt',
  'maxTurns',
  'mcpServers',
  'memory',
  'model',
  'observer',
  'observerMessage',
  'permissionMode',
  'prompt',
  'skills',
  'tools',
]

/** The query-`Options` fields `leastPrivilegeOptions` depends on. We only assert these
 *  stay PRESENT (a removal/rename is the drift that matters for least-privilege); we do
 *  NOT track additions to `Options` — it is a large type and most additions are
 *  irrelevant to the least-privilege recipe. Sorted. */
export const OPTIONS_LEAST_PRIV_BASELINE: readonly string[] = [
  'mcpServers',
  'model',
  'settingSources',
  'skills',
  'strictMcpConfig',
  'tools',
]

/** The `AgentDefinition` fields the scaffold emitter (card X-B `scaffoldAgent`) writes
 *  into agent frontmatter. A NEW AgentDefinition field NOT in this set is the actionable
 *  drift: the scaffold + composer prose should learn it. (`name`/`nonGoals` are
 *  scaffold-spec conveniences, not AgentDefinition fields, so they are absent here.) */
export const SCAFFOLD_HANDLED_AGENT_FIELDS: readonly string[] = [
  'description',
  'disallowedTools',
  'effort',
  'model',
  'prompt',
  'skills',
  'tools',
]

/** Top-level property names of a named `type X = {…}` or `interface X {…}` in a `.d.ts`
 *  text, sorted and de-duplicated. Returns null when the type is not found or is not an
 *  object shape. Uses the TypeScript AST (via `ts.createSourceFile`, a pure parse — no
 *  I/O), so only DEPTH-1 members are captured: a field whose type is an inline object
 *  literal contributes its own name, never the inner names. */
export function extractTypeFields(dtsText: string, typeName: string): string[] | null {
  const sf = ts.createSourceFile('sdk.d.ts', dtsText, ts.ScriptTarget.Latest, /*setParentNodes*/ false, ts.ScriptKind.TS)
  // Match only a TOP-LEVEL declaration of the exact name — NOT a same-named type nested
  // in a namespace/module (a depth-first walk could hit that first and mis-extract). If a
  // future SDK moves the type inside a module, this returns null → the canary reports
  // "schema source unavailable" (safe degradation) rather than wrong fields.
  let members: ts.NodeArray<ts.TypeElement> | undefined
  for (const stmt of sf.statements) {
    if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === typeName && ts.isTypeLiteralNode(stmt.type)) {
      members = stmt.type.members
      break
    }
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === typeName) {
      members = stmt.members
      break
    }
  }
  if (members === undefined) return null
  // Depth-1 PROPERTY names only. Method/call/construct/index signatures are NOT data
  // fields of the frontmatter/AgentDefinition schema — including them would produce false
  // drift the day the SDK adds one. `name` is always present on a PropertySignature.
  const names = new Set<string>()
  for (const m of members) {
    if (!ts.isPropertySignature(m)) continue
    const name = m.name
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) names.add(name.text)
  }
  return [...names].sort()
}

/** Added AgentDefinition fields the scaffold emitter does not yet handle — the ones that
 *  should drive a scaffold/composer update on drift. */
export function unhandledByScaffold(fields: readonly string[]): string[] {
  return fields.filter((f) => !SCAFFOLD_HANDLED_AGENT_FIELDS.includes(f))
}

/** The live-extracted field sets read off the installed SDK's `.d.ts`. A member is null
 *  when its source type could not be located (SDK/type source missing) — the diff then
 *  reports "unavailable" for that half rather than a false "everything removed". */
export interface LiveSchema {
  agentDefinitionFields: string[] | null
  optionFields: string[] | null
}

export interface SchemaDiff {
  status: 'match' | 'drift' | 'unavailable'
  /** Live AgentDefinition fields absent from the committed baseline (new fields). */
  added: string[]
  /** Baseline AgentDefinition fields absent from the live type (removed/renamed). */
  removed: string[]
  /** Subset of `added` the scaffold emitter does not handle — the actionable ones. */
  addedUnhandled: string[]
  /** Least-privilege `Options` fields the baseline expects but the live type lacks. */
  leastPrivMissing: string[]
  /** Whether the `Options` type was actually read. When false, the least-priv check was
   *  SKIPPED (not "intact") — the report must not claim the Options fields are fine. */
  optionsAvailable: boolean
  /** Cheap heuristic hint (clearly a guess): exactly one add + one remove ≈ a rename. */
  possibleRename?: { from: string; to: string }
}

/** Diff the live SDK schema against the committed baselines. Pure. `status` is
 *  `unavailable` when the AgentDefinition type could not be read (nothing to compare),
 *  `match` when there is no drift on any tracked axis, else `drift`. */
export function diffSchema(
  live: LiveSchema,
  agentBaseline: readonly string[] = AGENT_DEFINITION_BASELINE,
  optionBaseline: readonly string[] = OPTIONS_LEAST_PRIV_BASELINE,
): SchemaDiff {
  if (live.agentDefinitionFields === null) {
    return { status: 'unavailable', added: [], removed: [], addedUnhandled: [], leastPrivMissing: [], optionsAvailable: false }
  }
  const liveSet = new Set(live.agentDefinitionFields)
  const baseSet = new Set(agentBaseline)
  const added = live.agentDefinitionFields.filter((f) => !baseSet.has(f))
  const removed = [...baseSet].filter((f) => !liveSet.has(f)).sort()
  const addedUnhandled = unhandledByScaffold(added)
  // Only check least-priv option presence when the Options type was readable; a null
  // there is "couldn't verify", not "all removed". `optionsAvailable` carries that
  // distinction to the report so it never claims "intact" for an unchecked type.
  const optionsAvailable = live.optionFields !== null
  const leastPrivMissing = optionsAvailable ? optionBaseline.filter((f) => !live.optionFields!.includes(f)).sort() : []
  const diff: SchemaDiff = {
    status: added.length === 0 && removed.length === 0 && leastPrivMissing.length === 0 ? 'match' : 'drift',
    added,
    removed,
    addedUnhandled,
    leastPrivMissing,
    optionsAvailable,
  }
  if (added.length === 1 && removed.length === 1) diff.possibleRename = { from: removed[0]!, to: added[0]! }
  return diff
}

/** Render the schema-drift section as report lines (pure — the canary orchestrator is a
 *  thin console adapter over this, so the wording is unit-testable without spending
 *  launches). The SDK type is the ground-truth PROXY for Claude Code's `.md` frontmatter
 *  parser; a NEW field the scaffold does not emit is the actionable signal (drives the
 *  composer + scaffold sync, card Y-D). Informational only — the canary never gates on it. */
export function formatSchemaDrift(diff: SchemaDiff, sdkVersion: string | null): string[] {
  const header = `[canary] AGENT SCHEMA DRIFT (SDK ${sdkVersion ?? '?'} AgentDefinition — proxy for the .md frontmatter parser)`
  if (diff.status === 'unavailable') {
    return [header, '  (SDK type source unavailable — skipping schema-drift check)']
  }
  const optionsNote = diff.optionsAvailable
    ? 'least-priv Options intact'
    : 'least-priv Options NOT checked (Options type unreadable)'
  if (diff.status === 'match') {
    return [header, `  (matches the committed baseline — no new/removed AgentDefinition fields, ${optionsNote})`]
  }
  const lines = [header]
  if (!diff.optionsAvailable) {
    lines.push('  • note: least-priv Options NOT checked (Options type unreadable) — AgentDefinition drift below only')
  }
  if (diff.possibleRename) {
    lines.push(`  • possible RENAME: ${diff.possibleRename.from} → ${diff.possibleRename.to}  (inspect the add/remove pair below)`)
  }
  for (const f of diff.added) {
    const unhandled = diff.addedUnhandled.includes(f)
    lines.push(
      `  • ADDED field: ${f}${unhandled ? '  ← NOT emitted by scaffold → update composer + scaffoldAgent (card Y-D)' : '  (already handled by scaffold)'}`,
    )
  }
  for (const f of diff.removed) {
    lines.push(`  • REMOVED/renamed field: ${f}  (also typecheck-RED if leastPrivilegeOptions/probe USE it)`)
  }
  for (const f of diff.leastPrivMissing) {
    lines.push(`  • least-priv Options field MISSING: ${f}  ← leastPrivilegeOptions relies on it — update the recipe`)
  }
  lines.push('  → after adopting: update AGENT_DEFINITION_BASELINE in agent-schema.ts, the scaffold emitter, and the composer guidance.')
  return lines
}
