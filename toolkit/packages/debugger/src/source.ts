// IMPURE journal resolution (filesystem). Held out of `pnpm test` (no .test.ts suffix),
// exactly like the @dwt/smoke live runners. Normal Node — fs/mtime are fine here (this
// is NOT a workflow-sandbox module, so the Date/Math sandbox bans do not apply).
//
// Journals live at ~/.claude/projects/<project-slug>/<sessionId>/workflows/wf_<runId>.json.
// The same `workflows/` dirs also hold sub-run `agent-*.meta.json` siblings, so the
// `wf_` prefix is filtered BEFORE any mtime sort — otherwise a freshly-written meta file
// could win "latest" and parse to null (a confusing "no journal found" on a real run).

import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { parseJournal } from './journal.js'

export interface ResolvedJournal {
  path: string
  text: string
  sessionId: string
  runId: string
}

export interface ResolveOptions {
  cwd?: string
  project?: string
  home?: string
}

const isJournalFile = (name: string): boolean => /^wf_.*\.json$/.test(name)

// Real journals are tiny (largest observed ~85 KB). Cap the read so a pathological
// multi-GB file on disk can't OOM the CLI — it degrades to "not a readable journal".
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024

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

function projectsBase(home: string): string {
  return join(home, '.claude', 'projects')
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
  const home = opts.home ?? homedir()
  const base = projectsBase(home)
  const cwd = opts.cwd ?? process.cwd()

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
  const home = opts.home ?? homedir()
  const base = projectsBase(home)
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
