// canary-all.ts — `pnpm canary`. The upgrade-canary MATRIX orchestrator + change
// reporter. For each runtime target (system + bundled by default) it runs the
// positive (smoke) and negative (edge) checks, reads the measured CC version from
// each run, diffs the result against the per-machine marker, reports WHAT CHANGED
// (version moves, check flips, rejection-wording drift), and records the new
// snapshot. It is the SOLE writer of the marker (`pnpm canary:version` only reads
// it). Impure + spends launches → OUT of `pnpm test`; the pure logic it leans on
// (diffSnapshot, canonicalizeReason, readInitVersion, summarize) is covered there.

import { readFileSync, writeFileSync } from 'node:fs'
import { diffSchema, extractTypeFields, formatSchemaDrift, type LiveSchema } from './agent-schema.js'
import { runBudgetChecks } from './budget-canaries.js'
import { buildChangelogReport, type ChangelogReport } from './changelog.js'
import { CHANGELOG_URL, resolveChangelogText } from './changelog-source.js'
import { runEdgeChecks } from './edge-canaries.js'
import { type CheckResult, summarize } from './lib.js'
import { runNestingChecks } from './nesting-canaries.js'
import { runSmokeChecks } from './run.js'
import {
  getClaudeVersion,
  getLatestSdkVersion,
  getSdkTypesPath,
  getSdkVersion,
  MARKER_PATH,
  parseTargetSelection,
  resolveTargets,
} from './runtimes.js'
import {
  type CanaryMarker,
  type CheckSnapshot,
  diffSnapshot,
  formatMarker,
  parseMarker,
  type TargetsSnapshot,
} from './version.js'

function toSnapshot(checks: readonly CheckResult[]): CheckSnapshot[] {
  return checks.map((c) => ({
    name: c.name,
    ok: c.ok,
    ...(c.canonicalReason !== undefined ? { canonicalReason: c.canonicalReason } : {}),
  }))
}

function readMarker(): CanaryMarker | null {
  try {
    return parseMarker(readFileSync(MARKER_PATH, 'utf8'))
  } catch {
    return null
  }
}

/** Print the "what the changelog documents" section for the measured version range.
 *  Pure decision (buildChangelogReport) → presentation here. Informational only:
 *  a missing/empty source prints a one-liner and never affects the exit code. */
function printChangelog(r: ChangelogReport): void {
  console.log(`\n[canary] WHAT THE CHANGELOG DOCUMENTS (CC ${r.from ?? 'unknown'} → ${r.to ?? 'unknown'})`)
  switch (r.status) {
    case 'no-source':
      console.log(`  (changelog source unavailable — offline? skipping documented-changes lookup: ${CHANGELOG_URL})`)
      return
    case 'unknown-version':
      console.log('  (current Claude Code version could not be measured — skipping)')
      return
    case 'downgrade':
      console.log(`  (downgrade ${r.from} → ${r.to} — changelog inspection skipped)`)
      return
    case 'no-move':
      console.log('  (no version move — nothing new documented since the last run)')
      return
    default:
      break // first-run | shown fall through to the body below
  }
  if (r.relevant.length === 0) {
    const tail = r.otherCount > 0 ? ` (${r.otherCount} documented, none toolbox-relevant)` : ''
    console.log(`  (no toolbox-relevant changes documented for this range)${tail}`)
    return
  }
  console.log('  toolbox-relevant changes (may drive fixes/features):')
  const MAX_ENTRIES = 10
  for (const h of r.relevant.slice(0, MAX_ENTRIES)) {
    console.log(`  • ${h.version}`)
    for (const line of h.lines) console.log(`      - ${line}`)
  }
  if (r.relevant.length > MAX_ENTRIES) {
    console.log(`  (+${r.relevant.length - MAX_ENTRIES} more relevant entries — see the changelog)`)
  }
  if (r.otherCount > 0) {
    console.log(`  (+${r.otherCount} other documented ${r.otherCount === 1 ? 'entry' : 'entries'} with no toolbox-relevant line)`)
  }
}

/** Read the live `AgentDefinition` / `Options` field sets off the installed SDK's
 *  `.d.ts`. Impure (fs) → held out of `pnpm test`; the pure extraction + diff it feeds
 *  (extractTypeFields, diffSchema) are covered there. Any read failure degrades to nulls,
 *  which the diff renders as "schema source unavailable" — never a throw, never a gate. */
function readLiveSchema(): LiveSchema {
  const p = getSdkTypesPath()
  if (p === null) return { agentDefinitionFields: null, optionFields: null }
  let text: string
  try {
    text = readFileSync(p, 'utf8')
  } catch {
    return { agentDefinitionFields: null, optionFields: null }
  }
  return {
    agentDefinitionFields: extractTypeFields(text, 'AgentDefinition'),
    optionFields: extractTypeFields(text, 'Options'),
  }
}

/** Thin console adapter over the pure `formatSchemaDrift` (which owns the wording, so it
 *  is unit-testable without spending launches). Informational only — never gates. */
