// AUTOMATED integration test for the Stop-hook main() dedup WIRING — the cross-session
// compaction-replay scenario that was previously only e2e-verified by hand (card
// #1809638841292686795). It drives the REAL bundled artifact (bin/wt-stop-hook.mjs) as a
// child process, piping crafted Stop payloads to stdin and asserting stdout — the "closest to
// real" option: it exercises the actual bundle + the actual durable-file IO, where a wiring or
// bundling regression would hide (a pure-seam unit test cannot see those).
//
// Isolation: each test runs the hook with CLAUDE_CONFIG_DIR, HOME and TMPDIR pointed at a
// throwaway dir, so
//   - journals resolve under <root>/.claude/projects/<slug>/<session>/workflows/  (config-dir-scoped)
//   - the durable dedup sets live under <root>/wt-stop-hook/                        (TMPDIR-scoped)
// and nothing touches the developer's real config dir or /tmp/wt-stop-hook state.
// (CLAUDE_CONFIG_DIR must be pinned explicitly: the dev session env carries the REAL one,
// and journal resolution prefers it over HOME — inheriting it would escape the fixture.)
//
// It covers BOTH halves of the #65796 fix in one harness:
//   • RESOLVED run — dedup keyed by the stable runId (reported-runs). The original fix.
//   • VANISHED run — dedup keyed by taskId (given-up-tasks). The card-#1 follow-up
//     (#1809638758262244809), which fully closes the replay for never-readable journals.
//
// NOTE: this drives the COMMITTED bundle. If you change stop-hook.ts / stop-state.ts, run
// `pnpm debugger:build` first (the dev loop does) or this tests the stale artifact.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'
import { projectSlug } from '../src/source.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', '..', '..', 'bin', 'wt-stop-hook.mjs')
const FIXTURE_COMPLETED = join(HERE, 'fixtures', 'real-completed.json')
// real-completed.json's own fields — the payload's task id must equal the journal's taskId for
// findJournalByTaskId to resolve it, and the notice echoes the runId (from the filename we plant).
const COMPLETED_TASK_ID = 'wsmktx6hv'
const COMPLETED_RUN_ID = 'wf_9d4ee73f-61b'

const isWin = process.platform === 'win32'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function mkRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `wt-hook-itest-${tag}-`))
  roots.push(root)
  return root
}

/** Env that pins the hook's config dir + HOME + TMPDIR into `root` and disables disk-folder writes.
 *  NOTE: stop-state.ts locates its state dir via node:os `tmpdir()`, which honors $TMPDIR on POSIX
 *  but NOT on win32 (only %TEMP%/%TMP%, which this deliberately leaves untouched) — so on win32 the
 *  spawned hook's real state dir is the ambient system temp, not `root`. See `stopHookRealStateDir`. */
function hookEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: join(root, '.claude'), HOME: root, TMPDIR: root }
  delete env['DWT_WORKFLOW_LOG_DIR'] // logDir=null → no audit folder written, keeps the run pure
  return env
}

/** Where the spawned hook ACTUALLY resolves its wt-stop-hook state dir, given `root` (see
 *  hookEnv's note): `root` on POSIX (TMPDIR honored there), this process's own real tmpdir()
 *  on win32 (TMPDIR is a no-op there, and neither side overrides TEMP/TMP, so both this test
 *  process and the spawned child resolve the SAME ambient system temp dir). */
function stopHookRealStateDir(root: string): string {
  return join(isWin ? tmpdir() : root, 'wt-stop-hook')
}

/** Per-session state (stop-state.ts's statePath) is keyed ONLY by sessionId — no cwd/root
 *  component — so on win32, where the state dir above is the SHARED ambient temp (not `root`),
 *  reusing a literal session id like 'sess-A' across different `it()` blocks would leak one
 *  test's per-session `reported`/`tries` into the next. Suffixing with `root`'s own unique
 *  mkdtemp basename keeps every test's session ids globally unique on every platform. */
function sessId(root: string, label: string): string {
  return `${label}-${basename(root)}`
}

interface HookResult {
  raw: string
  out: Record<string, unknown>
}

/** Run the bundled Stop hook once with `payload` on stdin; return raw stdout + parsed JSON. */
function runHook(payload: unknown, env: NodeJS.ProcessEnv): HookResult {
  const res = spawnSync(process.execPath, [BUNDLE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  })
  const raw = (res.stdout ?? '').trim()
  let out: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') out = parsed as Record<string, unknown>
  } catch {
    // the hook always emits JSON; a parse miss means a crash — leave out={} and let raw assert
  }
  return { raw, out }
}

/** Read a durable dedup file's array field from the child's real (platform-aware) state dir. */
function readDurableField(root: string, kind: string, cwd: string, field: string): string[] {
  const path = join(stopHookRealStateDir(root), `${kind}-${projectSlug(cwd)}.json`)
  if (!existsSync(path)) return []
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>)[field])) {
    return (data as Record<string, string[]>)[field]!
  }
  return []
}

