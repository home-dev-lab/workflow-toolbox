// IMPURE entry for the Stop-hook auto-surfacing of the workflow audit report. Bundled by
// `pnpm debugger:build` into plugin/bin/wt-stop-hook.mjs and registered as the plugin's
// `Stop` hook. Held out of `pnpm test` (no .test.ts peer); every decision it makes is in
// the pure, unit-tested stop-detect.ts / stop-surface.ts.
//
// Contract: read the Stop payload from stdin, detect which background workflow runs just
// finished (diff against persisted per-session state), and — per the HYBRID design —
// ALWAYS print a systemMessage notice, plus a decision:"block" + compact reason ONLY when
// a finished run looks like trouble. The audit FOLDER is written only when
// $DWT_WORKFLOW_LOG_DIR is set. MUST NEVER break the session: any error → leave one stderr trace,
// print `{}`, exit 0.

import { findJournalByTaskId, transcriptDirFor } from './source.js'
import { parseJournal, agentEvents } from './journal.js'
import { diagnoseRun } from './diagnose.js'
import { buildAuditReport } from './report.js'
import { formatAuditReportMarkdown } from './report-format.js'
import { resolveLogDir, writeAuditFolder, scanTranscripts } from './audit-folder.js'
import { parseStopPayload, planStopActions } from './stop-detect.js'
import {
  buildFullSurface,
  buildProvisionalSurface,
  decideSurface,
  mergeStopSurfaces,
  renderHookOutput,
  type StopSurface,
} from './stop-surface.js'
import {
  readStopState,
  writeStopState,
  readReportedRuns,
  writeReportedRuns,
  readGivenUpTasks,
  writeGivenUpTasks,
} from './stop-state.js'

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => {
      data += c
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
  })
}

function emit(output: string): void {
  process.stdout.write(output)
  process.exit(0)
}