function printSchemaDrift(live: LiveSchema, sdkVersion: string | null): void {
  console.log(`\n${formatSchemaDrift(diffSchema(live), sdkVersion).join('\n')}`)
}

async function main(): Promise<void> {
  const selection = parseTargetSelection(process.argv.slice(2))
  const sdkVersion = getSdkVersion()
  const npmLatest = getLatestSdkVersion()
  const targets = resolveTargets(selection)
  if (targets.length === 0) {
    console.error('[canary] no runtime targets to run')
    process.exit(2)
  }

  const currentTargets: TargetsSnapshot = {}
  const allChecks: CheckResult[] = []
  for (const t of targets) {
    const where = t.opts.pathToClaudeCodeExecutable ? `(${t.opts.pathToClaudeCodeExecutable})` : '(SDK bundled)'
    console.log(`\n[canary] ──── target: ${t.name} ${where} ────`)
    const smoke = await runSmokeChecks(t.opts)
    const edge = await runEdgeChecks(t.opts)
    const nesting = await runNestingChecks(t.opts)
    const budget = await runBudgetChecks(t.opts)
    const checks = [...smoke.checks, ...edge.checks, ...nesting.checks, ...budget.checks]
    const ccVersion = smoke.ccVersion ?? edge.ccVersion ?? nesting.ccVersion ?? budget.ccVersion
    currentTargets[t.name] = { ccVersion, checks: toSnapshot(checks) }
    allChecks.push(...checks)
    console.log(`  → ${t.name}: CC ${ccVersion ?? 'unknown'} · ${checks.filter((c) => c.ok).length}/${checks.length} checks passed`)
  }

  const last = readMarker()
  const diff = diffSnapshot(last?.targets, currentTargets)

  console.log(`\n${'='.repeat(64)}\n[canary] SUMMARY`)
  const bundledCc = currentTargets['bundled']?.ccVersion ?? null
  console.log(`  SDK ${sdkVersion ?? '?'} ⇒ bundled CC ${bundledCc ?? 'n/a (bundled target not run)'}`)
  const newer = npmLatest !== null && sdkVersion !== null && npmLatest !== sdkVersion
  console.log(
    `  installed SDK ${sdkVersion ?? '?'} · latest on npm ${npmLatest ?? 'unknown (offline)'}` +
      (newer ? '  ← newer SDK available: `pnpm update` to test it' : ''),
  )
  for (const [name, snap] of Object.entries(currentTargets)) {
    const ok = snap.checks.filter((c) => c.ok).length
    console.log(`  ${name}: CC ${snap.ccVersion ?? 'unknown'} — ${ok}/${snap.checks.length} passed`)
  }

  console.log(`\n[canary] WHAT CHANGED SINCE LAST RUN`)
  const changed = diff.versionDeltas.length + diff.flips.length + diff.reasonDrift.length
  if (last === null) {
    console.log('  (no previous marker on this machine — first run, nothing to compare)')
  } else if (changed === 0) {
    console.log('  (nothing changed — same runtimes, same outcomes)')
  } else {
    for (const d of diff.versionDeltas) console.log(`  • runtime version: ${d}`)
    for (const f of diff.flips) console.log(`  • CHECK FLIP: ${f}  ← investigate (may drive a fix)`)
    for (const r of diff.reasonDrift) console.log(`  • rejection wording drifted: ${r}  ← may drive a fix/feature`)
  }

  // AgentDefinition / least-priv Options schema drift vs the committed baseline
  // (informational — never gates; the SDK type is the ground-truth proxy for CC's .md
  // frontmatter parser). Runs every canary invocation, not only on a version move.
  printSchemaDrift(readLiveSchema(), sdkVersion)

  // What the official changelog documents for this version move (informational —
  // never gates). `to` mirrors how the marker's claudeVersion is chosen below.
  const changelogFrom = last?.claudeVersion ?? null
  const changelogTo = currentTargets['system']?.ccVersion ?? getClaudeVersion()
  printChangelog(buildChangelogReport(await resolveChangelogText(), changelogFrom, changelogTo))

  const { passed, report } = summarize(allChecks)
  console.log(`\n${report}`)

  const marker: CanaryMarker = {
    // Prefer the system target's measured CC version; fall back to a direct
    // `claude --version` when the system target was not run (e.g. --target bundled).
    claudeVersion: currentTargets['system']?.ccVersion ?? getClaudeVersion(),
    sdkVersion,
    targets: currentTargets,
    lastRunISO: new Date().toISOString(),
    lastVerdict: passed ? 'pass' : 'fail',
  }
  writeFileSync(MARKER_PATH, formatMarker(marker))
  console.log(`[canary] recorded ${passed ? 'PASS' : 'FAIL'} → ${MARKER_PATH}\n`)

  process.exit(passed ? 0 : 1)
}

main().catch((err: unknown) => {
  console.error(`\n[canary] FAILED: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(2)
})