/** A background_tasks[] payload with one still-listed, finished workflow task. */
function stopPayload(sessionId: string, cwd: string, taskId: string, name: string): unknown {
  return {
    session_id: sessionId,
    cwd,
    stop_hook_active: false,
    background_tasks: [{ id: taskId, type: 'workflow', status: 'completed', name }],
  }
}

describe('stop-hook bundle · cross-session replay dedup (#65796, integration)', () => {
  it('does NOT replay a RESOLVED run after a session-UUID change (runId-keyed dedup)', () => {
    const root = mkRoot('resolved')
    const env = hookEnv(root)
    const cwd = '/wt-itest-resolved'
    const sessA = sessId(root, 'sess-A')
    const sessB = sessId(root, 'sess-B')
    // Plant the completed journal where findJournalByTaskId (HOME-scoped) will resolve it.
    const wfDir = join(root, '.claude', 'projects', projectSlug(cwd), sessA, 'workflows')
    mkdirSync(wfDir, { recursive: true })
    copyFileSync(FIXTURE_COMPLETED, join(wfDir, `${COMPLETED_RUN_ID}.json`))

    // Session A: journal resolves → a full audit notice, and the runId is recorded durably.
    const a = runHook(stopPayload(sessA, cwd, COMPLETED_TASK_ID, 'wt-canary-c1'), env)
    expect(String(a.out['systemMessage'] ?? '')).toContain(COMPLETED_RUN_ID)
    expect(readDurableField(root, 'reported-runs', cwd, 'runs')).toContain(COMPLETED_RUN_ID)

    // Session B: a NEW session UUID (auto-compaction), fresh per-session state, the SAME finished
    // task still listed. The durable reported-runs set makes it silent instead of re-surfacing.
    const b = runHook(stopPayload(sessB, cwd, COMPLETED_TASK_ID, 'wt-canary-c1'), env)
    expect(b.raw).toBe('{}')
  })

  it('does NOT replay a VANISHED run after a session-UUID change (taskId-keyed dedup, card #1)', () => {
    const root = mkRoot('vanished')
    const env = hookEnv(root)
    const cwd = '/wt-itest-vanished'
    const sessA = sessId(root, 'sess-A')
    const sessB = sessId(root, 'sess-B')
    const taskId = 'w1vanishedtask'
    // No journal is ever planted — findJournalByTaskId returns null (runId unknown).

    // Session A needs 3 Stops to give up on the unresolvable run: provisional once, then silent,
    // then conclusive (decideSurface max=3). On conclusion the taskId is recorded durably.
    const a1 = runHook(stopPayload(sessA, cwd, taskId, 'ghost wf'), env)
    expect(a1.raw).toContain('journal not yet readable') // the one provisional notice
    const a2 = runHook(stopPayload(sessA, cwd, taskId, 'ghost wf'), env)
    expect(a2.raw).toBe('{}')
    const a3 = runHook(stopPayload(sessA, cwd, taskId, 'ghost wf'), env)
    expect(a3.raw).toBe('{}')
    expect(readDurableField(root, 'given-up-tasks', cwd, 'tasks')).toContain(taskId)

    // Session B: new UUID, fresh state, same still-listed finished task. WITHOUT the given-up set
    // this re-emits the provisional notice (the bug); WITH it the run is re-resolved (still null)
    // and the provisional replay is suppressed — silent.
    const b = runHook(stopPayload(sessB, cwd, taskId, 'ghost wf'), env)
    expect(b.raw).toBe('{}')
  })

  it('RECOVERS a given-up run whose journal later becomes readable (no permanent silencing)', () => {
    const root = mkRoot('recovery')
    const env = hookEnv(root)
    const cwd = '/wt-itest-recovery'
    const sessA = sessId(root, 'sess-A')
    const sessB = sessId(root, 'sess-B')
    const taskId = COMPLETED_TASK_ID // the fixture's taskId — resolvable ONCE the journal is planted

    // Session A: the journal is absent, so 3 Stops give up on it (recorded in given-up-tasks).
    const a1 = runHook(stopPayload(sessA, cwd, taskId, 'wt-canary-c1'), env)
    expect(a1.raw).toContain('journal not yet readable')
    runHook(stopPayload(sessA, cwd, taskId, 'wt-canary-c1'), env)
    runHook(stopPayload(sessA, cwd, taskId, 'wt-canary-c1'), env)
    expect(readDurableField(root, 'given-up-tasks', cwd, 'tasks')).toContain(taskId)

    // The journal now becomes readable (a slow write landed / a transient read failure healed).
    const wfDir = join(root, '.claude', 'projects', projectSlug(cwd), sessA, 'workflows')
    mkdirSync(wfDir, { recursive: true })
    copyFileSync(FIXTURE_COMPLETED, join(wfDir, `${COMPLETED_RUN_ID}.json`))

    // Session B (new UUID): the give-up must NOT permanently silence the run — since it now
    // resolves, the full audit report surfaces. (Under an up-front skip this would stay silent.)
    const b = runHook(stopPayload(sessB, cwd, taskId, 'wt-canary-c1'), env)
    expect(String(b.out['systemMessage'] ?? '')).toContain(COMPLETED_RUN_ID)
  })
})
