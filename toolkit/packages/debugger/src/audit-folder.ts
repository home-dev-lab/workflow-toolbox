// IMPURE audit-folder module. Normal Node fs (NOT a workflow-sandbox module). The DISK-WRITE
// path (writeAuditFolder) is held out of `pnpm test`, like source.ts / cli.ts — it has real
// side effects and is only typechecked. The READ path (scanTranscripts) IS covered: it is
// deterministic over a committed on-disk fixture (audit-folder.test.ts).
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
import {
  parseTranscriptUsage,
  parseTranscriptCompaction,
  isNonEmptyUsage,
  type AgentUsage,
  type TranscriptCompaction,
} from './transcript-usage.js'
import { parseTranscriptDenials, type ToolDenial } from './tool-denial.js'
import {
  expectationForAgentType,
  isDelegatedAgentType,
  parseTranscriptExternalCalls,
  type DelegationScan,
} from './external-delegation.js'
import { isRecord, strOrNull } from '@workflow-toolbox/std'

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
  /** Per-agent tool denials — populated only when `withDenials`, and only for transcripts that
   *  had at least one denied tool call. */
  denialsByAgent: Map<string, ToolDenial[]>
  /** Per-agent auto-compaction — populated only when `withCompaction`, and only for transcripts
   *  that actually compacted (a `compact_boundary` event). */
  compactionByAgent: Map<string, TranscriptCompaction>
  /** Per-agent external delegation — populated only when `withDelegation`, and only for agents
   *  whose `agent-<id>.meta.json` sidecar carries an agentType (a default spawn has none).
   *  `scan` is the external-CLI invocation scan when the agentType matches a registered
   *  signature, null when the delegation target is unknown to the registry. */
  delegationByAgent: Map<string, DelegationScan>
}

/** Whether an agentId is safe to interpolate into `agent-<id>.jsonl` under the transcript dir.
 *  agentIds are system-generated (`a<hex>`), but scanTranscripts now reads on EVERY finished run,
 *  so any id that could escape the dir via `join` (a `.`, `/`, or `..` segment) is refused BEFORE
 *  the read. Exported so the security invariant is unit-tested directly, not just via scanTranscripts. */
export function isSafeAgentId(agentId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(agentId)
}

/** Scan a run's transcript dir for each agent's `agent-<id>.jsonl`. Best-effort: a missing or
 *  unreadable transcript is simply omitted; never throws. Shared by report-cli.ts and
 *  stop-hook.ts so the present-set loop lives in one place. `withUsage` reads + parses each
 *  transcript's token usage; `withDenials` reads + scans it for silently-denied tool calls.
 *  With NEITHER it does the cheap statSync-only presence scan (no file reads). A single read
 *  serves all flags when several are set. `withCompaction` scans it for auto-compaction boundaries. */
export function scanTranscripts(
  transcriptDir: string,
  agentIds: Iterable<string>,
  opts: { withUsage?: boolean; withDenials?: boolean; withCompaction?: boolean; withDelegation?: boolean } = {},
): TranscriptScan {
  const presentTranscripts = new Set<string>()
  const transcriptSources: TranscriptSource[] = []
  const usageByAgent = new Map<string, AgentUsage>()
  const denialsByAgent = new Map<string, ToolDenial[]>()
  const compactionByAgent = new Map<string, TranscriptCompaction>()
  const delegationByAgent = new Map<string, DelegationScan>()
  const needRead =
    opts.withUsage === true || opts.withDenials === true || opts.withCompaction === true || opts.withDelegation === true

  for (const agentId of agentIds) {
    // Defense-in-depth: refuse any id that could escape the transcript dir via `join` (see
    // isSafeAgentId) — this read fires on EVERY finished run, so the id is an attack surface.
    if (!isSafeAgentId(agentId)) continue
    const sourcePath = join(transcriptDir, `agent-${agentId}.jsonl`)
    if (needRead) {
      let text: string
      try {
        text = readFileSync(sourcePath, 'utf8')
      } catch {
        continue // absent / unreadable → omit
      }
      presentTranscripts.add(agentId)
      transcriptSources.push({ agentId, sourcePath })
      if (opts.withUsage) {
        const usage = parseTranscriptUsage(text)
        if (isNonEmptyUsage(usage)) usageByAgent.set(agentId, usage)
      }
      if (opts.withDenials) {
        const denials = parseTranscriptDenials(text, agentId)
        if (denials.length > 0) denialsByAgent.set(agentId, denials)
      }
      if (opts.withCompaction) {
        const compaction = parseTranscriptCompaction(text)
        if (compaction.compacted) compactionByAgent.set(agentId, compaction)
      }
      if (opts.withDelegation) {
        const agentType = readAgentTypeSidecar(join(transcriptDir, `agent-${agentId}.meta.json`))
        // A default spawn type (`workflow-subagent`) is not a delegation — without this
        // skip, every agent of every ordinary run lands in the report's "unknown" list.
        if (agentType !== null && isDelegatedAgentType(agentType)) {
          const expectation = expectationForAgentType(agentType)
          delegationByAgent.set(agentId, {
            agentType,
            scan: expectation !== null ? parseTranscriptExternalCalls(text, expectation) : null,
          })
        }
      }
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
  return { presentTranscripts, transcriptSources, usageByAgent, denialsByAgent, compactionByAgent, delegationByAgent }
}

/** Read the agentType off an `agent-<id>.meta.json` sidecar (written by the runtime next to
 *  the transcript when a spawn was routed to a non-default agentType). Best-effort: absent /
 *  unreadable / shapeless → null, never throws. */
function readAgentTypeSidecar(metaPath: string): string | null {
  let text: string
  try {
    text = readFileSync(metaPath, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? strOrNull(parsed['agentType']) : null
  } catch {
    return null
  }
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
