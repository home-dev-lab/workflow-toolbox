// IMPURE journal resolution (filesystem). Held out of `pnpm test` (no .test.ts suffix),
// exactly like the @workflow-toolbox/smoke live runners. Normal Node — fs/mtime are fine here (this
// is NOT a workflow-sandbox module, so the Date/Math sandbox bans do not apply).
//
// Journals live at $CLAUDE_CONFIG_DIR/projects/<project-slug>/<sessionId>/workflows/
// wf_<runId>.json (default config dir: ~/.claude — but a machine can run SEVERAL, e.g.
// a personal ~/.claude and a work ~/.claude-work, so the root is resolved, never assumed).
// The same `workflows/` dirs also hold sub-run `agent-*.meta.json` siblings, so the
// `wf_` prefix is filtered BEFORE any mtime sort — otherwise a freshly-written meta file
// could win "latest" and parse to null (a confusing "no journal found" on a real run).

import { join, basename } from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { parseJournal } from './journal.js'
import { numOrNull } from '@workflow-toolbox/std'

// Config-dir resolution + state keys live in their own lean module (config-dir.ts);
// re-exported here so /source stays the one-stop subpath for existing importers.
export { resolveConfigDir, configDirKey, resolveDir } from './config-dir.js'
import { resolveConfigDir } from './config-dir.js'

// Project-registry reading + slug resolution live in their own module too (project-registry.ts,
// which imports projectSlug back from here — a safe ESM circular import since it's only
// called inside a function body, never at top-level module evaluation).
export { readProjectRegistry, readRegistryFile, resolveProjectSlug } from './project-registry.js'

export interface ResolvedJournal {
  path: string
  text: string
  sessionId: string
  runId: string
}

export interface ResolveOptions {
  cwd?: string
  project?: string
  /** Claude config dir holding `projects/` (default: resolveConfigDir(process.env)). */
  configDir?: string
}

const isJournalFile = (name: string): boolean => /^wf_.*\.json$/.test(name)

// Real journals are tiny (largest observed ~85 KB). Cap the read so a pathological
// multi-GB file on disk can't OOM the CLI — it degrades to "not a readable journal".
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024

/** Byte cap for RunSummary.argsPreview (a slice of JSON.stringify(args)). Exported because
 *  the observe-ui CLIENT builds its display salvage logic on the assumption this stays
 *  small (run-picker.ts's brute-force truncated-JSON salvage is O(n^2) in this cap) — its
 *  test suite imports this constant to pin the coupling instead of duplicating the literal. */
export const ARGS_PREVIEW_CAP = 160

/** The on-disk project-dir name Claude Code derives from a cwd (non-alphanumerics → "-"). */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** A run's transcript dir: <sessionDir>/subagents/workflows/<runId>/, derived from its
 *  journal path <sessionDir>/workflows/wf_<runId>.json (up two levels: drop the filename,
 *  then the workflows/ dir — `join` normalizes the `..` segments). Shared by the report CLI
 *  and the Stop hook (both stat agent-<id>.jsonl files under it). `join`-only (no `dirname`
 *  import) so the helper never leaves a dangling import when tree-shaken from a bundle. */
export function transcriptDirFor(journalPath: string, runId: string): string {
  return join(journalPath, '..', '..', 'subagents', 'workflows', runId)
}

function projectsBase(configDir: string): string {
  return join(configDir, 'projects')
}

/** The single project dir a "latest"/by-runId resolution scans FIRST — printed
 *  by the CLIs so a wrong-cwd resolution is visible instead of silently
 *  plausible (a `pnpm wt:report` from toolkit/ scans the -toolkit slug, not
 *  the repo root's). */
export function scannedProjectDir(opts: ResolveOptions = {}): string {
  const configDir = opts.configDir ?? resolveConfigDir()
  const cwd = opts.cwd ?? process.cwd()
  return join(projectsBase(configDir), opts.project ?? projectSlug(cwd))
}

