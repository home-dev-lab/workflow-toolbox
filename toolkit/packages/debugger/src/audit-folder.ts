// IMPURE audit-folder writer. Held out of `pnpm test` (no .test.ts peer), exactly like
// source.ts / cli.ts; still typechecked. Normal Node fs (NOT a workflow-sandbox module).
//
// The env var gates the DISK side effect ONLY — the report itself is always produced
// and surfaced by the CLI (see report-cli.ts). `$DWT_WORKFLOW_LOG_DIR` (or an explicit
// --out) opts an enterprise into a persistent audit folder per run:
//   <baseDir>/<runId>/{ report.md, journal.json, transcripts/agent-<id>.jsonl }
//
// Failure contract: never throws. Returns {written:false, reason} on a non-writable
// path; {written:true, dir, files} on success.

import { mkdirSync, writeFileSync, copyFileSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTranscriptUsage, isNonEmptyUsage, type AgentUsage } from './transcript-usage.js'

export interface ResolvedLogDir {
  baseDir: string
  /** Where the directory came from — an explicit --out flag or the env var. */
  source: 'flag' | 'env'
}

/** Resolve the audit-folder base dir: an explicit --out wins, else $DWT_WORKFLOW_LOG_DIR.
 *  Returns null when neither is set — disk persistence is OFF by default. */
export function resolveLogDir(env: NodeJS.ProcessEnv, outFlag?: string): ResolvedLogDir | null {
  if (outFlag !== undefined && outFlag.trim() !== '') return { baseDir: outFlag, source: 'flag' }
  const envDir = env['DWT_WORKFLOW_LOG_DIR']
  if (typeof envDir === 'string' && envDir.trim() !== '') return { baseDir: envDir, source: 'env' }
  return null
}

export interface TranscriptSource {
  agentId: string
  /** Absolute path to the source agent-<id>.jsonl on disk (only existing ones passed). */
  sourcePath: string
}

export interface TranscriptScan {
  /** agentIds whose transcript exists on disk (→ buildAuditReport's presentTranscripts). */
  presentTranscripts: Set<string>
  /** Existing transcripts to copy into an audit folder. */
  transcriptSources: TranscriptSource[]
  /** Per-agent billed usage — populated only when `withUsage`, and only for transcripts that
   *  parsed to NON-EMPTY usage (a present-but-empty transcript must not inflate report coverage). */
  usageByAgent: Map<string, AgentUsage>
}

/** Scan a run's transcript dir for each agent's `agent-<id>.jsonl`. Best-effort: a missing or
 *  unreadable transcript is simply omitted; never throws. Shared by report-cli.ts and
 *  stop-hook.ts so the present-set loop lives in one place. `withUsage` reads + parses each
 *  transcript's token usage; left false it does the cheap statSync-only presence scan (no reads),
 *  which the Stop hook uses when it won't render the full report. */
export function scanTranscripts(
  transcriptDir: string,
  agentIds: Iterable<string>,
  opts: { withUsage?: boolean } = {},
): TranscriptScan {
  const presentTranscripts = new Set<string>()
  const transcriptSources: TranscriptSource[] = []
  const usageByAgent = new Map<string, AgentUsage>()

  for (const agentId of agentIds) {
    const sourcePath = join(transcriptDir, `agent-${agentId}.jsonl`)
    if (opts.withUsage) {
      let text: string
      try {
        text = readFileSync(sourcePath, 'utf8')
      } catch {
        continue // absent / unreadable → omit
      }
      presentTranscripts.add(agentId)
      transcriptSources.push({ agentId, sourcePath })
      const usage = parseTranscriptUsage(text)
      if (isNonEmptyUsage(usage)) usageByAgent.set(agentId, usage)
    } else {
      try {
        if (statSync(sourcePath).isFile()) {
          presentTranscripts.add(agentId)
          transcriptSources.push({ agentId, sourcePath })
        }
      } catch {
        // absent → skip
      }
    }
  }
  return { presentTranscripts, transcriptSources, usageByAgent }
}

export interface WriteResult {
  written: boolean
  reason?: string
  dir?: string
  files?: string[]
}

export interface WriteAuditFolderArgs {
  baseDir: string
  runId: string
  markdown: string
  /** The raw journal text, copied VERBATIM to journal.json (not re-serialized). */
  journalText: string
  transcriptSources: TranscriptSource[]
}

export function writeAuditFolder(args: WriteAuditFolderArgs): WriteResult {
  const dir = join(args.baseDir, args.runId)
  try {
    mkdirSync(dir, { recursive: true })
    const files: string[] = []
    writeFileSync(join(dir, 'report.md'), args.markdown, 'utf8')
    files.push('report.md')
    writeFileSync(join(dir, 'journal.json'), args.journalText, 'utf8')
    files.push('journal.json')

    if (args.transcriptSources.length > 0) {
      const tdir = join(dir, 'transcripts')
      mkdirSync(tdir, { recursive: true })
      for (const t of args.transcriptSources) {
        const rel = `transcripts/agent-${t.agentId}.jsonl`
        try {
          copyFileSync(t.sourcePath, join(dir, rel))
          files.push(rel)
        } catch {
          // Best-effort: a transcript that vanished between stat and copy is skipped,
          // never fatal — the journal (the authoritative record) is already written.
        }
      }
    }
    return { written: true, dir, files }
  } catch (err) {
    return { written: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
