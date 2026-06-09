// IMPURE entry for the Stop-hook auto-surfacing of the workflow audit report. Bundled by
// `pnpm debugger:build` into plugin/bin/dwt-stop-hook.mjs and registered as the plugin's
// `Stop` hook. Held out of `pnpm test` (no .test.ts peer); every decision it makes is in
// the pure, unit-tested stop-detect.ts / stop-surface.ts.
//
// Contract: read the Stop payload from stdin, detect which background workflow runs just
// finished (diff against persisted per-session state), and — per the HYBRID design —
// ALWAYS print a systemMessage notice, plus a decision:"block" + compact reason ONLY when
// a finished run looks like trouble. The audit FOLDER is written only when
// $DWT_WORKFLOW_LOG_DIR is set. MUST NEVER break the session: any error → print `{}`,
// exit 0.

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
import { readStopState, writeStopState } from './stop-state.js'

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
  // stateless block-loop. (The launching session's `dwt:report` still covers this run.)
  if (payload.sessionId === null) {
    emit('{}')
    return
  }
  const sessionId = payload.sessionId
  const cwd = payload.cwd ?? process.cwd()

  const state = readStopState(sessionId)
  const { toResolve, running } = planStopActions(state.pending, payload.workflows)

  const surfaces: StopSurface[] = []
  const stillPending: string[] = []

  for (const id of toResolve) {
    if (state.reported.includes(id)) continue
    const tries = (state.tries[id] ?? 0) + 1
    state.tries[id] = tries

    const resolved = findJournalByTaskId(id, { cwd })
    const journal = resolved ? parseJournal(resolved.text) : null
    const diagnosis = journal ? diagnoseRun(journal) : null
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
      const { presentTranscripts, transcriptSources, usageByAgent } = scanTranscripts(tdir, agentIds, {
        withUsage: logDir !== null,
      })
      const report = buildAuditReport(journal, { presentTranscripts, usageByAgent })

      let diskDir: string | null = null
      if (logDir) {
        // Same report.md body dwt:report writes — only built when a disk folder is configured.
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
    } else {
      stillPending.push(id)
    }
  }

  // When we are ALREADY inside a block-continuation (stop_hook_active), do not stack a new
  // block toward the 8-in-a-row override — keep the notices, drop the block.
  const finalSurfaces = payload.stopHookActive ? surfaces.map((s) => ({ ...s, block: false })) : surfaces

  state.pending = [...new Set([...running, ...stillPending])]
  writeStopState(sessionId, state)

  emit(renderHookOutput(mergeStopSurfaces(finalSurfaces)))
}

main().catch(() => {
  process.stdout.write('{}')
  process.exit(0)
})