/** A positional that is a journal PATH (contains a separator or ends in .json)
 *  rather than a runId. Both CLIs print the journal path in their own error
 *  messages, so accepting it back is the obvious escape hatch. Exported so the
 *  CLIs can tell "path didn't read" apart from "project scan found nothing". */
export function looksLikeJournalPath(arg: string): boolean {
  return arg.includes('/') || arg.includes('\\') || arg.endsWith('.json')
}

/** Resolve a literal wf_*.json path: read it directly, deriving runId from the
 *  filename and sessionId from the <session>/workflows/<file> layout. */
function resolveJournalPath(path: string): ResolvedJournal | null {
  const name = basename(path)
  if (!isJournalFile(name)) return null
  const sessionDir = join(path, '..', '..')
  return readResolved({ path, sessionId: basename(sessionDir) })
}

/** The project dir a journal lives under (<projectDir>/<session>/workflows/<file> —
 *  three levels up). Single home for that layout knowledge, like transcriptDirFor. */
export function projectDirFor(journalPath: string): string {
  return join(journalPath, '..', '..', '..')
}

/** The one failed-lookup message every CLI surface prints — path-vs-runId aware,
 *  shared so the wording cannot drift across the four front-ends. */
export function journalLookupErrorMessage(
  tool: string,
  runId: string | null,
  opts: ResolveOptions = {},
): string {
  if (runId && looksLikeJournalPath(runId)) {
    return `${tool}: cannot read journal path ${JSON.stringify(runId)} — not an existing wf_*.json file.`
  }
  const which = runId && runId !== 'latest' ? `run "${runId}"` : 'any run in this project'
  return (
    `${tool}: no journal found for ${which}.\n` +
    `  [scanned ${scannedProjectDir(opts)}]\n` +
    '  Journals live at $CLAUDE_CONFIG_DIR/projects/<project>/<session>/workflows/wf_<runId>.json (default ~/.claude).\n' +
    '  Run from the project that produced the run, pass --project=<slug>, or pass the journal path directly.'
  )
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

function listJournals(projectDir: string): { path: string; sessionId: string }[] {
  const out: { path: string; sessionId: string }[] = []
  for (const session of listDirs(projectDir)) {
    const wfDir = join(projectDir, session, 'workflows')
    let names: string[]
    try {
      names = readdirSync(wfDir)
    } catch {
      continue
    }
    for (const name of names) {
      if (isJournalFile(name)) out.push({ path: join(wfDir, name), sessionId: session })
    }
  }
  return out
}

function readResolved(entry: { path: string; sessionId: string }): ResolvedJournal | null {
  let text: string
  try {
    if (statSync(entry.path).size > MAX_JOURNAL_BYTES) return null
    text = readFileSync(entry.path, 'utf8')
  } catch {
    return null
  }
  return {
    path: entry.path,
    text,
    sessionId: entry.sessionId,
    runId: basename(entry.path).replace(/\.json$/, ''),
  }
}

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function normalizeRunId(id: string): string {
  const s = id.trim().replace(/\.json$/, '')
  return s.startsWith('wf_') ? s : `wf_${s}`
}

/**
 * Resolve a journal by runId, or — when runId is null/"latest" — the most recently
 * written journal in the current (cwd-derived) project. A runId search spans the
 * current project first, then all projects (cross-session/cross-project recovery).
 * Never throws; returns null when nothing matches.
 */
export function findJournal(runId: string | null, opts: ResolveOptions = {}): ResolvedJournal | null {
  const base = projectsBase(opts.configDir ?? resolveConfigDir())
  const cwd = opts.cwd ?? process.cwd()

  // Literal journal path — bypass project discovery entirely.
  if (runId && looksLikeJournalPath(runId)) {
    return resolveJournalPath(runId)
  }

  if (runId && runId !== 'latest') {
    const wanted = normalizeRunId(runId)
    const projectDirs = opts.project
      ? [join(base, opts.project)]
      : [join(base, projectSlug(cwd)), ...listDirs(base).map((d) => join(base, d))]
    const seen = new Set<string>()
    for (const dir of projectDirs) {
      if (seen.has(dir)) continue
      seen.add(dir)
      for (const entry of listJournals(dir)) {
        if (basename(entry.path).replace(/\.json$/, '') === wanted) return readResolved(entry)
      }
    }
    return null
  }

  const projectDir = opts.project ? join(base, opts.project) : join(base, projectSlug(cwd))
  const journals = listJournals(projectDir)
  if (journals.length === 0) return null
  let newest = journals[0]!
  let newestMtime = mtimeMs(newest.path)
  for (const entry of journals.slice(1)) {
    const m = mtimeMs(entry.path)
    if (m > newestMtime) {
      newest = entry
      newestMtime = m
    }
  }
  return readResolved(newest)
}

export interface RunRef {
  runId: string
  journalPath: string
  sessionId: string
  mtimeMs: number
  /** The project dir's basename (e.g. `-home-user-proj`) this run's journal lives under —
   *  the same slug `opts.project`/`projectSlug()` accept. Lets a multi-project picker (the
   *  observe-ui rich run picker) group runs by project without re-deriving it from
   *  journalPath. Always set (opts.project when scoped to one; the actual dir name when
   *  scanning every project). */
  project: string
}

/**
 * Enumerate workflow runs newest-first (by journal mtime), WITHOUT parsing the
 * journals — only the cheap filename + stat is read, so it stays fast over many
 * runs. With no `opts.project`, scans EVERY project under $configDir/projects
 * (an observability tool wants "my recent runs, wherever they ran"); with a
 * project slug, scopes to that one. Non-`wf_` siblings (agent-*.meta.json) are
 * filtered by listJournals. Never throws; returns [] when nothing is found.
 */
export function listRuns(opts: ResolveOptions = {}): RunRef[] {
  const base = projectsBase(opts.configDir ?? resolveConfigDir())
  const projectDirs: { dir: string; project: string }[] = opts.project
    ? [{ dir: join(base, opts.project), project: opts.project }]
    : listDirs(base).map((d) => ({ dir: join(base, d), project: d }))
  const refs: RunRef[] = []
  for (const { dir, project } of projectDirs) {
    for (const entry of listJournals(dir)) {
      refs.push({
        runId: basename(entry.path).replace(/\.json$/, ''),
        journalPath: entry.path,
        sessionId: entry.sessionId,
        mtimeMs: mtimeMs(entry.path),
        project,
      })
    }
  }
  // Newest-first; tiebreak on runId so equal-mtime runs sort deterministically.
  refs.sort((a, b) => b.mtimeMs - a.mtimeMs || a.runId.localeCompare(b.runId))
  return refs
}

/**
 * A RunRef enriched with the cheap human-facing header fields parsed from the journal:
 * the workflow's name, its one-line goal (the journal's `summary`, which mirrors the
 * artifact's `meta.description`), the run's real start time, and its status — plus the
 * journal-header fields that are the DISCRIMINATOR between same-named runs (e.g. two
 * pr-review runs against different target ranges): duration, total tokens, agent count,
 * and a truncated preview of the launch args. All of it is already parsed by readRunSummary
 * (zero extra IO) — every field degrades to null on a missing field / malformed / vanished
 * journal, never a throw.
 */
export interface RunSummary extends RunRef {
  workflowName: string | null
  goal: string | null
  startTime: number | null
  status: string | null
  durationMs: number | null
  totalTokens: number | null
  agentCount: number | null
  /** `JSON.stringify(journal.args)`, sliced to 160 chars — the cheapest discriminator
   *  between two runs of the same workflow (e.g. which range a pr-review targeted). Null
   *  when the journal carries no `args` at all (not merely empty args). */
  argsPreview: string | null
}

/**
 * Parse one run's journal into a RunSummary. Unlike listRuns this DOES read+parse the
 * journal, so it is applied only to an already-capped slice, never the full disk scan.
 * Never throws; an unreadable/oversized/malformed journal yields all-null header fields.
 */
export function readRunSummary(ref: RunRef): RunSummary {
  const out: RunSummary = {
    ...ref,
    workflowName: null,
    goal: null,
    startTime: null,
    status: null,
    durationMs: null,
    totalTokens: null,
    agentCount: null,
    argsPreview: null,
  }
  const resolved = readResolved({ path: ref.journalPath, sessionId: ref.sessionId })
  if (!resolved) return out
  const j = parseJournal(resolved.text)
  if (!j) return out
  if (typeof j.workflowName === 'string') out.workflowName = j.workflowName
  if (typeof j.summary === 'string') out.goal = j.summary
  if (typeof j.startTime === 'number') out.startTime = j.startTime
  if (typeof j.status === 'string') out.status = j.status
  out.durationMs = numOrNull(j.durationMs)
  out.totalTokens = numOrNull(j.totalTokens)
  out.agentCount = numOrNull(j.agentCount)
  if (j.args !== undefined) {
    try {
      const s = JSON.stringify(j.args)
      if (typeof s === 'string') out.argsPreview = s.length > ARGS_PREVIEW_CAP ? s.slice(0, ARGS_PREVIEW_CAP) : s
    } catch {
      // circular/unserializable args (not expected from a JSON.parse'd journal) — leave null
    }
  }
  return out
}

/**
 * listRuns + per-run enrichment, time-windowed and capped. `sinceMs` (when given) drops
 * refs older than it BEFORE the `maxRuns` slice — a wide-but-old disk history never crowds
 * out runs inside the window just because they're not among the newest `maxRuns` overall.
 * `maxRuns` alone (as before) bounds the parse cost: only that many journals are ever read,
 * not every run on disk. Defaults (`maxRuns` 50, no `sinceMs`) reproduce the pre-window
 * behavior exactly. Never throws; returns [] when nothing is found.
 */
export function listRunSummaries(
  opts: ResolveOptions = {},
  windowOpts: { sinceMs?: number; maxRuns?: number } = {},
): RunSummary[] {
  const maxRuns = windowOpts.maxRuns ?? 50
  const refs = listRuns(opts).filter(
    (r) => windowOpts.sinceMs === undefined || r.mtimeMs >= windowOpts.sinceMs,
  )
  return refs.slice(0, maxRuns).map(readRunSummary)
}

/**
 * Resolve a journal by its `taskId` FIELD (NOT the wf_<runId> filename) — the only handle
 * a Stop hook's background_tasks[] carries. Unlike findJournal, this must PARSE each
 * journal in the project (across all sessions) to read `taskId`. Older journals without a
 * taskId are skipped; on multiple matches (e.g. a resumeFromRunId re-launch reused the
 * handle) the newest by mtime wins. Never throws; returns null when none matches.
 */
export function findJournalByTaskId(
  taskId: string,
  opts: ResolveOptions = {},
): ResolvedJournal | null {
  const base = projectsBase(opts.configDir ?? resolveConfigDir())
  const cwd = opts.cwd ?? process.cwd()
  const projectDir = opts.project ? join(base, opts.project) : join(base, projectSlug(cwd))

  let best: ResolvedJournal | null = null
  let bestMtime = -1
  for (const entry of listJournals(projectDir)) {
    const resolved = readResolved(entry)
    if (!resolved) continue
    const journal = parseJournal(resolved.text)
    if (!journal || journal.taskId !== taskId) continue
    const m = mtimeMs(entry.path)
    if (m > bestMtime) {
      best = resolved
      bestMtime = m
    }
  }
  return best
}