async function main(): Promise<void> {
  let raw = ''
  try {
    raw = await readStdin()
  } catch {
    emit('{}')
    return
  }

  let payload
  try {
    payload = parseStopPayload(JSON.parse(raw) as unknown)
  } catch {
    emit('{}')
    return
  }

  // No session id → we can't persist the diff state; surface nothing rather than risk a
  // stateless block-loop. (The launching session's `wt:report` still covers this run.)
  if (payload.sessionId === null) {
    emit('{}')
    return
  }
  const sessionId = payload.sessionId
  const cwd = payload.cwd ?? process.cwd()

  const state = readStopState(sessionId)
  // Durable, PROJECT-scoped set of runIds already surfaced — survives a mid-session sessionId
  // change (auto-compaction can spawn a new UUID, claude-code#65796), which would otherwise reset
  // the per-session `reported` set and replay every still-listed finished run.
  const reportedRuns = new Set(readReportedRuns(cwd))
  let reportedRunsChanged = false
  // Durable, PROJECT-scoped set of taskIds we gave up resolving because the journal was NEVER
  // readable (VANISHED runs). reported-runs keys on runId, which such a run never yields, so it
  // needs its own taskId-keyed set to suppress the cross-session provisional replay (#65796) —
  // WITHOUT permanently silencing it: resolution is still re-attempted every Stop, so a journal
  // that later becomes readable (a transient failure that healed) still surfaces its full report.
  const givenUpTasks = new Set(readGivenUpTasks(cwd))
  let givenUpTasksChanged = false
  const { toResolve, running } = planStopActions(state.pending, payload.workflows)

  const surfaces: StopSurface[] = []
  const stillPending: string[] = []

  for (const id of toResolve) {
    if (state.reported.includes(id)) continue
    const tries = (state.tries[id] ?? 0) + 1
    state.tries[id] = tries

    const resolved = findJournalByTaskId(id, { cwd })
    const runId = resolved?.runId ?? null
    // Cross-session guard: this run was already conclusively surfaced (possibly under a different
    // sessionId, before an auto-compaction UUID change) — don't replay it. Keyed on the stable
    // runId, so a fresh (post-UUID-change) per-session state can't re-announce it.
    if (runId !== null && reportedRuns.has(runId)) {
      state.reported.push(id)
      delete state.tries[id]
      continue
    }
    const journal = resolved ? parseJournal(resolved.text) : null
    const diagnosis = journal ? diagnoseRun(journal) : null
    // Durable VANISHED-run guard: we already conclusively gave up on this taskId in a PRIOR session
    // (its journal was never readable). If it is STILL unresolvable, suppress the provisional replay
    // — that cross-session re-announce is the #65796 noise. But if the journal has since become
    // readable (a transient read failure that healed), fall through and surface the full report: the
    // give-up must never permanently silence a run that can now be audited.
    if (diagnosis === null && givenUpTasks.has(id)) {
      state.reported.push(id)
      delete state.tries[id]
      continue
    }
    const decision = decideSurface(diagnosis, tries)

    if (decision.surface === 'full' && resolved && journal && diagnosis) {
      // best-effort transcript present-set + sources, then optional disk folder. Token usage is
      // read ONLY when the full report.md will be rendered (a disk folder is configured) — the
      // compact Stop surface doesn't show the breakdown, so skip the reads otherwise.
      const tdir = transcriptDirFor(resolved.path, resolved.runId)
      const agentIds = agentEvents(journal)
        .map((a) => a.agentId)
        .filter((id): id is string => typeof id === 'string')
      const logDir = resolveLogDir(process.env)
      // Always scan for tool denials AND auto-compaction (a silently-degraded or over-scoped run
      // reads `completed-ok` in the journal — the transcript is the only on-disk signal; the read
      // already happens for denials, so compaction is free). Token usage stays gated on a
      // configured log dir since it's only rendered into the disk report.md.
      const { presentTranscripts, transcriptSources, usageByAgent, denialsByAgent, compactionByAgent, delegationByAgent } =
        scanTranscripts(tdir, agentIds, {
          withUsage: logDir !== null,
          withDenials: true,
          withCompaction: true,
          withDelegation: true,
        })
      const report = buildAuditReport(journal, {
        presentTranscripts,
        usageByAgent,
        denialsByAgent,
        compactionByAgent,
        delegationByAgent,
      })

      let diskDir: string | null = null
      if (logDir) {
        // Same report.md body wt:report writes — only built when a disk folder is configured.
        const markdown = formatAuditReportMarkdown(report, { journalPath: resolved.path })
        const result = writeAuditFolder({
          baseDir: logDir.baseDir,
          runId: resolved.runId,
          markdown,
          journalText: resolved.text,
          transcriptSources,
        })
        if (result.written && result.dir) diskDir = result.dir
      }

      surfaces.push(buildFullSurface({ runId: resolved.runId, report, diagnosis, diskDir }))
    } else if (decision.surface === 'provisional') {
      const task = payload.workflows.find((w) => w.id === id)
      surfaces.push(buildProvisionalSurface({ id, name: task?.name ?? null }))
    }

    if (decision.conclusive) {
      state.reported.push(id)
      delete state.tries[id]
      // Record the run durably so a later sessionId change can't replay it. A resolved run is keyed
      // by its stable runId; a run we gave up on (never-readable journal, runId null) is keyed by
      // taskId in the given-up set instead — otherwise it re-announces once per UUID change.
      if (runId !== null) {
        if (!reportedRuns.has(runId)) {
          reportedRuns.add(runId)
          reportedRunsChanged = true
        }
      } else if (!givenUpTasks.has(id)) {
        givenUpTasks.add(id)
        givenUpTasksChanged = true
      }
    } else {
      stillPending.push(id)
    }
  }

  // When we are ALREADY inside a block-continuation (stop_hook_active), do not stack a new
  // block toward the 8-in-a-row override — keep the notices, drop the block.
  const finalSurfaces = payload.stopHookActive ? surfaces.map((s) => ({ ...s, block: false })) : surfaces

  state.pending = [...new Set([...running, ...stillPending])]
  writeStopState(sessionId, state)
  if (reportedRunsChanged) writeReportedRuns(cwd, [...reportedRuns])
  if (givenUpTasksChanged) writeGivenUpTasks(cwd, [...givenUpTasks])

  emit(renderHookOutput(mergeStopSurfaces(finalSurfaces)))
}

const stopHookSelfTest = process.env.WT_FAIL_OPEN_TRACE_SELF_TEST
const stopHookEntry = stopHookSelfTest === '*' || stopHookSelfTest === 'wt-stop-hook.mjs'
  ? Promise.reject(new Error('forced fail-open self-test for wt-stop-hook.mjs'))
  : main()

stopHookEntry.catch((error) => {
  try {
    process.stderr.write(`wt-stop-hook.mjs: FAILED OPEN - ${error instanceof Error ? error.message : String(error)}\n`)
  } catch {
    // Writing the trace must not itself become the reason the hook fails closed.
  }
  process.stdout.write('{}')
  process.exit(0)
})
